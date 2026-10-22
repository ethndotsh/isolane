// The public classes: a Runtime runs each tenant in its own worker process,
// a Tenant is one tenant's handle, and an Isolate is one V8 isolate in a
// tenant's worker. Programs (program.ts) are pools of isolates.

import { resolve as resolvePath } from 'node:path';

import { resolve, validateConfig, validateLimits, type IsolateConfig, type ResolvedConfig, type ResolvedLimits, type RuntimeLimits } from './config.js';
import { IsolaneError, abortedError, invalidConfig, limitError } from './errors.js';
import { Emitter, HookChain, validateHooks, type Hooks, type RuntimeEvents } from './hooks.js';
import { resolveModules, type ModuleLoadOptions, type ProgramSource } from './modules.js';
import { DRAIN, FETCH, LOAD, OBSERVE, Program, USABLE, resolveInstances, type InstancesOptions, type ProgramFiles } from './program.js';
import { requestParts, responseFrom } from './program-fetch.js';
import { checkReturn, isStandardSchema, type StandardSchemaV1 } from './schema.js';
import { resolveWorkerBinary } from './worker-binary.js';
import { DEFAULT_CACHES, MAX_CACHE_BYTES, SpareWorker, TenantWorker, emptyUsage, type CacheBudgets, exitCode, isOutOfMemory, type IsolateState, type ProgramSpec, type TenantUsage } from './worker-pool.js';
import { WorkerProcess, meetsStrict, type IsolationInfo, type ModuleOptionsWire, type WorkerExit, type WorkerUsage } from './worker.js';

/** What `isolationReport()` finds: the host's isolation, and whether strict mode accepts it. */
export type IsolationReport = IsolationInfo & { meetsStrict: boolean };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySchema = StandardSchemaV1<any, any>;
/** What `run`/`eval` resolve to: the schema's output, or any JSON value. */
type ResultOf<S> = S extends AnySchema ? StandardSchemaV1.InferOutput<S> : unknown;

/** An isolate's config for one call to `runtime.run`, with its tenant. */
export interface RunConfig extends IsolateConfig {
  /** Which tenant's worker process runs this code. Required. */
  tenant: string;
}

/** Options for one eval (or run). */
export interface EvalOptions<S extends AnySchema | undefined = undefined> {
  /** A Standard Schema the completion value must match (`ERR_INVALID_RETURN` if not); the result is typed by it. */
  returns?: S;
  /**
   * The code's name in stack traces and compile errors: `src/handler.js`
   * reads `at handle (src/handler.js:12:5)`. Defaults to
   * `<tenant>/eval-<n>.js` (n counts the isolate's evals from 1).
   */
  filename?: string;
  /**
   * Aborting it stops the eval: a running one is terminated (as a timeout
   * would) and its isolate retired, one that hasn't started never does,
   * and it rejects with `ERR_ABORTED`. Its host calls' `ctx.signal` aborts
   * too.
   */
  signal?: AbortSignal;
}

/** Options for one call (`isolate.call`). */
export interface CallOptions<S extends AnySchema | undefined = undefined> {
  /** A Standard Schema the function's result must match (`ERR_INVALID_RETURN` if not); the result is typed by it. */
  returns?: S;
  /** Aborting it stops the call, as for an eval (`EvalOptions.signal`). */
  signal?: AbortSignal;
}

/** Options for `tenant.load()`: an isolate's config for its instances, and the program's own. */
export interface LoadOptions extends IsolateConfig, ModuleLoadOptions {
  /** For a single-module source: its path, and its name in stack traces. Default `main.js`. */
  filename?: string;
  /**
   * What `import { env } from 'isolane:env'` gives the program: a JSON
   * object, with the `host` functions mounted in it (`env.db.getUser`)
   * instead of on the global. Default `{}`.
   */
  env?: Record<string, unknown>;
  /** How its instances are kept (warm by default). */
  instances?: InstancesOptions;
}

