// isolane's errors: one class, a code per failure, and a kind that says
// whose problem it is.

/**
 * Every failure has a code:
 *
 * guest (the guest code's own doing):
 * - `ERR_GUEST_EXCEPTION`: it threw, or its result promise rejected. See `guest`.
 * - `ERR_UNSETTLED`: its result is a promise that can never settle.
 * - `ERR_NOT_SERIALIZABLE`: its completion value isn't JSON-serializable.
 *
 * limit (a budget ran out):
 * - `ERR_TIMEOUT`: `timeoutMs` elapsed. The isolate stays usable.
 * - `ERR_CPU_LIMIT`: the eval used more than `cpuTimeLimitMs` of CPU time
 *   (Linux). The isolate stays usable.
 * - `ERR_MEMORY_LIMIT`: the isolate exceeded `memoryLimitBytes` (it is
 *   retired), or the tenant's worker exceeded `workerMemoryLimitBytes` (it
 *   restarts on the next call).
 * - `ERR_ISOLATE_RETIRED`: an earlier failure retired this isolate; create
 *   a new one.
 *
 * usage (the calling code's mistake):
 * - `ERR_INVALID_OPTION`: an option is malformed. Thrown synchronously.
 * - `ERR_ISOLATE_DISPOSED`: `dispose()` was called.
 * - `ERR_RUNTIME_CLOSED`: `close()` was called.
 *
 * security:
 * - `ERR_TENANT_QUARANTINED`: the tenant's worker had a security event
 *   recently (see `quarantineMs`), so the runtime refuses it for now.
 *
 * infrastructure (the worker or the host):
 * - `ERR_WORKER_CRASHED`: the tenant's worker process died. It may mean an
 *   exploit attempt; see `onSecurityEvent`.
 * - `ERR_WORKER_UNRESPONSIVE`: the worker stopped answering and was killed.
 * - `ERR_ISOLATION_UNAVAILABLE`: strict mode refused this host's isolation.
 * - `ERR_INTERNAL`: an isolane bug.
 */
export type IsolaneErrorCode =
  | 'ERR_GUEST_EXCEPTION'
  | 'ERR_UNSETTLED'
  | 'ERR_NOT_SERIALIZABLE'
  | 'ERR_TIMEOUT'
  | 'ERR_CPU_LIMIT'
  | 'ERR_MEMORY_LIMIT'
  | 'ERR_ISOLATE_RETIRED'
  | 'ERR_INVALID_OPTION'
  | 'ERR_ISOLATE_DISPOSED'
  | 'ERR_RUNTIME_CLOSED'
  | 'ERR_TENANT_QUARANTINED'
  | 'ERR_WORKER_CRASHED'
  | 'ERR_WORKER_UNRESPONSIVE'
  | 'ERR_ISOLATION_UNAVAILABLE'
  | 'ERR_INTERNAL';

export type IsolaneErrorKind = 'guest' | 'limit' | 'usage' | 'security' | 'infrastructure';

const KINDS: Record<IsolaneErrorCode, IsolaneErrorKind> = {
  ERR_GUEST_EXCEPTION: 'guest',
  ERR_UNSETTLED: 'guest',
  ERR_NOT_SERIALIZABLE: 'guest',
  ERR_TIMEOUT: 'limit',
  ERR_CPU_LIMIT: 'limit',
  ERR_MEMORY_LIMIT: 'limit',
  ERR_ISOLATE_RETIRED: 'limit',
  ERR_INVALID_OPTION: 'usage',
  ERR_ISOLATE_DISPOSED: 'usage',
  ERR_RUNTIME_CLOSED: 'usage',
  ERR_TENANT_QUARANTINED: 'security',
  ERR_WORKER_CRASHED: 'infrastructure',
  ERR_WORKER_UNRESPONSIVE: 'infrastructure',
  ERR_ISOLATION_UNAVAILABLE: 'infrastructure',
  ERR_INTERNAL: 'infrastructure',
};

/** Failures where running the same code again, unchanged, may succeed. */
const RETRYABLE = new Set<IsolaneErrorCode>(['ERR_WORKER_CRASHED', 'ERR_WORKER_UNRESPONSIVE']);

export function isIsolaneErrorCode(code: unknown): code is IsolaneErrorCode {
  return typeof code === 'string' && Object.hasOwn(KINDS, code);
}

/** What the guest threw, for `ERR_GUEST_EXCEPTION`. */
export interface GuestErrorInfo {
  /** `error.name`, when the guest threw an object that has one. */
  name?: string;
  /** `error.message`, or the thrown value as a string. */
  message: string;
  stack?: string;
}

export interface IsolaneErrorDetails {
  tenant?: string;
  guest?: GuestErrorInfo;
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

  constructor(code: IsolaneErrorCode, message: string, details: IsolaneErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'IsolaneError';
    this.code = code;
    this.kind = KINDS[code];
    this.retryable = details.retryable ?? RETRYABLE.has(code);
    if (details.tenant !== undefined) this.tenant = details.tenant;
    if (details.guest !== undefined) this.guest = details.guest;
  }
}

/** `ERR_INVALID_OPTION`, thrown while validating options. */
export const invalidOption = (message: string) => new IsolaneError('ERR_INVALID_OPTION', `isolane: ${message}`);
