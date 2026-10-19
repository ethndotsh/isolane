// Network and filesystem access for guest code, brokered by the supervisor.
// The worker can't open sockets or files (seccomp, Landlock); a VM given a
// policy gets `fetch` or `fs` globals that are host calls, and this module
// checks every request against the policy before doing it on the guest's
// behalf. A policy is only as wide as it says: the defaults are no network
// and no files.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { join, posix, sep } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HostFunction = (...args: any[]) => unknown;

const MiB = 1 << 20;

// ---- network ----

export interface NetworkPolicy {
  /**
   * Hostnames the guest may fetch from: exact (`api.example.com`) or any
   * subdomain (`*.example.com`, not the apex). Ports aren't restricted.
   * Or a function that decides each request (and each redirect hop).
   */
  allow: readonly string[] | ((url: URL, method: string) => boolean | Promise<boolean>);
  /** Allowed methods. Default: GET, HEAD, POST, PUT, PATCH, DELETE. */
  methods?: readonly string[];
  /**
   * Allow addresses that aren't on the public internet: loopback, private
   * ranges, link-local (cloud metadata at 169.254.169.254), CGNAT, and so
   * on. Default false, checked on the addresses actually connected to, so
   * DNS can't be used to point an allowed name at them.
   */
  allowPrivateNetworks?: boolean;
  /** Per response body. Default 10 MiB. */
  maxResponseBytes?: number;
  /** Per request body. Default 10 MiB. */
  maxRequestBytes?: number;
  /** Per fetch, across redirects. Default 30 s. */
  timeoutMs?: number;
  /** Default 5. Each hop is checked against the policy. */
  maxRedirects?: number;
  /** Fetches per VM over its lifetime. Default unlimited. */
  maxRequests?: number;
}

const DEFAULT_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
// Headers the broker controls; a guest's values are dropped.
const DROPPED_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
]);

// Separate lists: a BlockList also checks IPv4 addresses against IPv6 rules
// (as IPv4-mapped), and ::ffff:0:0/96 would then match every IPv4 address.
const NON_PUBLIC_V4 = new BlockList();
const NON_PUBLIC_V6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC_V4.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback, IPv4-compatible
  ['::ffff:0:0', 96], // IPv4-mapped
  ['64:ff9b::', 96], // NAT64
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC_V6.addSubnet(net, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return family === 4 ? !NON_PUBLIC_V4.check(address, 'ipv4') : !NON_PUBLIC_V6.check(address, 'ipv6');
}

type LookupCallback = (err: Error | null, address: string | LookupAddress[], family?: number) => void;

/** A `lookup` for http/net/tls that only returns addresses the policy
 * allows, so the address checked is the address connected to. */
function pinnedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { family?: number | string; all?: boolean }, cb: LookupCallback) => {
    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : Number(options.family) || 0;
    dnsLookup(hostname, { all: true, family }, (err, addresses) => {
      if (err) return cb(err, []);
      const usable = allowPrivate ? addresses : addresses.filter((a) => isPublicAddress(a.address));
      if (usable.length === 0) return cb(new Error(`${hostname} has no public address`), []);
      if (options.all) cb(null, usable);
      else cb(null, usable[0].address, usable[0].family);
    });
  };
}

function hostAllowed(patterns: readonly string[], host: string): boolean {
  return patterns.some((p) => {
    const pattern = p.toLowerCase();
    return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern;
  });
}

interface FetchRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body?: string; // base64
}

interface FetchResponse {
  status: number;
  statusText: string;
  url: string;
  redirected: boolean;
  headers: [string, string][];
  body: string; // base64
}

function parseFetchRequest(raw: unknown): FetchRequest {
  const r = raw as Partial<FetchRequest> | null;
  const ok =
    r !== null &&
    typeof r === 'object' &&
    typeof r.url === 'string' &&
    typeof r.method === 'string' &&
    Array.isArray(r.headers) &&
    r.headers.every((h) => Array.isArray(h) && h.length === 2 && typeof h[0] === 'string' && typeof h[1] === 'string') &&
    (r.body === undefined || typeof r.body === 'string');
  if (!ok) throw new TypeError('fetch: malformed request');
  return r as FetchRequest;
}

