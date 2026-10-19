// One worker process: spawn it, speak the frame protocol, and treat
// everything it sends as hostile. A worker that has run guest code may be
// compromised, so its output is size-capped, parsed as JSON only, and
// shape-checked before anything acts on it.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import type { PathSegment } from './binary.js';
import type { GuestErrorInfo } from './errors.js';

/** Largest frame accepted from a worker (matches the worker's own cap). */
export const MAX_FRAME = 64 << 20;

/**
 * A frame body is UTF-8 JSON (starting with `{`), or bytes attached to
 * JSON: a 0x00 tag, a u32 little-endian JSON length, the JSON, then raw
 * bytes that the JSON's `bin` field claims, all of them, in order.
 */
const BINARY_TAG = 0;
const BINARY_HEADER = 5;

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
  | ({ t: 'ready' } & IsolationInfo)
  | ({ t: 'result'; req: number; ok: true; value: unknown } & WorkerUsage)
  | ({ t: 'result'; req: number; ok: false; code: string; message: string; guest?: GuestErrorInfo } & WorkerUsage)
  | ({ t: 'usage'; vm: number } & WorkerUsage)
  | { t: 'hostCall'; vm: number; call: number; name: string; args: unknown[] }
  | { t: 'log'; vm: number; level: LogLevel; message: string };

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

const optString = (v: unknown) => (typeof v === 'string' ? v : undefined);

function parseGuestError(raw: unknown): GuestErrorInfo | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const g = raw as Record<string, unknown>;
  if (typeof g.message !== 'string') return undefined;
  const info: GuestErrorInfo = { message: g.message };
  const name = optString(g.name);
  const stack = optString(g.stack);
  if (name !== undefined) info.name = name;
  if (stack !== undefined) info.stack = stack;
  return info;
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
 * host call may have them, and it must claim them all. */
