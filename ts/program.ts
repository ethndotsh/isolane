// Programs: code loaded once for a tenant (an ES module), and the pool of
// instances (isolates that have evaluated it) its calls run in. Instances
// are warm by default: each serves call after call (one at a time, or up
// to `concurrency` at once), so the module's state persists between them;
// `reuse: false` gives every call a fresh one. The pool starts instances as
// calls need them, up to `max`, queues the rest (at most `queue` of them,
// for up to `queueMs`), replaces an instance that was retired, and closes
// idle ones after `idleMs`, down to `min`, once their `ctx.waitUntil` work
// is done.

import { IsolaneError, abortedError, invalidConfig } from './errors.js';
import type { HookChain, ModulesCompiled } from './hooks.js';
import type { StandardSchemaV1 } from './schema.js';
import type { ModuleOptionsWire, WorkerUsage } from './worker.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySchema = StandardSchemaV1<any, any>;
type ResultOf<S> = S extends AnySchema ? StandardSchemaV1.InferOutput<S> : unknown;

/** Load a program into an isolate (internal to Isolate). */
export const LOAD = Symbol('load');
/** Whether an isolate can take another call (internal to Isolate). */
export const USABLE = Symbol('usable');
/** Be told what an isolate's work costs (internal to Isolate). */
export const OBSERVE = Symbol('observe');
/** Call the program's fetch handler in an isolate (internal to Isolate). */
export const FETCH = Symbol('fetch');
/** Wait for an isolate's `ctx.waitUntil` work (internal to Isolate). */
export const DRAIN = Symbol('drain');

/** A program's files: module sources (or other files: JSON, text, bytes) by path. */
export type ProgramFiles = Record<string, string | Uint8Array>;

/** What a program needs of an isolate. */
export interface Instance {
  readonly id: number;
  readonly tenant: string;
  call<S extends AnySchema | undefined = undefined>(name: string, args?: readonly unknown[], options?: { returns?: S; signal?: AbortSignal }): Promise<ResultOf<S>>;
  close(): void;
  [LOAD](main: string, files: Readonly<ProgramFiles>, options: ModuleOptionsWire): Promise<unknown>;
  [FETCH](request: Request, signal: AbortSignal | undefined): Promise<{ response: Response; waiting: number }>;
  [DRAIN](): Promise<void>;
  readonly [USABLE]: boolean;
  [OBSERVE](onUsage: (usage: WorkerUsage) => void): void;
}

/** How a program's instances are kept. */
export interface InstancesOptions {
  /**
   * Keep instances warm: each serves call after call, so module state
   * persists between them. Default true. `false`: every call gets a fresh
   * instance, used once (for end users who must not share state).
   */
  reuse?: boolean;
  /** Instances kept loaded and ready, even when idle. Default 0. */
  min?: number;
  /** Most instances at once. Default 4. */
  max?: number;
  /**
   * Calls one instance runs at once (only with `reuse`). Default 1: each
   * call has the instance to itself, and `limits.cpuMs` and the other
   * per-eval limits are its own. Above 1 they are the instance's, shared
   * by the calls in it (see the guide).
   */
  concurrency?: number;
  /** Close an instance idle this long, while there are more than `min`. Default 30 s. */
  idleMs?: number;
  /** Most calls waiting for an instance at once; another fails with `ERR_LIMIT` (`instances.queue`). Default 1,000. */
  queue?: number;
  /** Longest a call waits for a free instance; then it fails with `ERR_LIMIT` (`instances.queueMs`). Default 10 s. */
  queueMs?: number;
}

export interface ResolvedInstances {
  readonly reuse: boolean;
  readonly min: number;
  readonly max: number;
  readonly concurrency: number;
  readonly idleMs: number;
  readonly queue: number;
  readonly queueMs: number;
}

const INSTANCE_DEFAULTS: ResolvedInstances = Object.freeze({ reuse: true, min: 0, max: 4, concurrency: 1, idleMs: 30_000, queue: 1_000, queueMs: 10_000 });
const INSTANCE_KEYS = new Set(Object.keys(INSTANCE_DEFAULTS));
const MAX_MS = 2 ** 31 - 1;