export function networkBroker(policy: NetworkPolicy): HostFunction {
  if (!policy || (!Array.isArray(policy.allow) && typeof policy.allow !== 'function')) {
    throw new TypeError('isolane: network.allow must be a list of hostnames or a function');
  }
  const methods = new Set((policy.methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase()));
  const maxResponse = policy.maxResponseBytes ?? 10 * MiB;
  const maxRequest = policy.maxRequestBytes ?? 10 * MiB;
  const timeoutMs = policy.timeoutMs ?? 30_000;
  const maxRedirects = policy.maxRedirects ?? 5;
  const allowPrivate = policy.allowPrivateNetworks === true;
  let requests = 0;

  const lookup = pinnedLookup(allowPrivate);

  const check = async (url: URL, method: string) => {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new TypeError(`fetch: ${url.protocol} URLs are not supported`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && isIP(host) && !isPublicAddress(host)) {
      throw new Error(`fetch to ${url.origin} is not allowed: not a public address`);
    }
    const allowed =
      typeof policy.allow === 'function' ? await policy.allow(new URL(url), method) : hostAllowed(policy.allow, host);
    if (allowed !== true) throw new Error(`fetch to ${url.origin} is not allowed by the network policy`);
  };

  const once = (url: URL, method: string, headers: Record<string, string>, body: Buffer | undefined, deadline: number) =>
    new Promise<{ status: number; statusText: string; headers: [string, string][]; body: Buffer }>((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return reject(new Error('fetch timed out'));
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(url, {
        method,
        headers,
        lookup: lookup as never,
        agent: false,
        signal: AbortSignal.timeout(remaining),
      });
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooBig = false;
        res.on('data', (chunk: Buffer) => {
          if (tooBig) return;
          size += chunk.length;
          if (size > maxResponse) {
            tooBig = true;
            reject(new Error(`response larger than ${maxResponse} bytes`));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (tooBig) return;
          const pairs: [string, string][] = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]]);
          resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', headers: pairs, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      });
      req.on('error', (err) => reject(err.name === 'AbortError' ? new Error('fetch timed out') : err));
      req.end(body);
    });

  return async (raw: unknown): Promise<FetchResponse> => {
    const r = parseFetchRequest(raw);
    if (policy.maxRequests !== undefined && requests >= policy.maxRequests) {
      throw new Error(`fetch: this VM has used its ${policy.maxRequests} requests`);
    }
    requests++;
    let url: URL;
    try {
      url = new URL(r.url);
    } catch {
      throw new TypeError(`fetch: invalid URL ${JSON.stringify(r.url.slice(0, 200))}`);
    }
    let method = r.method.toUpperCase();
    if (!methods.has(method)) throw new TypeError(`fetch: method ${method} is not allowed`);
    let body = r.body === undefined ? undefined : Buffer.from(r.body, 'base64');
    if (body && body.length > maxRequest) throw new Error(`fetch: request body larger than ${maxRequest} bytes`);
    const headers: Record<string, string> = {};
    for (const [k, v] of r.headers) {
      const name = k.toLowerCase();
      if (DROPPED_HEADERS.has(name)) continue;
      headers[name] = name in headers ? `${headers[name]}, ${v}` : v;
    }
    headers['accept-encoding'] ??= 'identity';
    const deadline = Date.now() + timeoutMs;

    for (let hop = 0; ; hop++) {
      await check(url, method);
      let res;
      try {
        res = await once(url, method, headers, body, deadline);
      } catch (err) {
        throw new Error(`fetch to ${url.origin} failed: ${(err as Error).message}`);
      }
      const location = res.headers.find(([k]) => k === 'location')?.[1];
      if ([301, 302, 303, 307, 308].includes(res.status) && location !== undefined) {
        if (hop >= maxRedirects) throw new Error(`fetch: more than ${maxRedirects} redirects`);
        url = new URL(location, url);
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
          delete headers['content-type'];
        }
        // Credentials don't follow a redirect to another origin.
        delete headers['authorization'];
        delete headers['cookie'];
        continue;
      }
      return {
        status: res.status,
        statusText: res.statusText,
        url: url.href,
        redirected: hop > 0,
        headers: res.headers,
        body: res.body.toString('base64'),
      };
    }
  };
}

// ---- sockets ----

