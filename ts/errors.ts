// isolane's errors: one class, a code per failure, and a kind that says
// whose problem it is.

/**
 * Every failure has a code (`ERR_` + subject + condition):
 *
 * guest (the guest code's own doing):
 * - `ERR_GUEST_EXCEPTION`: it threw, or its result promise rejected. See `guest`.
 * - `ERR_HANDLER_NOT_FOUND`: `isolate.call(name)` named no function the
 *   isolate's code defined.
 * - `ERR_UNSETTLED`: its result is a promise that can never settle.
 * - `ERR_NOT_SERIALIZABLE`: its completion value isn't JSON-serializable.
 * - `ERR_INVALID_RETURN`: its completion value doesn't match the `returns`
 *   schema. See `issues`.
 *
 * limit (a budget ran out):
 * - `ERR_LIMIT`: a limit was hit; `limit` names it:
 *   - isolate limits: `timeoutMs`, `cpuMs`, `heapBytes`, `backgroundMs`,
 *     `codeBytes`, `resultBytes`, `pendingHostCalls`, `hostCalls`,
 *     `pendingHostCallBytes`;
 *   - tenant limits: `isolates`, `pendingEvals`, `workerMemoryBytes`;
 *   - the runtime's: `tenants`.
 *   After `timeoutMs`, `cpuMs`, `heapBytes`, and `backgroundMs` the
 *   isolate is retired (an eval stopped part-way may have left its state
 *   half-updated); after `workerMemoryBytes` the tenant's worker restarts
 *   on the next call; after the others the isolate stays usable. Some
 *   limits don't fail the eval: `timers` throws a RangeError in the guest,
 *   `decompressedBytes` errors the stream, the log limits truncate output,
 *   and the policies' limits (`fetch.limits.requests`, ...) fail the
 *   guest's call. All of them emit `onLimit`.
 * - `ERR_ISOLATE_RETIRED`: an earlier failure retired this isolate (an
 *   eval that was stopped part-way, by a limit or its signal, or one that
 *   ran out of memory), or a recycle did. Retryable: create a new one.
 *
 * usage (the calling code's doing):
 * - `ERR_INVALID_CONFIG`: the configuration is malformed (the message names
 *   the field). Thrown synchronously.
 * - `ERR_ISOLATE_CLOSED`: the isolate was closed (or its tenant stopped).
 * - `ERR_RUNTIME_CLOSED`: the runtime was closed.
 * - `ERR_ABORTED`: the eval's `signal` was aborted (`reason`). An eval
 *   stopped while it ran retires its isolate; one that hadn't started
 *   doesn't.
 * - `ERR_SHIM`: one of the embedder's `shims` threw (or, for `after`,
 *   rejected or never settled). See `shim`; the message has its error.
 * - `ERR_DENIED`: a `beforeEval` or `beforeCall` hook refused it (`reason`). (A
 *   `beforeHostCall` denial reaches the guest as an error with this
 *   `code`, and doesn't fail the eval.)
 *
 * security:
 * - `ERR_TENANT_QUARANTINED`: the tenant's worker had a security event
 *   recently (see `quarantineMs`), so the runtime refuses it for now.
 *
 * infrastructure (the worker or the host):
 * - `ERR_WORKER_CRASHED`: the tenant's worker process died. It may mean an
 *   exploit attempt; see `onSecurityEvent`.
 * - `ERR_WORKER_UNRESPONSIVE`: the worker stopped answering and was killed.
 * - `ERR_WORKER_INCOMPATIBLE`: the worker binary speaks another protocol
 *   version than this library.
 * - `ERR_ISOLATION_UNAVAILABLE`: strict mode refused this host's isolation.
 * - `ERR_INTERNAL`: an isolane bug.
 */
