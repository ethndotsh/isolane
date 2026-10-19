// isolane: run untrusted multi-tenant JavaScript in sandboxed V8 worker
// processes. A Runtime runs each tenant in its own worker process; each
// Isolate is one V8 isolate in it. (The API descends from clockwork's
// LanePool, with tenants added.)

import { resolve as resolvePath } from 'node:path';

import { capabilities, type FsPolicy, type NetworkPolicy, type SocketPolicy } from './capabilities.js';
import { IsolaneError, invalidOption, isIsolaneErrorCode, type IsolaneErrorCode } from './errors.js';
import {
  guestLimits,
  resolveLimits,
  validateLimits,
  type IsolateLimits,
  type Limits,
  type ResolvedLimits,
} from './limits.js';
import {
  OOM_EXIT_CODE,
  WorkerProcess,
  meetsStrict,
  type IsolationInfo,
  type LogLevel,
  type WorkerExit,
  type WorkerHandlers,
  type WorkerMessage,
  type WorkerUsage,
} from './worker.js';

export type { IsolationInfo, LockdownLevel, LogLevel } from './worker.js';
export type { FsPolicy, NetworkPolicy, SocketPolicy } from './capabilities.js';
export { IsolaneError } from './errors.js';
export { DEFAULT_LIMITS } from './limits.js';
export type { IsolateLimits, Limits, RuntimeLimits, TenantLimits } from './limits.js';
export type { GuestErrorInfo, IsolaneErrorCode, IsolaneErrorKind } from './errors.js';

/**
 * A host function callable from guest code. Arguments and the result cross
 * as JSON; it may be async. In the guest it returns a Promise. A throw or
 * rejection rejects that Promise with an `Error` carrying the message.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HostFunction = (...args: any[]) => unknown;

/**
 * A host function the guest calls synchronously: `{ sync: true, fn }`. The
 * guest gets the result (or the thrown error) directly instead of a
 * Promise, and its isolate waits for the reply (counting against
 * `timeoutMs`). `fn` itself may still be async.
 */
export interface SyncHostFunction {
  sync: true;
  fn: HostFunction;
}

/**
 * What a tenant has used, cumulatively, since the runtime started (or its
 * last `resetUsage`). Survives worker restarts. CPU time is measured on
 * Linux only (0 elsewhere).
 */
export interface TenantUsage {
  evals: number;
  /** Evals that failed, for any reason. */
  failures: number;
  /** CPU time on the tenant's isolate threads, evals and continuations. */
  cpuMs: number;
  hostCalls: number;
  logBytes: number;
  /** The largest V8 heap (plus external memory) any of its isolates reported. */
  peakMemoryBytes: number;
  securityEvents: number;
}

const emptyUsage = (): TenantUsage => ({
  evals: 0,
  failures: 0,
  cpuMs: 0,
  hostCalls: 0,
  logBytes: 0,
  peakMemoryBytes: 0,
  securityEvents: 0,
});

/** A line of guest console output. */
export interface LogEntry {
  tenant: string;
  level: LogLevel;
  message: string;
}

/** Everything about a VM except which tenant it belongs to. */
export interface IsolateOptions {
  /**
   * This isolate's limits (see `IsolateLimits`); they override the
   * runtime's and the tenant's, field by field.
   */
  limits?: IsolateLimits;
  /** Shorthand for `limits.cpuTimeMs`: CPU time per eval (Linux; `ERR_CPU_LIMIT`). */
  cpuTimeLimitMs?: number;
  /** Shorthand for `limits.timeoutMs`: wall-clock budget per eval. */
  timeoutMs?: number;
  /** Shorthand for `limits.heapBytes`: the V8 heap; exceeding it retires the isolate. */
  memoryLimitBytes?: number;
  /**
   * Functions installed as guest globals, by name. Async in the guest
   * (they return a Promise) unless given as `{ sync: true, fn }`.
   */
  hostFunctions?: Record<string, HostFunction | SyncHostFunction>;
  /**
   * JSON values installed as guest globals before any code runs: the safe
   * way to pass inputs, instead of splicing them into the code string.
   */
  globals?: Record<string, unknown>;
  /** Where this VM's `console` output goes. Default: the pool's `onLog`. */
  onLog?: (entry: LogEntry) => void;
  /**
   * The wall clock guest code sees (`Date`, `Intl`'s default "now").
   * - `'frozen'` (default): moves only when an eval starts and when a host
   *   call returns, so guest code can't time itself (Cloudflare Workers'
   *   rule; denies side-channel attacks a timer).
   * - `'realtime'`: the real clock.
   * - `{ fixedMs }`: always this time (ms since the epoch), for
   *   reproducible runs.
   */
  clock?: 'frozen' | 'realtime' | { fixedMs: number };
  /**
   * Seed `Math.random` (and V8's internal hash seeds) for reproducible
   * runs: an integer from 0 to 2^53 - 1. Default: fresh OS randomness for
   * every VM. A seeded VM's hash seeds are predictable to its own code.
   */
  randomSeed?: number;
  /** Allow `eval` and `new Function`. Default false. */
  allowCodeGeneration?: boolean;
  /**
   * Keep the `WebAssembly` global and allow compiling modules. Default
   * false: WebAssembly's compilers are a large share of V8's attack surface.
   */
  allowWebAssembly?: boolean;
  /**
   * Install the WinterTC web platform globals: URL, URLSearchParams,
   * TextEncoder/TextDecoder, atob/btoa, Event/EventTarget, AbortController,
   * DOMException, structuredClone, performance, queueMicrotask,
   * reportError, crypto.getRandomValues/randomUUID, navigator, self.
   * Default false (plain ECMAScript).
   */
  webPlatform?: boolean;
  /**
   * Give guest code `fetch` (with `Response` and `Headers`), brokered by
   * this process under the policy. Default: no network.
   */
  network?: NetworkPolicy;
  /**
   * Give guest code an `fs` object (promise-based: readFile, writeFile,
   * readdir, stat, exists, mkdir, rm) over a host directory, brokered by
   * this process under the policy. Default: no files.
   */
  fs?: FsPolicy;
  /**
   * Give guest code `connect(address, { secureTransport })`, TCP or TLS
   * sockets brokered by this process under the policy. Default: none.
   */
  sockets?: SocketPolicy;
}