export interface SocketPolicy {
  /**
   * `host:port` pairs the guest may connect to: `db.example.com:5432`,
   * `*.example.com:443` (subdomains), `cache.example.com:*` (any port), or
   * `[2001:db8::1]:80`. Or a function deciding each connection.
   */
  allow: readonly string[] | ((hostname: string, port: number) => boolean | Promise<boolean>);
  /** As for `NetworkPolicy`: non-public addresses are refused by default. */
  allowPrivateNetworks?: boolean;
  /** Sockets a VM may have open at once. Default 8. */
  maxConnections?: number;
  /** Default 10 s. */
  connectTimeoutMs?: number;
  /** Close a socket with no traffic for this long. Default 60 s. */
  idleTimeoutMs?: number;
}

/** Buffered, unread bytes per socket before reading from the network pauses. */
const SOCKET_HIGH_WATER = 1 * MiB;

function socketAllowed(patterns: readonly string[], host: string, port: number): boolean {
  return patterns.some((p) => {
    const at = p.lastIndexOf(':');
    if (at <= 0) return false;
    const hostPattern = p.slice(0, at).replace(/^\[|\]$/g, '').toLowerCase();
    const portPattern = p.slice(at + 1);
    if (portPattern !== '*' && Number(portPattern) !== port) return false;
    return hostPattern.startsWith('*.') ? host.endsWith(hostPattern.slice(1)) : host === hostPattern;
  });
}

interface GuestSocket {
  socket: Socket;
  chunks: Buffer[];
  buffered: number;
  ended: boolean;
  error?: Error;
  wake?: () => void;
}

export function socketBroker(policy: SocketPolicy): { fn: HostFunction; dispose: () => void } {
  if (!policy || (!Array.isArray(policy.allow) && typeof policy.allow !== 'function')) {
    throw new TypeError('isolane: sockets.allow must be a list of host:port patterns or a function');
  }
  const allowPrivate = policy.allowPrivateNetworks === true;
  const lookup = pinnedLookup(allowPrivate);
  const maxConnections = policy.maxConnections ?? 8;
  const connectTimeoutMs = policy.connectTimeoutMs ?? 10_000;
  const idleTimeoutMs = policy.idleTimeoutMs ?? 60_000;
  const sockets = new Map<number, GuestSocket>();
  let nextId = 1;
  let disposed = false;

  const get = (id: unknown) => {
    const s = typeof id === 'number' ? sockets.get(id) : undefined;
    if (!s) throw new Error('socket is closed');
    return s;
  };

  const open = async (raw: unknown) => {
    const r = raw as { hostname?: unknown; port?: unknown; tls?: unknown } | null;
    if (!r || typeof r.hostname !== 'string' || !Number.isInteger(r.port) || (r.port as number) < 1 || (r.port as number) > 65535) {
      throw new TypeError('connect: expected a hostname and a port from 1 to 65535');
    }
    const host = r.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = r.port as number;
    if (sockets.size >= maxConnections) throw new Error(`connect: this VM already has ${maxConnections} sockets open`);
    if (!allowPrivate && isIP(host) && !isPublicAddress(host)) {
      throw new Error(`connect to ${host}:${port} is not allowed: not a public address`);
    }
    const allowed = typeof policy.allow === 'function' ? await policy.allow(host, port) : socketAllowed(policy.allow, host, port);
    if (allowed !== true) throw new Error(`connect to ${host}:${port} is not allowed by the socket policy`);

    const socket = await new Promise<Socket>((resolve, reject) => {
      const s =
        r.tls === true
          ? tlsConnect({ host, port, servername: isIP(host) ? undefined : host, lookup: lookup as never })
          : netConnect({ host, port, lookup: lookup as never });
      const timer = setTimeout(() => s.destroy(new Error('timed out')), connectTimeoutMs);
      s.once(r.tls === true ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        s.removeAllListeners('error');
        resolve(s);
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`connect to ${host}:${port} failed: ${err.message}`));
      });
    });
    if (disposed) {
      socket.destroy();
      throw new Error('socket is closed');
    }
    const id = nextId++;
    const g: GuestSocket = { socket, chunks: [], buffered: 0, ended: false };
    const wake = () => {
      const w = g.wake;
      g.wake = undefined;
      w?.();
    };
    socket.on('data', (chunk: Buffer) => {
      g.chunks.push(chunk);
      g.buffered += chunk.length;
      if (g.buffered >= SOCKET_HIGH_WATER) socket.pause();
      wake();
    });
    socket.on('end', () => {
      g.ended = true;
      wake();
    });
    socket.on('error', (err) => {
      g.error = err;
      wake();
    });
    socket.on('close', () => {
      g.ended = true;
      wake();
    });
    socket.setTimeout(idleTimeoutMs, () => socket.destroy(new Error('idle timeout')));
    sockets.set(id, g);
    return id;
  };

  const read = async (id: unknown) => {
    const g = get(id);
    if (g.wake) throw new Error('socket.read: another read is already waiting');
    while (g.chunks.length === 0 && !g.ended && !g.error) {
      await new Promise<void>((r) => (g.wake = r));
    }
    if (g.chunks.length) {
      const data = Buffer.concat(g.chunks);
      g.chunks = [];
      g.buffered = 0;
      g.socket.resume();
      return data.toString('base64');
    }
    if (g.error) throw new Error(`socket error: ${g.error.message}`);
    return null; // end of stream
  };

  const write = async (id: unknown, data: unknown) => {
    const g = get(id);
    if (typeof data !== 'string') throw new TypeError('socket.write: malformed data');
    if (g.error) throw new Error(`socket error: ${g.error.message}`);
    await new Promise<void>((resolve, reject) =>
      g.socket.write(Buffer.from(data, 'base64'), (err) => (err ? reject(new Error(`socket error: ${err.message}`)) : resolve())),
    );
  };

  const close = async (id: unknown) => {
    const g = typeof id === 'number' ? sockets.get(id) : undefined;
    if (!g) return;
    sockets.delete(id as number);
    g.socket.destroy();
    g.ended = true;
    const w = g.wake;
    g.wake = undefined;
    w?.();
  };

  const fn: HostFunction = (op: unknown, ...args: unknown[]) => {
    if (op === 'open') return open(args[0]);
    if (op === 'read') return read(args[0]);
    if (op === 'write') return write(args[0], args[1]);
    if (op === 'close') return close(args[0]);
    throw new TypeError('socket: unknown operation');
  };
  const dispose = () => {
    disposed = true;
    for (const id of [...sockets.keys()]) void close(id);
  };
  return { fn, dispose };
}

