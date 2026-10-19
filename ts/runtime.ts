// The public classes: a Runtime runs each tenant in its own worker process,
// a Tenant is one tenant's handle, and an Isolate is one V8 isolate in a
// tenant's worker.

import { resolve as resolvePath } from 'node:path';

import { resolve, validateConfig, validateLimits, type IsolateConfig, type ResolvedConfig, type ResolvedLimits, type RuntimeLimits } from './config.js';
import { IsolaneError, invalidConfig, limitError } from './errors.js';
import { Emitter, HookChain, validateHooks, type Hooks, type RuntimeEvents } from './hooks.js';
import { checkReturn, isStandardSchema, type StandardSchemaV1 } from './schema.js';
import { resolveWorkerBinary } from './worker-binary.js';
import { SpareWorker, TenantWorker, emptyUsage, isOutOfMemory, type IsolateState, type TenantUsage } from './worker-pool.js';
import { WorkerProcess, meetsStrict, type IsolationInfo, type WorkerExit } from './worker.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySchema = StandardSchemaV1<any, any>;
/** What `run`/`eval` resolve to: the schema's output, or any JSON value. */
type ResultOf<S> = S extends AnySchema ? StandardSchemaV1.InferOutput<S> : unknown;

/** An isolate's config for one call to `runtime.run`, with its tenant. */
export interface RunConfig extends IsolateConfig {
  /** Which tenant's worker process runs this code. Required. */
  tenant: string;
}

export interface RuntimeOptions {
  /**
   * Path to the isolane-worker binary. Defaults to `$ISOLANE_WORKER`, then
   * the platform package npm installed with isolane (`@isolane/worker-*`).
   */
  workerPath?: string;
  /**
   * Refuse to run guest code unless the worker reports a secure V8 sandbox,
   * a full seccomp filter, and Landlock. Default true; set false for local
   * development on hosts without them (`isolationReport()` says what's
   * missing).
   */
  strict?: boolean;
  /** Config every isolate starts from. */
  defaults?: IsolateConfig;
  /**
   * A tenant's config (e.g. by plan), over `defaults`: any part of an
   * IsolateConfig, including tenant limits (isolates, workerMemoryBytes,
   * ...). Called when the tenant's worker starts and for each new isolate.
   */
  tenants?: (tenant: string) => IsolateConfig | undefined;
  /** Runtime-level hooks: they run for every tenant and isolate. */
  hooks?: Hooks;
  /** Runtime-wide limits (`tenants`). */
  limits?: RuntimeLimits;
  /**
   * Keep this many workers started and ready, so a tenant without a worker
   * gets one without waiting for V8 to start (tens of ms). Each spare costs
   * a process (~27 MB). Default 0.
   */
  spares?: number;
  /**
   * After a security event, refuse the tenant for this long (new isolates
   * throw `ERR_TENANT_QUARANTINED`), so a tenant probing for an exploit
   * can't retry in a tight loop. Default 60 s; `null` to turn it off.
   * `tenant.release()` lifts it early.
   */
  quarantineMs?: number | null;
}

const RUNTIME_KEYS = new Set(['workerPath', 'strict', 'defaults', 'tenants', 'hooks', 'limits', 'spares', 'quarantineMs']);
const RUNTIME_RENAMED: Record<string, string> = {
  prewarm: 'spares',
  idleTimeoutMs: 'defaults.limits.idleMs',
  workerMemoryLimitBytes: 'defaults.limits.workerMemoryBytes',
  tenantLimits: 'tenants',
  onLog: 'hooks.onLog',
  onSecurityEvent: 'hooks.onSecurityEvent',
};

/** Stop starting spares after this many in a row die before being used. */
const MAX_SPARE_FAILURES = 3;

/** An isolate's own eval for `run`: its timers die with it. */
const EVAL_LAST = Symbol('evalLast');
/** The Runtime's isolate factory and tenant operations, for Tenant. */
const CREATE = Symbol('create');
const USAGE = Symbol('usage');
const RESET_USAGE = Symbol('resetUsage');
const RELEASE = Symbol('release');
const STOP = Symbol('stop');

/**
 * Runs guest code in per-tenant sandboxed worker processes. Results are
 * JSON values; failures reject with an {@link IsolaneError}.
 */
