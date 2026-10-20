// Worker processes and what runs on them: spare workers (started, never yet
// used), and each tenant's worker with its isolates, requests in flight,
// and host calls. Everything a worker sends is checked (worker.ts); this
// module dispatches it.

import { splitBytes, type BinaryPart } from './binary.js';
import { capabilities } from './capabilities.js';
import { workerLimits, type ResolvedConfig, type ResolvedLimits, type ResolvedShims } from './config.js';
import { IsolaneError, invalidConfig, isIsolaneErrorCode, limitError, type IsolaneErrorCode } from './errors.js';
import type { HookChain } from './hooks.js';
import type { HostContext, HostEntry } from './host.js';
import {
  MAX_FRAME,
  OOM_EXIT_CODE,
  WorkerProcess,
  type LogLevel,
  type WorkerExit,
  type WorkerHandlers,
  type WorkerMessage,
  type WorkerUsage,
} from './worker.js';

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

export const emptyUsage = (): TenantUsage => ({
  evals: 0,
  failures: 0,
  cpuMs: 0,
  hostCalls: 0,
  logBytes: 0,
  peakMemoryBytes: 0,
  securityEvents: 0,
});

/**
 * The worker enforces `timeoutMs` itself; the supervisor doesn't trust it
 * to. An eval with a timeout that gets no reply by this long after its
 * worker-side deadline means a wedged or compromised worker, which is
 * killed. Generous, so a merely overloaded host isn't mistaken for one.
 */
const unresponsiveAfterMs = (timeoutMs: number) => timeoutMs + Math.max(1000, timeoutMs);

export const isOutOfMemory = (exit: WorkerExit) => exit.reason === 'exited' && exit.code === OOM_EXIT_CODE;

export function describeExit(exit: WorkerExit): string {
  if (isOutOfMemory(exit)) return 'ran out of memory (limits.workerMemoryBytes)';
  if (exit.reason === 'protocol-violation') return `broke the protocol (${exit.detail})`;
  if (exit.reason === 'incompatible') return `is incompatible (${exit.detail})`;
  if (exit.reason === 'insufficient-isolation') return `was refused (${exit.detail})`;
  if (exit.reason === 'unresponsive') return `stopped responding and was killed (${exit.detail})`;
  if (exit.signal) return `was killed by ${exit.signal}${exit.detail ? `: ${exit.detail}` : ''}`;
  return `exited with code ${exit.code}${exit.detail ? `: ${exit.detail}` : ''}`;
}

/**
 * A started worker not yet given to a tenant. It has never run guest code;
 * a tenant claims it whole, and it serves only that tenant from then on.
 * Messages go to whoever has claimed it.
 */
export class SpareWorker {
  readonly proc: WorkerProcess;
  readonly memoryBytes: number | undefined;
  handlers: WorkerHandlers | undefined;

  constructor(
    workerPath: string,
    strict: boolean,
    memoryBytes: number | undefined,
    prepareWeb: boolean,
    onExit: (s: SpareWorker) => void,
  ) {
    this.memoryBytes = memoryBytes;
    this.proc = new WorkerProcess(
      workerPath,
      {
        onMessage: (msg) => this.handlers?.onMessage(msg),
        onExit: (exit) => {
          if (this.handlers) this.handlers.onExit(exit);
          else onExit(this);
        },
      },
      strict,
      memoryBytes,
      prepareWeb,
    );
  }
}

interface Pending {
  isolate: IsolateState;
  resolve(value: unknown): void;
  reject(err: IsolaneError): void;
  timer?: NodeJS.Timeout;
  /** Re-arms `timer` from now: the worker showed it's working. */
  rearm?: () => void;
}

/** How much longer than its first deadline an eval may be kept waiting
 * by the isolate's own work ahead of it (timers, continuations), as long
 * as the worker keeps reporting it. */
const MAX_DEADLINE_EXTENSION = 10;

/** A host call in flight: its abort signal, made only if the function asks for it. */
/** One host call in flight, and its handler's context: `signal` is made on first use (most functions never ask). */
class Call implements HostContext {
  readonly tenant: string;
  readonly isolate: number;
  #chain: HookChain;
  #controller?: AbortController;
  /** Set when the call was abandoned before anything asked for the signal. */
  #abandoned?: Error;

  constructor(tenant: string, isolate: number, chain: HookChain) {
    this.tenant = tenant;
    this.isolate = isolate;
    this.#chain = chain;
  }