export type IsolaneErrorCode =
  | 'ERR_GUEST_EXCEPTION'
  | 'ERR_UNSETTLED'
  | 'ERR_NOT_SERIALIZABLE'
  | 'ERR_INVALID_RETURN'
  | 'ERR_LIMIT'
  | 'ERR_ISOLATE_RETIRED'
  | 'ERR_INVALID_CONFIG'
  | 'ERR_ISOLATE_CLOSED'
  | 'ERR_RUNTIME_CLOSED'
  | 'ERR_SHIM'
  | 'ERR_ABORTED'
  | 'ERR_HANDLER_NOT_FOUND'
  | 'ERR_DENIED'
  | 'ERR_TENANT_QUARANTINED'
  | 'ERR_WORKER_CRASHED'
  | 'ERR_WORKER_UNRESPONSIVE'
  | 'ERR_WORKER_INCOMPATIBLE'
  | 'ERR_ISOLATION_UNAVAILABLE'
  | 'ERR_INTERNAL';

export type IsolaneErrorKind = 'guest' | 'limit' | 'usage' | 'security' | 'infrastructure';

const KINDS: Record<IsolaneErrorCode, IsolaneErrorKind> = {
  ERR_GUEST_EXCEPTION: 'guest',
  ERR_UNSETTLED: 'guest',
  ERR_NOT_SERIALIZABLE: 'guest',
  ERR_INVALID_RETURN: 'guest',
  ERR_HANDLER_NOT_FOUND: 'guest',
  ERR_LIMIT: 'limit',
  ERR_ISOLATE_RETIRED: 'limit',
  ERR_INVALID_CONFIG: 'usage',
  ERR_ISOLATE_CLOSED: 'usage',
  ERR_RUNTIME_CLOSED: 'usage',
  ERR_SHIM: 'usage',
  ERR_ABORTED: 'usage',
  ERR_DENIED: 'usage',
  ERR_TENANT_QUARANTINED: 'security',
  ERR_WORKER_CRASHED: 'infrastructure',
  ERR_WORKER_UNRESPONSIVE: 'infrastructure',
  ERR_WORKER_INCOMPATIBLE: 'infrastructure',
  ERR_ISOLATION_UNAVAILABLE: 'infrastructure',
  ERR_INTERNAL: 'infrastructure',
};

/** Failures where running the same code again, unchanged, may succeed. */
const RETRYABLE = new Set<IsolaneErrorCode>(['ERR_WORKER_CRASHED', 'ERR_WORKER_UNRESPONSIVE', 'ERR_ISOLATE_RETIRED']);

export function isIsolaneErrorCode(code: unknown): code is IsolaneErrorCode {
  return typeof code === 'string' && Object.hasOwn(KINDS, code);
}

/**
 * What the guest threw, for `ERR_GUEST_EXCEPTION` (and `onGuestError`).
 * Every part is bounded: long text is cut (with `…`), and causes and an
 * AggregateError's errors only go so deep.
 */
export interface GuestErrorInfo {
  /** `error.name`, when the guest threw an object that has one. */
  name?: string;
  /** `error.message`, or the thrown value as a string. */
  message: string;
  /**
   * `error.stack`, without isolane's own frames (its built-in scripts,
   * `ext:` and `isolane:`). For code that didn't compile: where, the
   * source line, and a caret, then the error.
   */
  stack?: string;
  /** The stack's frames, innermost first (empty when there are none). */
  frames: GuestStackFrame[];
  /** Where code failed to compile (a SyntaxError in the code itself). */
  location?: GuestErrorLocation;
  /** `error.cause`, described the same way. */
  cause?: GuestErrorInfo;
  /** An AggregateError's `errors`. */
  errors?: GuestErrorInfo[];
  /** The error's own enumerable properties whose values are JSON (`code`, ...). */
  properties?: Record<string, unknown>;
}

