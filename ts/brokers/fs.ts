// The filesystem broker behind the guest's `fs`: paths confined to the
// policy's root (see fs-root.ts), read-only unless writes are allowed.

import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, stat, unlink } from 'node:fs/promises';
import { posix } from 'node:path';

import { DEFAULT_POLICY_LIMITS } from '../config.js';
import { fsRoot, type FsRoot } from '../fs-root.js';
import { NO_REPORTER, type BrokerFunction, type BrokerReporter } from './net.js';

export interface FsPolicy {
  /** Host directory the guest sees as `/`. Nothing outside it is reachable. */
  root: string;
  /** Allow writeFile, mkdir, and rm. Default false (read-only). */
  write?: boolean;
  limits?: {
    /** Largest file the guest may read or write. Default 10 MiB. */
    fileBytes?: number;
    /** Bytes the isolate may write in all, over its life. Default 100 MiB. */
    writtenBytes?: number;
    /** Operations in flight at once (each holds a file handle). Default 16. */
    pendingOperations?: number;
  };
}

/** An fs failure as the guest sees it: a message naming the guest path and
 * a Node-style `code`. */
class FsError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/** Guest-facing messages name guest paths only, never host paths. */
function fsFailure(op: string, path: string, err: unknown): FsError {
  if (err instanceof FsError) return err;
  const code = (err as NodeJS.ErrnoException)?.code;
  const what: Record<string, string> = {
    ENOENT: 'no such file or directory',
    EEXIST: 'already exists',
    ENOTDIR: 'not a directory',
    EISDIR: 'is a directory',
    ENOTEMPTY: 'directory not empty',
    ELOOP: 'is a symbolic link',
    EACCES: 'permission denied',
    EPERM: 'permission denied',
  };
  return new FsError(`fs.${op} ${JSON.stringify(path)}: ${what[code ?? ''] ?? code ?? 'failed'}`, code ?? 'EIO');
}

export function fsBroker(policy: FsPolicy, report: BrokerReporter = NO_REPORTER): BrokerFunction {
  if (!policy || typeof policy.root !== 'string') throw new TypeError('isolane: fs.root must be a directory path');
  const defaults = DEFAULT_POLICY_LIMITS.fs;
  const maxBytes = policy.limits?.fileBytes ?? defaults.fileBytes;
  const maxWritten = policy.limits?.writtenBytes ?? defaults.writtenBytes;
  const maxOperations = policy.limits?.pendingOperations ?? defaults.pendingOperations;
  /** A policy limit reached: reported to `onLimit`, and the guest's error. */
  const overLimit = (name: keyof typeof defaults, message: string, code: string) => {
    report.limit(`fs.limits.${name}`, message);
    return new FsError(message, code);
  };
  let written = 0;
  let running = 0;
  let rootReal: Promise<string> | undefined;
  const outside = (path: string): never => {
    report.denied('fs', path, 'outside the root');
    throw new FsError(`fs: ${JSON.stringify(path)} is outside the root`, 'EACCES');
  };
  // Each operation gets its own view of the root (ts/fs-root.ts), closed
  // when it's done: on Linux, the directories it walked through, held open.
  const confined = async <T>(use: (root: FsRoot) => Promise<T>): Promise<T> => {
    const root = fsRoot(policy.root, (rootReal ??= realpath(policy.root)), outside);
    try {
      return await use(root);
    } finally {
      await root.close();
    }
  };
  // Creating or removing an entry: never the root itself.
  const notRoot = (path: string) => {
    if (posix.normalize('/' + path) === '/') {
      report.denied('fs', path, 'the root itself cannot be replaced or removed');
      throw new FsError('fs: the root itself cannot be replaced or removed', 'EPERM');
    }
  };

  const ops: Record<string, (path: string, arg: unknown) => Promise<unknown>> = {
    readFile: (path) =>
      confined(async (root) => {
        const fh = await open(await root.existing(path), fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
        try {
          const st = await fh.stat();
          if (!st.isFile()) throw new FsError(`fs.readFile ${JSON.stringify(path)}: not a file`, 'EISDIR');
          if (st.size > maxBytes) throw overLimit('fileBytes', `fs.readFile ${JSON.stringify(path)}: larger than ${maxBytes} bytes (fs.limits.fileBytes)`, 'EFBIG');
          return await fh.readFile();
        } finally {
          await fh.close();
        }
      }),
    readdir: (path) => confined(async (root) => (await readdir(await root.existing(path))).sort()),
    stat: (path) =>
      confined(async (root) => {
        const st = await stat(await root.existing(path));
        return { size: st.size, isFile: st.isFile(), isDirectory: st.isDirectory(), mtimeMs: st.mtimeMs };
      }),
    exists: (path) =>
      confined(async (root) => {
        try {
          await root.existing(path);
          return true;
        } catch {
          return false;
        }
      }),
    async writeFile(path, data) {
      if (!(data instanceof Uint8Array)) throw new FsError('fs.writeFile: malformed data', 'EINVAL');
      const bytes = data;
      if (bytes.length > maxBytes) throw overLimit('fileBytes', `fs.writeFile ${JSON.stringify(path)}: larger than ${maxBytes} bytes (fs.limits.fileBytes)`, 'EFBIG');
      if (written + bytes.length > maxWritten) {
        throw overLimit('writtenBytes', `fs.writeFile ${JSON.stringify(path)}: this isolate has written its ${maxWritten} bytes (fs.limits.writtenBytes)`, 'EDQUOT');
      }
      notRoot(path);
      written += bytes.length;
      // O_NOFOLLOW: a symlink at the entry is refused, not written through.
      const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
      await confined(async (root) => {
        const fh = await open(await root.entry(path), flags, 0o644);
        try {
          await fh.writeFile(bytes);
        } finally {
          await fh.close();
        }
      });
    },
    async mkdir(path, recursive) {
      if (recursive !== true) notRoot(path);
      await confined(async (root) => (recursive === true ? root.mkdirp(path) : mkdir(await root.entry(path))));
    },
    async rm(path, recursive) {
      notRoot(path);
      await confined(async (root) => {
        const entry = await root.entry(path);
        const st = await lstat(entry);
        if (!st.isDirectory()) return unlink(entry);
        if (recursive !== true) throw new FsError(`fs.rm ${JSON.stringify(path)}: is a directory`, 'EISDIR');
        await root.rmTree(path);
      });
    },
  };
  const writes = new Set(['writeFile', 'mkdir', 'rm']);

  return async (op: unknown, path: unknown, arg: unknown) => {
    if (typeof op !== 'string' || !Object.hasOwn(ops, op)) throw new FsError('fs: unknown operation', 'EINVAL');
    if (typeof path !== 'string' || path.includes('\0')) throw new FsError(`fs.${op}: path must be a string`, 'EINVAL');
    if (writes.has(op) && policy.write !== true) {
      report.denied('fs', path, `fs.${op}: the filesystem is read-only`);
      throw new FsError(`fs.${op}: the filesystem is read-only`, 'EROFS');
    }
    if (running >= maxOperations) {
      throw overLimit('pendingOperations', `fs.${op}: ${maxOperations} operations are already running (fs.limits.pendingOperations)`, 'EMFILE');
    }
    running++;
    try {
      return await ops[op](path, arg);
    } catch (err) {
      throw fsFailure(op, path, err);
    } finally {
      running--;
    }
  };
}
