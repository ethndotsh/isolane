// Every resource cap in one place: what each limit bounds, its default, and
// how the levels combine. A runtime sets defaults (`limits`), a tenant can
// get its own (`tenantLimits(tenant)`, e.g. by plan), and each isolate can
// narrow its own isolate limits further. Later levels override earlier ones,
// field by field.

import { invalidOption } from './errors.js';

/** Limits on one isolate. */
export interface IsolateLimits {
  /** Wall-clock budget per eval (and per continuation). `null`: none. Default 30 s. */
  timeoutMs?: number | null;
  /** CPU time per eval (and per continuation); Linux only. `null`: none. Default none. */
  cpuTimeMs?: number | null;
  /** The isolate's V8 heap; exceeding it retires the isolate. `null`: V8's default. Default 128 MiB. */
  heapBytes?: number | null;
  /** Live timers; more throws a RangeError in the guest. Default 10,000. */
  timers?: number;
  /** Console output per eval; the rest is dropped. Default 1 MiB. */
  logBytesPerEval?: number;
  /** Longest console message; longer ones are cut. Default 16 KiB. */
  logMessageBytes?: number;
  /** Source code per eval (UTF-8 bytes). Default 16 MiB. */
  codeBytes?: number;
  /** Completion value per eval, as JSON. Default 16 MiB. */
  resultBytes?: number;
  /** Output of one decompression call (DecompressionStream). Default 128 MiB. */
  decompressedBytes?: number;
}

/** Limits on one tenant (its worker process). */
export interface TenantLimits {
  /** Live isolates. Default 100. */
  isolates?: number;
  /** Evals in flight (running or queued) across its isolates. Default 1,000. */
  concurrentEvals?: number;
  /**
   * The worker's memory: every isolate's heap, ArrayBuffers, and
   * WebAssembly memory together, beyond V8's own baseline (Linux,
   * RLIMIT_DATA). `null`: none. Default 2 GiB.
   */
  workerMemoryBytes?: number | null;
}

/** Limits on the runtime as a whole. */
export interface RuntimeLimits {
  /**
   * Tenants with a live worker process. At the cap, the least recently used
   * idle tenant's worker is stopped to make room; if none is idle, the new
   * tenant is refused. Default 1,000.
   */
  tenants?: number;
}

export type Limits = IsolateLimits & TenantLimits & RuntimeLimits;

export const DEFAULT_LIMITS = {
  timeoutMs: 30_000,
  cpuTimeMs: null,
  heapBytes: 128 * 1024 ** 2,
  timers: 10_000,
  logBytesPerEval: 1024 ** 2,
  logMessageBytes: 16 * 1024,
  codeBytes: 16 * 1024 ** 2,
  resultBytes: 16 * 1024 ** 2,
  decompressedBytes: 128 * 1024 ** 2,
  isolates: 100,
  concurrentEvals: 1_000,
  workerMemoryBytes: 2 * 1024 ** 3,
  tenants: 1_000,
} satisfies Required<Limits>;

/** Every limit, with defaults filled in (`null` where a limit is off). */
export type ResolvedLimits = { [K in keyof Limits]-?: Exclude<Limits[K], undefined> };

const ISOLATE_KEYS = new Set<string>([
  'timeoutMs',
  'cpuTimeMs',
  'heapBytes',
  'timers',
  'logBytesPerEval',
  'logMessageBytes',
  'codeBytes',
  'resultBytes',
  'decompressedBytes',
]);
const NULLABLE = new Set<string>(['timeoutMs', 'cpuTimeMs', 'heapBytes', 'workerMemoryBytes']);
const MINIMUM: Partial<Record<keyof Limits, number>> = { workerMemoryBytes: 64 * 1024 ** 2, heapBytes: 1024 ** 2 };

/** Check one level's limits; `isolateOnly` refuses tenant and runtime keys. */
export function validateLimits(limits: unknown, where: string, isolateOnly = false): Limits {
  if (limits === undefined) return {};
  if (limits === null || typeof limits !== 'object') throw invalidOption(`${where} must be an object`);
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw invalidOption(`${where}.${key} is not a limit`);
    if (isolateOnly && !ISOLATE_KEYS.has(key)) {
      throw invalidOption(`${where}.${key} is a tenant or runtime limit; set it in the runtime's limits or tenantLimits`);
    }
    if (value === undefined) continue;
    if (value === null && NULLABLE.has(key)) continue;
    const min = MINIMUM[key as keyof Limits] ?? 1;
    if (!(Number.isSafeInteger(value) && (value as number) >= min)) {
      throw invalidOption(`${where}.${key} must be an integer of at least ${min}${NULLABLE.has(key) ? ', or null' : ''}`);
    }
  }
  return limits as Limits;
}

/** Combine levels, later winning per field, over the defaults. */
export function resolveLimits(...levels: (Limits | undefined)[]): ResolvedLimits {
  const out: Record<string, unknown> = { ...DEFAULT_LIMITS };
  for (const level of levels) {
    if (!level) continue;
    for (const [key, value] of Object.entries(level)) if (value !== undefined) out[key] = value;
  }
  return out as ResolvedLimits;
}

/** The limits the worker enforces inside the guest, as it expects them. */
export function guestLimits(l: ResolvedLimits) {
  return {
    timers: l.timers,
    logBytesPerEval: l.logBytesPerEval,
    logMessageBytes: l.logMessageBytes,
    resultBytes: l.resultBytes,
    decompressedBytes: l.decompressedBytes,
  };
}
