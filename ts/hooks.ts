// One hook system. Interceptors (`before*`, `after*`) can refuse or change
// what happens; events (`on*`) only observe. Hooks can be set on the
// runtime, in `tenants(name)`, in `defaults`, and per call, and every
// level's run: interceptors in onion order (`before*` outermost first,
// `after*` innermost first), events at every level. `runtime.on(event, fn)`
// gets the same events.

import { invalidConfig, IsolaneError, type GuestErrorInfo } from './errors.js';
import type { LogLevel } from './worker.js';

type Awaitable<T> = T | Promise<T>;

/** A host call, before it runs. */
export interface HostCallEvent {
  tenant: string;
  /** The isolate's id. */
  isolate: number;
  /** The function's name, dotted for namespaces (`db.getUser`). */
  name: string;
  args: unknown[];
}

/** A host call, after it ran. */
export interface HostCallOutcome extends HostCallEvent {
  /** What it returned (when it didn't throw). */
  result?: unknown;
  /** What it threw, if it did. */
  error?: unknown;
  durationMs: number;
}

/** An eval, before it runs. */
export interface EvalEvent {
  tenant: string;
  isolate: number;
  code: string;
  /** The code's name in stack traces. */
  filename: string;
}

/** An eval, after it ran. */
export interface EvalOutcome extends EvalEvent {
  result?: unknown;
  error?: IsolaneError;
  durationMs: number;
}

/** A call (`isolate.call`, `program.call`), before it runs. */
export interface CallEvent {
  tenant: string;
  isolate: number;
  /** The program, for a call to one of its instances. */
  program?: number;
  /** The function called. */
  name: string;
  args: unknown[];
}

/** A call, after it ran. */
export interface CallOutcome extends CallEvent {
  result?: unknown;
  error?: IsolaneError;
  durationMs: number;
}

export interface LogEvent {
  tenant: string;
  isolate?: number;
  /** The program, when the isolate is one of its instances. */
  program?: number;
  level: LogLevel;
  message: string;
  /** `guest`: the guest's console; `host`: a host function's `ctx.log`. */
  source: 'guest' | 'host';
}

/**
 * An error the guest's code didn't handle, outside an eval's result: an
 * exception in a timer or task callback (`exception`), or a promise
 * rejected with no handler by the time its task was done (`rejection`).
 * It's also logged (`Uncaught ...`), and neither fails an eval.
 */
export interface GuestErrorEvent {
  tenant: string;
  isolate: number;
  /** The program, when the isolate is one of its instances. */
  program?: number;
  kind: 'exception' | 'rejection';
  error: GuestErrorInfo;
}

/** A limit was hit (an `ERR_LIMIT` error, from the worker or the runtime). */
export interface LimitEvent {
  tenant: string;
  isolate?: number;
  /** The program, when the isolate is one of its instances (or the limit is the program's own). */
  program?: number;
  /** Which limit: a key of `Limits` (`timeoutMs`, `isolates`, ...). */
  limit: string;
  message: string;
}

/** A fetch, connect, or fs call that its policy refused. */
export interface PolicyDenialEvent {
  tenant: string;
  isolate: number;
  /** The program, when the isolate is one of its instances. */
  program?: number;
  /** The guest API the policy governs. */
  api: 'fetch' | 'connect' | 'fs';
  /** What was refused: a URL, `host:port`, or a guest path. */
  target: string;
  reason: string;
}

/** A worker died unexpectedly or broke the protocol: possibly an exploit attempt. */
export interface SecurityEvent {
  kind: 'crash' | 'protocol' | 'unresponsive';
  tenant: string;
  /** When the tenant's quarantine ends (ms since the epoch), if it is quarantined. */
  quarantinedUntil?: number;
  /** What the worker did: the signal or exit code, and the end of its stderr. */
  detail: string;
}

/**
 * A program was loaded into one of its instances (an isolate): its
 * modules compiled and evaluated, its setup. `tenant.load()` loads the
 * first; the rest start as calls need them.
 */
export interface ProgramLoadEvent {
  tenant: string;
  program: number;
  isolate: number;
  /** The main module's path. */
  filename: string;
  durationMs: number;
  /**
   * How the program's code modules were compiled, for a load that
   * succeeded: how many, how many of them from the worker's code cache
   * (made by an earlier instance), and how many caches V8 rejected and
   * compiled from source instead.
   */
  modules?: ModulesCompiled;
  /** Why the load failed, if it did. */
  error?: IsolaneError;
}

/** How a program instance's code modules were compiled (see `ProgramLoadEvent`). */
export interface ModulesCompiled {
  compiled: number;
  cached: number;
  rejected: number;
}

/** A tenant's worker process started or exited. */
export interface WorkerEvent {
  tenant: string;
  /** `recycle`: it reached `workerLifetimeMs` or `workerEvals`; new isolates start on a fresh worker, and this one exits once it has drained. */
  kind: 'start' | 'recycle' | 'exit';
  pid?: number;
  /** For `recycle` and `exit`: why (`idle`, `stopped`, `crashed`, `out of memory`, ...). */
  reason?: string;
}