  get signal(): AbortSignal {
    if (!this.#controller) {
      this.#controller = new AbortController();
      if (this.#abandoned) this.#controller.abort(this.#abandoned);
    }
    return this.#controller.signal;
  }

  // A bound function, so `({ log }) => log('info', ...)` works.
  readonly log = (level: LogLevel, ...args: unknown[]): void => {
    this.#chain.emit('log', { tenant: this.tenant, isolate: this.isolate, level, message: formatArgs(args), source: 'host' });
  };

  abandon(reason: Error): void {
    this.#abandoned = reason;
    this.#controller?.abort(reason);
  }
}

/** One isolate's state on its tenant's worker. */
export interface IsolateState {
  readonly id: number;
  /** Host functions by index, as the worker names them in host calls. */
  readonly functions: readonly HostEntry[];
  readonly chain: HookChain;
  readonly timeoutMs: number | null;
  readonly codeBytes: number;
  /** The longest console line it may send (the worker cuts lines; this checks it did). */
  readonly logLineBytes: number;
  /** Log bytes it may send per second, however many evals it runs (the worker holds each eval to logBytes; this bounds a worker that doesn't). */
  readonly logBytesPerSecond: number;
  /** The current one-second window: when it started, and its bytes. */
  logWindow: { start: number; bytes: number; dropped: boolean };
  /** Async host calls it may have waiting (the worker refuses more; this checks it did). */
  readonly pendingHostCalls: number;
  readonly hostCallBytes: number;
  /** Its shims, for naming the one in an `ERR_SHIM`. */
  readonly shims: ResolvedShims;
  /** When its queued evals will have run out their timeouts (they run one at a time). */
  busyUntil: number;
  readonly calls: Map<number, Call>;
  /** The frame bytes of `calls`. */
  callBytes: number;
  readonly dispose: () => void;
}

export interface TenantWorkerOptions {
  tenant: string;
  workerPath: string;
  strict: boolean;
  /** Its tenant-level limits (isolates, concurrentEvals, workerMemoryBytes, idleMs), fixed at start. */
  limits: ResolvedLimits;
  usage: TenantUsage;
  /** The tenant's hooks (runtime, defaults, tenants(name)), for worker and limit events. */
  chain: HookChain;
  onGone: (worker: TenantWorker, exit: WorkerExit) => void;
  /** Its first isolate uses the web platform: build its snapshot right away. */
  prepareWeb: boolean;
  spare?: SpareWorker;
}

/** Longest host-function error message sent to the guest. */
const ERROR_TEXT_MAX = 64 * 1024;
const clip = (s: string) => (s.length > ERROR_TEXT_MAX ? `${s.slice(0, ERROR_TEXT_MAX)}…` : s);

const formatArgs = (args: unknown[]) =>
  args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a) ?? String(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');

/** A tenant's worker process and the isolates and requests in flight on it. */
export class TenantWorker {
  readonly tenant: string;
  readonly limits: ResolvedLimits;
  /** When it last had nothing running (for evicting idle tenants). */
  idleSince = Date.now();
  #proc: WorkerProcess;
  #requests = new Map<number, Pending>();
  #isolates = new Map<number, IsolateState>();
  #idleTimer: NodeJS.Timeout | undefined;
  #usage: TenantUsage;
  #chain: HookChain;
  #onGone: (exit: WorkerExit) => void;
  /** What in-flight evals reject with when the worker is stopped on purpose. */
  #stopped: { code: IsolaneErrorCode; why: string } | undefined;

  constructor(o: TenantWorkerOptions) {
    this.tenant = o.tenant;
    this.limits = o.limits;
    this.#usage = o.usage;
    this.#chain = o.chain;
    this.#onGone = (exit) => o.onGone(this, exit);
    const handlers: WorkerHandlers = {
      onMessage: (msg) => this.#onMessage(msg),
      onExit: (exit) => this.#onExit(exit),
    };
    if (o.spare) {
      this.#proc = o.spare.proc;
      o.spare.handlers = handlers;
    } else {
      this.#proc = new WorkerProcess(o.workerPath, handlers, o.strict, o.limits.workerMemoryBytes ?? undefined, o.prepareWeb);
    }
    this.#proc.ready.then(
      () => this.#chain.emit('worker', { tenant: this.tenant, event: 'start', pid: this.#proc.pid }),
      () => {},
    );
  }

  get ready(): Promise<unknown> {
    return this.#proc.ready;
  }

  get pid(): number | undefined {
    return this.#proc.pid;
  }

  /** No isolates and nothing in flight. */
  get idle(): boolean {
    return this.#isolates.size === 0 && this.#requests.size === 0;
  }

  #limit(limit: string, message: string, isolate?: number): IsolaneError {
    const err = limitError(limit, message, this.tenant);
    this.#chain.emit('limit', { tenant: this.tenant, isolate, limit, message: err.message });
    return err;
  }

  /** Start an isolate. Throws ERR_LIMIT (isolates) or ERR_INVALID_CONFIG (name collisions). */
  createIsolate(id: number, config: ResolvedConfig, chain: HookChain): IsolateState {
    if (this.#isolates.size >= this.limits.isolates) {
      throw this.#limit('isolates', `tenant ${this.tenant} already has ${this.limits.isolates} isolates`);
    }
    const topLevel = new Set(config.host.map((e) => e.path[0]));
    let caps;
    try {
      caps = capabilities(config, topLevel, (api, target, reason) =>
        chain.emit('policyDenial', { tenant: this.tenant, isolate: id, api, target, reason }),
      );
    } catch (err) {
      throw err instanceof TypeError ? invalidConfig('', (err as Error).message.replace(/^isolane: /, '')) : err;
    }
    const functions = [...config.host, ...caps.entries];
    const state: IsolateState = {
      id,
      functions,
      chain,
      timeoutMs: config.limits.timeoutMs,
      codeBytes: config.limits.codeBytes,
      logLineBytes: config.limits.logLineBytes,
      logBytesPerSecond: Math.max(4 * config.limits.logBytes, 4 * 1024 ** 2),
      logWindow: { start: 0, bytes: 0, dropped: false },
      pendingHostCalls: config.limits.pendingHostCalls,
      hostCallBytes: config.limits.hostCallBytes,
      shims: config.shims,
      busyUntil: 0,
      calls: new Map(),
      callBytes: 0,
      dispose: caps.dispose,
    };
    this.#isolates.set(id, state);
    this.#touch();
    this.#proc.send({
      t: 'create',
      vm: id,
      // The tenant's shared budget, as fixed when this worker started.
      limits: { ...workerLimits(config.limits), workerBackgroundMs: this.limits.workerBackgroundMs ?? undefined },
      time: config.time,
      random: config.seed === undefined ? {} : { seed: config.seed },
      eval: config.eval,
      wasm: config.wasm,
      web: config.web !== false,
      baseUrl: config.web ? config.web.baseUrl : undefined,
      functions: functions.map((f) => ({ path: f.path, sync: f.sync })),
      prelude: caps.prelude,
      shims: config.shims,
    });
    return state;
  }

  /** `last`: the isolate closes after this eval (a one-shot run), so the
   * worker drops it as soon as the result is sent and its pending timers
   * never run. */
  eval(state: IsolateState, req: number, code: string, filename: string, last = false): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.#proc.alive) {
        reject(new IsolaneError('ERR_WORKER_CRASHED', `worker for tenant ${this.tenant} is gone`, { tenant: this.tenant }));
        return;
      }
      // A frame carries at most 64 MiB: a frame the worker can't take
      // would end it as if it had crashed.
      const codeBytes = Math.min(state.codeBytes, MAX_FRAME - 64 * 1024);
      if (Buffer.byteLength(code, 'utf8') > codeBytes) {
        reject(this.#limit('codeBytes', `the code is larger than ${codeBytes} bytes`, state.id));
        return;
      }
      if (this.#requests.size >= this.limits.concurrentEvals) {
        reject(this.#limit('concurrentEvals', `tenant ${this.tenant} already has ${this.limits.concurrentEvals} evals in flight`, state.id));
        return;
      }
      const pending: Pending = { isolate: state, resolve, reject };
      const timeoutMs = state.timeoutMs;
      if (timeoutMs !== null) {
        const start = Math.max(Date.now(), state.busyUntil);
        state.busyUntil = start + timeoutMs;
        const limit = start - Date.now() + unresponsiveAfterMs(timeoutMs);
        // setTimeout takes at most 2^31 - 1 ms (a longer one fires at once);
        // a deadline past that (over 24 days) is no deadline.
        if (limit <= 2 ** 31 - 1) {
          const sent = Date.now();
          const arm = (ms: number) =>
            setTimeout(
              () => this.#proc.kill('unresponsive', `no reply to an eval ${Date.now() - sent}ms after it was sent (limits.timeoutMs ${timeoutMs})`),
              ms,
            );
          pending.timer = arm(limit);
          // The isolate's background work (a timer batch, a host call's
          // continuation: each budgeted like an eval) can run ahead of the
          // eval. The worker reports each as it finishes; that's progress, so
          // the deadline moves, up to a bound a worker can't stretch further.
          const latest = sent + limit * MAX_DEADLINE_EXTENSION;
          pending.rearm = () => {
            clearTimeout(pending.timer);
            pending.timer = arm(Math.max(0, Math.min(limit, latest - Date.now())));
          };
        }
      }
      this.#requests.set(req, pending);
      this.#touch();
      this.#proc.send(last ? { t: 'eval', vm: state.id, req, code, filename, last } : { t: 'eval', vm: state.id, req, code, filename });
    });
  }

  closeIsolate(state: IsolateState): void {
    if (!this.#isolates.delete(state.id)) return;
    // Its evals, running or queued, end now. The worker stops whatever is
    // running and drops the rest; a late result is ignored, and no eval
    // timer is left to call the worker unresponsive.
    const closed = new IsolaneError('ERR_ISOLATE_CLOSED', 'isolane: the isolate was closed', { tenant: this.tenant });
    for (const [req, p] of this.#requests) {
      if (p.isolate !== state) continue;
      this.#requests.delete(req);
      clearTimeout(p.timer);
      p.reject(closed);
    }
    this.#abandonCalls(state, new Error('the isolate was closed'));
    state.dispose();
    this.#proc.send({ t: 'dispose', vm: state.id });
    this.#touch();
  }

  /** Stop the worker; in-flight evals reject with `code`. */
  stop(code: IsolaneErrorCode = 'ERR_ISOLATE_CLOSED', why = 'was stopped'): void {
    this.#stopped ??= { code, why };
    clearTimeout(this.#idleTimer);
    this.#proc.kill();
  }

  /** Nobody waits for these calls any more: abort their signals. */
  #abandonCalls(state: IsolateState, reason: Error): void {
    for (const call of state.calls.values()) {
      call.abandon(reason);
    }
    state.calls.clear();
    state.callBytes = 0;
  }

  #touch(): void {
    clearTimeout(this.#idleTimer);
    if (this.idle) {
      this.idleSince = Date.now();
      this.#idleTimer = setTimeout(() => this.stop('ERR_ISOLATE_CLOSED', 'was stopped after being idle'), this.limits.idleMs);
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
      for (const p of this.#requests.values()) if (p.isolate.id === msg.vm) p.rearm?.();
      if (msg.limit !== undefined) {
        const state = this.#isolates.get(msg.vm);
        const message = msg.message ?? '';
        (state?.chain ?? this.#chain).emit('limit', { tenant: this.tenant, isolate: msg.vm, limit: msg.limit, message });
        // The isolate is retired: its host calls have no one waiting. (The
        // tenant's shared budget only pauses background work.)
        if (state && msg.limit !== 'workerBackgroundMs') {
          this.#abandonCalls(state, new IsolaneError('ERR_LIMIT', message, { tenant: this.tenant, limit: msg.limit }));
        }
      }
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
        const shim = code === 'ERR_SHIM' && msg.shim ? pending.isolate.shims[msg.shim.phase][msg.shim.index] : undefined;
        const err = new IsolaneError(code, msg.message, {
          tenant: this.tenant,
          guest: msg.guest,
          limit: msg.limit,
          // The filename from our own config, not the worker's word for it.
          shim: shim && msg.shim ? { phase: msg.shim.phase, index: msg.shim.index, filename: shim.filename } : undefined,
        });
        if (code === 'ERR_LIMIT') {
          this.#chain.emit('limit', { tenant: this.tenant, isolate: pending.isolate.id, limit: msg.limit ?? 'unknown', message: msg.message });
        }
        // The eval ran out of a limit: its isolate's host calls have no one
        // waiting (the worker frees their slots too).
        if (code === 'ERR_LIMIT' || code === 'ERR_ISOLATE_RETIRED') this.#abandonCalls(pending.isolate, err);
        pending.reject(err);
      }
      this.#touch();
      return;
    }
    const state = this.#isolates.get(msg.vm);
    if (msg.t === 'guestError') {
      if (state) state.chain.emit('guestError', { tenant: this.tenant, isolate: msg.vm, kind: msg.kind, error: msg.guest });
      return;
    }
    if (msg.t === 'log') {
      if (!state) return;
      // The worker cuts long lines; a worker that didn't is cut here too
      // (leaving room for the worker's own notices).
      let message = msg.message;
      const max = Math.max(state.logLineBytes, 1024);
      if (Buffer.byteLength(message) > max + 3) {
        message = `${Buffer.from(message).subarray(0, max).toString('utf8').replace(/\uFFFD$/, '')}…`;
      }
      // A worker floods only if it's compromised: past the per-second
      // bound, lines are dropped, with one notice per window.
      const now = Date.now();
      const window = state.logWindow;
      if (now - window.start >= 1000) Object.assign(window, { start: now, bytes: 0, dropped: false });
      window.bytes += Buffer.byteLength(message);
      if (window.bytes > state.logBytesPerSecond) {
        if (!window.dropped) {
          window.dropped = true;
          const notice = `[isolane] log output dropped: more than ${state.logBytesPerSecond} bytes in a second from this isolate`;
          state.chain.emit('log', { tenant: this.tenant, isolate: msg.vm, level: 'warn', message: notice, source: 'guest' });
        }
        return;
      }
      this.#usage.logBytes += message.length;
      state.chain.emit('log', { tenant: this.tenant, isolate: msg.vm, level: msg.level, message, source: 'guest' });
      return;
    }
    this.#onHostCall(state, msg);
  }

  #onHostCall(state: IsolateState | undefined, msg: Extract<WorkerMessage, { t: 'hostCall' }>): void {
    // The worker refuses a call past limits.pendingHostCalls (it counts a
    // call until its reply lands, so never fewer than here, plus one sync
    // call at a time). More means it isn't enforcing the limit.
    if (state && state.calls.size > state.pendingHostCalls) {
      this.#proc.kill('protocol-violation', `more than ${state.pendingHostCalls} host calls in flight (limits.pendingHostCalls)`);
      return;
    }
    // Likewise their bytes (limits.hostCallBytes).
    if (state && state.callBytes + msg.size > state.hostCallBytes) {
      this.#proc.kill('protocol-violation', `more than ${state.hostCallBytes} bytes of host calls in flight (limits.hostCallBytes)`);
      return;
    }
    this.#usage.hostCalls++;
    let replied = false;
    let expiry: NodeJS.Timeout | undefined;
    const reply = (ok: boolean, value?: string, err?: unknown, parts: BinaryPart[] = []) => {
      if (replied) return;
      replied = true;
      clearTimeout(expiry);
      if (state?.calls.delete(msg.call)) state.callBytes -= msg.size;
      const frame: Record<string, unknown> = { t: 'hostReply', vm: msg.vm, call: msg.call, ok };
      if (value !== undefined) frame.value = value; // JSON text; absent = undefined
      if (parts.length) frame.bin = parts.map((p) => [p.path, p.bytes.length]);
      if (!ok) {
        // Error messages can echo guest input; keep them to a size a frame takes.
        frame.error = clip(err instanceof Error ? err.message : String(err));
        // The guest sees the same class (TypeError, ...) and Node-style code.
        if (err instanceof Error && typeof err.name === 'string') frame.errorName = clip(err.name);
        const code = (err as { code?: unknown } | null)?.code;
        if (typeof code === 'string') frame.errorCode = clip(code);
      }
      this.#proc.send(
        frame,
        parts.map((p) => p.bytes),
      );
    };
    const fail = (err: unknown) => reply(false, undefined, err);
    const entry = state?.functions[msg.fn];
    if (!state || !entry) {
      fail(new Error(`host function ${msg.fn} is not available`));
      return;
    }
    const succeed = (result: unknown) => {
      // Bytes in the result (Buffers, typed arrays, ArrayBuffers) cross as
      // raw bytes and arrive as Uint8Arrays; everything else as JSON.
      let split;
      try {
        split = splitBytes(result);
      } catch (err) {
        fail(new Error(`host function ${entry.name} returned a non-JSON value: ${(err as Error).message}`));
        return;
      }
      const bytes = split.parts.reduce((n, p) => n + p.bytes.length, 0);
      if (!WorkerProcess.fits((split.json?.length ?? 0) * 3 + 1024, bytes)) {
        fail(new RangeError(`host function ${entry.name} returned more than 64 MiB`));
        return;
      }
      reply(true, split.json, undefined, split.parts);
    };
    const ctx = new Call(this.tenant, state.id, state.chain);
    state.calls.set(msg.call, ctx);
    state.callBytes += msg.size;
    // No call of yours waits much longer than the isolate's timeoutMs, even one
    // made by an eval that has returned: past it the guest's promise
    // rejects, ctx.signal aborts, and the call's slot is free again.
    // isolane's own brokers have their own timeouts (a socket read may
    // rightly wait as long as connect.limits.idleMs).
    if (state.timeoutMs !== null && !entry.internal) {
      // A second past it, so an eval's own timeout (which abandons the
      // calls itself) always comes first.
      const ms = state.timeoutMs;
      expiry = setTimeout(() => {
        const message = `host function ${entry.name} didn't settle within ${ms}ms (limits.timeoutMs)`;
        ctx.abandon(new IsolaneError('ERR_LIMIT', `isolane: ${message}`, { tenant: this.tenant, limit: 'timeoutMs' }));
        // As the guest sees a refused call: a RangeError with code ERR_LIMIT.
        fail(Object.assign(new RangeError(message), { code: 'ERR_LIMIT' }));
      }, ms + 1000);
      expiry.unref();
    }
    // The fast path: isolane's own brokers, and functions nothing intercepts.
    if (entry.internal || !state.chain.observesHostCalls) {
      let result: unknown;
      try {
        result = entry.run(ctx, msg.args);
      } catch (err) {
        fail(err);
        return;
      }
      if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
        (result as PromiseLike<unknown>).then(succeed, fail);
      } else {
        succeed(result);
      }
      return;
    }
    void this.#intercepted(state, entry, ctx, msg.args).then(succeed, fail);
  }

  /** A host call through the hooks: `beforeHostCall`s, the function, `afterHostCall`s. */
  async #intercepted(state: IsolateState, entry: HostEntry, ctx: HostContext, raw: unknown[]): Promise<unknown> {
    const event = { tenant: this.tenant, isolate: state.id, name: entry.name, args: raw };
    const before = await state.chain.beforeHostCall(event);
    if ('denied' in before) {
      throw Object.assign(new Error(`${entry.name}: denied: ${before.denied}`), { code: 'ERR_DENIED' });
    }
    const started = performance.now();
    let result: unknown;
    let error: unknown;
    try {
      result = await entry.run(ctx, before.args);
    } catch (err) {
      error = err ?? new Error('host function failed');
    }
    const outcome = { ...event, args: before.args, durationMs: performance.now() - started, ...(error === undefined ? { result } : { error }) };
    const after = await state.chain.afterHostCall(outcome);
    if (error !== undefined) throw error;
    return after;
  }

  #onExit(exit: WorkerExit): void {
    clearTimeout(this.#idleTimer);
    const oom = isOutOfMemory(exit);
    const code: IsolaneErrorCode = oom
      ? 'ERR_LIMIT'
      : exit.reason === 'unresponsive'
        ? 'ERR_WORKER_UNRESPONSIVE'
        : exit.reason === 'insufficient-isolation'
          ? 'ERR_ISOLATION_UNAVAILABLE'
          : exit.reason === 'incompatible'
            ? 'ERR_WORKER_INCOMPATIBLE'
            : exit.reason === 'killed'
              ? (this.#stopped?.code ?? 'ERR_ISOLATE_CLOSED')
              : 'ERR_WORKER_CRASHED';
    const why = exit.reason === 'killed' && this.#stopped ? this.#stopped.why : describeExit(exit);
    const err = new IsolaneError(code, `isolane: worker for tenant ${this.tenant} ${why}`, {
      tenant: this.tenant,
      limit: oom ? 'workerMemoryBytes' : undefined,
      // A fresh worker has its full memory again.
      retryable: oom ? true : undefined,
    });
    if (oom && this.#requests.size) {
      this.#chain.emit('limit', { tenant: this.tenant, limit: 'workerMemoryBytes', message: err.message });
    }
    for (const state of this.#isolates.values()) {
      this.#abandonCalls(state, err);
      state.dispose();
    }
    this.#isolates.clear();
    for (const p of this.#requests.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#requests.clear();
    this.#chain.emit('worker', {
      tenant: this.tenant,
      event: 'exit',
      pid: this.#proc.pid,
      reason: exit.reason === 'killed' ? (this.#stopped?.why ?? 'stopped') : oom ? 'out of memory' : exit.reason === 'exited' && exit.code === 0 ? 'exited' : describeExit(exit),
    });
    this.#onGone(exit);
  }
}