export interface RunOptions extends IsolateOptions {
  /** Which tenant's worker process runs this code. Required. */
  tenant: string;
}

/** Later options win; host functions and globals merge by name. */
function mergeOptions<T extends IsolateOptions>(base: IsolateOptions | undefined, over: T): T {
  over = withLimits(over);
  if (!base) return over;
  base = withLimits(base);
  const merged = { ...base, ...over } as T;
  if (base.hostFunctions || over.hostFunctions) merged.hostFunctions = { ...base.hostFunctions, ...over.hostFunctions };
  if (base.globals || over.globals) merged.globals = { ...base.globals, ...over.globals };
  if (base.limits || over.limits) merged.limits = { ...base.limits, ...over.limits };
  return merged;
}

/** Fold the limit shorthands (timeoutMs, ...) into `limits`, at one level. */
function withLimits<T extends IsolateOptions>(opts: T): T {
  const limits: IsolateLimits = { ...validateLimits(opts.limits, 'limits', true) };
  const shorthand = [
    ['timeoutMs', 'timeoutMs'],
    ['cpuTimeLimitMs', 'cpuTimeMs'],
    ['memoryLimitBytes', 'heapBytes'],
  ] as const;
  let changed = false;
  for (const [short, key] of shorthand) {
    const v = opts[short];
    if (v === undefined) continue;
    if (limits[key] !== undefined && limits[key] !== v) throw invalidOption(`${short} and limits.${key} disagree`);
    limits[key] = v;
    changed = true;
  }
  if (!changed) return opts;
  const out = { ...opts, limits };
  for (const [short] of shorthand) delete out[short];
  validateLimits(limits, 'limits', true);
  return out;
}

type ClockSpec = { mode: 'frozen' } | { mode: 'realtime' } | { mode: 'fixed'; fixedMs: number };

interface VmSetup {
  clock: ClockSpec;
  hostFunctions: Record<string, HostFunction>;
  syncHostFunctions: string[];
  prelude?: string;
  dispose(): void;
}

/** Validate a VM's options and build what its worker needs. Throws on bad options. */
function vmSetup(opts: RunOptions): VmSetup {
  const clock = clockSpec(opts.clock);
  if (opts.randomSeed !== undefined && !(Number.isSafeInteger(opts.randomSeed) && opts.randomSeed >= 0)) {
    throw invalidOption('randomSeed must be an integer from 0 to 2^53 - 1');
  }
  const user: Record<string, HostFunction> = {};
  const syncHostFunctions: string[] = [];
  for (const [name, entry] of Object.entries(opts.hostFunctions ?? {})) {
    if (typeof entry === 'function') user[name] = entry;
    else if (entry && entry.sync === true && typeof entry.fn === 'function') {
      user[name] = entry.fn;
      syncHostFunctions.push(name);
    } else throw invalidOption(`hostFunctions.${name} must be a function or { sync: true, fn }`);
  }
  let caps;
  try {
    caps = capabilities(opts, user);
  } catch (err) {
    throw err instanceof TypeError ? invalidOption((err as Error).message.replace(/^isolane: /, '')) : err;
  }
  return {
    clock,
    hostFunctions: { ...user, ...caps.hostFunctions },
    syncHostFunctions,
    prelude: caps.prelude,
    dispose: caps.dispose,
  };
}

