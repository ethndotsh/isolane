// One worker process: spawn it, speak the frame protocol, and treat
// everything it sends as hostile. A worker that has run guest code may be
// compromised, so its output is size-capped, parsed as JSON only, and
// shape-checked before anything acts on it.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import type { PathSegment } from './binary.js';
import type { ResolvedShims, TimeSpec } from './config.js';
import { parseGuestError, type GuestErrorInfo } from './errors.js';
import { encodeFrame, FrameError, FrameReader, type Frame } from './frame.js';

/**
 * What the supervisor sends a worker: one variant per `proto::In` in
 * crates/worker/src/proto.rs, with the same field names.
 */
export type WorkerCommand =
  | {
      t: 'create';
      vm: number;
      limits: Record<string, number | undefined>;
      time: TimeSpec;
      random: { seed?: number };
      eval: boolean;
      wasm: boolean;
      web: boolean;
      baseUrl?: string;
      /** `env`: under the program's env object, not the global; `module`: an export of that host module. */
      functions: { path: readonly string[]; sync: boolean; env?: true; module?: string }[];
      prelude?: string;
      shims: ResolvedShims;
      /** A program's env, as JSON text (an object). */
      env?: string;
      /** Calls a program's instance runs at once (`instances.concurrency`), when above 1. */
      concurrency?: number;
    }
  | { t: 'eval'; vm: number; req: number; code: string; filename: string; last?: true }
  | {
      t: 'load';
      vm: number;
      req: number;
      /** The main module's path in `files`. */
      main: string;
      /**
       * The program's files, by a hash of their contents: the worker keeps
       * them under it, so only the first load on a worker sends them.
       */
      tree: string;
      /** Module sources by path (text files; bytes go in `bin`), when the worker doesn't have `tree` yet. */
      files?: Record<string, string>;
      /** Files sent as bytes: `[path, length]`, their bytes attached in order. */
      bin?: [string, number][];
      /** How the modules are resolved and transformed. */
      options?: ModuleOptionsWire;
    }
  | {
      t: 'call';
      vm: number;
      req: number;
      name: string;
      /** The arguments as a JSON array (text). */
      args: string;
      /** Byte arguments: `[argument index, length]`, their bytes attached in order. */
      bin?: [number, number][];
      /**
       * `fetch`: the program's fetch handler, with `args` `[head, body]`
       * and the response's body at most `maxBody` bytes; `drain`: wait for
       * its `ctx.waitUntil` work. Default: the function `name`.
       */
      kind?: 'fetch' | 'drain';
      maxBody?: number;
    }
  | {
      t: 'hostReply';
      vm: number;
      call: number;
      ok: boolean;
      /** JSON text; absent for `undefined`. */
      value?: string;
      error?: string;
      errorName?: string;
      errorCode?: string;
      /** Byte values in the result: where each goes, and its length. */
      bin?: [PathSegment[], number][];
    }
  | { t: 'abort'; vm: number; req: number }
  | { t: 'dispose'; vm: number }
  /** Drop the files kept as `tree` (isolates that loaded them keep theirs). */
  | { t: 'forget'; tree: string };

/** How a program's modules are resolved and transformed, as the worker takes it. */
export interface ModuleOptionsWire {
  ts?: { mode?: 'strip' | 'transform'; decorators?: boolean; emitDecoratorMetadata?: boolean };
  jsx?: { runtime?: 'automatic' | 'classic'; importSource?: string; factory?: string; fragment?: string; development?: boolean };
  define?: [string, string][];
  /** What a specifier resolves to instead: a file of the program, another specifier, or the program's host module of that name. */
  aliases?: Record<string, { file: string } | { specifier: string } | 'host'>;
}

/** The protocol version this library speaks; a worker reporting another is refused. */
export const PROTOCOL_VERSION = 10;

/**
 * Input queued for a worker that it hasn't read. A worker reads its input
 * as fast as it arrives (its main thread only forwards it), so past
 * INPUT_BACKLOG bytes it has INPUT_STALL_MS to catch up (Node to report
 * the queue drained), and past INPUT_MAX it's killed at once: a worker
 * that stops reading would otherwise grow the supervisor's memory without
 * bound.
 */