export class Runtime {
  #workerPath: string;
  #strict: boolean;
  #defaults: IsolateConfig;
  #tenants: ((tenant: string) => IsolateConfig | undefined) | undefined;
  #hooks: Hooks | undefined;
  #limits: RuntimeLimits;
  #quarantineMs: number | null;
  #spareCount: number;
  #emitter = new Emitter();
  #quarantined = new Map<string, number>();
  #usage = new Map<string, TenantUsage>();
  #spares: SpareWorker[] = [];
  #spareFailures = 0;
  #workers = new Map<string, TenantWorker>();
  #nextIsolate = 1;
  #nextReq = 1;
  #closed = false;

  /** Internals for tests and diagnostics. */
  readonly diagnostics: {
    /** The tenant's worker process id, if it has one. */
    workerPid(tenant: string): number | undefined;
  };

  constructor(options: RuntimeOptions = {}) {
    if (options === null || typeof options !== 'object') throw invalidConfig('', 'Runtime options must be an object');
    for (const key of Object.keys(options)) {
      if (RUNTIME_KEYS.has(key)) continue;
      const hint = RUNTIME_RENAMED[key];
      throw invalidConfig(key, hint ? `is not a Runtime option; use ${hint}` : 'is not a Runtime option');
    }
    let workerPath = options.workerPath;
    if (!workerPath) {
      const found = resolveWorkerBinary();
      if ('error' in found) throw invalidConfig('workerPath', `is unset and ${found.error}`);
      workerPath = found.path;
    }
    // Workers start in `/`, so a relative path must be resolved here.
    this.#workerPath = resolvePath(workerPath);
    if (options.strict !== undefined && typeof options.strict !== 'boolean') throw invalidConfig('strict', 'must be a boolean');
    this.#strict = options.strict ?? true;
    this.#defaults = validateConfig(options.defaults, 'defaults', 'defaults');
    if (options.tenants !== undefined && typeof options.tenants !== 'function') throw invalidConfig('tenants', 'must be a function');
    this.#tenants = options.tenants;
    validateHooks(options.hooks, 'hooks');
    this.#hooks = options.hooks;
    validateLimits(options.limits, 'limits', 'runtime');
    this.#limits = { ...options.limits };
    this.#quarantineMs = options.quarantineMs === undefined ? 60_000 : options.quarantineMs;
    if (this.#quarantineMs !== null && !(Number.isSafeInteger(this.#quarantineMs) && this.#quarantineMs >= 0)) {
      throw invalidConfig('quarantineMs', 'must be a non-negative integer, or null');
    }
    this.#spareCount = options.spares ?? 0;
    if (!(Number.isSafeInteger(this.#spareCount) && this.#spareCount >= 0)) throw invalidConfig('spares', 'must be a non-negative integer');
    this.diagnostics = Object.freeze({ workerPid: (tenant: string) => this.#workers.get(tenant)?.pid });
    this.#refill();
  }

  /**
   * Listen for an event from every tenant and isolate: `hostCall`, `eval`
   * (outcomes, after they ran), `log`, `limit`, `policyDenial`,
   * `securityEvent`, `worker`. Returns a function that unsubscribes.
   */
  on<K extends keyof RuntimeEvents>(event: K, listener: (e: RuntimeEvents[K]) => void): () => void {
    if (typeof listener !== 'function') throw invalidConfig('listener', 'must be a function');
    return this.#emitter.on(event, listener);
  }

  /** One tenant's handle: `runtime.tenant('acme').run('1 + 1')`. */
  tenant(name: string): Tenant {
    if (typeof name !== 'string' || name === '') throw invalidConfig('tenant', 'must be a non-empty string');
    return new Tenant(this, name);
  }

  /**
   * Evaluate `code` in a fresh isolate on the tenant's worker. With
   * `returns` (a Standard Schema), the completion value is validated and
   * typed: `ERR_INVALID_RETURN` if it doesn't match.
   */
  async run<S extends AnySchema | undefined = undefined>(code: string, config: RunConfig & { returns?: S }): Promise<ResultOf<S>> {
    if (config === null || typeof config !== 'object') throw invalidConfig('', 'run() needs a config with a tenant');
    const { tenant, returns, ...rest } = config;
    const isolate = this[CREATE](tenant, rest);
    try {
      return await isolate[EVAL_LAST](code, returns);
    } finally {
      isolate.close();
    }
  }

  /**
   * Start a probe worker and report the isolation this host provides: V8
   * version and sandbox, and which lockdown layers took effect. Ignores
   * strict mode, so it works on hosts that strict mode would refuse.
   */
  async isolationReport(): Promise<IsolationInfo & { meetsStrict: boolean }> {
    const probe = new WorkerProcess(this.#workerPath, { onMessage: () => {}, onExit: () => {} }, false);
    try {
      const info = await probe.ready;
      return { ...info, meetsStrict: meetsStrict(info) };
    } finally {
      probe.kill();
    }
  }

  /** Stop every worker process. In-flight evals reject with `ERR_RUNTIME_CLOSED`. */
  close(): void {
    this.#closed = true;
    for (const w of this.#workers.values()) w.stop('ERR_RUNTIME_CLOSED', 'was stopped: the runtime closed');
    this.#workers.clear();
    for (const s of this.#spares) s.proc.kill();
    this.#spares = [];
  }

  [Symbol.dispose](): void {
    this.close();
  }

  // ---- for Tenant ----

  /** @internal */
  [USAGE](tenant: string): TenantUsage {
    return { ...(this.#usage.get(tenant) ?? emptyUsage()) };
  }

  /** @internal */
  [RESET_USAGE](tenant: string): void {
    this.#usage.delete(tenant);
  }

  /** @internal */
  [RELEASE](tenant: string): void {
    this.#quarantined.delete(tenant);
  }

  /** @internal */
  [STOP](tenant: string): void {
    const w = this.#workers.get(tenant);
    if (!w) return;
    this.#workers.delete(tenant);
    w.stop('ERR_ISOLATE_CLOSED', 'was stopped');
  }

  /** @internal Create an isolate for `tenant` with the call's config. */
  [CREATE](tenant: string, config: IsolateConfig): Isolate {
    if (this.#closed) throw new IsolaneError('ERR_RUNTIME_CLOSED', 'isolane: the runtime is closed');
    if (typeof tenant !== 'string' || tenant === '') throw invalidConfig('tenant', 'is required (a non-empty string)');
    const until = this.#quarantined.get(tenant);
    if (until !== undefined) {
      if (Date.now() < until) {
        throw new IsolaneError(
          'ERR_TENANT_QUARANTINED',
          `isolane: tenant ${tenant} is quarantined for ${Math.ceil((until - Date.now()) / 1000)}s more after a security event`,
          { tenant },
        );
      }
      this.#quarantined.delete(tenant);
    }
    const call = validateConfig(config, '', 'call');
    const own = this.#tenantLayer(tenant);
    const resolved = resolve([this.#runtimeLayer(), this.#defaults, own, call], this.#limits, ['runtime', 'defaults', 'tenant', 'call']);
    const chain = new HookChain(resolved.hooks, this.#emitter);
    const worker = this.#workerFor(tenant, own, resolved.web !== false);
    const id = this.#nextIsolate++;
    const state = worker.createIsolate(id, resolved, chain);
    return new Isolate(worker, state, () => this.#nextReq++);
  }

  // ---- internals ----

  #runtimeLayer(): IsolateConfig | undefined {
    return this.#hooks ? { hooks: this.#hooks } : undefined;
  }

  #tenantLayer(tenant: string): IsolateConfig | undefined {
    return this.#tenants ? validateConfig(this.#tenants(tenant), `tenants(${JSON.stringify(tenant)})`, 'tenant') : undefined;
  }

  /** The tenant's own level: runtime + defaults + tenants(name), no call. */
  #tenantLevel(own: IsolateConfig | undefined): ResolvedConfig {
    return resolve([this.#runtimeLayer(), this.#defaults, own], this.#limits);
  }

  #usageOf(tenant: string): TenantUsage {
    let u = this.#usage.get(tenant);
    if (!u) this.#usage.set(tenant, (u = emptyUsage()));
    return u;
  }

  /** The memory cap spares start with (the defaults'). */
  #spareMemory(): number | undefined {
    return this.#tenantLevel(undefined).limits.workerMemoryBytes ?? undefined;
  }

  #refill(): void {
    while (!this.#closed && this.#spares.length < this.#spareCount && this.#spareFailures < MAX_SPARE_FAILURES) {
      // Spares build the web snapshot up front when the defaults turn web on.
      const web = this.#tenantLevel(undefined).web !== false;
      const spare = new SpareWorker(this.#workerPath, this.#strict, this.#spareMemory(), web, (gone) => {
        // Died before anyone used it (it never ran guest code).
        this.#spares = this.#spares.filter((s) => s !== gone);
        this.#spareFailures++;
        this.#refill();
      });
      spare.proc.ready.then(
        () => (this.#spareFailures = 0),
        () => {},
      );
      this.#spares.push(spare);
    }
  }

  /** A spare, if one was started with this memory cap. */
  #takeSpare(memory: number | undefined): SpareWorker | undefined {
    const i = this.#spares.findIndex((s) => s.memoryBytes === memory);
    if (i < 0) return undefined;
    const [spare] = this.#spares.splice(i, 1);
    setImmediate(() => this.#refill());
    return spare;
  }

  /** Make room for one more tenant's worker, evicting the least recently used idle one. */
  #makeRoom(limits: ResolvedLimits, tenant: string, chain: HookChain): void {
    if (this.#workers.size < limits.tenants) return;
    let lru: TenantWorker | undefined;
    for (const w of this.#workers.values()) if (w.idle && (!lru || w.idleSince < lru.idleSince)) lru = w;
    if (!lru) {
      const err = limitError('tenants', `${limits.tenants} tenants already have running workers, none idle`, tenant);
      chain.emit('limit', { tenant, limit: 'tenants', message: err.message });
      throw err;
    }
    this.#workers.delete(lru.tenant);
    lru.stop('ERR_ISOLATE_CLOSED', 'was stopped to make room for another tenant');
  }

  /** `web`: the isolate the worker is started for uses the web platform. */
  #workerFor(tenant: string, own: IsolateConfig | undefined, web: boolean): TenantWorker {
    let w = this.#workers.get(tenant);
    if (w) return w;
    const level = this.#tenantLevel(own);
    const chain = new HookChain(level.hooks, this.#emitter);
    this.#makeRoom(level.limits, tenant, chain);
    const memory = level.limits.workerMemoryBytes ?? undefined;
    w = new TenantWorker({
      tenant,
      workerPath: this.#workerPath,
      strict: this.#strict,
      limits: level.limits,
      usage: this.#usageOf(tenant),
      chain,
      onGone: (gone, exit) => this.#gone(tenant, gone, exit, chain),
      prepareWeb: web,
      spare: this.#takeSpare(memory),
    });
    this.#workers.set(tenant, w);
    return w;
  }

  #gone(tenant: string, gone: TenantWorker, exit: WorkerExit, chain: HookChain): void {
    if (this.#workers.get(tenant) === gone) this.#workers.delete(tenant);
    // Expected ends: stopped by us, refused (strict, incompatible), or out of memory.
    if (exit.reason === 'killed' || exit.reason === 'insufficient-isolation' || exit.reason === 'incompatible' || isOutOfMemory(exit)) return;
    // A clean exit only happens when stdin closes; anything else from a
    // worker that ran guest code is treated as a possible exploit.
    if (exit.reason === 'protocol-violation' || exit.reason === 'unresponsive' || exit.signal || exit.code !== 0) {
      this.#usageOf(tenant).securityEvents++;
      const quarantinedUntil = this.#quarantineMs === null ? undefined : Date.now() + this.#quarantineMs;
      if (quarantinedUntil !== undefined) this.#quarantined.set(tenant, quarantinedUntil);
      const what = exit.signal ? `killed by ${exit.signal}` : exit.code !== null ? `exit code ${exit.code}` : exit.reason;
      chain.emit('securityEvent', {
        kind: exit.reason === 'protocol-violation' ? 'protocol' : exit.reason === 'unresponsive' ? 'unresponsive' : 'crash',
        tenant,
        quarantinedUntil,
        detail: exit.detail ? `${what}: ${exit.detail}` : what,
      });
    }
  }
}

/** One tenant's handle. */
export class Tenant {
  readonly name: string;
  #runtime: Runtime;

  /** @internal Use `runtime.tenant(name)`. */
  constructor(runtime: Runtime, name: string) {
    this.#runtime = runtime;
    this.name = name;
  }

  /** Evaluate `code` in a fresh isolate. */
  run<S extends AnySchema | undefined = undefined>(code: string, config?: IsolateConfig & { returns?: S }): Promise<ResultOf<S>> {
    return this.#runtime.run(code, { ...config, tenant: this.name } as RunConfig & { returns?: S });
  }

  /** Create a stateful isolate: it keeps its globals between evals. */
  isolate(config?: IsolateConfig): Isolate {
    return this.#runtime[CREATE](this.name, config ?? {});
  }

  /** What the tenant has used so far (a copy). */
  usage(): TenantUsage {
    return this.#runtime[USAGE](this.name);
  }

  /** Start the tenant's usage from zero (e.g. at a billing period). */
  resetUsage(): void {
    this.#runtime[RESET_USAGE](this.name);
  }

  /** Lift the tenant's quarantine early. */
  release(): void {
    this.#runtime[RELEASE](this.name);
  }

  /** Stop the tenant's worker now; its isolates close (`ERR_ISOLATE_CLOSED`). The next call starts a fresh one. */
  stop(): void {
    this.#runtime[STOP](this.name);
  }
}

/** One V8 isolate in a tenant's worker. */
export class Isolate {
  readonly tenant: string;
  readonly id: number;
  #worker: TenantWorker;
  #state: IsolateState;
  #chain: HookChain;
  #nextReq: () => number;
  #closed = false;

  /** @internal */
  constructor(worker: TenantWorker, state: IsolateState, nextReq: () => number) {
    this.#worker = worker;
    this.#state = state;
    this.#chain = state.chain;
    this.#nextReq = nextReq;
    this.tenant = worker.tenant;
    this.id = state.id;
  }

  /**
   * Evaluate code, keeping global state between calls. `returns` (a
   * Standard Schema) validates and types the completion value.
   */
  eval<S extends AnySchema | undefined = undefined>(code: string, options?: { returns?: S }): Promise<ResultOf<S>> {
    return this.#eval(code, options?.returns, false);
  }

  /** @internal */
  [EVAL_LAST]<S extends AnySchema | undefined>(code: string, returns: S | undefined): Promise<ResultOf<S>> {
    return this.#eval(code, returns, true);
  }

  async #eval<S extends AnySchema | undefined>(code: string, returns: S | undefined, last: boolean): Promise<ResultOf<S>> {
    if (returns !== undefined && !isStandardSchema(returns)) throw invalidConfig('returns', 'must be a Standard Schema');
    if (this.#closed) throw new IsolaneError('ERR_ISOLATE_CLOSED', 'isolane: the isolate has been closed', { tenant: this.tenant });
    if (typeof code !== 'string') throw invalidConfig('code', 'must be a string');
    await this.#worker.ready.catch((err: Error) => {
      const code = /strict mode/.test(err.message)
        ? 'ERR_ISOLATION_UNAVAILABLE'
        : /speaks protocol/.test(err.message)
          ? 'ERR_WORKER_INCOMPATIBLE'
          : 'ERR_WORKER_CRASHED';
      throw new IsolaneError(code, err.message, { tenant: this.tenant });
    });
    const chain = this.#chain;
    if (!chain.observesEvals) {
      const value = await this.#worker.eval(this.#state, this.#nextReq(), code, last);
      return (returns ? await checkReturn(returns, value, this.tenant) : value) as ResultOf<S>;
    }
    const event = { tenant: this.tenant, isolate: this.id, code };
    const before = await chain.beforeEval(event);
    if ('denied' in before) {
      throw new IsolaneError('ERR_DENIED', `isolane: the eval was denied: ${before.denied}`, { tenant: this.tenant, reason: before.denied });
    }
    const started = performance.now();
    let value: unknown;
    try {
      value = await this.#worker.eval(this.#state, this.#nextReq(), before.code, last);
    } catch (err) {
      await chain.afterEval({ ...event, code: before.code, durationMs: performance.now() - started, error: err as IsolaneError });
      throw err;
    }
    value = await chain.afterEval({ ...event, code: before.code, durationMs: performance.now() - started, result: value });
    return (returns ? await checkReturn(returns, value, this.tenant) : value) as ResultOf<S>;
  }

  /** Free the isolate. Idempotent. Its host calls' signals abort. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.closeIsolate(this.#state);
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
