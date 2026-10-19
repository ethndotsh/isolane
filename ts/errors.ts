// isolane's errors: one class, a code per failure, and a kind that says
// whose problem it is.

/**
 * Every failure has a code (`ERR_` + subject + condition):
 *
 * guest (the guest code's own doing):
 * - `ERR_GUEST_EXCEPTION`: it threw, or its result promise rejected. See `guest`.
 * - `ERR_UNSETTLED`: its result is a promise that can never settle.
 * - `ERR_NOT_SERIALIZABLE`: its completion value isn't JSON-serializable.
 * - `ERR_INVALID_RETURN`: its completion value doesn't match the `returns`
 *   schema. See `issues`.
 *
 * limit (a budget ran out):
 * - `ERR_LIMIT`: a limit was hit; `limit` names it (`timeoutMs`, `cpuMs`,
 *   `heapBytes`, `workerMemoryBytes`, `isolates`, `tenants`,
 *   `concurrentEvals`, `codeBytes`, `resultBytes`). After `heapBytes` the
 *   isolate is retired; after `workerMemoryBytes` the tenant's worker
 *   restarts on the next call; after the others the isolate stays usable.
 * - `ERR_ISOLATE_RETIRED`: an earlier failure retired this isolate; create
 *   a new one.
 *
 * usage (the calling code's mistake):
 * - `ERR_INVALID_CONFIG`: the configuration is malformed (the message names
 *   the field). Thrown synchronously.
 * - `ERR_ISOLATE_CLOSED`: the isolate was closed (or its tenant stopped).
 * - `ERR_RUNTIME_CLOSED`: the runtime was closed.
 *
 * security:
 * - `ERR_DENIED`: a `beforeEval` hook refused the eval (`reason`).
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
  ERR_LIMIT: 'limit',
  ERR_ISOLATE_RETIRED: 'limit',
  ERR_INVALID_CONFIG: 'usage',
  ERR_ISOLATE_CLOSED: 'usage',
  ERR_RUNTIME_CLOSED: 'usage',
  ERR_DENIED: 'security',
  ERR_TENANT_QUARANTINED: 'security',
  ERR_WORKER_CRASHED: 'infrastructure',
  ERR_WORKER_UNRESPONSIVE: 'infrastructure',
  ERR_WORKER_INCOMPATIBLE: 'infrastructure',
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
  /** For `ERR_DENIED`: the hook's reason. */
  reason?: string;
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
  }
}

/** `ERR_INVALID_CONFIG`, naming the field: `invalidConfig('limits.timeoutMs', 'must be ...')`. */
export const invalidConfig = (path: string, problem: string) =>
  new IsolaneError('ERR_INVALID_CONFIG', `isolane: ${path ? `${path} ` : ''}${problem}`);

/** `ERR_LIMIT` for the named limit. */
export const limitError = (limit: string, message: string, tenant?: string) =>
  new IsolaneError('ERR_LIMIT', `isolane: ${message} (limits.${limit})`, { tenant, limit });