export function parseWorkerMessage(raw: unknown, bytes?: Buffer): WorkerMessage | null {
  if (raw === null || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.bin !== undefined && (m.t !== 'hostCall' || bytes === undefined)) return null;
  if (bytes !== undefined && m.t !== 'hostCall') return null;
  switch (m.t) {
    case 'ready': {
      const l = m.lockdown as Record<string, unknown> | null;
      const level = (v: unknown): v is LockdownLevel => v === 'full' || v === 'partial' || v === 'none';
      return typeof m.v8 === 'string' &&
        typeof m.sandboxSecure === 'boolean' &&
        l !== null &&
        typeof l === 'object' &&
        level(l.landlock) &&
        level(l.seccomp)
        ? { t: 'ready', v8: m.v8, sandboxSecure: m.sandboxSecure, lockdown: { landlock: l.landlock, seccomp: l.seccomp } }
        : null;
    }
    case 'result':
      if (!isUint(m.req) || typeof m.ok !== 'boolean') return null;
      if (m.ok) return { t: 'result', req: m.req, ok: true, value: m.value ?? null, ...parseUsage(m) };
      if (typeof m.code !== 'string' || typeof m.message !== 'string') return null;
      return { t: 'result', req: m.req, ok: false, code: m.code, message: m.message, guest: parseGuestError(m.guest), ...parseUsage(m) };
    case 'usage':
      return isUint(m.vm) ? { t: 'usage', vm: m.vm, ...parseUsage(m) } : null;
    case 'hostCall': {
      if (!(isUint(m.vm) && isUint(m.call) && typeof m.name === 'string' && Array.isArray(m.args))) return null;
      const args = bytes === undefined ? m.args : attachArgs(m.args, m.bin, bytes);
      return args ? { t: 'hostCall', vm: m.vm, call: m.call, name: m.name, args } : null;
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
  reason: 'exited' | 'protocol-violation' | 'insufficient-isolation' | 'ready-timeout' | 'unresponsive' | 'killed';
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

export class WorkerProcess {
  readonly ready: Promise<IsolationInfo>;
  #child: ChildProcessByStdio<Writable, Readable, Readable>;
  #buf: Buffer = Buffer.alloc(0);
  #alive = true;
  #stderrTail = '';

  constructor(workerPath: string, handlers: WorkerHandlers, strict: boolean, memoryLimitBytes?: number) {
    const args = ['--serve'];
    if (memoryLimitBytes !== undefined) args.push(`--memory-limit=${memoryLimitBytes}`);
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
      if (!isReady) failReady(new Error(`worker failed to start: ${exit.detail ?? exit.reason}`));
      handlers.onExit(exit);
    };
    this.#fail = (reason, detail) => {
      exitWith({ code: null, signal: null, reason, detail });
      this.#child.kill('SIGKILL');
    };

    // Chunks of a frame still arriving, joined once it's complete (joining
    // on every chunk would copy a large frame over and over).
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let need = 0;
    this.#child.stdout.on('data', (chunk: Buffer) => {
      if (!this.#alive) return;
      if (need > 0 && pendingBytes + chunk.length < need) {
        pending.push(chunk);
        pendingBytes += chunk.length;
        return;
      }
      if (pending.length) {
        pending.push(chunk);
        chunk = Buffer.concat(pending, pendingBytes + chunk.length);
        pending = [];
        pendingBytes = 0;
      }
      this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
      need = 0;
      while (this.#buf.length >= 4) {
        const len = this.#buf.readUInt32LE(0);
        if (len > MAX_FRAME) return this.#fail('protocol-violation', `frame of ${len} bytes`);
        if (this.#buf.length < 4 + len) {
          // Hold the partial frame until all of it is here.
          need = 4 + len;
          pending = [this.#buf];
          pendingBytes = this.#buf.length;
          this.#buf = Buffer.alloc(0);
          break;
        }
        const body = this.#buf.subarray(4, 4 + len);
        this.#buf = this.#buf.subarray(4 + len);
        let msg: WorkerMessage | null;
        try {
          if (body[0] === BINARY_TAG) {
            if (body.length < BINARY_HEADER) throw new Error('truncated binary frame');
            const jsonLen = body.readUInt32LE(1);
            if (jsonLen > body.length - BINARY_HEADER) throw new Error('binary frame JSON overruns the frame');
            const json = body.subarray(BINARY_HEADER, BINARY_HEADER + jsonLen).toString('utf8');
            // Copied: host functions may keep these bytes, and they shouldn't
            // keep the rest of the stream's buffer alive.
            const bytes = Buffer.from(body.subarray(BINARY_HEADER + jsonLen));
            msg = parseWorkerMessage(JSON.parse(json), bytes);
          } else {
            msg = parseWorkerMessage(JSON.parse(body.toString('utf8')));
          }
        } catch {
          msg = null;
        }
        if (!msg) return this.#fail('protocol-violation', 'malformed message');
        if (msg.t === 'ready') {
          // ISOLANE_DEV_INSECURE=1 admits a dev build of the worker (no V8
          // sandbox), outside strict mode only, for local development.
          const devInsecure = !strict && process.env.ISOLANE_DEV_INSECURE === '1';
          if (isReady || (!msg.sandboxSecure && !devInsecure)) return this.#fail('protocol-violation', 'unexpected ready');
          const { t: _, ...info } = msg;
          if (strict && !meetsStrict(info)) {
            return this.#fail(
              'insufficient-isolation',
              `strict mode: landlock=${info.lockdown.landlock}, seccomp=${info.lockdown.seccomp}`,
            );
          }
          isReady = true;
          clearTimeout(readyTimer);
          markReady(info);
        } else if (!isReady) {
          return this.#fail('protocol-violation', 'message before ready');
        } else {
          handlers.onMessage(msg);
        }
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
  }

  #fail: (reason: WorkerExit['reason'], detail: string) => void = () => {};

  get alive(): boolean {
    return this.#alive;
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  /** Send a message, with `attached` bytes after its JSON (a binary frame). */
  send(msg: object, attached: Uint8Array[] = []): void {
    if (!this.#alive) return;
    const json = Buffer.from(JSON.stringify(msg, wellFormed), 'utf8');
    if (attached.length === 0) {
      const header = Buffer.alloc(4);
      header.writeUInt32LE(json.length, 0);
      this.#child.stdin.write(Buffer.concat([header, json]));
      return;
    }
    const bytes = attached.reduce((n, b) => n + b.length, 0);
    const header = Buffer.alloc(4 + BINARY_HEADER);
    header.writeUInt32LE(BINARY_HEADER + json.length + bytes, 0);
    header[4] = BINARY_TAG;
    header.writeUInt32LE(json.length, 5);
    this.#child.stdin.write(Buffer.concat([header, json, ...attached]));
  }

  /** Whether a message of `json` bytes plus `attached` bytes fits in a frame. */
  static fits(json: number, attached: number): boolean {
    return json + attached + (attached > 0 ? BINARY_HEADER : 0) <= MAX_FRAME;
  }

  kill(reason: 'killed' | 'unresponsive' = 'killed', detail = 'killed by supervisor'): void {
    this.#fail(reason, detail);
  }
}