export function resolveInstances(options: unknown): ResolvedInstances {
  if (options === undefined) return INSTANCE_DEFAULTS;
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw invalidConfig('instances', 'must be an object');
  const o = options as Record<string, unknown>;
  for (const key of Object.keys(o)) if (!INSTANCE_KEYS.has(key)) throw invalidConfig(`instances.${key}`, `is not an instances field (fields: ${[...INSTANCE_KEYS].join(', ')})`);
  if (o.reuse !== undefined && typeof o.reuse !== 'boolean') throw invalidConfig('instances.reuse', 'must be a boolean');
  const int = (key: string, min: number, max: number) => {
    const v = o[key];
    if (v === undefined) return INSTANCE_DEFAULTS[key as keyof ResolvedInstances] as number;
    if (!(Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max)) throw invalidConfig(`instances.${key}`, `must be an integer from ${min} to ${max}`);
    return v as number;
  };
  const resolved = {
    reuse: (o.reuse as boolean | undefined) ?? INSTANCE_DEFAULTS.reuse,
    min: int('min', 0, 10_000),
    max: int('max', 1, 10_000),
    concurrency: int('concurrency', 1, 1_000),
    idleMs: int('idleMs', 1, MAX_MS),
    queue: int('queue', 0, 1_000_000),
    queueMs: int('queueMs', 0, MAX_MS),
  };
  if (resolved.min > resolved.max) throw invalidConfig('instances.min', `must be at most instances.max (${resolved.max})`);
  if (resolved.concurrency > 1 && !resolved.reuse) throw invalidConfig('instances.concurrency', 'must be 1 with reuse off (a fresh instance serves one call)');
  return Object.freeze(resolved);
}

/** `ERR_LIMIT` for one of the pool's limits (`instances.queue`, `instances.queueMs`: not `limits` fields). */
const poolLimit = (limit: string, message: string, tenant: string) => new IsolaneError('ERR_LIMIT', `isolane: ${message}`, { tenant, limit });

/** What a program has used. Worker-reported, as `tenant.usage()` is. */
export interface ProgramUsage {
  /** Calls made (those that ran, and those refused or stopped), and how many failed. `fetch` calls count too. */
  calls: number;
  failures: number;
  /** Instances loaded so far, and how many failed to load. */
  loads: number;
  loadFailures: number;
  /** Instances live now, and how many of them are running a call. */
  instances: number;
  busy: number;
  /** Calls waiting for an instance now. */
  queued: number;
  /** CPU time of its instances (setup, calls, and work between them); Linux only (0 elsewhere). */
  cpuMs: number;
}

/** The worker's account of a load's compiling, if it's well formed. */
function modulesCompiled(value: unknown): ModulesCompiled | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { compiled, cached, rejected } = value as Record<string, unknown>;
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  return count(compiled) && count(cached) && count(rejected) ? { compiled, cached, rejected } : undefined;
}

/** One instance and what the pool knows of it. */
interface Slot {
  readonly instance: Instance;
  /** Calls running in it now. */
  active: number;
  /** Calls it has served (a fresh instance, with reuse off, serves one). */
  served: number;
  /** Its `ctx.waitUntil` promises still running, as of its last fetch: closing it waits for them. */
  waiting: number;
  idleTimer?: NodeJS.Timeout;
}

/** A call waiting for an instance. */
interface Waiter {
  resolve(slot: Slot): void;
  reject(err: IsolaneError): void;
  timer?: NodeJS.Timeout;
}

export interface ProgramInit {
  id: number;
  tenant: string;
  main: string;
  files: Readonly<ProgramFiles>;
  /** How its modules are resolved and transformed. */
  options: ModuleOptionsWire;
  instances: ResolvedInstances;
  /** Whether its instances have the web platform (program.fetch needs Request and Response). */
  web: boolean;
  /** A new isolate for an instance (it may throw: limits, quarantine, a closed runtime). */
  create: () => Instance;
  /** The tenant's hooks, for `programLoad` and pool limits. */
  chain: HookChain;
}

/**
 * A program loaded for a tenant: `tenant.load(source, options)`. Calls run
 * in its instances; it is immutable (a new version is another `load`).
 */