/** A program's env: a JSON object whose names no host function takes. */
function checkEnv(env: unknown): Record<string, unknown> {
  if (env === undefined) return {};
  if (env === null || typeof env !== 'object' || Array.isArray(env)) throw invalidConfig('env', 'must be an object');
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(env));
  } catch (err) {
    throw invalidConfig('env', `must be JSON-serializable: ${(err as Error).message}`);
  }
  return copy as Record<string, unknown>;
}

/** A function name for `isolate.call`: not one of isolane's own (`__isolane_*`). */
function checkName(name: unknown): string {
  if (typeof name !== 'string' || name === '' || name.length > 1024) throw invalidConfig('name', 'must be a non-empty string of at most 1024 characters');
  if (name.startsWith('__isolane_')) throw invalidConfig('name', "must not start with __isolane_ (isolane's own functions)");
  return name;
}

function checkSignal(signal: unknown): AbortSignal | undefined {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw invalidConfig('signal', 'must be an AbortSignal');
  return signal;
}

/** A filename for stack traces: printable, and not one of isolane's own (`ext:`, `isolane:`). */
function checkFilename(filename: unknown): string | undefined {
  if (filename === undefined) return undefined;
  if (typeof filename !== 'string' || filename === '' || filename.length > 1024) {
    throw invalidConfig('filename', 'must be a non-empty string of at most 1024 characters');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(filename)) throw invalidConfig('filename', 'must not contain control characters');
  if (/^(ext|isolane):/.test(filename)) throw invalidConfig('filename', "must not start with ext: or isolane: (isolane's own scripts)");
  return filename;
}

/** The runtime's `caches`, over the defaults. */
function validateCaches(caches: RuntimeOptions['caches']): CacheBudgets {
  if (caches === undefined) return DEFAULT_CACHES;
  if (caches === null || typeof caches !== 'object' || Array.isArray(caches)) throw invalidConfig('caches', 'must be an object');
  const resolved = { ...DEFAULT_CACHES };
  for (const [key, value] of Object.entries(caches)) {
    if (!CACHE_KEYS.has(key)) throw invalidConfig(`caches.${key}`, 'is not a cache (fileBytes, codeBytes, wasmBytes)');
    if (value === undefined) continue;
    if (!(Number.isSafeInteger(value) && value >= 0 && value <= MAX_CACHE_BYTES)) {
      throw invalidConfig(`caches.${key}`, `must be an integer from 0 to ${MAX_CACHE_BYTES} (1 GiB)`);
    }
    resolved[key as keyof CacheBudgets] = value;
  }
  return resolved;
}

/** The tenant's name as a path segment for default filenames. */
const filenameSafe = (tenant: string) => tenant.replace(/[^\w.@-]/g, '_').slice(0, 128);

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
   * a process (about 15 MB idle, measured on a development build). Default 0.
   */
  spares?: number;
  /**
   * Keep this many web isolates made ahead of their VMs in each tenant's
   * worker (0 to 8), for each shape of isolate the worker created most
   * recently (up to four shapes): isolates that start the web platform and
   * have no `random.seed`, by their `limits.heapBytes`. A fresh web isolate
   * of one of those shapes then starts about 1 ms sooner (most of its
   * start). Each spare holds an isolate's idle memory in the worker (about
   * 3 MB), so a worker holds at most `spareIsolates` × 4 of them. Default 0.
   */
  spareIsolates?: number;
  /**
   * What each tenant's worker keeps for programs' later instances, in bytes
   * (0 keeps none; each at most 1 GiB). What is kept counts against the
   * worker's `workerMemoryBytes`, and goes with the worker when it is
   * recycled.
   */
  caches?: {
    /** Programs' files, so later instances aren't sent them again. Default 64 MiB. */
    fileBytes?: number;
    /** V8 code caches of programs' modules. Default 64 MiB. */
    codeBytes?: number;
    /** Compiled WebAssembly, counted by wire bytes (its compiled code is a few times larger). Default 32 MiB. */
    wasmBytes?: number;
  };
  /**
   * After a security event, refuse the tenant for this long (new isolates
   * throw `ERR_TENANT_QUARANTINED`), so a tenant probing for an exploit
   * can't retry in a tight loop. Default 60 s; `null` to turn it off.
   * `tenant.release()` lifts it early.
   */
  quarantineMs?: number | null;
}