/** One stack frame: `at handler (src/index.js:12:5)`. */
export interface GuestStackFrame {
  /** The function (`handler`, `Foo.bar`, `new Foo`), or null at the top level. */
  function: string | null;
  /** The script's name (`src/index.js`, `acme/eval-1.js`), `<host>` for a host function, `<anonymous>`, or `native`. */
  file: string | null;
  /** 1-based; null when the frame has no position (a host function). */
  line: number | null;
  column: number | null;
  /** An `await` resumed it (`at async handler (...)`). */
  async?: true;
}

/** A place in guest code (1-based). */
export interface GuestErrorLocation {
  file: string;
  line: number;
  column: number;
  /** The line (a window around the column, for long lines) and a caret under it. */
  sourceLine?: string;
}

/** Which shim failed, for `ERR_SHIM`. */
export interface ShimErrorInfo {
  phase: 'setup' | 'before' | 'after';
  /** Its position in that phase's resolved list (in run order). */
  index: number;
  /** Its name in stack traces: the one given, or `shim:<level>.<phase>.<n>`. */
  filename: string;
}

/** A schema issue (Standard Schema), for `ERR_INVALID_RETURN`. */
export interface SchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<unknown>;
}

export interface IsolaneErrorDetails {
  tenant?: string;
  /** For `ERR_LIMIT`: which limit (a key of `Limits`). */
  limit?: string;
  guest?: GuestErrorInfo;
  issues?: ReadonlyArray<SchemaIssue>;
  /** For `ERR_DENIED`: the hook's reason; for `ERR_ABORTED`: the signal's. */
  reason?: string;
  shim?: ShimErrorInfo;
  /** Overrides the default for the code (worker-level memory limits are retryable). */
  retryable?: boolean;
  cause?: unknown;
}

export class IsolaneError extends Error {
  readonly code: IsolaneErrorCode;
  readonly kind: IsolaneErrorKind;
  /** Running the same code again may succeed (on a fresh worker). */
  readonly retryable: boolean;
  /** The tenant the failure happened in, when there is one. */
  readonly tenant?: string;
  /** What the guest threw, for `ERR_GUEST_EXCEPTION`. */
  readonly guest?: GuestErrorInfo;
  /** For `ERR_LIMIT`: which limit was hit. */
  readonly limit?: string;
  /** For `ERR_INVALID_RETURN`: the schema's issues (Standard Schema). */
  readonly issues?: ReadonlyArray<SchemaIssue>;
  /** For `ERR_DENIED`: why. */
  readonly reason?: string;
  /** For `ERR_SHIM`: which shim. */
  readonly shim?: ShimErrorInfo;

  constructor(code: IsolaneErrorCode, message: string, details: IsolaneErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'IsolaneError';
    this.code = code;
    this.kind = KINDS[code];
    this.retryable = details.retryable ?? RETRYABLE.has(code);
    if (details.tenant !== undefined) this.tenant = details.tenant;
    if (details.guest !== undefined) this.guest = details.guest;
    if (details.limit !== undefined) this.limit = details.limit;
    if (details.issues !== undefined) this.issues = details.issues;
    if (details.reason !== undefined) this.reason = details.reason;
    if (details.shim !== undefined) this.shim = details.shim;
  }
}

/** `ERR_INVALID_CONFIG`, naming the field: `invalidConfig('limits.timeoutMs', 'must be ...')`. */
export const invalidConfig = (path: string, problem: string) =>
  new IsolaneError('ERR_INVALID_CONFIG', `isolane: ${path ? `${path} ` : ''}${problem}`);

/** `ERR_LIMIT` for the named limit. */
export const limitError = (limit: string, message: string, tenant?: string) =>
  new IsolaneError('ERR_LIMIT', `isolane: ${message} (limits.${limit})`, { tenant, limit });

// ---- guest errors from the worker ----

/** Frames from isolane's own scripts: the web platform (`ext:`), and the
 * runtime and prelude (`isolane:`). Not the guest's to act on. */
const isInternalFile = (file: string | null) => file !== null && (file.startsWith('ext:') || file.startsWith('isolane:'));

const MAX_FRAMES = 64;