export const INPUT_BACKLOG = 64 << 20;
export const INPUT_STALL_MS = 5_000;
export const INPUT_MAX = 1 << 30;

/** Time a fresh worker has to initialize V8 and report ready. */
const READY_TIMEOUT_MS = 10_000;

export type LockdownLevel = 'full' | 'partial' | 'none';

/** What a worker reports it is running under. */
export interface IsolationInfo {
  v8: string;
  /** The V8 sandbox is enabled and securely configured. */
  sandboxSecure: boolean;
  lockdown: { landlock: LockdownLevel; seccomp: LockdownLevel };
}

export type WorkerMessage =
  | ({ t: 'ready'; protocol: number } & IsolationInfo)
  | ({
      t: 'result';
      vm: number;
      req: number;
      retired?: string;
      ok: true;
      value: unknown;
      /** A fetch call's response body (`value` is its head). */
      body?: Uint8Array;
    } & WorkerUsage)
  | ({
      t: 'result';
      vm: number;
      req: number;
      /** This eval retired its isolate: what its later evals fail with. */
      retired?: string;
      ok: false;
      code: string;
      message: string;
      guest?: GuestErrorInfo;
      limit?: string;
      shim?: { phase: 'setup' | 'before' | 'after'; index: number };
    } & WorkerUsage)
  | ({ t: 'usage'; vm: number; limit?: string; message?: string } & WorkerUsage)
  | { t: 'hostCall'; vm: number; call: number; fn: number; args: unknown[]; /** The frame's body length. */ size: number }
  | { t: 'log'; vm: number; level: LogLevel; message: string }
  | { t: 'guestError'; vm: number; kind: 'exception' | 'rejection'; guest: GuestErrorInfo };

/** What an eval or continuation cost, as the worker reports it. */
export interface WorkerUsage {
  cpuUs?: number;
  heapBytes?: number;
  externalBytes?: number;
}

function parseUsage(m: Record<string, unknown>): WorkerUsage {
  const u: WorkerUsage = {};
  if (isUint(m.cpuUs)) u.cpuUs = m.cpuUs;
  if (isUint(m.heapBytes)) u.heapBytes = m.heapBytes;
  if (isUint(m.externalBytes)) u.externalBytes = m.externalBytes;
  return u;
}

export type LogLevel = 'log' | 'info' | 'debug' | 'warn' | 'error';
const LOG_LEVELS = new Set<string>(['log', 'info', 'debug', 'warn', 'error']);

/** Exit code a worker uses when it hits its memory limit. */
export const OOM_EXIT_CODE = 6;

const isUint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const SHIM_PHASES = new Set(['setup', 'before', 'after']);

function parseShimRef(raw: unknown): { phase: 'setup' | 'before' | 'after'; index: number } | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  return typeof r.phase === 'string' && SHIM_PHASES.has(r.phase) && isUint(r.index)
    ? { phase: r.phase as 'setup' | 'before' | 'after', index: r.index }
    : undefined;
}

/**
 * A host call's byte arguments: `bin` is `[argument index, length]` pairs,
 * the bytes follow in that order, and `args` has null at each index. Null
 * unless every byte is claimed exactly once and every index is valid.
 */
function attachArgs(args: unknown[], bin: unknown, bytes: Buffer): unknown[] | null {
  if (!Array.isArray(bin) || bin.length === 0 || bin.length > args.length) return null;
  const out = args.slice();
  const used = new Set<number>();
  let offset = 0;
  for (const entry of bin) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [index, len] = entry as unknown[];
    if (!isUint(index) || !isUint(len) || index >= args.length || used.has(index) || args[index] !== null) return null;
    if (len > bytes.length - offset) return null;
    used.add(index);
    out[index] = bytes.subarray(offset, offset + len);
    offset += len;
  }
  return offset === bytes.length ? out : null;
}

