// One configuration shape for an isolate, layered three ways: the runtime's
// `defaults`, the tenant's (`tenants(name)`), and the call. `resolve`
// validates every layer (errors name the field) and folds them into one
// frozen ResolvedConfig that everything downstream reads. Names follow the
// rules in docs/api-review.md: units are suffixes, capabilities are named
// for the guest API they enable, one word per idea.

import type { ConnectPolicy, FetchPolicy, FsPolicy } from './capabilities.js';
import { invalidConfig } from './errors.js';
import { validateHooks, type Hooks } from './hooks.js';
import { flattenHost, type HostEntry, type HostTree } from './host.js';

// ---- limits ----

/** Limits on one isolate. Settable at any level. */
export interface IsolateLimits {
  /** Wall-clock budget per eval (and per continuation). `null`: none. Default 30 s. */
  timeoutMs?: number | null;
  /** CPU time per eval (and per continuation); Linux only. `null`: none. Default none. */
  cpuMs?: number | null;
  /** The isolate's V8 heap; exceeding it retires the isolate. `null`: V8's default. Default 128 MiB. */
  heapBytes?: number | null;
  /** Live timers; more throws a RangeError in the guest. Default 10,000. */
  timers?: number;
  /** Console output per eval; the rest is dropped. Default 1 MiB. */
  logBytes?: number;
  /** Longest console line; longer ones are cut. Default 16 KiB. */
  logLineBytes?: number;
  /** Source code per eval (UTF-8 bytes). Default 16 MiB. */
  codeBytes?: number;
  /** Completion value per eval, as JSON. Default 16 MiB. */
  resultBytes?: number;
  /** Output of one decompression call (DecompressionStream). Default 128 MiB. */
  decompressedBytes?: number;
}

/** Limits on one tenant (its worker process). Settable in `defaults` and `tenants(name)`. */
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
  /** Stop the tenant's worker after this long with no isolates and nothing running. Default 30 s. */
  idleMs?: number;
}

/** Limits on the runtime as a whole (`RuntimeOptions.limits`). */
export interface RuntimeLimits {
  /**
   * Tenants with a live worker process. At the cap, the least recently used
   * idle tenant's worker is stopped to make room; if none is idle, the new
   * tenant is refused. Default 1,000.
   */
  tenants?: number;
}

/** What `limits` accepts in an IsolateConfig (tenant limits only in `defaults` and `tenants(name)`). */
export type Limits = IsolateLimits & TenantLimits;

export const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  cpuMs: null,
  heapBytes: 128 * 1024 ** 2,
  timers: 10_000,
  logBytes: 1024 ** 2,
  logLineBytes: 16 * 1024,
  codeBytes: 16 * 1024 ** 2,
  resultBytes: 16 * 1024 ** 2,
  decompressedBytes: 128 * 1024 ** 2,
  isolates: 100,
  concurrentEvals: 1_000,
  workerMemoryBytes: 2 * 1024 ** 3,
  idleMs: 30_000,
  tenants: 1_000,
} as const);

/** Every limit, with defaults filled in (`null` where a limit is off). */
export type ResolvedLimits = { [K in keyof (Limits & RuntimeLimits)]-?: Exclude<(Limits & RuntimeLimits)[K], undefined> };

const ISOLATE_LIMITS = new Set(['timeoutMs', 'cpuMs', 'heapBytes', 'timers', 'logBytes', 'logLineBytes', 'codeBytes', 'resultBytes', 'decompressedBytes']);
const TENANT_LIMITS = new Set(['isolates', 'concurrentEvals', 'workerMemoryBytes', 'idleMs']);
const NULLABLE = new Set(['timeoutMs', 'cpuMs', 'heapBytes', 'workerMemoryBytes']);
const MINIMUM: Record<string, number> = { workerMemoryBytes: 64 * 1024 ** 2, heapBytes: 1024 ** 2 };

/** Old names, for errors that say what to write instead. */
const RENAMED: Record<string, string> = {
  timeoutMs: 'limits.timeoutMs',
  cpuTimeLimitMs: 'limits.cpuMs',
  memoryLimitBytes: 'limits.heapBytes',
  hostFunctions: 'host',
  allowCodeGeneration: 'eval',
  allowWebAssembly: 'wasm',
  webPlatform: 'web',
  network: 'fetch',
  sockets: 'connect',
  clock: 'time',
  randomSeed: 'random.seed',
  onLog: 'hooks.onLog',
  result: 'returns',
};
const RENAMED_LIMITS: Record<string, string> = {
  cpuTimeMs: 'cpuMs',
  logBytesPerEval: 'logBytes',
  logMessageBytes: 'logLineBytes',
  idleTimeoutMs: 'idleMs',
};

