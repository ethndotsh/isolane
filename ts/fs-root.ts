// Host paths for the fs broker's guest paths, confined to the policy's root.
//
// On Linux every path is walked one component at a time from an open
// descriptor for the root: each step opens `/proc/self/fd/<dir>/<name>`
// with O_NOFOLLOW, and /proc/self/fd/<dir> is a magic link to the directory
// that descriptor holds, so the step acts like openat(dir, name): the name
// is looked up in that directory, whatever has since happened to the path
// that led to it. A symlink is never followed by the kernel; the walk reads
// it and, if its target stays inside the root, walks the target from the
// root. So a symlink swapped in mid-operation can't redirect anything
// outside: there's no window between checking a path and using it.
//
// Elsewhere (macOS, development only) paths are resolved with realpath and
// then used, which a concurrent symlink writer can race.

import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, realpath, rm, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = fsConstants;
/** Symlinks followed in one lookup, as the kernel allows (MAXSYMLINKS). */
const MAX_LINKS = 40;

/** One operation's view of the root. `close()` releases what it opened. */
export interface FsRoot {
  /** An existing entry, every symlink resolved inside the root. The path names that entry until `close()`. */
  existing(path: string): Promise<string>;
  /** An entry to create or remove: its parent resolved like `existing`, the entry itself never followed. */
  entry(path: string): Promise<string>;
  /** `mkdir -p`, every directory confined like `existing`. */
  mkdirp(path: string): Promise<void>;
  /** Remove a directory and everything in it, never following a symlink inside. */
  rmTree(path: string): Promise<void>;
  close(): Promise<void>;
}

/** `outside(path)` reports and throws for a path whose symlinks lead out of the root. */
export function fsRoot(root: string, rootReal: Promise<string>, outside: (path: string) => never): FsRoot {
  return process.platform === 'linux' ? walkedRoot(root, rootReal, outside) : resolvedRoot(rootReal, outside);
}

const segments = (path: string) => posix.normalize('/' + path).split('/').filter(Boolean);

function walkedRoot(root: string, rootReal: Promise<string>, outside: (path: string) => never): FsRoot {
  const handles: FileHandle[] = [];
  const at = (dir: FileHandle, name?: string) => (name === undefined ? `/proc/self/fd/${dir.fd}` : `/proc/self/fd/${dir.fd}/${name}`);
  const opened = async (path: string, flags: number) => {
    const handle = await open(path, flags);
    handles.push(handle);
    return handle;
  };
  // The root as the host names it (resolve) and as it really is (realpath):
  // an absolute symlink target under either stays inside.
  const prefixes = async () => [...new Set([resolve(root), await rootReal])];

  /** Where a symlink in `dir` (the root-relative `parent`) points, root-relative; `outside` if it leaves the root. */
  const target = async (path: string, dir: FileHandle, parent: string[], name: string) => {
    const link = await readlink(at(dir, name));
    let base = parent;
    let rest = link;
    if (link.startsWith('/')) {
      const prefix = (await prefixes()).find((p) => link === p || link.startsWith(p + sep));
      if (prefix === undefined) outside(path);
      base = [];
      rest = link.slice(prefix.length);
    }
    const out = [...base];
    for (const part of rest.split('/')) {
      if (part === '' || part === '.') continue;
      if (part !== '..') out.push(part);
      else if (out.pop() === undefined) outside(path);
    }
    return out;
  };

  /** Walk `parts` from the root; with `create`, make missing directories on the way. */
  const walk = async (path: string, parts: string[], last: 'any' | 'directory', create = false) => {
    const top = await opened(root, O_RDONLY | O_DIRECTORY);
    let dir = top;
    let here: string[] = [];
    let todo = [...parts];
    let links = 0;
    while (todo.length) {
      const name = todo.shift()!;
      const final = todo.length === 0 && last === 'any';
      // Not O_DIRECTORY at the end: the entry may be a file. O_NONBLOCK so
      // opening a FIFO doesn't wait for a writer.
      const flags = O_RDONLY | O_NOFOLLOW | (final ? O_NONBLOCK : O_DIRECTORY);
      try {
        dir = await opened(at(dir, name), flags);
        here.push(name);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' && create) {
          await mkdir(at(dir, name)).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== 'EEXIST') throw e;
          });
          todo.unshift(name);
          continue;
        }
        // A symlink fails O_NOFOLLOW with ELOOP, or with ENOTDIR when
        // O_DIRECTORY is checked first.
        if (code !== 'ELOOP' && !(code === 'ENOTDIR' && (await lstat(at(dir, name))).isSymbolicLink())) throw err;
        if (++links > MAX_LINKS) throw Object.assign(new Error('too many symbolic links'), { code: 'ELOOP' });
        todo = [...(await target(path, dir, here, name)), ...todo];
        dir = top;
        here = [];
      }
    }
    return dir;
  };

  /** The parent directory of an entry, and the entry's name. */
  const parentOf = async (path: string) => {
    const parts = segments(path);
    const name = parts.pop();
    if (name === undefined) throw Object.assign(new Error('the root has no parent'), { code: 'EPERM' });
    return { dir: await walk(path, parts, 'directory'), name };
  };

  const removeTree = async (parent: FileHandle, name: string): Promise<void> => {
    // O_NOFOLLOW: if the entry is now a symlink, this fails rather than
    // descending into whatever it points to.
    const dir = await opened(at(parent, name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    for (const entry of await readdir(at(dir), { withFileTypes: true })) {
      if (entry.isDirectory()) await removeTree(dir, entry.name);
      else await unlink(at(dir, entry.name)); // unlink removes a symlink itself
    }
    await rmdir(at(parent, name));
  };

  return {
    existing: async (path) => at(await walk(path, segments(path), 'any')),
    entry: async (path) => {
      const { dir, name } = await parentOf(path);
      return at(dir, name);
    },
    mkdirp: async (path) => {
      await walk(path, segments(path), 'directory', true);
    },
    rmTree: async (path) => {
      const { dir, name } = await parentOf(path);
      await removeTree(dir, name);
    },
    close: async () => {
      await Promise.all(handles.splice(0).map((h) => h.close().catch(() => {})));
    },
  };
}

function resolvedRoot(rootReal: Promise<string>, outside: (path: string) => never): FsRoot {
  const inside = (r: string, p: string) => p === r || p.startsWith(r + sep);
  const existing = async (path: string) => {
    const r = await rootReal;
    const real = await realpath(join(r, posix.normalize('/' + path)));
    if (!inside(r, real)) outside(path);
    return real;
  };
  const entry = async (path: string) => {
    const guest = posix.normalize('/' + path);
    return join(await existing(posix.dirname(guest)), posix.basename(guest));
  };
  return {
    existing,
    entry,
    mkdirp: async (path) => {
      // Find the deepest existing ancestor, confine it, create the rest.
      const r = await rootReal;
      let found = posix.normalize('/' + path);
      const missing: string[] = [];
      for (;;) {
        try {
          await realpath(join(r, found));
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          missing.unshift(posix.basename(found));
          found = posix.dirname(found);
        }
      }
      const base = await existing(found);
      if (missing.length) await mkdir(join(base, ...missing), { recursive: true });
    },
    rmTree: async (path) => {
      await rm(await entry(path), { recursive: true });
    },
    close: async () => {},
  };
}