export class Program {
  readonly tenant: string;
  readonly id: number;
  #main: string;
  #files: Readonly<ProgramFiles>;
  #modules: ModuleOptionsWire;
  #options: ResolvedInstances;
  #web: boolean;
  #create: () => Instance;
  #chain: HookChain;
  #slots = new Set<Slot>();
  /** Instances being loaded, and being drained (waiting for `ctx.waitUntil` work) before they close. */
  #starting = 0;
  #draining = 0;
  #queue: Waiter[] = [];
  #closed = false;
  /** Settles once every call in flight is done (set by close()). */
  #drained?: Promise<void>;
  #onDrained?: () => void;
  #usage: Omit<ProgramUsage, 'instances' | 'busy' | 'queued'> = { calls: 0, failures: 0, loads: 0, loadFailures: 0, cpuMs: 0 };

  /** @internal Use `tenant.load()`. */
  constructor(init: ProgramInit) {
    this.tenant = init.tenant;
    this.id = init.id;
    this.#main = init.main;
    this.#files = init.files;
    this.#modules = init.options;
    this.#options = init.instances;
    this.#web = init.web;
    this.#create = init.create;
    this.#chain = init.chain;
  }

  /** @internal Load the first instance: its failure is the load's. */
  async start(): Promise<void> {
    this.#offer(await this.#start());
  }

  /**
   * Call a handler the program exports: a named export, or else a method
   * of its default export (`export default { fetch }`), called with the
   * default export as `this`. Arguments and the result are JSON values, or
   * bytes at the top level, as for `isolate.call`. The call runs in a free
   * instance (or a new one, up to `instances.max`; or waits, up to
   * `instances.queueMs`), budgeted as an eval. A handler that throws
   * rejects with `ERR_GUEST_EXCEPTION` and its instance stays in service;
   * a call stopped part-way retires its instance, which is replaced.
   */
  call<S extends AnySchema | undefined = undefined>(
    name: string,
    args: readonly unknown[] = [],
    options: { returns?: S; signal?: AbortSignal } = {},
  ): Promise<ResultOf<S>> {
    if (options === null || typeof options !== 'object') throw invalidConfig('options', 'must be an object');
    const signal = options.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw invalidConfig('signal', 'must be an AbortSignal');
    return this.#invoke(signal, (instance) => instance.call(name, args, options));
  }