/**
 * One V8 stack line (`    at fn (file:1:2)`, `    at file:1:2`,
 * `    at async fn (file:1:2)`, `    at eval (eval at f (file:1:2), <anonymous>:1:1)`).
 */
export function parseFrame(line: string): GuestStackFrame | null {
  const m = /^\s*at (.*)$/.exec(line);
  if (!m) return null;
  let rest = m[1];
  let async = false;
  if (rest.startsWith('async ')) {
    async = true;
    rest = rest.slice(6);
  }
  let fn: string | null = null;
  let loc = rest;
  if (rest.endsWith(')')) {
    // The location is the last parenthesized group (eval origins nest).
    let depth = 0;
    for (let i = rest.length - 1; i >= 0; i--) {
      if (rest[i] === ')') depth++;
      else if (rest[i] === '(' && --depth === 0) {
        if (i > 0) {
          fn = rest.slice(0, i).trimEnd() || null;
          loc = rest.slice(i + 1, -1);
        }
        break;
      }
    }
  }
  const pos = /^(.*):(\d+):(\d+)$/.exec(loc);
  const frame: GuestStackFrame = pos
    ? { function: fn, file: pos[1], line: Number(pos[2]), column: Number(pos[3]) }
    : { function: fn, file: loc || null, line: null, column: null };
  if (async) frame.async = true;
  return frame;
}

/** A stack without isolane's own frames, and its frames parsed. */
function stackFrames(stack: string | undefined): { stack: string | undefined; frames: GuestStackFrame[] } {
  if (stack === undefined) return { stack, frames: [] };
  const frames: GuestStackFrame[] = [];
  const kept: string[] = [];
  for (const line of stack.split('\n')) {
    const frame = parseFrame(line);
    if (frame && isInternalFile(frame.file)) continue;
    if (frame && frames.length < MAX_FRAMES) frames.push(frame);
    kept.push(line);
  }
  return { stack: kept.join('\n'), frames };
}

const MAX_DEPTH = 8;
const MAX_ERRORS = 16;

/** A worker's description of a guest error, shape-checked (the worker may be compromised). */
export function parseGuestError(raw: unknown, depth = 0): GuestErrorInfo | undefined {
  if (raw === null || typeof raw !== 'object' || depth >= MAX_DEPTH) return undefined;
  const g = raw as Record<string, unknown>;
  if (typeof g.message !== 'string') return undefined;
  const { stack, frames } = stackFrames(typeof g.stack === 'string' ? g.stack : undefined);
  const info: GuestErrorInfo = { message: g.message, frames };
  if (typeof g.name === 'string') info.name = g.name;
  if (stack !== undefined) info.stack = stack;
  const l = g.location as Record<string, unknown> | null | undefined;
  if (l && typeof l === 'object' && typeof l.file === 'string' && isPosInt(l.line) && isPosInt(l.column)) {
    info.location = { file: l.file, line: l.line, column: l.column };
    if (typeof l.sourceLine === 'string') info.location.sourceLine = l.sourceLine;
  }
  const cause = parseGuestError(g.cause, depth + 1);
  if (cause) info.cause = cause;
  if (Array.isArray(g.errors)) {
    info.errors = g.errors
      .slice(0, MAX_ERRORS)
      .map((e) => parseGuestError(e, depth + 1))
      .filter((e): e is GuestErrorInfo => e !== undefined);
  }
  if (g.properties !== null && typeof g.properties === 'object' && !Array.isArray(g.properties)) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(g.properties)) if (k !== '__proto__') props[k] = v;
    if (Object.keys(props).length) info.properties = props;
  }
  return info;
}

const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** `ERR_ABORTED` for an eval whose `signal` was aborted. */
export function abortedError(signal: AbortSignal, tenant: string): IsolaneError {
  const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'aborted');
  return new IsolaneError('ERR_ABORTED', `isolane: the eval was aborted: ${reason}`, { tenant, reason, cause: signal.reason });
}