// ---- filesystem ----

export interface FsPolicy {
  /** Host directory the guest sees as `/`. Nothing outside it is reachable. */
  root: string;
  /** Allow writeFile, mkdir, and rm. Default false (read-only). */
  write?: boolean;
  /** Largest file the guest may read or write. Default 10 MiB. */
  maxFileBytes?: number;
}

class FsError extends Error {}

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
  return new FsError(`fs.${op} ${JSON.stringify(path)}: ${what[code ?? ''] ?? code ?? 'failed'}`);
}

export function fsBroker(policy: FsPolicy): HostFunction {
  if (!policy || typeof policy.root !== 'string') throw new TypeError('isolane: fs.root must be a directory path');
  const maxBytes = policy.maxFileBytes ?? 10 * MiB;
  let rootReal: Promise<string> | undefined;
  const root = () => (rootReal ??= realpath(policy.root));
  const inside = (r: string, p: string) => p === r || p.startsWith(r + sep);

  // The host path for a guest path, with every symlink resolved, refused if
  // it lands outside the root. Guests can't create symlinks, but the root
  // may already contain some.
  const resolveExisting = async (path: string) => {
    const r = await root();
    const real = await realpath(join(r, posix.normalize('/' + path)));
    if (!inside(r, real)) throw new FsError(`fs: ${JSON.stringify(path)} is outside the root`);
    return real;
  };
  // For creating or removing an entry: its parent must resolve inside the
  // root, and the entry itself is never followed if it's a symlink.
  const resolveEntry = async (path: string) => {
    const guest = posix.normalize('/' + path);
    if (guest === '/') throw new FsError('fs: the root itself cannot be replaced or removed');
    const parent = await resolveExisting(posix.dirname(guest));
    return join(parent, posix.basename(guest));
  };

  const ops: Record<string, (path: string, arg: unknown) => Promise<unknown>> = {
    async readFile(path) {
      const fh = await open(await resolveExisting(path), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const st = await fh.stat();
        if (!st.isFile()) throw new FsError(`fs.readFile ${JSON.stringify(path)}: not a file`);
        if (st.size > maxBytes) throw new FsError(`fs.readFile ${JSON.stringify(path)}: larger than ${maxBytes} bytes`);
        return (await fh.readFile()).toString('base64');
      } finally {
        await fh.close();
      }
    },
    async readdir(path) {
      return (await readdir(await resolveExisting(path))).sort();
    },
    async stat(path) {
      const st = await stat(await resolveExisting(path));
      return { size: st.size, isFile: st.isFile(), isDirectory: st.isDirectory(), mtimeMs: st.mtimeMs };
    },
    async exists(path) {
      try {
        await resolveExisting(path);
        return true;
      } catch {
        return false;
      }
    },
    async writeFile(path, data) {
      if (typeof data !== 'string') throw new FsError('fs.writeFile: malformed data');
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length > maxBytes) throw new FsError(`fs.writeFile ${JSON.stringify(path)}: larger than ${maxBytes} bytes`);
      const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
      const fh = await open(await resolveEntry(path), flags, 0o644);
      try {
        await fh.writeFile(bytes);
      } finally {
        await fh.close();
      }
    },
    async mkdir(path, recursive) {
      if (recursive !== true) {
        await mkdir(await resolveEntry(path));
        return;
      }
      // Find the deepest existing ancestor, confine it, create the rest.
      const r = await root();
      let existing = posix.normalize('/' + path);
      const missing: string[] = [];
      for (;;) {
        try {
          await lstat(join(r, existing));
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          missing.unshift(posix.basename(existing));
          existing = posix.dirname(existing);
        }
      }
      const base = await resolveExisting(existing);
      if (missing.length) await mkdir(join(base, ...missing), { recursive: true });
    },
    async rm(path, recursive) {
      const entry = await resolveEntry(path);
      const st = await lstat(entry);
      if (st.isDirectory() && recursive !== true) throw new FsError(`fs.rm ${JSON.stringify(path)}: is a directory`);
      await rm(entry, { recursive: recursive === true });
    },
  };
  const writes = new Set(['writeFile', 'mkdir', 'rm']);

  return async (op: unknown, path: unknown, arg: unknown) => {
    if (typeof op !== 'string' || !Object.hasOwn(ops, op)) throw new FsError('fs: unknown operation');
    if (typeof path !== 'string' || path.includes('\0')) throw new FsError(`fs.${op}: path must be a string`);
    if (writes.has(op) && policy.write !== true) throw new FsError(`fs.${op}: the filesystem is read-only`);
    try {
      return await ops[op](path, arg);
    } catch (err) {
      throw fsFailure(op, path, err);
    }
  };
}