  /**
   * Send a request to the program's fetch handler, as Workers does:
   * `fetch(request, env, ctx)`, a named export or a method of the default
   * export, given a spec Request, the program's `env`, and a `ctx` with
   * `waitUntil(promise)`. Takes what the global `fetch` takes, and resolves
   * to the handler's Response. Both bodies are buffered whole, at most
   * `limits.bodyBytes` each. The request's `signal` stops the call (as an
   * eval's signal does). A handler that throws, or returns anything but a
   * Response, rejects with `ERR_GUEST_EXCEPTION`.
   */
  async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
    this.#checkOpen();
    if (!this.#web) throw invalidConfig('web', 'program.fetch needs the web platform (its Request and Response), which web: false turns off');
    let request: Request;
    let again: Request;
    try {
      request = input instanceof Request && init === undefined ? input : new Request(input, init);
      // A retry (see #invoke) sends the request again: keep its body for it.
      again = request.body === null ? request : request.clone();
    } catch (err) {
      throw invalidConfig('request', (err as Error).message);
    }
    let attempts = 0;
    return this.#invoke(request.signal, async (instance, slot) => {
      const { response, waiting } = await instance[FETCH](attempts++ === 0 ? request : again, request.signal);
      slot.waiting = waiting;
      return response;
    }).finally(() => {
      if (attempts < 2 && again !== request) void again.body?.cancel();
    });
  }

  /** What the program has used, and its pool now. */
  usage(): ProgramUsage {
    let busy = 0;
    for (const slot of this.#slots) if (slot.active > 0) busy++;
    return { ...this.#usage, instances: this.#slots.size, busy, queued: this.#queue.length };
  }

  /**
   * Stop taking calls (`ERR_PROGRAM_CLOSED`, queued ones too), wait for
   * those running to finish and for the instances' `ctx.waitUntil` work,
   * and close the instances. Idempotent.
   */
  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      const closed = new IsolaneError('ERR_PROGRAM_CLOSED', 'isolane: the program was closed', { tenant: this.tenant });
      for (const waiter of this.#queue.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(closed);
      }
      this.#drained = new Promise((resolve) => (this.#onDrained = resolve));
      for (const slot of [...this.#slots]) if (slot.active === 0) this.#drop(slot);
      this.#checkDrained();
    }
    return this.#drained as Promise<void>;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /**
   * Run one call in an instance. A call that an instance refused without
   * running it (the instance was retired just before: `ERR_ISOLATE_RETIRED`,
   * retryable) goes to another, once.
   */
  async #invoke<R>(signal: AbortSignal | undefined, run: (instance: Instance, slot: Slot) => Promise<R>): Promise<R> {
    this.#checkOpen();
    if (signal?.aborted) throw abortedError(signal, this.tenant);
    for (let attempt = 0; ; attempt++) {
      const slot = await this.#acquire(signal);
      this.#usage.calls++;
      try {
        return await run(slot.instance, slot);
      } catch (err) {
        const retried = attempt === 0 && err instanceof IsolaneError && err.code === 'ERR_ISOLATE_RETIRED' && err.retryable;
        if (retried) {
          this.#usage.calls--;
          continue;
        }
        this.#usage.failures++;
        throw err;
      } finally {
        slot.served++;
        this.#release(slot);
      }
    }
  }

  #checkOpen(): void {
    if (this.#closed) throw new IsolaneError('ERR_PROGRAM_CLOSED', 'isolane: the program was closed', { tenant: this.tenant });
  }

  #checkDrained(): void {
    if (this.#closed && this.#slots.size === 0 && this.#starting === 0 && this.#draining === 0) this.#onDrained?.();
  }

  /**
   * An instance with room for one more call: an idle one, else the least
   * busy one with room (with `concurrency` above 1: sharing a warm
   * instance beats loading another), else a new one, else the next one
   * freed.
   */
  async #acquire(signal: AbortSignal | undefined): Promise<Slot> {
    let best: Slot | undefined;
    for (const slot of [...this.#slots]) {
      if (!this.#fits(slot)) continue;
      if (!slot.instance[USABLE]) {
        if (slot.active === 0) this.#drop(slot);
        continue;
      }
      if (best === undefined || slot.active < best.active) best = slot;
      if (slot.active === 0) break;
    }
    if (best) {
      this.#take(best);
      return best;
    }
    if (this.#slots.size + this.#starting < this.#options.max) {
      const slot = await this.#start();
      this.#checkOpen();
      this.#take(slot);
      // Calls that queued while it loaded can share it.
      this.#handOn(slot);
      return slot;
    }
    return this.#wait(signal);
  }

  /** Whether `slot` may take another call: while it has room, when warm; once, when fresh. */
  #fits(slot: Slot): boolean {
    if (!this.#options.reuse) return slot.served === 0 && slot.active === 0;
    return slot.active < this.#options.concurrency;
  }

  #take(slot: Slot): void {
    clearTimeout(slot.idleTimer);
    slot.idleTimer = undefined;
    slot.active++;
  }

  /** Wait in the queue for an instance, up to `queueMs`. */
  #wait(signal: AbortSignal | undefined): Promise<Slot> {
    if (this.#queue.length >= this.#options.queue) {
      const message = `${this.#queue.length} calls already wait for an instance of the program (instances.queue; instances.max is ${this.#options.max})`;
      this.#chain.emit('limit', { tenant: this.tenant, program: this.id, limit: 'instances.queue', message });
      return Promise.reject(poolLimit('instances.queue', message, this.tenant));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      const leave = () => {
        const i = this.#queue.indexOf(waiter);
        if (i >= 0) this.#queue.splice(i, 1);
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        leave();
        reject(abortedError(signal as AbortSignal, this.tenant));
      };
      waiter.resolve = (slot) => {
        leave();
        resolve(slot);
      };
      waiter.reject = (err) => {
        leave();
        reject(err);
      };
      const ms = this.#options.queueMs;
      waiter.timer = setTimeout(() => {
        const message = `no instance of the program was free within ${ms}ms (instances.queueMs; instances.max is ${this.#options.max})`;
        const err = poolLimit('instances.queueMs', message, this.tenant);
        this.#chain.emit('limit', { tenant: this.tenant, program: this.id, limit: 'instances.queueMs', message: err.message });
        waiter.reject(err);
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }

  /** Load a new instance. Rejects with the load's failure (the isolate is closed). */
  async #start(): Promise<Slot> {
    this.#starting++;
    let instance: Instance | undefined;
    const started = performance.now();
    try {
      instance = this.#create();
      instance[OBSERVE]((u) => {
        if (u.cpuUs !== undefined) this.#usage.cpuMs += u.cpuUs / 1000;
      });
      const loaded = await instance[LOAD](this.#main, this.#files, this.#modules);
      this.#usage.loads++;
      this.#chain.emit('programLoad', {
        tenant: this.tenant,
        program: this.id,
        isolate: instance.id,
        filename: this.#main,
        durationMs: performance.now() - started,
        modules: modulesCompiled(loaded),
      });
    } catch (err) {
      this.#usage.loads++;
      this.#usage.loadFailures++;
      if (instance) {
        instance.close();
        this.#chain.emit('programLoad', {
          tenant: this.tenant,
          program: this.id,
          isolate: instance.id,
          filename: this.#main,
          durationMs: performance.now() - started,
          error: err as IsolaneError,
        });
      }
      throw err;
    } finally {
      this.#starting--;
      // A load that failed while the program closed was the last thing it waited for.
      this.#checkDrained();
    }
    const slot: Slot = { instance, active: 0, served: 0, waiting: 0 };
    this.#slots.add(slot);
    if (this.#closed) {
      this.#drop(slot);
      this.#checkOpen();
    }
    return slot;
  }

  /** A call is done with `slot`. */
  #release(slot: Slot): void {
    slot.active--;
    this.#offer(slot);
  }

  /** `slot` has room for a call: hand it on, keep it idle, or replace it. */
  #offer(slot: Slot): void {
    if (!this.#slots.has(slot)) return;
    if (this.#closed || !slot.instance[USABLE] || (!this.#options.reuse && slot.served > 0)) {
      if (slot.active === 0) this.#drop(slot);
    } else {
      this.#handOn(slot);
      if (slot.active === 0 && this.#slots.size > this.#options.min) {
        slot.idleTimer = setTimeout(() => {
          if (slot.active === 0 && this.#slots.size > this.#options.min) this.#drop(slot);
        }, this.#options.idleMs);
        slot.idleTimer.unref();
      }
    }
    this.#refill();
  }

  /** Give queued calls `slot`, while it has room for them. */
  #handOn(slot: Slot): void {
    while (this.#queue.length > 0 && this.#fits(slot) && slot.instance[USABLE]) {
      this.#take(slot);
      // Resolving takes the waiter off the queue.
      (this.#queue[0] as Waiter).resolve(slot);
    }
  }

  /**
   * Close an instance and forget it: once its `ctx.waitUntil` work is
   * done, if it has any (waiting for it is budgeted as an eval).
   */
  #drop(slot: Slot): void {
    if (!this.#slots.delete(slot)) return;
    clearTimeout(slot.idleTimer);
    const instance = slot.instance;
    if (slot.waiting > 0 && instance[USABLE]) {
      this.#draining++;
      instance[DRAIN]()
        .catch(() => {})
        .finally(() => {
          instance.close();
          this.#draining--;
          this.#checkDrained();
        });
      return;
    }
    instance.close();
    this.#checkDrained();
  }

  /**
   * Keep the pool at `min` ready instances, and start one for a queued
   * call if there's room. Failures here are reported (`programLoad`), and
   * fail the queued call they were for.
   */
  #refill(): void {
    if (this.#closed) return;
    const live = () => this.#slots.size + this.#starting;
    const ready = [...this.#slots].filter((s) => s.active === 0 && this.#fits(s)).length;
    let wanted = Math.max(0, this.#options.min - ready - this.#starting);
    if (this.#queue.length > this.#starting) wanted = Math.max(wanted, 1);
    while (wanted-- > 0 && live() < this.#options.max) {
      this.#start().then(
        (slot) => this.#offer(slot),
        (err: IsolaneError) => this.#queue[0]?.reject(err),
      );
    }
  }
}
