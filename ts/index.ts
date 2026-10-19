// isolane: run untrusted multi-tenant JavaScript in sandboxed V8 worker
// processes. The API mirrors clockwork's LanePool; the difference is that
// every run names a tenant, and each tenant gets its own worker process.

import { resolve as resolvePath } from 'node:path';

import { WorkerProcess, meetsStrict, type IsolationInfo, type WorkerExit, type WorkerMessage } from './worker.js';

export type { IsolationInfo, LockdownLevel } from './worker.js';

/**
 * Why an eval failed:
 * - `ERR_TIMEOUT`: `timeoutMs` elapsed. The VM stays usable.
 * - `ERR_GUEST_EXCEPTION`: the guest threw, or its result promise rejected.
 * - `ERR_MEMORY_LIMIT`: the VM exceeded `memoryLimitBytes`; it is retired.
 * - `ERR_VM_TERMINATED`: an earlier eval retired this VM; create a new one.
 * - `ERR_VM_DISPOSED`: `dispose()` was called.
 * - `ERR_NOT_SERIALIZABLE`: the completion value isn't JSON-serializable.
 * - `ERR_UNSETTLED`: the result is a promise that can never settle.
 * - `ERR_WORKER_CRASHED`: the tenant's worker process died (possibly an
 *   exploit attempt; see `onSecurityEvent`).
 * - `ERR_INTERNAL`: an isolane bug or resource failure.
 */
export type LaneErrorCode =
  | 'ERR_TIMEOUT'
  | 'ERR_GUEST_EXCEPTION'
  | 'ERR_MEMORY_LIMIT'
  | 'ERR_VM_TERMINATED'
  | 'ERR_VM_DISPOSED'
  | 'ERR_NOT_SERIALIZABLE'
  | 'ERR_UNSETTLED'
  | 'ERR_WORKER_CRASHED'
  | 'ERR_INTERNAL';

const KNOWN_CODES = new Set<string>([
  'ERR_TIMEOUT',
  'ERR_GUEST_EXCEPTION',
  'ERR_MEMORY_LIMIT',
  'ERR_VM_TERMINATED',
  'ERR_VM_DISPOSED',
  'ERR_NOT_SERIALIZABLE',
  'ERR_UNSETTLED',
  'ERR_WORKER_CRASHED',
  'ERR_INTERNAL',
]);

export class LaneError extends Error {
  readonly code: LaneErrorCode;

  constructor(code: LaneErrorCode, message: string) {
    super(message);
    this.name = 'LaneError';
    this.code = code;
  }
}

/**
 * A host function callable from guest code. Arguments and the result cross
 * as JSON; it may be async. In the guest it returns a Promise. A throw or
 * rejection rejects that Promise with an `Error` carrying the message.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HostFunction = (...args: any[]) => unknown;

export interface EvalOptions {
  /** Which tenant's worker process runs this code. Required. */
  tenant: string;
  /** Wall-clock budget per eval (and per host-reply continuation). */
  timeoutMs?: number;
  /** Cap on the V8 heap. Exceeding it retires the VM. */
  memoryLimitBytes?: number;
  /** Functions installed as guest globals, by name. */
  hostFunctions?: Record<string, HostFunction>;
}

export interface SecurityEvent {
  kind: 'worker-crash' | 'protocol-violation' | 'worker-unresponsive';
  tenant: string;
  exitCode: number | null;
  signal: string | null;
  detail?: string;
}

export interface LanePoolOptions {
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
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: LaneError): void;
  timer?: NodeJS.Timeout;
}

/**
 * The worker enforces `timeoutMs` itself; the supervisor doesn't trust it
 * to. An eval with a timeout that gets no reply by this long after its
 * worker-side deadline means a wedged or compromised worker, which is
 * killed. Generous, so a merely overloaded host isn't mistaken for one.
 */
const unresponsiveAfterMs = (timeoutMs: number) => timeoutMs + Math.max(1000, timeoutMs);

/** A tenant's worker process and the VMs and requests in flight on it. */
class TenantWorker {
  readonly tenant: string;
  #proc: WorkerProcess;
  #requests = new Map<number, Pending>();
  #hostFunctions = new Map<number, Record<string, HostFunction>>();
  #timeouts = new Map<number, number | undefined>();
  // When each VM's queued evals will have run out their timeouts: a VM runs
  // its evals one at a time, so a queued eval's clock starts after these.
  #busyUntil = new Map<number, number>();
  #vmCount = 0;
  #idleTimer: NodeJS.Timeout | undefined;
  #onGone: (exit: WorkerExit) => void;
  #idleTimeoutMs: number;