export type Level = 'defaults' | 'tenant' | 'call';

function checkInteger(path: string, value: unknown, min: number, nullable: boolean): void {
  if (value === undefined || (value === null && nullable)) return;
  if (!(Number.isSafeInteger(value) && (value as number) >= min)) {
    throw invalidConfig(path, `must be an integer of at least ${min}${nullable ? ', or null' : ''}`);
  }
}

export function validateLimits(limits: unknown, path: string, level: Level | 'runtime'): void {
  if (limits === undefined) return;
  if (limits === null || typeof limits !== 'object') throw invalidConfig(path, 'must be an object');
  for (const [key, value] of Object.entries(limits)) {
    const field = `${path}.${key}`;
    if (level === 'runtime') {
      if (key !== 'tenants') {
        throw invalidConfig(
          field,
          ISOLATE_LIMITS.has(key) || TENANT_LIMITS.has(key)
            ? `isn't a runtime limit; set it in defaults.limits or tenants(name).limits`
            : 'is not a limit',
        );
      }
    } else if (key === 'tenants') {
      throw invalidConfig(field, `is a runtime limit; set it in the Runtime's limits`);
    } else if (!ISOLATE_LIMITS.has(key) && !TENANT_LIMITS.has(key)) {
      const hint = RENAMED_LIMITS[key];
      throw invalidConfig(field, hint ? `is now limits.${hint}` : 'is not a limit');
    } else if (TENANT_LIMITS.has(key) && level === 'call') {
      throw invalidConfig(field, 'is a tenant limit; set it in defaults.limits or tenants(name).limits');
    }
    checkInteger(field, value, MINIMUM[key] ?? 1, NULLABLE.has(key));
  }
}

// ---- the config ----

/** The guest's wall clock: frozen between I/O (default), real, or one fixed instant. */
export type TimeConfig = 'frozen' | 'real' | { fixedMs: number };

/** The web platform: `true`, or with a base URL for relative URLs (and `location`). */
export type WebConfig = boolean | { baseUrl?: string };

/** Trusted JS for `shims`: its source, or its source and its name in stack traces. */
export type Shim = string | { code: string; filename?: string };

/**
 * The embedder's own JS, run in the isolate around guest code: trusted,
 * like host functions, and compiled by isolane, so it works with `eval`
 * off. Each runs as its own script (guest line numbers are unaffected),
 * named `shim:<level>.<phase>.<n>` in stack traces unless it has a
 * `filename`. A shim that throws fails the eval with `ERR_SHIM`, not
 * `ERR_GUEST_EXCEPTION`. Levels concatenate: `defaults`, then
 * `tenants(name)`, then the call.
 */
export interface ShimsConfig {
  /**
   * Once, when the isolate is created, after the web platform, host
   * functions, and globals are in place, so it can wrap or freeze them.
   * A script: not awaited. If it throws, every eval fails with `ERR_SHIM`.
   */
  setup?: Shim | Shim[];
  /** Before each eval's code, as a script (not awaited). */
  before?: Shim | Shim[];
  /**
   * After each eval's value settles (not when it threw): the body of an
   * `async function (result)`. A value other than undefined replaces the
   * result. The innermost level's run first (the call's, then the
   * tenant's, then the defaults'), each level's in order.
   */
  after?: Shim | Shim[];
}

export interface ResolvedShim {
  readonly code: string;
  readonly filename: string;
}

export interface ResolvedShims {
  readonly setup: readonly ResolvedShim[];
  readonly before: readonly ResolvedShim[];
  readonly after: readonly ResolvedShim[];
}

/** Everything about an isolate except which tenant it belongs to. */
export interface IsolateConfig {
  /**
   * Functions guest code can call, by name; nested objects become frozen
   * namespaces (`{ db: { getUser } }` is `db.getUser(1)` in the guest). A
   * bare function is async in the guest and unchecked; `hostFunction({...})`
   * adds schemas, sync calls, and the call context as a parameter.
   */
  host?: HostTree;
  /** JSON values the guest starts with, as globals: inputs as data, not code. */
  globals?: Record<string, unknown>;
  /** Allow `eval` and `new Function`. Default false. */
  eval?: boolean;
  /** Keep `WebAssembly`. Default false: its compilers are much of V8's attack surface. */
  wasm?: boolean;
  /**
   * The WinterTC web platform globals (URL, TextEncoder, streams, Blob,
   * timers, fetch's classes, ...). Default false (plain ECMAScript). With
   * `{ baseUrl }`, relative URLs resolve against it and `location` exists.
   */
  web?: WebConfig;
  /** `fetch`, brokered by this process under the policy. Default: none. */
  fetch?: FetchPolicy | false;
  /** `connect()`, TCP/TLS sockets brokered under the policy. Default: none. */
  connect?: ConnectPolicy | false;
  /** An `fs` object over a host directory, brokered under the policy. Default: none. */
  fs?: FsPolicy | false;
  time?: TimeConfig;
  /** Seed Math.random, crypto's randomness, and V8's hash seeds, for reproducible runs. */
  random?: { seed?: number };
  limits?: Limits;
  /** Interceptors and events for this level; every level's hooks run. */
  hooks?: Hooks;
  /** Trusted JS run around guest code: once at setup, and before and after each eval. */
  shims?: ShimsConfig;
}