function clockSpec(clock: RunOptions['clock']): ClockSpec {
  if (clock === undefined || clock === 'frozen') return { mode: 'frozen' };
  if (clock === 'realtime') return { mode: 'realtime' };
  if (typeof clock === 'object' && clock !== null && Number.isFinite(clock.fixedMs)) {
    return { mode: 'fixed', fixedMs: clock.fixedMs };
  }
  throw invalidOption(`clock must be 'frozen', 'realtime', or { fixedMs }`);
}

export interface SecurityEvent {
  kind: 'worker-crash' | 'protocol-violation' | 'worker-unresponsive';
  tenant: string;
  /** When the tenant's quarantine ends (ms since the epoch), if it is quarantined. */
  quarantinedUntil?: number;
  exitCode: number | null;
  signal: string | null;
  detail?: string;
}

export interface RuntimeOptions {
  /** Path to the isolane-worker binary. Defaults to `$ISOLANE_WORKER`. */
  workerPath?: string;
  /** Stop a tenant's worker after this long with no VMs and no runs. */
  idleTimeoutMs?: number;
  /**
   * Refuse to run guest code unless the worker reports a secure V8 sandbox,
   * a full seccomp filter, and Landlock. Defaults to on when
   * `NODE_ENV=production`. Off, workers run with whatever the host supports.
   */
  strict?: boolean;
  /**
   * Called when a worker dies unexpectedly or breaks the protocol, which
   * may mean guest code attempted an exploit. Use it to alert, or to
   * suspend the tenant's account.
   */
  onSecurityEvent?: (event: SecurityEvent) => void;
  /** Where guest `console` output goes, unless a VM sets its own. Default: dropped. */
  onLog?: (entry: LogEntry) => void;
  /**
   * Cap on each tenant worker's memory (Linux; RLIMIT_DATA): every VM's
   * heap, ArrayBuffers, and WebAssembly memory together, on top of V8's own
   * baseline (measured at startup and excluded). At least 64 MiB. A worker past it
   * exits, its in-flight evals reject with `ERR_MEMORY_LIMIT`, and the next
   * call starts a fresh one. Default 2 GiB; `null` for no cap.
   */
  workerMemoryLimitBytes?: number | null;
  /**
   * Defaults for every limit: per isolate, per tenant, and for the runtime
   * (see `Limits` and `DEFAULT_LIMITS`). `workerMemoryLimitBytes` above is
   * shorthand for `limits.workerMemoryBytes`.
   */
  limits?: Limits;
  /**
   * Per-tenant limits (e.g. by plan), over the runtime's `limits`. Called
   * when the tenant's worker starts and for each new isolate.
   */
  tenantLimits?: (tenant: string) => Limits | undefined;
  /** Options every VM starts from; a tenant's and a call's options override them. */
  defaults?: IsolateOptions;
  /**
   * After a security event, refuse the tenant for this long (new isolates
   * throw `ERR_TENANT_QUARANTINED`), so a tenant probing for an exploit
   * can't retry in a tight loop. Default 60 s; `null` to turn it off.
   * `runtime.releaseQuarantine(tenant)` lifts it early.
   */
  quarantineMs?: number | null;
  /**
   * Keep this many workers started and ready, so a tenant without a worker
   * gets one without waiting for V8 to start (tens of ms). Each spare costs
   * a process (~27 MB). Default 0.
   */
  prewarm?: number;
}

/** Stop prewarming after this many spares in a row die before being used. */
const MAX_SPARE_FAILURES = 3;


interface Pending {
  resolve(value: unknown): void;
  reject(err: IsolaneError): void;
  timer?: NodeJS.Timeout;
}

/**
 * The worker enforces `timeoutMs` itself; the supervisor doesn't trust it
 * to. An eval with a timeout that gets no reply by this long after its
 * worker-side deadline means a wedged or compromised worker, which is
 * killed. Generous, so a merely overloaded host isn't mistaken for one.
 */
const unresponsiveAfterMs = (timeoutMs: number) => timeoutMs + Math.max(1000, timeoutMs);

/**
 * A started worker not yet given to a tenant. It has never run guest code;
 * a tenant claims it whole, and it serves only that tenant from then on.
 * Messages go to whoever has claimed it.
 */
class SpareWorker {
  readonly proc: WorkerProcess;
  handlers: WorkerHandlers | undefined;
  exited: WorkerExit | undefined;