const RUNTIME_KEYS = new Set(['workerPath', 'strict', 'defaults', 'tenants', 'hooks', 'limits', 'spares', 'spareIsolates', 'caches', 'quarantineMs']);
const CACHE_KEYS = new Set(['fileBytes', 'codeBytes', 'wasmBytes']);
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
const LOAD_PROGRAM = Symbol('loadProgram');

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
  #spareIsolates: number;
  #caches: CacheBudgets;
  #spareFailures = 0;
  #workers = new Map<string, TenantWorker>();
  /** Recycled workers finishing what they run, at most one per tenant. */
  #draining = new Map<string, TenantWorker>();
  #nextIsolate = 1;
  #nextReq = 1;
  #nextProgram = 1;
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
      throw invalidConfig(key, 'is not a Runtime option');
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
    this.#spareIsolates = options.spareIsolates ?? 0;
    if (!(Number.isSafeInteger(this.#spareIsolates) && this.#spareIsolates >= 0 && this.#spareIsolates <= 8)) {
      throw invalidConfig('spareIsolates', 'must be an integer from 0 to 8');
    }
    this.#caches = validateCaches(options.caches);
    this.diagnostics = Object.freeze({ workerPid: (tenant: string) => this.#workers.get(tenant)?.pid });
    this.#refill();
  }

  /**
   * Listen for an event from every tenant and isolate: `hostCall`, `eval`
   * (outcomes, after they ran), `log`, `limit`, `policyDenial`,
   * `securityEvent`, `guestError`, `worker`. Returns a function that
   * unsubscribes.
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
  async run<S extends AnySchema | undefined = undefined>(code: string, config: RunConfig & EvalOptions<S>): Promise<ResultOf<S>> {
    if (config === null || typeof config !== 'object') throw invalidConfig('', 'run() needs a config with a tenant');
    const { tenant, returns, filename, signal, ...rest } = config;
    checkFilename(filename);
    checkSignal(signal);
    const isolate = this[CREATE](tenant, rest);
    try {
      return await isolate[EVAL_LAST](code, { returns, filename, signal });
    } finally {
      isolate.close();
    }
  }

  /**
   * Start a probe worker and report the isolation this host provides: V8
   * version and sandbox, and which lockdown layers took effect. Ignores
   * strict mode, so it works on hosts that strict mode would refuse.
   */
  async isolationReport(): Promise<IsolationReport> {
    const probe = new WorkerProcess(this.#workerPath, { onMessage: () => {}, onExit: () => {} }, false, { probe: true });
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
    for (const w of [...this.#workers.values(), ...this.#draining.values()]) w.stop('ERR_RUNTIME_CLOSED', 'was stopped: the runtime closed');
    this.#workers.clear();
    this.#draining.clear();
    for (const s of this.#spares) s.proc.kill();
    this.#spares = [];
  }

  [Symbol.dispose](): void {
    this.close();
  }

  // ---- for Tenant ----

  /** @internal */
  [USAGE](tenant: string): TenantUsage {
    this.#workers.get(tenant)?.sampleCpu();
    this.#draining.get(tenant)?.sampleCpu();
    return { ...(this.#usage.get(tenant) ?? emptyUsage()) };
  }

  /** @internal */
  [RESET_USAGE](tenant: string): void {
    const u = this.#usage.get(tenant);
    if (!u) return;
    // Zeroed in place: the tenant's live workers keep counting into it.
    this.#workers.get(tenant)?.sampleCpu();
    this.#draining.get(tenant)?.sampleCpu();
    for (const key of Object.keys(u)) delete (u as unknown as Record<string, unknown>)[key];
    Object.assign(u, emptyUsage());
    // An idle tenant's entry goes, so names that come and go don't pile up.
    if (!this.#workers.has(tenant) && !this.#draining.has(tenant)) this.#usage.delete(tenant);
  }

  /** @internal */
  [RELEASE](tenant: string): void {
    this.#quarantined.delete(tenant);
  }

  /** @internal */
  [STOP](tenant: string): void {
    for (const workers of [this.#workers, this.#draining]) {
      const w = workers.get(tenant);
      if (!w) continue;
      workers.delete(tenant);
      w.stop('ERR_ISOLATE_CLOSED', 'was stopped');
    }
  }

  /** @internal Create an isolate for `tenant` with the call's config (a program's instance, with `program`). */
  [CREATE](tenant: string, config: IsolateConfig, program?: ProgramSpec): Isolate {
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
    if (program) {
      for (const entry of resolved.host) {
        const name = entry.path[0];
        if (Object.hasOwn(program.env, name)) throw invalidConfig(`env.${name}`, `is also a host function's name (${entry.name}): host functions are mounted in env`);
      }
    }
    const chain = new HookChain(resolved.hooks, this.#emitter, program?.id);
    const worker = this.#workerFor(tenant, own, resolved.web !== false);
    const id = this.#nextIsolate++;
    const state = worker.createIsolate(id, resolved, chain, program);
    return new Isolate(worker, state, () => this.#nextReq++);
  }

  /** @internal Load a program for `tenant`: its first instance is evaluated before this resolves. */
  async [LOAD_PROGRAM](tenant: string, source: string | ProgramSource, options: LoadOptions): Promise<Program> {
    if (options === null || typeof options !== 'object') throw invalidConfig('', 'load() options must be an object');
    const { filename, env, instances, modules, ts, jsx, define, ...config } = options;
    const program = resolveModules(source, checkFilename(filename), { modules, ts, jsx, define });
    const pool = resolveInstances(instances);
    const spec: ProgramSpec = { id: this.#nextProgram++, env: checkEnv(env), hostModules: program.hostModules, concurrency: pool.concurrency };
    validateConfig(config, '', 'call');
    if (this.#closed) throw new IsolaneError('ERR_RUNTIME_CLOSED', 'isolane: the runtime is closed');
    const levels = resolve([this.#runtimeLayer(), this.#defaults, this.#tenantLayer(tenant), config], this.#limits);
    const loaded = new Program({
      id: spec.id,
      tenant,
      main: program.main,
      files: program.files,
      options: program.options,
      instances: pool,
      web: levels.web !== false,
      create: () => this[CREATE](tenant, config, spec),
      chain: new HookChain(levels.hooks, this.#emitter, spec.id),
    });
    await loaded.start();
    return loaded;
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
      const spare = new SpareWorker(this.#workerPath, this.#strict, {
          memoryLimitBytes: this.#spareMemory(),
          prepareWeb: web,
          spareIsolates: this.#spareIsolates,
          codeCacheBytes: this.#caches.codeBytes,
          wasmCacheBytes: this.#caches.wasmBytes,
        }, (gone) => {
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
    // Draining workers are processes too (a recycling tenant's replacement
    // doesn't need room: its old worker leaves).
    if (this.#workers.size + this.#draining.size < limits.tenants || this.#draining.has(tenant)) return;
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
      onRecycle: (old) => this.#recycled(tenant, old),
      prepareWeb: web,
      spareIsolates: this.#spareIsolates,
      caches: this.#caches,
      spare: this.#takeSpare(memory),
    });
    this.#workers.set(tenant, w);
    return w;
  }

  /** `old` is being recycled: the tenant's next isolate starts a fresh worker. */
  #recycled(tenant: string, old: TenantWorker): void {
    if (this.#workers.get(tenant) === old) this.#workers.delete(tenant);
    // One drains at a time: one recycled before the last one drained
    // retires that one's isolates now.
    const before = this.#draining.get(tenant);
    if (before && before !== old) before.stop('ERR_ISOLATE_RETIRED', 'was recycled twice before it drained; create new isolates');
    this.#draining.set(tenant, old);
  }

  #gone(tenant: string, gone: TenantWorker, exit: WorkerExit, chain: HookChain): void {
    if (this.#workers.get(tenant) === gone) this.#workers.delete(tenant);
    if (this.#draining.get(tenant) === gone) this.#draining.delete(tenant);
    // Expected ends: stopped by us, refused (strict, incompatible), or out of memory.
    if (exit.reason === 'killed' || exit.reason === 'insufficient-isolation' || exit.reason === 'incompatible' || isOutOfMemory(exit)) return;
    // A worker exits by itself only when its stdin closes, which the
    // supervisor never does without killing it: any other end, a clean
    // exit (code 0) included, is treated as a possible exploit.
    if (exit.reason === 'protocol-violation' || exit.reason === 'unresponsive' || exit.reason === 'exited' || exit.signal || exit.code !== 0) {
      this.#usageOf(tenant).securityEvents++;
      const quarantinedUntil = this.#quarantineMs === null ? undefined : Date.now() + this.#quarantineMs;
      if (quarantinedUntil !== undefined) {
        // Expired entries go when a new one comes, so a flood of crashing
        // tenant names doesn't keep growing the map.
        const now = Date.now();
        for (const [name, until] of this.#quarantined) if (until <= now) this.#quarantined.delete(name);
        this.#quarantined.set(tenant, quarantinedUntil);
      }
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
  run<S extends AnySchema | undefined = undefined>(code: string, config?: IsolateConfig & EvalOptions<S>): Promise<ResultOf<S>> {
    return this.#runtime.run(code, { ...config, tenant: this.name } as RunConfig & EvalOptions<S>);
  }

  /** Create a stateful isolate: it keeps its globals between evals. */
  isolate(config?: IsolateConfig): Isolate {
    return this.#runtime[CREATE](this.name, config ?? {});
  }

  /**
   * Load a program: `source` is an ES module's code, or `{ main, files }`
   * for a program of several files (modules that import each other,
   * TypeScript, JSX, JSON, packages under node_modules), resolved and
   * compiled in the worker. The main module is evaluated once per instance
   * (its setup, which can't do I/O and has `limits.startupCpuMs`), and
   * `program.call(name, args)` invokes its exports. Instances are kept warm
   * and reused (`instances`). Resolves once the first instance has loaded,
   * so a syntax error, an import that doesn't resolve, or a throw in
   * top-level code rejects here.
   */
  load(source: string | ProgramSource, options?: LoadOptions): Promise<Program> {
    return this.#runtime[LOAD_PROGRAM](this.name, source, options ?? {});
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
  #evals = 0;

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
  eval<S extends AnySchema | undefined = undefined>(code: string, options?: EvalOptions<S>): Promise<ResultOf<S>> {
    return this.#eval(code, options ?? {}, false);
  }

  /** @internal */
  [EVAL_LAST]<S extends AnySchema | undefined>(code: string, options: EvalOptions<S>): Promise<ResultOf<S>> {
    return this.#eval(code, options, true);
  }

  async #eval<S extends AnySchema | undefined>(code: string, options: EvalOptions<S>, last: boolean): Promise<ResultOf<S>> {
    const { returns } = options;
    if (returns !== undefined && !isStandardSchema(returns)) throw invalidConfig('returns', 'must be a Standard Schema');
    const filename = checkFilename(options.filename) ?? `${filenameSafe(this.tenant)}/eval-${this.#evals + 1}.js`;
    const signal = checkSignal(options.signal);
    this.#evals++;
    this.#checkOpen();
    if (signal?.aborted) throw abortedError(signal, this.tenant);
    if (typeof code !== 'string') throw invalidConfig('code', 'must be a string');
    await this.#ready();
    const chain = this.#chain;
    if (!chain.observesEvals) {
      const value = await this.#worker.eval(this.#state, this.#nextReq(), code, filename, last, signal);
      return (returns ? await checkReturn(returns, value, this.tenant) : value) as ResultOf<S>;
    }
    const event = { tenant: this.tenant, isolate: this.id, code, filename };
    const before = await chain.beforeEval(event);
    if ('denied' in before) {
      throw new IsolaneError('ERR_DENIED', `isolane: the eval was denied: ${before.denied}`, { tenant: this.tenant, reason: before.denied });
    }
    const started = performance.now();
    let value: unknown;
    try {
      value = await this.#worker.eval(this.#state, this.#nextReq(), before.code, filename, last, signal);
    } catch (err) {
      await chain.afterEval({ ...event, code: before.code, durationMs: performance.now() - started, error: err as IsolaneError });
      throw err;
    }
    value = await chain.afterEval({ ...event, code: before.code, durationMs: performance.now() - started, result: value });
    return (returns ? await checkReturn(returns, value, this.tenant) : value) as ResultOf<S>;
  }

  /**
   * Call a function the isolate's code defined, with arguments as data:
   * nothing is compiled, so this is the way to invoke a handler that an
   * earlier eval set up (warm). `name` is a function declaration of a
   * classic script, or a property set on `globalThis`. Arguments and the
   * result are JSON values, or bytes (ArrayBuffers and views, which arrive
   * as Uint8Arrays) at the top level. The call settles when the function's
   * returned value (or promise) does; work it leaves running continues
   * between evals under `limits.backgroundMs`. Each call is an eval for
   * the clock and for limits (`timeoutMs`, `cpuMs`, `hostCalls`, ...).
   * A function that throws rejects with `ERR_GUEST_EXCEPTION` and the
   * isolate stays usable; a call stopped part-way (a time or CPU limit,
   * or its signal) retires it.
   */
  call<S extends AnySchema | undefined = undefined>(name: string, args: readonly unknown[] = [], options: CallOptions<S> = {}): Promise<ResultOf<S>> {
    return this.#call(name, args, options);
  }

  async #call<S extends AnySchema | undefined>(name: string, args: readonly unknown[], options: CallOptions<S>): Promise<ResultOf<S>> {
    checkName(name);
    if (!Array.isArray(args)) throw invalidConfig('args', 'must be an array');
    const { returns } = options;
    if (returns !== undefined && !isStandardSchema(returns)) throw invalidConfig('returns', 'must be a Standard Schema');
    const signal = checkSignal(options.signal);
    this.#checkOpen();
    if (signal?.aborted) throw abortedError(signal, this.tenant);
    await this.#ready();
    const chain = this.#chain;
    if (!chain.observesCalls) {
      const value = await this.#worker.call(this.#state, this.#nextReq(), name, args, signal);
      return (returns ? await checkReturn(returns, value, this.tenant) : value) as ResultOf<S>;
    }
    const program = this.#chain.program;
    const event = { tenant: this.tenant, isolate: this.id, ...(program === undefined ? {} : { program }), name, args: [...args] };
    const before = await chain.beforeCall(event);
    if ('denied' in before) {
      throw new IsolaneError('ERR_DENIED', `isolane: the call was denied: ${before.denied}`, { tenant: this.tenant, reason: before.denied });
    }
    const started = performance.now();
    let value: unknown;
    try {
      value = await this.#worker.call(this.#state, this.#nextReq(), name, before.args, signal);
    } catch (err) {
      await chain.afterCall({ ...event, args: before.args, durationMs: performance.now() - started, error: err as IsolaneError });
      throw err;
    }
    value = await chain.afterCall({ ...event, args: before.args, durationMs: performance.now() - started, result: value });
    return (returns ? await checkReturn(returns, value, this.tenant) : value) as ResultOf<S>;
  }

  /**
   * @internal Call the program's fetch handler (a program's instance):
   * `fetch(request, env, ctx)` in the guest. Through the call hooks, as
   * `fetch` with `[request]`; their result is the Response.
   */
  async [FETCH](request: Request, signal: AbortSignal | undefined): Promise<{ response: Response; waiting: number }> {
    this.#checkOpen();
    if (signal?.aborted) throw abortedError(signal, this.tenant);
    await this.#ready();
    let waiting = 0;
    const send = async (request: unknown): Promise<Response> => {
      if (!(request instanceof Request)) throw invalidConfig('request', 'must be a Request (a beforeCall hook replaced it with something else)');
      const { head, body } = await requestParts(request, this.#state.limits.bodyBytes, this.tenant);
      const maxBody = this.#state.limits.bodyBytes;
      const args = body === null ? [head] : [head, body];
      const raw = await this.#worker.call(this.#state, this.#nextReq(), 'fetch', args, signal, { kind: 'fetch', maxBody });
      const answer = responseFrom(raw, this.tenant);
      waiting = answer.waiting;
      return answer.response;
    };
    const chain = this.#chain;
    if (!chain.observesCalls) return { response: await send(request), waiting };
    const program = this.#chain.program;
    const event = { tenant: this.tenant, isolate: this.id, ...(program === undefined ? {} : { program }), name: 'fetch', args: [request] };
    const before = await chain.beforeCall(event);
    if ('denied' in before) {
      throw new IsolaneError('ERR_DENIED', `isolane: the call was denied: ${before.denied}`, { tenant: this.tenant, reason: before.denied });
    }
    const started = performance.now();
    let response: Response;
    try {
      response = await send(before.args[0]);
    } catch (err) {
      await chain.afterCall({ ...event, args: before.args, durationMs: performance.now() - started, error: err as IsolaneError });
      throw err;
    }
    const result = await chain.afterCall({ ...event, args: before.args, durationMs: performance.now() - started, result: response });
    if (!(result instanceof Response)) throw invalidConfig('result', 'must be a Response (an afterCall hook replaced it with something else)');
    return { response: result, waiting };
  }

  /** @internal Wait for the instance's `ctx.waitUntil` work (before closing it). */
  async [DRAIN](): Promise<void> {
    this.#checkOpen();
    await this.#ready();
    await this.#worker.call(this.#state, this.#nextReq(), 'drain', [], undefined, { kind: 'drain' });
  }

  /** @internal Load a program into this isolate (a program's instance). */
  async [LOAD](main: string, files: Readonly<ProgramFiles>, options: ModuleOptionsWire): Promise<unknown> {
    this.#checkOpen();
    await this.#ready();
    return this.#worker.load(this.#state, this.#nextReq(), main, files, options);
  }

  /** @internal Whether a program can route another call here. */
  get [USABLE](): boolean {
    return !this.#closed && this.#state.retired === undefined && this.#state.retiring === undefined && this.#worker.alive && !this.#worker.recycling;
  }

  /** @internal */
  [OBSERVE](onUsage: (usage: WorkerUsage) => void): void {
    this.#state.onUsage = onUsage;
  }

  /** Throws if the isolate can't run anything: closed, or retired by the worker. */
  #checkOpen(): void {
    if (this.#closed) throw new IsolaneError('ERR_ISOLATE_CLOSED', 'isolane: the isolate has been closed', { tenant: this.tenant });
    const retired = this.#state.retired;
    if (retired !== undefined) throw new IsolaneError('ERR_ISOLATE_RETIRED', `isolane: ${retired}`, { tenant: this.tenant });
  }

  /** Wait for the worker to start; its failure as this isolate's. */
  async #ready(): Promise<void> {
    await this.#worker.ready.catch((err: Error & { exit?: WorkerExit }) => {
      throw new IsolaneError(err.exit ? exitCode(err.exit) : 'ERR_WORKER_CRASHED', err.message, { tenant: this.tenant });
    });
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