export type TimeSpec = { mode: 'frozen' } | { mode: 'real' } | { mode: 'fixed'; fixedMs: number };

export interface ResolvedConfig {
  readonly host: readonly HostEntry[];
  readonly globals: Readonly<Record<string, unknown>>;
  readonly eval: boolean;
  readonly wasm: boolean;
  readonly web: false | { readonly baseUrl?: string };
  readonly fetch?: FetchPolicy;
  readonly connect?: ConnectPolicy;
  readonly fs?: FsPolicy;
  readonly time: TimeSpec;
  readonly seed?: number;
  readonly limits: ResolvedLimits;
  /** Every level's hooks, outermost first. */
  readonly hooks: readonly Hooks[];
  /** In run order. */
  readonly shims: ResolvedShims;
}

const CONFIG_KEYS = new Set(['host', 'globals', 'eval', 'wasm', 'web', 'fetch', 'connect', 'fs', 'time', 'random', 'limits', 'hooks', 'shims']);

const SHIM_PHASES = ['setup', 'before', 'after'] as const;

function validateShims(shims: unknown, path: string): void {
  if (shims === undefined) return;
  if (shims === null || typeof shims !== 'object' || Array.isArray(shims)) throw invalidConfig(path, 'must be { setup, before, after }');
  for (const [phase, value] of Object.entries(shims)) {
    if (!(SHIM_PHASES as readonly string[]).includes(phase)) throw invalidConfig(`${path}.${phase}`, 'is not a shims field (fields: setup, before, after)');
    if (value === undefined) continue;
    const list = Array.isArray(value) ? value : [value];
    list.forEach((shim: unknown, i) => {
      const at = Array.isArray(value) ? `${path}.${phase}.${i}` : `${path}.${phase}`;
      if (typeof shim === 'string') return;
      if (shim === null || typeof shim !== 'object') throw invalidConfig(at, 'must be code (a string) or { code, filename }');
      for (const key of Object.keys(shim)) {
        if (key !== 'code' && key !== 'filename') throw invalidConfig(`${at}.${key}`, 'is not a shim field (fields: code, filename)');
      }
      const s = shim as { code?: unknown; filename?: unknown };
      if (typeof s.code !== 'string') throw invalidConfig(`${at}.code`, 'must be a string');
      if (s.filename !== undefined && (typeof s.filename !== 'string' || s.filename === '')) throw invalidConfig(`${at}.filename`, 'must be a non-empty string');
    });
  }
}

function shimList(shims: ShimsConfig, phase: (typeof SHIM_PHASES)[number], level: string): ResolvedShim[] {
  const value = shims[phase];
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((shim, i) =>
    Object.freeze(typeof shim === 'string' ? { code: shim, filename: `shim:${level}.${phase}.${i}` } : { code: shim.code, filename: shim.filename ?? `shim:${level}.${phase}.${i}` }),
  );
}

function checkPolicy(path: string, value: unknown, keys: string[], limitKeys: string[]): void {
  if (value === undefined || value === false) return;
  if (value === true) throw invalidConfig(path, 'needs a policy object (there is no safe default target list)');
  if (value === null || typeof value !== 'object') throw invalidConfig(path, 'must be a policy object or false');
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw invalidConfig(`${path}.${key}`, `is not a ${path} policy field (fields: ${keys.join(', ')})`);
  }
  const limits = (value as { limits?: unknown }).limits;
  if (limits !== undefined) {
    if (limits === null || typeof limits !== 'object') throw invalidConfig(`${path}.limits`, 'must be an object');
    for (const [key, v] of Object.entries(limits)) {
      if (!limitKeys.includes(key)) throw invalidConfig(`${path}.limits.${key}`, `is not a ${path} limit (limits: ${limitKeys.join(', ')})`);
      checkInteger(`${path}.limits.${key}`, v, 1, false);
    }
  }
  const p = value as Record<string, unknown>;
  if (p.privateNetworks !== undefined && typeof p.privateNetworks !== 'boolean') {
    throw invalidConfig(`${path}.privateNetworks`, 'must be a boolean');
  }
  if ('hosts' in p) {
    const hosts = p.hosts;
    if (typeof hosts !== 'function' && !(Array.isArray(hosts) && hosts.every((h) => typeof h === 'string'))) {
      throw invalidConfig(`${path}.hosts`, 'must be a list of patterns or a function');
    }
  } else if (path !== 'fs') {
    throw invalidConfig(`${path}.hosts`, 'is required (a list of patterns or a function)');
  }
}