// ---- guest side ----

export const FETCH_HOST_FUNCTION = '__isolane_fetch';
export const FS_HOST_FUNCTION = '__isolane_fs';
export const SOCKET_HOST_FUNCTION = '__isolane_socket';

/**
 * Trusted setup the worker runs in a VM's context before any guest code:
 * wraps the raw host functions in `fetch`/`Response`/`Headers` and `fs`,
 * then deletes the raw ones. Plain ECMAScript (no TextEncoder or atob), so
 * it carries its own UTF-8 and base64. Guest code can tamper with these
 * wrappers, which only affects itself: the brokers above validate every
 * request on their own.
 */
export const PRELUDE = String.raw`(() => {
  'use strict';
  const g = globalThis;
  const rawFetch = g.${FETCH_HOST_FUNCTION};
  const rawFs = g.${FS_HOST_FUNCTION};
  const rawSocket = g.${SOCKET_HOST_FUNCTION};
  delete g.${FETCH_HOST_FUNCTION};
  delete g.${FS_HOST_FUNCTION};
  delete g.${SOCKET_HOST_FUNCTION};

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64_INDEX = new Uint8Array(128);
  for (let i = 0; i < 64; i++) B64_INDEX[B64.charCodeAt(i)] = i;
  const toBase64 = (bytes) => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
    }
    return out;
  };
  const fromBase64 = (s) => {
    const len = s.length;
    const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
    const out = new Uint8Array((len / 4) * 3 - pad);
    for (let i = 0, j = 0; i < len; i += 4) {
      const n = (B64_INDEX[s.charCodeAt(i)] << 18) | (B64_INDEX[s.charCodeAt(i + 1)] << 12) | (B64_INDEX[s.charCodeAt(i + 2)] << 6) | B64_INDEX[s.charCodeAt(i + 3)];
      out[j++] = n >> 16;
      if (j < out.length) out[j++] = (n >> 8) & 255;
      if (j < out.length) out[j++] = n & 255;
    }
    return out;
  };
  const utf8Encode = (str) => {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
        const d = str.charCodeAt(i + 1);
        if (d >= 0xdc00 && d < 0xe000) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        }
      }
      if (c >= 0xd800 && c < 0xe000) c = 0xfffd;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  };
  const utf8Decode = (b) => {
    let out = '';
    for (let i = 0; i < b.length; ) {
      const c = b[i];
      const need = c < 0x80 ? 0 : c >= 0xc2 && c < 0xe0 ? 1 : c >= 0xe0 && c < 0xf0 ? 2 : c >= 0xf0 && c < 0xf5 ? 3 : -1;
      let cp = need === 0 ? c : need === 1 ? c & 31 : need === 2 ? c & 15 : c & 7;
      let ok = need >= 0 && i + need < b.length;
      for (let k = 1; ok && k <= need; k++) {
        if ((b[i + k] & 0xc0) !== 0x80) ok = false;
        else cp = (cp << 6) | (b[i + k] & 63);
      }
      if (ok && ((need === 2 && (cp < 0x800 || (cp >= 0xd800 && cp < 0xe000))) || (need === 3 && (cp < 0x10000 || cp > 0x10ffff)))) ok = false;
      if (!ok) {
        out += '�';
        i++;
        continue;
      }
      out += String.fromCodePoint(cp);
      i += need + 1;
    }
    return out;
  };
  const toBytes = (data) => {
    if (typeof data === 'string') return utf8Encode(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return utf8Encode(String(data));
  };

  if (rawFetch) {
    class Headers {
      #map = new Map();
      constructor(init) {
        if (init == null) return;
        const pairs = init instanceof Headers ? [...init] : Array.isArray(init) ? init : Object.entries(init);
        for (const [k, v] of pairs) this.append(k, v);
      }
      append(k, v) {
        k = String(k).toLowerCase();
        v = String(v);
        this.#map.set(k, this.#map.has(k) ? this.#map.get(k) + ', ' + v : v);
      }
      set(k, v) { this.#map.set(String(k).toLowerCase(), String(v)); }
      get(k) { return this.#map.get(String(k).toLowerCase()) ?? null; }
      has(k) { return this.#map.has(String(k).toLowerCase()); }
      delete(k) { this.#map.delete(String(k).toLowerCase()); }
      forEach(fn, self) { for (const [k, v] of this) fn.call(self, v, k, this); }
      *entries() { yield* [...this.#map].sort((a, b) => (a[0] < b[0] ? -1 : 1)); }
      *keys() { for (const [k] of this.entries()) yield k; }
      *values() { for (const [, v] of this.entries()) yield v; }
      [Symbol.iterator]() { return this.entries(); }
    }
    class Response {
      #body;
      #used = false;
      constructor(r) {
        this.status = r.status;
        this.statusText = r.statusText;
        this.ok = r.status >= 200 && r.status < 300;
        this.url = r.url;
        this.redirected = r.redirected;
        this.headers = new Headers(r.headers);
        this.#body = r.body;
      }
      get bodyUsed() { return this.#used; }
      #take() {
        if (this.#used) return Promise.reject(new TypeError('body already used'));
        this.#used = true;
        return Promise.resolve(fromBase64(this.#body));
      }
      bytes() { return this.#take(); }
      arrayBuffer() { return this.#take().then((b) => b.buffer); }
      text() { return this.#take().then(utf8Decode); }
      json() { return this.text().then(JSON.parse); }
    }
    g.Headers = Headers;
    g.Response = Response;
    g.fetch = async function fetch(input, init = {}) {
      const url = typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : String(input);
      const headers = [...new Headers(init.headers)];
      const body = init.body == null ? undefined : toBase64(toBytes(init.body));
      return new Response(await rawFetch({ url, method: String(init.method ?? 'GET'), headers, body }));
    };
  }

  if (rawSocket) {
    g.connect = async function connect(address, options = {}) {
      let hostname, port;
      if (typeof address === 'string') {
        const at = address.lastIndexOf(':');
        hostname = address.slice(0, at);
        port = Number(address.slice(at + 1));
      } else {
        hostname = address?.hostname;
        port = Number(address?.port);
      }
      const tls = options.secureTransport === 'on';
      const id = await rawSocket('open', { hostname, port, tls });
      return Object.freeze({
        async read() {
          const data = await rawSocket('read', id);
          return data === null ? null : fromBase64(data);
        },
        write: (data) => rawSocket('write', id, toBase64(toBytes(data))),
        close: () => rawSocket('close', id),
      });
    };
  }

  if (rawFs) {
    const encodingOf = (options) => (typeof options === 'string' ? options : options?.encoding);
    g.fs = Object.freeze({
      async readFile(path, options) {
        const bytes = fromBase64(await rawFs('readFile', path));
        const enc = encodingOf(options);
        if (enc == null) return bytes;
        if (enc === 'utf8' || enc === 'utf-8') return utf8Decode(bytes);
        throw new TypeError('fs.readFile: unsupported encoding ' + enc);
      },
      writeFile: (path, data) => rawFs('writeFile', path, toBase64(toBytes(data))),
      readdir: (path) => rawFs('readdir', path),
      stat: (path) => rawFs('stat', path),
      exists: (path) => rawFs('exists', path),
      mkdir: (path, options) => rawFs('mkdir', path, options?.recursive === true),
      rm: (path, options) => rawFs('rm', path, options?.recursive === true),
    });
  }
})();`;