/** Validate a decoded frame's shape; null if it isn't a message we accept.
 * `bytes` are the frame's attached bytes, if it is a binary frame: only a
 * host call or a call's result may have them, and it must claim them all. */
export function parseWorkerMessage(raw: unknown, bytes?: Buffer): WorkerMessage | null {
  if (raw === null || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const binary = m.t === 'hostCall' || (m.t === 'result' && m.ok === true);
  if (m.bin !== undefined && (!binary || bytes === undefined)) return null;
  if (bytes !== undefined && !binary) return null;
  switch (m.t) {
    case 'ready': {
      const l = m.lockdown as Record<string, unknown> | null;
      const level = (v: unknown): v is LockdownLevel => v === 'full' || v === 'partial' || v === 'none';
      // Workers before protocol 2 didn't say: treat that as 1 (so they're
      // refused as incompatible, not as hostile).
      const protocol = m.protocol === undefined ? 1 : m.protocol;
      return isUint(protocol) &&
        typeof m.v8 === 'string' &&
        typeof m.sandboxSecure === 'boolean' &&
        l !== null &&
        typeof l === 'object' &&
        level(l.landlock) &&
        level(l.seccomp)
        ? {
            t: 'ready',
            protocol,
            v8: m.v8,
            sandboxSecure: m.sandboxSecure,
            lockdown: { landlock: l.landlock, seccomp: l.seccomp },
          }
        : null;
    }
    case 'result': {
      if (!isUint(m.vm) || !isUint(m.req) || typeof m.ok !== 'boolean') return null;
      if (m.retired !== undefined && typeof m.retired !== 'string') return null;
      const retired = m.retired as string | undefined;
      if (m.ok) {
        // A call's bytes result: the frame's bytes, all of them. With a
        // value too, a fetch call's response: its head, and its body.
        if (bytes !== undefined) {
          if (m.bin !== bytes.length) return null;
          if (m.value !== undefined) return { t: 'result', vm: m.vm, req: m.req, retired, ok: true, value: m.value, body: new Uint8Array(bytes), ...parseUsage(m) };
          return { t: 'result', vm: m.vm, req: m.req, retired, ok: true, value: new Uint8Array(bytes), ...parseUsage(m) };
        }
        return { t: 'result', vm: m.vm, req: m.req, retired, ok: true, value: m.value ?? null, ...parseUsage(m) };
      }
      if (typeof m.code !== 'string' || typeof m.message !== 'string') return null;
      if (m.limit !== undefined && typeof m.limit !== 'string') return null;
      return {
        t: 'result',
        vm: m.vm,
        req: m.req,
        retired,
        ok: false,
        code: m.code,
        message: m.message,
        guest: parseGuestError(m.guest),
        limit: m.limit as string | undefined,
        shim: parseShimRef(m.shim),
        ...parseUsage(m),
      };
    }
    case 'usage':
      // `limit`: work between evals hit it (and the isolate is retired).
      if (!isUint(m.vm)) return null;
      if (m.limit !== undefined && (typeof m.limit !== 'string' || typeof m.message !== 'string')) return null;
      return m.limit === undefined
        ? { t: 'usage', vm: m.vm, ...parseUsage(m) }
        : { t: 'usage', vm: m.vm, limit: m.limit, message: m.message as string, ...parseUsage(m) };
    case 'hostCall': {
      if (!(isUint(m.vm) && isUint(m.call) && isUint(m.fn) && Array.isArray(m.args))) return null;
      const args = bytes === undefined ? m.args : attachArgs(m.args, m.bin, bytes);
      return args ? { t: 'hostCall', vm: m.vm, call: m.call, fn: m.fn, args, size: 0 } : null;
    }
    case 'guestError': {
      const guest = parseGuestError(m.guest);
      return isUint(m.vm) && (m.kind === 'exception' || m.kind === 'rejection') && guest ? { t: 'guestError', vm: m.vm, kind: m.kind, guest } : null;
    }
    case 'log':
      return isUint(m.vm) && typeof m.level === 'string' && LOG_LEVELS.has(m.level) && typeof m.message === 'string'
        ? { t: 'log', vm: m.vm, level: m.level as LogLevel, message: m.message }
        : null;
    default:
      return null;
  }
}

export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Why the supervisor considers the worker gone. */
  reason: 'exited' | 'protocol-violation' | 'incompatible' | 'insufficient-isolation' | 'ready-timeout' | 'unresponsive' | 'killed';
  detail?: string;
}