  constructor(workerPath: string, strict: boolean, memoryLimitBytes: number | undefined, onExit: (s: SpareWorker) => void) {
    this.proc = new WorkerProcess(
      workerPath,
      {
        onMessage: (msg) => this.handlers?.onMessage(msg),
        onExit: (exit) => {
          this.exited = exit;
          if (this.handlers) this.handlers.onExit(exit);
          else onExit(this);
        },
      },
      strict,
      memoryLimitBytes,
    );
  }
}

/** A tenant's worker process and the VMs and requests in flight on it. */
class TenantWorker {
  readonly tenant: string;
  #proc: WorkerProcess;
  #requests = new Map<number, Pending>();
  #hostFunctions = new Map<number, Record<string, HostFunction>>();
  #disposers = new Map<number, () => void>();
  #loggers = new Map<number, ((entry: LogEntry) => void) | undefined>();
  #timeouts = new Map<number, number | undefined>();
  // When each VM's queued evals will have run out their timeouts: a VM runs
  // its evals one at a time, so a queued eval's clock starts after these.
  #busyUntil = new Map<number, number>();
  #vmCount = 0;
  #idleTimer: NodeJS.Timeout | undefined;
  #onGone: (exit: WorkerExit) => void;
  #idleTimeoutMs: number;
  #usage: TenantUsage;
  /** Its tenant-level limits (isolates, concurrentEvals), fixed at start. */
  readonly limits: ResolvedLimits;
  #codeBytes = new Map<number, number>();
  /** When it last had nothing running (for evicting idle tenants). */
  idleSince = Date.now();

  constructor(
    tenant: string,
    workerPath: string,
    idleTimeoutMs: number,
    strict: boolean,
    memoryLimitBytes: number | undefined,
    onGone: (worker: TenantWorker, exit: WorkerExit) => void,
    usage: TenantUsage,
    limits: ResolvedLimits,
    spare?: SpareWorker,
  ) {
    this.tenant = tenant;
    this.#usage = usage;
    this.limits = limits;
    this.#idleTimeoutMs = idleTimeoutMs;
    this.#onGone = (exit) => onGone(this, exit);
    const handlers: WorkerHandlers = {
      onMessage: (msg) => this.#onMessage(msg),
      onExit: (exit) => this.#onExit(exit),
    };
    if (spare) {
      this.#proc = spare.proc;
      spare.handlers = handlers;
    } else {
      this.#proc = new WorkerProcess(workerPath, handlers, strict, memoryLimitBytes);
    }
  }

  get ready(): Promise<unknown> {
    return this.#proc.ready;
  }

  get pid(): number | undefined {
    return this.#proc.pid;
  }

  /** No isolates and nothing in flight. */
  get idle(): boolean {
    return this.#vmCount === 0 && this.#requests.size === 0;
  }