  constructor(
    tenant: string,
    workerPath: string,
    idleTimeoutMs: number,
    strict: boolean,
    onGone: (worker: TenantWorker, exit: WorkerExit) => void,
  ) {
    this.tenant = tenant;
    this.#idleTimeoutMs = idleTimeoutMs;
    this.#onGone = (exit) => onGone(this, exit);
    this.#proc = new WorkerProcess(
      workerPath,
      {
        onMessage: (msg) => this.#onMessage(msg),
        onExit: (exit) => this.#onExit(exit),
      },
      strict,
    );
  }

  get ready(): Promise<unknown> {
    return this.#proc.ready;
  }

  get pid(): number | undefined {
    return this.#proc.pid;
  }

  createVm(vm: number, opts: EvalOptions): void {
    this.#hostFunctions.set(vm, { ...(opts.hostFunctions ?? {}) });
    this.#timeouts.set(vm, opts.timeoutMs);
    this.#vmCount++;
    this.#touch();
    this.#proc.send({
      t: 'create',
      vm,
      timeoutMs: opts.timeoutMs,
      heapBytes: opts.memoryLimitBytes,
      hostFunctions: Object.keys(opts.hostFunctions ?? {}),
    });
  }

  eval(vm: number, req: number, code: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.#proc.alive) {
        reject(new LaneError('ERR_WORKER_CRASHED', `worker for tenant ${this.tenant} is gone`));
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
      this.#proc.send({ t: 'eval', vm, req, code });
    });
  }

  disposeVm(vm: number): void {
    if (!this.#hostFunctions.delete(vm)) return;
    this.#timeouts.delete(vm);
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
      this.#idleTimer = setTimeout(() => this.kill(), this.#idleTimeoutMs);
      this.#idleTimer.unref();
    }
  }

  #onMessage(msg: Exclude<WorkerMessage, { t: 'ready' }>): void {
    if (msg.t === 'result') {
      const pending = this.#requests.get(msg.req);
      if (!pending) return;
      this.#requests.delete(msg.req);
      clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.value);
      else {
        const code = KNOWN_CODES.has(msg.code) ? (msg.code as LaneErrorCode) : 'ERR_INTERNAL';
        pending.reject(new LaneError(code, msg.message));
      }
      this.#touch();
      return;
    }
    // hostCall
    const reply = (ok: boolean, value?: string, error?: string) => {
      const frame: Record<string, unknown> = { t: 'hostReply', vm: msg.vm, call: msg.call, ok };
      if (value !== undefined) frame.value = value; // JSON text; absent = undefined
      if (error !== undefined) frame.error = error;
      this.#proc.send(frame);
    };
    const fail = (err: unknown) => reply(false, undefined, err instanceof Error ? err.message : String(err));
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
    const err = new LaneError('ERR_WORKER_CRASHED', `worker for tenant ${this.tenant} ${describeExit(exit)}`);
    for (const p of this.#requests.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#requests.clear();
    this.#onGone(exit);
  }
}

function describeExit(exit: WorkerExit): string {
  if (exit.reason === 'protocol-violation') return `broke the protocol (${exit.detail})`;
  if (exit.reason === 'insufficient-isolation') return `was refused (${exit.detail})`;
  if (exit.reason === 'unresponsive') return `stopped responding and was killed (${exit.detail})`;
  if (exit.signal) return `was killed by ${exit.signal}`;
  return `exited with code ${exit.code}${exit.detail ? `: ${exit.detail}` : ''}`;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/**
 * Runs guest code in per-tenant sandboxed worker processes. Results are
 * JSON values; failures reject with a {@link LaneError}.
 */
export class LanePool {
  #workerPath: string;
  #idleTimeoutMs: number;
  #onSecurityEvent: ((e: SecurityEvent) => void) | undefined;
  #strict: boolean;
  #workers = new Map<string, TenantWorker>();
  #nextVm = 1;
  #nextReq = 1;
  #closed = false;

  constructor(options: LanePoolOptions = {}) {
    const workerPath = options.workerPath ?? process.env.ISOLANE_WORKER;
    if (!workerPath) {
      throw new Error('isolane: no worker binary (pass workerPath or set ISOLANE_WORKER)');
    }
    // Workers start in `/`, so a relative path must be resolved here.
    this.#workerPath = resolvePath(workerPath);
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#onSecurityEvent = options.onSecurityEvent;
    this.#strict = options.strict ?? process.env.NODE_ENV === 'production';
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
  async run(code: string, options: EvalOptions): Promise<unknown> {
    const vm = this.createVm(options);
    try {
      return await vm.eval(code);
    } finally {
      vm.dispose();
    }
  }

  /** Create a stateful VM on the tenant's worker. */
  createVm(options: EvalOptions): LaneVm {
    if (this.#closed) throw new Error('isolane: pool is closed');
    if (typeof options?.tenant !== 'string' || options.tenant === '') {
      throw new TypeError('isolane: options.tenant is required');
    }
    const worker = this.#workerFor(options.tenant);
    const id = this.#nextVm++;
    worker.createVm(id, options);
    return new LaneVm(worker, id, () => this.#nextReq++);
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
  }

  #workerFor(tenant: string): TenantWorker {
    let w = this.#workers.get(tenant);
    if (!w) {
      w = new TenantWorker(tenant, this.#workerPath, this.#idleTimeoutMs, this.#strict, (gone, exit) => {
        if (this.#workers.get(tenant) === gone) this.#workers.delete(tenant);
        if (exit.reason === 'killed' || exit.reason === 'insufficient-isolation') return;
        // A clean exit only happens when stdin closes; anything else from a
        // worker that ran guest code is treated as a possible exploit.
        if (exit.reason === 'protocol-violation' || exit.reason === 'unresponsive' || exit.signal || exit.code !== 0) {
          this.#onSecurityEvent?.({
            kind:
              exit.reason === 'protocol-violation'
                ? 'protocol-violation'
                : exit.reason === 'unresponsive'
                  ? 'worker-unresponsive'
                  : 'worker-crash',
            tenant,
            exitCode: exit.code,
            signal: exit.signal,
            detail: exit.detail,
          });
        }
      });
      this.#workers.set(tenant, w);
    }
    return w;
  }
}

/** A stateful VM on a tenant's worker. */
export class LaneVm {
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
    if (this.#disposed) throw new LaneError('ERR_VM_DISPOSED', 'vm has been disposed');
    await this.#worker.ready.catch((err: Error) => {
      throw new LaneError('ERR_WORKER_CRASHED', err.message);
    });
    return this.#worker.eval(this.#id, this.#nextReq(), code);
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