export interface WorkerHandlers {
  onMessage(msg: Exclude<WorkerMessage, { t: 'ready' }>): void;
  onExit(exit: WorkerExit): void;
}

/** Whether a worker's isolation meets strict mode: secure V8 sandbox,
 * seccomp fully applied, and Landlock in force. */
export function meetsStrict(info: IsolationInfo): boolean {
  return info.sandboxSecure && info.lockdown.seccomp === 'full' && info.lockdown.landlock !== 'none';
}

/**
 * The worker parses frames as UTF-8 JSON, which can't carry lone UTF-16
 * surrogates (JSON.stringify escapes them, and the worker rejects the
 * escape). Replace them with U+FFFD in every string sent: guest code,
 * host-function error messages, and names.
 */
function wellFormed(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? toWellFormed(value) : value;
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const toWellFormed = (s: string): string => s.replace(LONE_SURROGATE, '\ufffd');

/** How a worker process is started. */
export interface WorkerProcessOptions {
  /** Its memory limit (`limits.workerMemoryBytes`). */
  memoryLimitBytes?: number;
  /**
   * It will run web VMs, so if its binary has no embedded web snapshot, it
   * builds one in the background as it starts (otherwise, when the first
   * web VM asks).
   */
  prepareWeb?: boolean;
  /** Isolates it keeps made ahead of their VMs (the runtime's `spareIsolates`). */
  spareIsolates?: number;
  /** It only reports the isolation it has (`isolationReport`). */
  probe?: boolean;
}

export class WorkerProcess {
  readonly ready: Promise<IsolationInfo>;
  #child: ChildProcessByStdio<Writable, Readable, Readable>;
  #alive = true;
  #stderrTail = '';
  #stall: NodeJS.Timeout | undefined;

  constructor(workerPath: string, handlers: WorkerHandlers, strict: boolean, options: WorkerProcessOptions = {}) {
    const { memoryLimitBytes, prepareWeb = false, spareIsolates = 0, probe = false } = options;
    const args = ['--serve'];
    if (memoryLimitBytes !== undefined) args.push(`--memory-bytes=${memoryLimitBytes}`);
    if (prepareWeb) args.push('--prepare-web');
    if (spareIsolates > 0) args.push(`--spare-isolates=${spareIsolates}`);
    // Empty environment and no inherited fds beyond the three pipes: nothing
    // from the application process (secrets in env vars, open sockets) is
    // reachable from the worker.
    this.#child = spawn(workerPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {},
      cwd: '/',
    });

    let markReady!: (info: IsolationInfo) => void;
    let failReady!: (err: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    this.ready.catch(() => {});
    const readyTimer = setTimeout(() => this.#fail('ready-timeout', 'worker did not report ready'), READY_TIMEOUT_MS);
    let isReady = false;

    const exitWith = (exit: WorkerExit) => {
      if (!this.#alive) return;
      this.#alive = false;
      clearTimeout(readyTimer);
      clearTimeout(this.#stall);
      if (!isReady) failReady(Object.assign(new Error(`worker failed to start: ${exit.detail ?? exit.reason}`), { exit }));
      handlers.onExit(exit);
    };
    this.#fail = (reason, detail) => {
      exitWith({ code: null, signal: null, reason, detail });
      this.#child.kill('SIGKILL');
    };

    // Handle one frame; false once the worker is failed.
    const handle = (frame: Frame): boolean => {
      const msg = parseWorkerMessage(frame.json, frame.bytes);
      if (!msg) {
        this.#fail('protocol-violation', 'malformed message');
        return false;
      }
      if (msg.t === 'hostCall') msg.size = frame.size;
      if (msg.t !== 'ready') {
        if (!isReady) {
          this.#fail('protocol-violation', 'message before ready');
          return false;
        }
        handlers.onMessage(msg);
        return true;
      }
      if (!isReady && msg.protocol !== PROTOCOL_VERSION) {
        this.#fail(
          'incompatible',
          `the worker speaks protocol ${msg.protocol}, this library ${PROTOCOL_VERSION}: install a matching isolane-worker (${workerPath})`,
        );
        return false;
      }
      // ISOLANE_DEV_INSECURE=1 admits a dev build of the worker (no V8
      // sandbox), outside strict mode only, for local development.
      const devInsecure = !strict && process.env.ISOLANE_DEV_INSECURE === '1';
      if (isReady) {
        this.#fail('protocol-violation', 'unexpected ready');
        return false;
      }
      // A build without a secure V8 sandbox is a setup problem, not an
      // attack (a probe only reports it).
      if (!msg.sandboxSecure && !devInsecure && !probe) {
        this.#fail(
          'insufficient-isolation',
          'the worker has no secure V8 sandbox (a development build?); use a release worker, or ISOLANE_DEV_INSECURE=1 with strict: false for local development',
        );
        return false;
      }
      const { t: _, protocol: __, ...info } = msg;
      if (strict && !probe && !meetsStrict(info)) {
        this.#fail('insufficient-isolation', `strict mode: landlock=${info.lockdown.landlock}, seccomp=${info.lockdown.seccomp}`);
        return false;
      }
      isReady = true;
      clearTimeout(readyTimer);
      markReady(info);
      return true;
    };
    const frames = new FrameReader();
    this.#child.stdout.on('data', (chunk: Buffer) => {
      if (!this.#alive) return;
      try {
        for (const frame of frames.push(chunk)) {
          if (!handle(frame)) return;
        }
      } catch (err) {
        if (!(err instanceof FrameError)) throw err;
        this.#fail('protocol-violation', err.message);
      }
    });
    // Keep a little stderr for diagnostics; never parse it.
    this.#child.stderr.on('data', (chunk: Buffer) => {
      this.#stderrTail = (this.#stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    this.#child.on('exit', (code, signal) =>
      exitWith({ code, signal, reason: 'exited', detail: this.#stderrTail.trim() || undefined }),
    );
    this.#child.on('error', (err) => exitWith({ code: null, signal: null, reason: 'exited', detail: err.message }));
    this.#child.stdin.on('error', () => {});
    this.#child.stdin.on('drain', () => {
      clearTimeout(this.#stall);
      this.#stall = undefined;
    });
  }

  /** After a write: hold the worker to reading what it's sent. */
  #checkBacklog(): void {
    const queued = this.#child.stdin.writableLength;
    if (queued > INPUT_MAX) {
      this.#fail('unresponsive', `stopped reading its input (${queued} bytes queued)`);
      return;
    }
    if (queued > INPUT_BACKLOG && !this.#stall) {
      this.#stall = setTimeout(() => {
        const left = this.#child.stdin.writableLength;
        if (left > INPUT_BACKLOG) this.#fail('unresponsive', `stopped reading its input (${left} bytes queued for ${INPUT_STALL_MS}ms)`);
        this.#stall = undefined;
      }, INPUT_STALL_MS);
      this.#stall.unref();
    }
  }

  #fail: (reason: WorkerExit['reason'], detail: string) => void = () => {};

  get alive(): boolean {
    return this.#alive;
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  /** Send a message, with `attached` bytes after its JSON (a binary frame). */
  send(msg: WorkerCommand, attached: Uint8Array[] = []): void {
    if (!this.#alive) return;
    this.#child.stdin.write(encodeFrame(Buffer.from(JSON.stringify(msg, wellFormed), 'utf8'), attached));
    this.#checkBacklog();
  }

  kill(reason: 'killed' | 'unresponsive' | 'protocol-violation' = 'killed', detail = 'stopped by the supervisor'): void {
    this.#fail(reason, detail);
  }
}