const DENY = Symbol('isolane.deny');

/** What an interceptor returns to refuse: `return deny('not on your plan')`. */
export interface Denial {
  readonly [DENY]: true;
  readonly reason: string;
}

export function deny(reason: string): Denial {
  return Object.freeze({ [DENY]: true as const, reason: String(reason) });
}

const isDenial = (v: unknown): v is Denial => v !== null && typeof v === 'object' && (v as Denial)[DENY] === true;

export interface Hooks {
  /** Before a host function runs: `deny(reason)` refuses it (the guest gets an Error, code `ERR_DENIED`); `{ args }` replaces its arguments. */
  beforeHostCall?(call: HostCallEvent): Awaitable<void | Denial | { args: unknown[] }>;
  /** After it ran: `{ result }` replaces what the guest gets (when it didn't throw). */
  afterHostCall?(call: HostCallOutcome): Awaitable<void | { result: unknown }>;
  /** Before an eval: `deny(reason)` refuses it (`ERR_DENIED`); `{ code }` replaces the code. */
  beforeEval?(event: EvalEvent): Awaitable<void | Denial | { code: string }>;
  /** After it ran: `{ result }` replaces the result (when it succeeded). */
  afterEval?(event: EvalOutcome): Awaitable<void | { result: unknown }>;
  /** Before a call: `deny(reason)` refuses it (`ERR_DENIED`); `{ args }` replaces its arguments. */
  beforeCall?(event: CallEvent): Awaitable<void | Denial | { args: unknown[] }>;
  /** After it ran: `{ result }` replaces the result (when it succeeded). */
  afterCall?(event: CallOutcome): Awaitable<void | { result: unknown }>;
  onLog?(event: LogEvent): void;
  /** An uncaught exception or unhandled rejection in guest code (see `GuestErrorEvent`). */
  onGuestError?(event: GuestErrorEvent): void;
  onLimit?(event: LimitEvent): void;
  onPolicyDenial?(event: PolicyDenialEvent): void;
  onProgramLoad?(event: ProgramLoadEvent): void;
  /** Runtime, `defaults`, and `tenants(name)` levels only (there's no call). */
  onSecurityEvent?(event: SecurityEvent): void;
  /** Runtime, `defaults`, and `tenants(name)` levels only (there's no call). */
  onWorker?(event: WorkerEvent): void;
}

/** Events `runtime.on()` delivers, by name. */
export interface RuntimeEvents {
  hostCall: HostCallOutcome;
  eval: EvalOutcome;
  call: CallOutcome;
  log: LogEvent;
  guestError: GuestErrorEvent;
  limit: LimitEvent;
  policyDenial: PolicyDenialEvent;
  programLoad: ProgramLoadEvent;
  securityEvent: SecurityEvent;
  worker: WorkerEvent;
}

const HOOK_KEYS = new Set([
  'beforeHostCall',
  'afterHostCall',
  'beforeEval',
  'afterEval',
  'beforeCall',
  'afterCall',
  'onLog',
  'onGuestError',
  'onLimit',
  'onPolicyDenial',
  'onProgramLoad',
  'onSecurityEvent',
  'onWorker',
]);

export function validateHooks(hooks: unknown, path: string): void {
  if (hooks === undefined) return;
  if (hooks === null || typeof hooks !== 'object') throw invalidConfig(path, 'must be an object');
  for (const [key, value] of Object.entries(hooks)) {
    if (!HOOK_KEYS.has(key)) throw invalidConfig(`${path}.${key}`, `is not a hook (hooks: ${[...HOOK_KEYS].join(', ')})`);
    if (value !== undefined && typeof value !== 'function') throw invalidConfig(`${path}.${key}`, 'must be a function');
  }
}

/** `runtime.on()` listeners. */
export class Emitter {
  #listeners = new Map<keyof RuntimeEvents, Set<(e: never) => void>>();

  on<K extends keyof RuntimeEvents>(event: K, listener: (e: RuntimeEvents[K]) => void): () => void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(listener as (e: never) => void);
    return () => set.delete(listener as (e: never) => void);
  }

  has(event: keyof RuntimeEvents): boolean {
    return (this.#listeners.get(event)?.size ?? 0) > 0;
  }

  emit<K extends keyof RuntimeEvents>(event: K, payload: RuntimeEvents[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of set) safely(() => (listener as (e: RuntimeEvents[K]) => void)(payload));
  }
}

/** Run an observer; one that throws must not take isolane's work down with it. */
function safely(f: () => void): void {
  try {
    f();
  } catch (err) {
    process.emitWarning(`isolane: an event listener threw: ${(err as Error)?.stack ?? err}`);
  }
}

const EVENT_HOOK = {
  log: 'onLog',
  guestError: 'onGuestError',
  limit: 'onLimit',
  policyDenial: 'onPolicyDenial',
  programLoad: 'onProgramLoad',
  securityEvent: 'onSecurityEvent',
  worker: 'onWorker',
} as const;