export interface Capabilities {
  hostFunctions: Record<string, HostFunction>;
  prelude?: string;
  /** Release what the VM holds open (sockets) when it goes away. */
  dispose(): void;
}

/** The host functions, setup script, and cleanup for a VM's policies. */
export function capabilities(
  opts: { network?: NetworkPolicy; fs?: FsPolicy; sockets?: SocketPolicy; globals?: Record<string, unknown> },
  userHostFunctions: Record<string, HostFunction>,
): Capabilities {
  const hostFunctions: Record<string, HostFunction> = {};
  const reserved = new Set<string>();
  const disposers: (() => void)[] = [];
  if (opts.network) {
    hostFunctions[FETCH_HOST_FUNCTION] = networkBroker(opts.network);
    for (const n of ['fetch', 'Headers', 'Response']) reserved.add(n);
  }
  if (opts.fs) {
    hostFunctions[FS_HOST_FUNCTION] = fsBroker(opts.fs);
    reserved.add('fs');
  }
  if (opts.sockets) {
    const broker = socketBroker(opts.sockets);
    hostFunctions[SOCKET_HOST_FUNCTION] = broker.fn;
    disposers.push(broker.dispose);
    reserved.add('connect');
  }
  for (const name of Object.keys(userHostFunctions)) {
    if (reserved.has(name) || name.startsWith('__isolane_')) {
      throw new TypeError(`isolane: host function name ${name} is reserved by the network, fs, or sockets policy`);
    }
  }
  let prelude = reserved.size ? PRELUDE : '';
  if (opts.globals !== undefined) {
    if (opts.globals === null || typeof opts.globals !== 'object') throw new TypeError('isolane: globals must be an object');
    for (const name of Object.keys(opts.globals)) {
      if (name === '__proto__' || reserved.has(name) || Object.hasOwn(userHostFunctions, name)) {
        throw new TypeError(`isolane: global name ${name} is reserved or already a host function`);
      }
    }
    // JSON text inside a JS string literal: values arrive as plain data.
    const json = JSON.stringify(opts.globals);
    if (json === undefined) throw new TypeError('isolane: globals must be JSON-serializable');
    prelude = `Object.assign(globalThis, JSON.parse(${JSON.stringify(json)}));\n` + prelude;
  }
  return {
    hostFunctions,
    prelude: prelude || undefined,
    dispose: () => disposers.forEach((d) => d()),
  };
}
