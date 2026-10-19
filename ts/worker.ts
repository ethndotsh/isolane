// One worker process: spawn it, speak the frame protocol, and treat
// everything it sends as hostile. A worker that has run guest code may be
// compromised, so its output is size-capped, parsed as JSON only, and
// shape-checked before anything acts on it.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/** Largest frame accepted from a worker (matches the worker's own cap). */
export const MAX_FRAME = 64 << 20;

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
  | { t: 'result'; req: number; ok: true; value: unknown }
  | { t: 'result'; req: number; ok: false; code: string; message: string }
  | { t: 'hostCall'; vm: number; call: number; name: string; args: unknown[] }
  | { t: 'log'; vm: number; level: LogLevel; message: string };

export type LogLevel = 'log' | 'info' | 'debug' | 'warn' | 'error';
const LOG_LEVELS = new Set<string>(['log', 'info', 'debug', 'warn', 'error']);

/** Exit code a worker uses when it hits its memory limit. */
export const OOM_EXIT_CODE = 6;

const isUint = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Validate a decoded frame's shape; null if it isn't a message we accept. */
export function parseWorkerMessage(raw: unknown): WorkerMessage | null {
  if (raw === null || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
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
      if (m.ok) return { t: 'result', req: m.req, ok: true, value: m.value ?? null };
      return typeof m.code === 'string' && typeof m.message === 'string'
        ? { t: 'result', req: m.req, ok: false, code: m.code, message: m.message }
        : null;
    case 'hostCall':
      return isUint(m.vm) && isUint(m.call) && typeof m.name === 'string' && Array.isArray(m.args)
        ? { t: 'hostCall', vm: m.vm, call: m.call, name: m.name, args: m.args }
        : null;
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

    this.#child.stdout.on('data', (chunk: Buffer) => {
      if (!this.#alive) return;
      this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
      while (this.#buf.length >= 4) {
        const len = this.#buf.readUInt32LE(0);
        if (len > MAX_FRAME) return this.#fail('protocol-violation', `frame of ${len} bytes`);
        if (this.#buf.length < 4 + len) break;
        const body = this.#buf.subarray(4, 4 + len);
        this.#buf = this.#buf.subarray(4 + len);
        let msg: WorkerMessage | null;
        try {
          msg = parseWorkerMessage(JSON.parse(body.toString('utf8')));
        } catch {
          msg = null;
        }
        if (!msg) return this.#fail('protocol-violation', 'malformed message');
        if (msg.t === 'ready') {
          if (isReady || !msg.sandboxSecure) return this.#fail('protocol-violation', 'unexpected ready');
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

  send(msg: object): void {
    if (!this.#alive) return;
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    this.#child.stdin.write(Buffer.concat([header, body]));
  }

  kill(reason: 'killed' | 'unresponsive' = 'killed', detail = 'killed by supervisor'): void {
    this.#fail(reason, detail);
  }
}