  createIsolate(
    vm: number,
    opts: IsolateOptions,
    setup: VmSetup,
    onLog: ((entry: LogEntry) => void) | undefined,
    limits: ResolvedLimits,
  ): void {
    if (this.#vmCount >= this.limits.isolates) {
      throw new IsolaneError(
        'ERR_RESOURCE_LIMIT',
        `isolane: tenant ${this.tenant} already has ${this.limits.isolates} isolates (limits.isolates)`,
        { tenant: this.tenant, limit: 'isolates' },
      );
    }
    this.#hostFunctions.set(vm, setup.hostFunctions);
    this.#disposers.set(vm, setup.dispose);
    this.#loggers.set(vm, onLog);
    this.#timeouts.set(vm, limits.timeoutMs ?? undefined);
    this.#codeBytes.set(vm, limits.codeBytes);
    this.#vmCount++;
    this.#touch();
    this.#proc.send({
      t: 'create',
      vm,
      timeoutMs: limits.timeoutMs ?? undefined,
      cpuTimeLimitMs: limits.cpuTimeMs ?? undefined,
      heapBytes: limits.heapBytes ?? undefined,
      limits: guestLimits(limits),
      hostFunctions: Object.keys(setup.hostFunctions).filter((n) => !setup.syncHostFunctions.includes(n)),
      syncHostFunctions: setup.syncHostFunctions,
      clock: setup.clock,
      randomSeed: opts.randomSeed,
      allowCodeGeneration: opts.allowCodeGeneration === true,
      allowWebAssembly: opts.allowWebAssembly === true,
      webPlatform: opts.webPlatform === true,
      prelude: setup.prelude,
    });
  }

  /** `last`: the isolate is disposed after this eval (a one-shot run), so
   * the worker drops it as soon as the result is sent and its pending
   * timers never run. */
  eval(vm: number, req: number, code: string, last = false): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.#proc.alive) {
        reject(new IsolaneError('ERR_WORKER_CRASHED', `worker for tenant ${this.tenant} is gone`, { tenant: this.tenant }));
        return;
      }
      const codeBytes = this.#codeBytes.get(vm);
      if (codeBytes !== undefined && Buffer.byteLength(code, 'utf8') > codeBytes) {
        reject(
          new IsolaneError('ERR_RESOURCE_LIMIT', `isolane: the code is larger than ${codeBytes} bytes (limits.codeBytes)`, {
            tenant: this.tenant,
            limit: 'codeBytes',
          }),
        );
        return;
      }
      if (this.#requests.size >= this.limits.concurrentEvals) {
        reject(
          new IsolaneError(
            'ERR_RESOURCE_LIMIT',
            `isolane: tenant ${this.tenant} already has ${this.limits.concurrentEvals} evals in flight (limits.concurrentEvals)`,
            { tenant: this.tenant, limit: 'concurrentEvals' },
          ),
        );
        return;
      }
      const pending: Pending = { resolve, reject };
      const timeoutMs = this.#timeouts.get(vm);
      if (timeoutMs !== undefined) {
        const start = Math.max(Date.now(), this.#busyUntil.get(vm) ?? 0);
        this.#busyUntil.set(vm, start + timeoutMs);
        const limit = start - Date.now() + unresponsiveAfterMs(timeoutMs);
        pending.timer = setTimeout(
          () => this.#proc.kill('unresponsive', `no reply to an eval ${limit}ms after it was sent (timeoutMs ${timeoutMs})`),
          limit,
        );
      }
      this.#requests.set(req, pending);
      this.#touch();
      this.#proc.send(last ? { t: 'eval', vm, req, code, last } : { t: 'eval', vm, req, code });
    });
  }

  disposeVm(vm: number): void {
    if (!this.#hostFunctions.delete(vm)) return;
    this.#disposers.get(vm)?.();
    this.#disposers.delete(vm);
    this.#loggers.delete(vm);
    this.#timeouts.delete(vm);
    this.#codeBytes.delete(vm);
    this.#busyUntil.delete(vm);
    this.#vmCount--;
    this.#proc.send({ t: 'dispose', vm });
    this.#touch();
  }

  kill(): void {
    clearTimeout(this.#idleTimer);
    this.#proc.kill();
  }

  #touch(): void {
    clearTimeout(this.#idleTimer);
    if (this.#vmCount === 0 && this.#requests.size === 0) {
      this.idleSince = Date.now();
      this.#idleTimer = setTimeout(() => this.kill(), this.#idleTimeoutMs);
      this.#idleTimer.unref();
    }
  }

  #count(u: WorkerUsage): void {
    if (u.cpuUs !== undefined) this.#usage.cpuMs += u.cpuUs / 1000;
    const memory = (u.heapBytes ?? 0) + (u.externalBytes ?? 0);
    if (memory > this.#usage.peakMemoryBytes) this.#usage.peakMemoryBytes = memory;
  }

  #onMessage(msg: Exclude<WorkerMessage, { t: 'ready' }>): void {
    if (msg.t === 'usage') {
      this.#count(msg);
      return;
    }
    if (msg.t === 'result') {
      this.#usage.evals++;
      if (!msg.ok) this.#usage.failures++;
      this.#count(msg);
      const pending = this.#requests.get(msg.req);
      if (!pending) return;
      this.#requests.delete(msg.req);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.value);
      else {
        const code = isIsolaneErrorCode(msg.code) ? msg.code : 'ERR_INTERNAL';
        // Worker-enforced limits name themselves as "(limits.<name>)".
        const limit = code === 'ERR_RESOURCE_LIMIT' ? /\(limits\.(\w+)\)/.exec(msg.message)?.[1] : undefined;
        pending.reject(new IsolaneError(code, msg.message, { tenant: this.tenant, guest: msg.guest, limit }));
      }
      this.#touch();
      return;
    }
    if (msg.t === 'log') {
      this.#usage.logBytes += msg.message.length;
      const log = this.#loggers.get(msg.vm);
      try {
        log?.({ tenant: this.tenant, level: msg.level, message: msg.message });
      } catch {
        // A throwing logger must not take the worker connection down.
      }
      return;
    }
    // hostCall
    this.#usage.hostCalls++;
    const reply = (ok: boolean, value?: string, err?: unknown) => {
      const frame: Record<string, unknown> = { t: 'hostReply', vm: msg.vm, call: msg.call, ok };
      if (value !== undefined) frame.value = value; // JSON text; absent = undefined
      if (!ok) {
        frame.error = err instanceof Error ? err.message : String(err);
        // The guest sees the same class (TypeError, ...) and Node-style code.
        if (err instanceof Error && typeof err.name === 'string') frame.errorName = err.name;
        const code = (err as { code?: unknown } | null)?.code;
        if (typeof code === 'string') frame.errorCode = code;
      }
      this.#proc.send(frame);
    };
    const fail = (err: unknown) => reply(false, undefined, err);
    const succeed = (result: unknown) => {
      let json: string | undefined;
      try {
        json = JSON.stringify(result);
      } catch (err) {
        fail(new Error(`host function ${msg.name} returned a non-JSON value: ${(err as Error).message}`));
        return;
      }
      reply(true, json);
    };
    const fn = Object.hasOwn(this.#hostFunctions.get(msg.vm) ?? {}, msg.name)
      ? this.#hostFunctions.get(msg.vm)![msg.name]
      : undefined;
    if (!fn) {
      fail(new Error(`host function ${msg.name} is not available`));
      return;
    }
    let result: unknown;
    try {
      result = fn(...msg.args);
    } catch (err) {
      fail(err);
      return;
    }
    if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
      (result as PromiseLike<unknown>).then(succeed, fail);
    } else {
      succeed(result);
    }
  }

  #onExit(exit: WorkerExit): void {
    clearTimeout(this.#idleTimer);
    for (const dispose of this.#disposers.values()) dispose();
    this.#disposers.clear();
    const code: IsolaneErrorCode = isOutOfMemory(exit)
      ? 'ERR_MEMORY_LIMIT'
      : exit.reason === 'unresponsive'
        ? 'ERR_WORKER_UNRESPONSIVE'
        : exit.reason === 'insufficient-isolation'
          ? 'ERR_ISOLATION_UNAVAILABLE'
          : exit.reason === 'killed'
            ? 'ERR_RUNTIME_CLOSED'
            : 'ERR_WORKER_CRASHED';
    const err = new IsolaneError(code, `worker for tenant ${this.tenant} ${describeExit(exit)}`, {
      tenant: this.tenant,
      // A fresh worker has its full memory again.
      retryable: code === 'ERR_MEMORY_LIMIT' ? true : undefined,
    });
    for (const p of this.#requests.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#requests.clear();
    this.#onGone(exit);
  }
}

const isOutOfMemory = (exit: WorkerExit) => exit.reason === 'exited' && exit.code === OOM_EXIT_CODE;

function describeExit(exit: WorkerExit): string {
  if (isOutOfMemory(exit)) return 'ran out of memory (limits.workerMemoryBytes)';
  if (exit.reason === 'protocol-violation') return `broke the protocol (${exit.detail})`;
  if (exit.reason === 'insufficient-isolation') return `was refused (${exit.detail})`;
  if (exit.reason === 'unresponsive') return `stopped responding and was killed (${exit.detail})`;
  if (exit.signal) return `was killed by ${exit.signal}`;
  return `exited with code ${exit.code}${exit.detail ? `: ${exit.detail}` : ''}`;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/**
 * Runs guest code in per-tenant sandboxed worker processes. Results are
 * JSON values; failures reject with a {@link IsolaneError}.
 */
export class Runtime {
  #workerPath: string;
  #idleTimeoutMs: number;
  #onSecurityEvent: ((e: SecurityEvent) => void) | undefined;
  #onLog: ((e: LogEntry) => void) | undefined;
  #limits: Limits;
  #tenantLimits: ((tenant: string) => Limits | undefined) | undefined;
  #defaults: IsolateOptions | undefined;
  #quarantineMs: number | null;
  #quarantined = new Map<string, number>();
  #usage = new Map<string, TenantUsage>();
  #prewarm: number;
  #spares: SpareWorker[] = [];
  #spareFailures = 0;
  #strict: boolean;
  #workers = new Map<string, TenantWorker>();
  #nextVm = 1;
  #nextReq = 1;
  #closed = false;

  constructor(options: RuntimeOptions = {}) {
    const workerPath = options.workerPath ?? process.env.ISOLANE_WORKER;
    if (!workerPath) {
      throw new Error('isolane: no worker binary (pass workerPath or set ISOLANE_WORKER)');
    }
    // Workers start in `/`, so a relative path must be resolved here.
    this.#workerPath = resolvePath(workerPath);
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#onSecurityEvent = options.onSecurityEvent;
    this.#strict = options.strict ?? process.env.NODE_ENV === 'production';
    this.#onLog = options.onLog;
    this.#defaults = options.defaults;
    this.#quarantineMs = options.quarantineMs === undefined ? 60_000 : options.quarantineMs;
    this.#prewarm = options.prewarm ?? 0;
    if (!(Number.isSafeInteger(this.#prewarm) && this.#prewarm >= 0)) throw invalidOption('prewarm must be a non-negative integer');
    const limits = { ...validateLimits(options.limits, 'limits') };
    if (options.workerMemoryLimitBytes !== undefined) {
      if (limits.workerMemoryBytes !== undefined && limits.workerMemoryBytes !== options.workerMemoryLimitBytes) {
        throw invalidOption('workerMemoryLimitBytes and limits.workerMemoryBytes disagree');
      }
      limits.workerMemoryBytes = options.workerMemoryLimitBytes;
      validateLimits(limits, 'limits');
    }
    this.#limits = limits;
    this.#tenantLimits = options.tenantLimits;
    if (this.#tenantLimits !== undefined && typeof this.#tenantLimits !== 'function') {
      throw invalidOption('tenantLimits must be a function');
    }
    this.#refill();
  }

  /** The runtime's and the tenant's limits, before any isolate's own. */
  #limitsFor(tenant: string): ResolvedLimits {
    const own = this.#tenantLimits ? validateLimits(this.#tenantLimits(tenant), `tenantLimits(${JSON.stringify(tenant)})`) : undefined;
    return resolveLimits(this.#limits, own);
  }

  /** The memory cap a worker is started with (undefined: none). */
  #workerMemory(limits: ResolvedLimits): number | undefined {
    return limits.workerMemoryBytes ?? undefined;
  }

  #refill(): void {
    while (!this.#closed && this.#spares.length < this.#prewarm && this.#spareFailures < MAX_SPARE_FAILURES) {
      const spare = new SpareWorker(this.#workerPath, this.#strict, this.#workerMemory(resolveLimits(this.#limits)), (gone) => {
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
    if (memory !== this.#workerMemory(resolveLimits(this.#limits))) return undefined;
    const spare = this.#spares.shift();
    if (spare) setImmediate(() => this.#refill());
    return spare;
  }

  /**
   * A handle for one tenant, with options its VMs start from:
   * `pool.tenant('acme', { timeoutMs: 1000 }).run('1 + 1')`.
   */
  tenant(name: string, defaults?: IsolateOptions): Tenant {
    if (typeof name !== 'string' || name === '') throw invalidOption('tenant name is required');
    return new Tenant(this, name, defaults);
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

  /** Evaluate `code` in a fresh VM on the tenant's worker. */
  async run(code: string, options: RunOptions): Promise<unknown> {
    const vm = this.createIsolate(options);
    try {
      return await vm._evalLast(code);
    } finally {
      vm.dispose();
    }
  }

  /** Create a stateful VM on the tenant's worker. */
  createIsolate(options: RunOptions): Isolate {
    if (this.#closed) throw new IsolaneError('ERR_RUNTIME_CLOSED', 'isolane: the runtime is closed');
    if (typeof options?.tenant !== 'string' || options.tenant === '') {
      throw invalidOption('options.tenant is required');
    }
    const until = this.#quarantined.get(options.tenant);
    if (until !== undefined) {
      if (Date.now() < until) {
        throw new IsolaneError(
          'ERR_TENANT_QUARANTINED',
          `isolane: tenant ${options.tenant} is quarantined for ${Math.ceil((until - Date.now()) / 1000)}s more after a security event`,
          { tenant: options.tenant },
        );
      }
      this.#quarantined.delete(options.tenant);
    }
    const opts = mergeOptions(this.#defaults, options);
    const tenantLevel = this.#limitsFor(opts.tenant);
    const limits = resolveLimits(tenantLevel, opts.limits);
    const setup = vmSetup(opts);
    const worker = this.#workerFor(opts.tenant, tenantLevel);
    const id = this.#nextVm++;
    try {
      worker.createIsolate(id, opts, setup, opts.onLog ?? this.#onLog, limits);
    } catch (err) {
      setup.dispose();
      throw err;
    }
    return new Isolate(worker, id, () => this.#nextReq++);
  }

  /** @internal The tenant's worker pid, if it has one (tests and diagnostics). */
  _workerPid(tenant: string): number | undefined {
    return this.#workers.get(tenant)?.pid;
  }

  /** Stop every worker process. In-flight evals reject. */
  close(): void {
    this.#closed = true;
    for (const w of this.#workers.values()) w.kill();
    this.#workers.clear();
    for (const s of this.#spares) s.proc.kill();
    this.#spares = [];
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /** What a tenant has used so far (a copy). */
  usage(tenant: string): TenantUsage {
    return { ...(this.#usage.get(tenant) ?? emptyUsage()) };
  }

  /** Start a tenant's usage from zero (e.g. at a billing period). */
  resetUsage(tenant: string): void {
    this.#usage.delete(tenant);
  }

  #usageOf(tenant: string): TenantUsage {
    let u = this.#usage.get(tenant);
    if (!u) this.#usage.set(tenant, (u = emptyUsage()));
    return u;
  }

  /** Lift a tenant's quarantine early. */
  releaseQuarantine(tenant: string): void {
    this.#quarantined.delete(tenant);
  }

  /** Make room for one more tenant's worker, evicting the least recently used idle one. */
  #makeRoom(limits: ResolvedLimits, tenant: string): void {
    if (this.#workers.size < limits.tenants) return;
    let lru: TenantWorker | undefined;
    for (const w of this.#workers.values()) if (w.idle && (!lru || w.idleSince < lru.idleSince)) lru = w;
    if (!lru) {
      throw new IsolaneError(
        'ERR_RESOURCE_LIMIT',
        `isolane: ${limits.tenants} tenants already have running workers, none idle (limits.tenants)`,
        { tenant, limit: 'tenants' },
      );
    }
    this.#workers.delete(lru.tenant);
    lru.kill();
  }

  #workerFor(tenant: string, limits: ResolvedLimits): TenantWorker {
    let w = this.#workers.get(tenant);
    if (!w) {
      this.#makeRoom(limits, tenant);
      const memory = this.#workerMemory(limits);
      w = new TenantWorker(tenant, this.#workerPath, this.#idleTimeoutMs, this.#strict, memory, (gone, exit) => {
        if (this.#workers.get(tenant) === gone) this.#workers.delete(tenant);
        // Expected ends: stopped by us, refused by strict mode, or out of memory.
        if (exit.reason === 'killed' || exit.reason === 'insufficient-isolation' || isOutOfMemory(exit)) return;
        // A clean exit only happens when stdin closes; anything else from a
        // worker that ran guest code is treated as a possible exploit.
        if (exit.reason === 'protocol-violation' || exit.reason === 'unresponsive' || exit.signal || exit.code !== 0) {
          this.#usageOf(tenant).securityEvents++;
          const quarantinedUntil = this.#quarantineMs === null ? undefined : Date.now() + this.#quarantineMs;
          if (quarantinedUntil !== undefined) this.#quarantined.set(tenant, quarantinedUntil);
          this.#onSecurityEvent?.({
            kind:
              exit.reason === 'protocol-violation'
                ? 'protocol-violation'
                : exit.reason === 'unresponsive'
                  ? 'worker-unresponsive'
                  : 'worker-crash',
            tenant,
            quarantinedUntil,
            exitCode: exit.code,
            signal: exit.signal,
            detail: exit.detail,
          });
        }
      }, this.#usageOf(tenant), limits, this.#takeSpare(memory));
      this.#workers.set(tenant, w);
    }
    return w;
  }
}

/** One tenant's view of a pool, with default options for its VMs. */
export class Tenant {
  readonly name: string;
  #pool: Runtime;
  #defaults: IsolateOptions | undefined;

  /** @internal Use `pool.tenant(name)`. */
  constructor(pool: Runtime, name: string, defaults: IsolateOptions | undefined) {
    this.#pool = pool;
    this.name = name;
    this.#defaults = defaults;
  }

  /** Evaluate `code` in a fresh VM. */
  run(code: string, options?: IsolateOptions): Promise<unknown> {
    return this.#pool.run(code, this.#options(options));
  }

  /** Create a stateful VM. */
  createIsolate(options?: IsolateOptions): Isolate {
    return this.#pool.createIsolate(this.#options(options));
  }

  #options(options: IsolateOptions | undefined): RunOptions {
    return { ...mergeOptions(this.#defaults, options ?? {}), tenant: this.name };
  }
}

/** A stateful VM on a tenant's worker. */
export class Isolate {
  #worker: TenantWorker;
  #id: number;
  #nextReq: () => number;
  #disposed = false;

  /** @internal */
  constructor(worker: TenantWorker, id: number, nextReq: () => number) {
    this.#worker = worker;
    this.#id = id;
    this.#nextReq = nextReq;
  }

  /** Evaluate code in this VM, preserving global state between calls. */
  async eval(code: string): Promise<unknown> {
    await this.#ready();
    return this.#worker.eval(this.#id, this.#nextReq(), code);
  }

  async #ready(): Promise<void> {
    if (this.#disposed) throw new IsolaneError('ERR_ISOLATE_DISPOSED', 'the isolate has been disposed');
    await this.#worker.ready.catch((err: Error) => {
      const refused = /strict mode/.test(err.message);
      throw new IsolaneError(refused ? 'ERR_ISOLATION_UNAVAILABLE' : 'ERR_WORKER_CRASHED', err.message, {
        tenant: this.#worker.tenant,
      });
    });
  }

  /** @internal The isolate's last eval (Runtime.run): its timers die with it. */
  async _evalLast(code: string): Promise<unknown> {
    await this.#ready();
    return this.#worker.eval(this.#id, this.#nextReq(), code, true);
  }

  /** Free the VM's isolate. Idempotent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#worker.disposeVm(this.#id);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