/** Check one layer; returns it (unchanged). */
export function validateConfig(layer: unknown, where: string, level: Level): IsolateConfig {
  if (layer === undefined || layer === null) return {};
  if (typeof layer !== 'object') throw invalidConfig(where, 'must be an object');
  const at = (key: string) => (where ? `${where}.${key}` : key);
  const c = layer as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (CONFIG_KEYS.has(key) || (level === 'call' && (key === 'tenant' || key === 'returns'))) continue;
    const hint = RENAMED[key];
    throw invalidConfig(at(key), hint ? `is not a config field; use ${hint}` : 'is not a config field');
  }
  for (const key of ['eval', 'wasm'] as const) {
    if (c[key] !== undefined && typeof c[key] !== 'boolean') throw invalidConfig(at(key), 'must be a boolean');
  }
  if (c.web !== undefined && typeof c.web !== 'boolean') {
    const web = c.web as Record<string, unknown> | null;
    if (web === null || typeof web !== 'object') throw invalidConfig(at('web'), 'must be a boolean or { baseUrl }');
    for (const key of Object.keys(web)) if (key !== 'baseUrl') throw invalidConfig(at(`web.${key}`), 'is not a web field (fields: baseUrl)');
    if (web.baseUrl !== undefined) {
      let url: URL | undefined;
      try {
        url = new URL(String(web.baseUrl));
      } catch {
        url = undefined;
      }
      if (typeof web.baseUrl !== 'string' || !url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
        throw invalidConfig(at('web.baseUrl'), 'must be an absolute http: or https: URL');
      }
    }
  }
  checkPolicy(at('fetch'), c.fetch, ['hosts', 'methods', 'privateNetworks', 'limits'], ['requests', 'requestBytes', 'responseBytes', 'redirects', 'timeoutMs']);
  if (c.fetch && (c.fetch as FetchPolicy).methods !== undefined) {
    const m = (c.fetch as FetchPolicy).methods;
    if (!Array.isArray(m) || !m.every((x) => typeof x === 'string')) throw invalidConfig(at('fetch.methods'), 'must be a list of method names');
  }
  checkPolicy(at('connect'), c.connect, ['hosts', 'privateNetworks', 'limits'], ['connections', 'connectMs', 'idleMs']);
  checkPolicy(at('fs'), c.fs, ['root', 'write', 'limits'], ['fileBytes']);
  if (c.fs) {
    const fs = c.fs as FsPolicy;
    if (typeof fs.root !== 'string' || fs.root === '') throw invalidConfig(at('fs.root'), 'must be a directory path');
    if (fs.write !== undefined && typeof fs.write !== 'boolean') throw invalidConfig(at('fs.write'), 'must be a boolean');
  }
  if (c.time !== undefined) timeSpec(c.time as TimeConfig, at('time'));
  if (c.random !== undefined) {
    const r = c.random as Record<string, unknown> | null;
    if (r === null || typeof r !== 'object') throw invalidConfig(at('random'), 'must be { seed }');
    for (const key of Object.keys(r)) if (key !== 'seed') throw invalidConfig(at(`random.${key}`), 'is not a random field (fields: seed)');
    if (r.seed !== undefined && !(Number.isSafeInteger(r.seed) && (r.seed as number) >= 0)) {
      throw invalidConfig(at('random.seed'), 'must be an integer from 0 to 2^53 - 1');
    }
  }
  if (c.globals !== undefined) {
    if (c.globals === null || typeof c.globals !== 'object' || Array.isArray(c.globals)) throw invalidConfig(at('globals'), 'must be an object');
    for (const name of Object.keys(c.globals)) {
      if (name === '__proto__' || name.startsWith('__isolane_')) throw invalidConfig(at(`globals.${name}`), 'is a reserved name');
    }
    try {
      if (JSON.stringify(c.globals) === undefined) throw new Error();
    } catch {
      throw invalidConfig(at('globals'), 'must be JSON-serializable');
    }
  }
  validateLimits(c.limits, at('limits'), level);
  if (c.host !== undefined) flattenHost(c.host, at('host'));
  validateHooks(c.hooks, at('hooks'));
  validateShims(c.shims, at('shims'));
  return c as IsolateConfig;
}