/**
 * Every level's hooks for one isolate (or tenant), plus the runtime's
 * listeners. Built once per isolate; the flags let the hot path skip it.
 */
export class HookChain {
  readonly levels: readonly Hooks[];
  readonly emitter: Emitter;
  /** The program whose instance this isolate is: its events say so. */
  readonly program: number | undefined;
  /** Whether host calls need the interceptor path at all. */
  readonly interceptsHostCalls: boolean;
  readonly interceptsEvals: boolean;
  readonly interceptsCalls: boolean;

  constructor(levels: readonly Hooks[], emitter: Emitter, program?: number) {
    this.levels = levels;
    this.emitter = emitter;
    this.program = program;
    this.interceptsHostCalls = levels.some((h) => h.beforeHostCall || h.afterHostCall);
    this.interceptsEvals = levels.some((h) => h.beforeEval || h.afterEval);
    this.interceptsCalls = levels.some((h) => h.beforeCall || h.afterCall);
  }

  /** Whether anything observes host-call outcomes (interceptors or listeners). */
  get observesHostCalls(): boolean {
    return this.interceptsHostCalls || this.emitter.has('hostCall');
  }

  get observesEvals(): boolean {
    return this.interceptsEvals || this.emitter.has('eval');
  }

  get observesCalls(): boolean {
    return this.interceptsCalls || this.emitter.has('call');
  }

  emit<K extends keyof typeof EVENT_HOOK>(event: K, payload: RuntimeEvents[K]): void {
    if (this.program !== undefined && !('program' in payload)) payload = { ...payload, program: this.program };
    const key = EVENT_HOOK[event];
    for (const level of this.levels) {
      const hook = level[key] as ((e: RuntimeEvents[K]) => void) | undefined;
      if (hook) safely(() => hook.call(level, payload));
    }
    this.emitter.emit(event, payload);
  }

  /** Run `beforeHostCall`s; the (possibly replaced) arguments, or a denial reason. */
  async beforeHostCall(call: HostCallEvent): Promise<{ args: unknown[] } | { denied: string }> {
    let args = call.args;
    for (const level of this.levels) {
      if (!level.beforeHostCall) continue;
      const r = await level.beforeHostCall({ ...call, args });
      if (isDenial(r)) return { denied: r.reason };
      if (r && typeof r === 'object' && Array.isArray((r as { args?: unknown }).args)) args = (r as { args: unknown[] }).args;
    }
    return { args };
  }

  /** Run `afterHostCall`s (innermost first); the (possibly replaced) result. */
  async afterHostCall(outcome: HostCallOutcome): Promise<unknown> {
    let result = outcome.result;
    for (let i = this.levels.length - 1; i >= 0; i--) {
      const level = this.levels[i];
      if (!level.afterHostCall) continue;
      const r = await level.afterHostCall({ ...outcome, result });
      if (outcome.error === undefined && r && typeof r === 'object' && 'result' in r) result = (r as { result: unknown }).result;
    }
    this.emitter.emit('hostCall', { ...outcome, result });
    return result;
  }

  async beforeEval(event: EvalEvent): Promise<{ code: string } | { denied: string }> {
    let code = event.code;
    for (const level of this.levels) {
      if (!level.beforeEval) continue;
      const r = await level.beforeEval({ ...event, code });
      if (isDenial(r)) return { denied: r.reason };
      if (r && typeof r === 'object' && typeof (r as { code?: unknown }).code === 'string') code = (r as { code: string }).code;
    }
    return { code };
  }

  async afterEval(outcome: EvalOutcome): Promise<unknown> {
    let result = outcome.result;
    for (let i = this.levels.length - 1; i >= 0; i--) {
      const level = this.levels[i];
      if (!level.afterEval) continue;
      const r = await level.afterEval({ ...outcome, result });
      if (outcome.error === undefined && r && typeof r === 'object' && 'result' in r) result = (r as { result: unknown }).result;
    }
    this.emitter.emit('eval', { ...outcome, result });
    return result;
  }

  async beforeCall(event: CallEvent): Promise<{ args: unknown[] } | { denied: string }> {
    let args = event.args;
    for (const level of this.levels) {
      if (!level.beforeCall) continue;
      const r = await level.beforeCall({ ...event, args });
      if (isDenial(r)) return { denied: r.reason };
      if (r && typeof r === 'object' && Array.isArray((r as { args?: unknown }).args)) args = (r as { args: unknown[] }).args;
    }
    return { args };
  }

  async afterCall(outcome: CallOutcome): Promise<unknown> {
    let result = outcome.result;
    for (let i = this.levels.length - 1; i >= 0; i--) {
      const level = this.levels[i];
      if (!level.afterCall) continue;
      const r = await level.afterCall({ ...outcome, result });
      if (outcome.error === undefined && r && typeof r === 'object' && 'result' in r) result = (r as { result: unknown }).result;
    }
    this.emitter.emit('call', { ...outcome, result });
    return result;
  }
}