function timeSpec(time: TimeConfig | undefined, path: string): TimeSpec {
  if (time === undefined || time === 'frozen') return { mode: 'frozen' };
  if (time === 'real') return { mode: 'real' };
  if (typeof time === 'object' && time !== null && Object.keys(time).every((k) => k === 'fixedMs') && Number.isFinite(time.fixedMs)) {
    return { mode: 'fixed', fixedMs: time.fixedMs };
  }
  throw invalidConfig(path, `must be 'frozen', 'real', or { fixedMs }`);
}

/**
 * Fold validated layers (outermost first) into one config. Later layers
 * win per field; `host` and `globals` merge by name, `limits` by field,
 * and `hooks` and `shims` accumulate (every level's run). `levels` names
 * the layers, for shims' default filenames.
 */
export function resolve(layers: readonly (IsolateConfig | undefined)[], runtimeLimits?: RuntimeLimits, levels: readonly string[] = []): ResolvedConfig {
  const host = new Map<string, HostEntry>();
  const setup: ResolvedShim[] = [];
  const before: ResolvedShim[] = [];
  const after: ResolvedShim[][] = [];
  const globals: Record<string, unknown> = {};
  const limits: Record<string, unknown> = { ...DEFAULT_LIMITS, ...runtimeLimits };
  const hooks: Hooks[] = [];
  let out: {
    eval: boolean;
    wasm: boolean;
    web: WebConfig;
    fetch?: FetchPolicy | false;
    connect?: ConnectPolicy | false;
    fs?: FsPolicy | false;
    time?: TimeConfig;
    seed?: number;
  } = { eval: false, wasm: false, web: false };
  for (const [i, layer] of layers.entries()) {
    if (!layer) continue;
    if (layer.host) for (const entry of flattenHost(layer.host, 'host')) host.set(entry.name, entry);
    if (layer.globals) Object.assign(globals, layer.globals);
    if (layer.limits) for (const [k, v] of Object.entries(layer.limits)) if (v !== undefined) limits[k] = v;
    if (layer.hooks) hooks.push(layer.hooks);
    if (layer.shims) {
      const level = levels[i] ?? 'config';
      setup.push(...shimList(layer.shims, 'setup', level));
      before.push(...shimList(layer.shims, 'before', level));
      after.unshift(shimList(layer.shims, 'after', level));
    }
    for (const key of ['eval', 'wasm', 'web', 'fetch', 'connect', 'fs', 'time'] as const) {
      if (layer[key] !== undefined) out = { ...out, [key]: layer[key] };
    }
    if (layer.random?.seed !== undefined) out.seed = layer.random.seed;
  }
  // A name can't be both a function and a namespace across layers.
  const names = [...host.keys()];
  for (const name of names) {
    const prefix = `${name}.`;
    const clash = names.find((n) => n.startsWith(prefix));
    if (clash) throw invalidConfig('host', `has ${name} as both a function and a namespace (${clash})`);
  }
  const web = out.web === false || out.web === undefined ? false : out.web === true ? {} : { ...out.web };
  return Object.freeze({
    host: Object.freeze([...host.values()]),
    globals: Object.freeze(globals),
    eval: out.eval,
    wasm: out.wasm,
    web: web ? Object.freeze(web) : false,
    fetch: out.fetch || undefined,
    connect: out.connect || undefined,
    fs: out.fs || undefined,
    time: timeSpec(out.time, 'time'),
    seed: out.seed,
    limits: Object.freeze(limits) as ResolvedLimits,
    hooks: Object.freeze(hooks),
    shims: Object.freeze({ setup: Object.freeze(setup), before: Object.freeze(before), after: Object.freeze(after.flat()) }),
  });
}

/** The limits the worker enforces, named as in `IsolateLimits`. */
export function workerLimits(l: ResolvedLimits) {
  return {
    timeoutMs: l.timeoutMs ?? undefined,
    cpuMs: l.cpuMs ?? undefined,
    heapBytes: l.heapBytes ?? undefined,
    timers: l.timers,
    logBytes: l.logBytes,
    logLineBytes: l.logLineBytes,
    resultBytes: l.resultBytes,
    decompressedBytes: l.decompressedBytes,
  };
}
