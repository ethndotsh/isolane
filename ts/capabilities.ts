// Network and filesystem access for guest code, brokered by the supervisor.
// The worker can't open sockets or files (seccomp, Landlock); an isolate
// given a policy gets `fetch`, `connect`, or `fs` globals that are host
// calls, and this module checks every request against the policy before
// doing it on the guest's behalf. A policy is named for the guest API it
// enables and is only as wide as it says: by default there are none.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, connect as netConnect, isIP, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import { join, posix, sep } from 'node:path';

import { internalEntry, type HostEntry } from './host.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HostFunction = (...args: any[]) => unknown;

/** Called when a policy refuses a request (for `onPolicyDenial`). */
export type DenialReporter = (api: 'fetch' | 'connect' | 'fs', target: string, reason: string) => void;

const MiB = 1 << 20;

// ---- network ----

export interface FetchPolicy {
  /**
   * Hostnames the guest may fetch from: exact (`api.example.com`) or any
   * subdomain (`*.example.com`, not the apex). Ports aren't restricted.
   * Or a function that decides each request (and each redirect hop).
   */
  hosts: readonly string[] | ((url: URL, method: string) => boolean | Promise<boolean>);
  /** Allowed methods. Default: GET, HEAD, POST, PUT, PATCH, DELETE. */
  methods?: readonly string[];
  /**
   * Allow addresses that aren't on the public internet: loopback, private
   * ranges, link-local (cloud metadata at 169.254.169.254), CGNAT, and so
   * on. Default false, checked on the addresses actually connected to, so
   * DNS can't be used to point an allowed name at them.
   */
  privateNetworks?: boolean;
  limits?: {
    /** Fetches per isolate over its lifetime. Default unlimited. */
    requests?: number;
    /** Per request body, streamed or not. Default 10 MiB. */
    requestBytes?: number;
    /** Per response body. Default 10 MiB. */
    responseBytes?: number;
    /** Default 5. Each hop is checked against the policy. */
    redirects?: number;
    /** Per fetch, across redirects, body included. Default 30 s. */
    timeoutMs?: number;
  };
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
 * allows, so the address checked is the address connected to. `refused`
 * hears when a name resolves only to addresses it doesn't. */
function pinnedLookup(allowPrivate: boolean, refused: () => void) {
  return (hostname: string, options: { family?: number | string; all?: boolean }, cb: LookupCallback) => {
    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : Number(options.family) || 0;
    dnsLookup(hostname, { all: true, family }, (err, addresses) => {
      if (err) return cb(err, []);
      const usable = allowPrivate ? addresses : addresses.filter((a) => isPublicAddress(a.address));
      if (usable.length === 0) {
        refused();
        return cb(new Error(`${hostname} has no public address`), []);
      }
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

/** What the guest asks to fetch (the body, if any, is a separate byte argument). */
interface FetchMeta {
  url: string;
  method: string;
  headers: [string, string][];
  /** Fetch's redirect mode: the broker follows redirects itself, re-checking each hop. */
  redirect: 'follow' | 'manual' | 'error';
  /** The body is a stream the guest sends with `write` while `open` waits. */
  streamBody?: boolean;
}

/** A response's status and headers; its body is read with `read`. */
interface FetchHead {
  status: number;
  statusText: string;
  url: string;
  /** Every URL fetched, in order (one per redirect hop). */
  urlList: string[];
  redirected: boolean;
  headers: [string, string][];
}

const REDIRECT_MODES = new Set(['follow', 'manual', 'error']);

function parseFetchMeta(raw: unknown): FetchMeta {
  const r = raw as Partial<FetchMeta> | null;
  const ok =
    r !== null &&
    typeof r === 'object' &&
    typeof r.url === 'string' &&
    typeof r.method === 'string' &&
    Array.isArray(r.headers) &&
    r.headers.every((h) => Array.isArray(h) && h.length === 2 && typeof h[0] === 'string' && typeof h[1] === 'string') &&
    (r.redirect === undefined || REDIRECT_MODES.has(r.redirect)) &&
    (r.streamBody === undefined || typeof r.streamBody === 'boolean');
  if (!ok) throw new TypeError('fetch: malformed request');
  return { ...(r as FetchMeta), redirect: r.redirect ?? 'follow' };
}

/** Unread response bytes per fetch before reading from the network pauses. */
const FETCH_HIGH_WATER = 1 * MiB;
/** Fetches a VM may have in flight (request sent, body not finished) at once. */
const MAX_OPEN_FETCHES = 64;
/** Streamed request bytes in the broker, unsent, before a guest's write waits. */
const UPLOAD_HIGH_WATER = 64 << 10;

interface InFlight {
  abort: AbortController;
  timer: NodeJS.Timeout;
  res?: http.IncomingMessage;
  chunks: Buffer[];
  buffered: number;
  received: number;
  ended: boolean;
  error?: Error;
  wake?: () => void;
  /** A streamed request body: what the guest writes, piped to the request. */
  upload?: PassThrough;
  /** Its bytes so far (limits.requestBytes). */
  sent: number;
}

/**
 * The guest's fetch, as three host-function operations on a fetch id the
 * guest picks:
 * - `open(id, meta, body?)`: send the request (following redirects as
 *   `meta.redirect` says, each hop checked against the policy) and resolve
 *   with the response's status and headers;
 * - `write(id, chunk)`: with `meta.streamBody`, the next bytes of the
 *   request body (null ends it), sent as they come (chunked), while `open`
 *   waits; resolves when the broker can take more;
 * - `read(id)`: the next bytes of the response body, or null at its end;
 * - `cancel(id)`: abort the request or the body.
 * Every failure reaches the guest as a TypeError, as the Fetch standard
 * has it.
 */
export function fetchBroker(policy: FetchPolicy, denied: DenialReporter = () => {}): { fn: HostFunction; dispose: () => void } {
  if (!policy || (!Array.isArray(policy.hosts) && typeof policy.hosts !== 'function')) {
    throw new TypeError('isolane: fetch.hosts must be a list of hostnames or a function');
  }
  const methods = new Set((policy.methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase()));
  const maxResponse = policy.limits?.responseBytes ?? 10 * MiB;
  const maxRequest = policy.limits?.requestBytes ?? 10 * MiB;
  const timeoutMs = policy.limits?.timeoutMs ?? 30_000;
  const maxRedirects = policy.limits?.redirects ?? 5;
  const maxRequests = policy.limits?.requests;
  const allowPrivate = policy.privateNetworks === true;
  let requests = 0;
  const inFlight = new Map<number, InFlight>();

  const check = async (url: URL, method: string) => {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new TypeError(`fetch: ${url.protocol} URLs are not supported`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && isIP(host) && !isPublicAddress(host)) {
      denied('fetch', url.href, 'not a public address');
      throw new Error(`fetch to ${url.origin} is not allowed: not a public address`);
    }
    const allowed =
      typeof policy.hosts === 'function' ? await policy.hosts(new URL(url), method) : hostAllowed(policy.hosts, host);
    if (allowed !== true) {
      denied('fetch', url.href, 'not allowed by the fetch policy');
      throw new Error(`fetch to ${url.origin} is not allowed by the fetch policy`);
    }
  };

  // One hop: resolves when the response's headers arrive (its body unread).
  // A streamed body is piped in as the guest writes it.
  const send = (
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: Uint8Array | PassThrough | undefined,
    signal: AbortSignal,
  ) =>
    new Promise<http.IncomingMessage>((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const lookup = pinnedLookup(allowPrivate, () => denied('fetch', url.href, 'not a public address'));
      const req = mod.request(url, { method, headers, lookup: lookup as never, agent: false, signal });
      req.on('response', resolve);
      req.on('error', reject);
      if (body instanceof PassThrough) {
        body.on('error', (err) => req.destroy(err));
        body.pipe(req);
      } else {
        req.end(body);
      }
    });

  const wake = (f: InFlight) => {
    const w = f.wake;
    f.wake = undefined;
    w?.();
  };
  const finish = (id: number) => {
    const f = inFlight.get(id);
    if (!f) return;
    inFlight.delete(id);
    clearTimeout(f.timer);
  };

  const failure = (err: unknown, f?: InFlight) => {
    if (f?.abort.signal.aborted) {
      const reason = f.abort.signal.reason;
      return new TypeError(reason instanceof Error ? reason.message : 'fetch was cancelled');
    }
    return err instanceof TypeError ? err : new TypeError((err as Error).message);
  };

  async function open(rawId: unknown, rawMeta: unknown, rawBody: unknown): Promise<FetchHead> {
    if (!(Number.isSafeInteger(rawId) && (rawId as number) >= 0) || inFlight.has(rawId as number)) {
      throw new TypeError('fetch: bad fetch id');
    }
    const id = rawId as number;
    const meta = parseFetchMeta(rawMeta);
    const given = rawBody === undefined || rawBody === null ? undefined : rawBody;
    if (given !== undefined && (!(given instanceof Uint8Array) || meta.streamBody)) throw new TypeError('fetch: malformed request body');
    let body: Uint8Array | PassThrough | undefined = given;
    if (given && given.length > maxRequest) throw new TypeError(`fetch: request body larger than ${maxRequest} bytes`);
    if (inFlight.size >= MAX_OPEN_FETCHES) throw new TypeError(`fetch: more than ${MAX_OPEN_FETCHES} fetches in flight`);
    if (maxRequests !== undefined && requests >= maxRequests) {
      denied('fetch', String((rawMeta as { url?: unknown } | null)?.url ?? ''), `used its ${maxRequests} requests`);
      throw new TypeError(`fetch: this isolate has used its ${maxRequests} requests (fetch.limits.requests)`);
    }
    requests++;
    let url: URL;
    try {
      url = new URL(meta.url);
    } catch {
      throw new TypeError(`fetch: invalid URL ${JSON.stringify(meta.url.slice(0, 200))}`);
    }
    // The policy matches methods case-insensitively; the request keeps the
    // guest's spelling (Fetch normalizes only the standard methods, which
    // Request already did, so a custom "TacO" is sent as "TacO").
    let method = meta.method;
    if (!methods.has(method.toUpperCase())) {
      denied('fetch', url.href, `method ${method} is not allowed`);
      throw new TypeError(`fetch: method ${method} is not allowed`);
    }
    // Keyed by lowercase name (for the checks below); sent with the
    // spelling the guest first used, as Fetch combines same-name headers.
    const headers: Record<string, string> = {};
    const spelling: Record<string, string> = {};
    for (const [k, v] of meta.headers) {
      const name = k.toLowerCase();
      if (DROPPED_HEADERS.has(name)) continue;
      headers[name] = name in headers ? `${headers[name]}, ${v}` : v;
      spelling[name] ??= k;
    }
    headers['accept-encoding'] ??= 'identity';
    // Fetch's user agent sends one; servers and WPT expect it.
    headers['user-agent'] ??= 'isolane';

    // The timeout covers the whole fetch, body included.
    const abort = new AbortController();
    const f: InFlight = {
      abort,
      timer: setTimeout(() => abort.abort(new Error('fetch timed out')), timeoutMs),
      chunks: [],
      buffered: 0,
      received: 0,
      ended: false,
      sent: 0,
    };
    if (meta.streamBody) {
      // Chunked: the length isn't known up front.
      f.upload = body = new PassThrough({ highWaterMark: UPLOAD_HIGH_WATER });
    }
    inFlight.set(id, f);
    const urlList: string[] = [];
    try {
      for (let hop = 0; ; hop++) {
        await check(url, method);
        urlList.push(url.href);
        let res: http.IncomingMessage;
        try {
          const spelled = Object.fromEntries(Object.entries(headers).map(([name, v]) => [spelling[name] ?? name, v]));
          res = await send(url, method, spelled, body, abort.signal);
        } catch (err) {
          throw new Error(`fetch to ${url.origin} failed: ${(err as Error).message}`);
        }
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && typeof location === 'string' && meta.redirect !== 'manual') {
          res.destroy();
          if (meta.redirect === 'error') throw new TypeError('fetch: the response redirected, and redirect is "error"');
          if (hop >= maxRedirects) throw new TypeError(`fetch: more than ${maxRedirects} redirects`);
          // Fetch: these become a GET without the body.
          const toGet = status === 303 ? method !== 'GET' && method !== 'HEAD' : (status === 301 || status === 302) && method === 'POST';
          // A streamed body can't be sent again (Fetch: a network error).
          if (body instanceof PassThrough && !toGet) {
            throw new TypeError("fetch: the response redirected, and a streamed request body can't be sent again");
          }
          // Node gives header values as Latin-1 (one char per byte); a
          // Location's raw bytes past ASCII are percent-encoded as bytes
          // before parsing, so UTF-8 (and invalid bytes) survive as sent.
          const next = new URL(location.replace(/[\x80-\xff]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`), url);
          if (toGet) {
            method = 'GET';
            // What the guest still writes of a streamed body goes nowhere.
            if (body instanceof PassThrough) body.resume();
            body = undefined;
            for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) {
              delete headers[name];
            }
          }
          // Credentials don't follow a redirect to another origin.
          if (next.origin !== url.origin) {
            delete headers['authorization'];
            delete headers['cookie'];
            delete headers['proxy-authorization'];
          }
          url = next;
          continue;
        }
        // Stream the body: buffer up to the high-water mark, then pause
        // until the guest reads.
        f.res = res;
        res.on('data', (chunk: Buffer) => {
          f.received += chunk.length;
          if (f.received > maxResponse) {
            f.error = new TypeError(`fetch: response larger than ${maxResponse} bytes`);
            res.destroy();
            wake(f);
            return;
          }
          f.chunks.push(chunk);
          f.buffered += chunk.length;
          if (f.buffered >= FETCH_HIGH_WATER) res.pause();
          wake(f);
        });
        res.on('end', () => {
          f.ended = true;
          clearTimeout(f.timer);
          wake(f);
        });
        res.on('error', (err) => {
          f.error ??= failure(err, f);
          wake(f);
        });
        res.on('close', () => {
          if (!f.ended && !f.error) f.error = failure(new Error('the response was cut off'), f);
          wake(f);
        });
        const pairs: [string, string][] = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          // Fetch: a header value with a NUL is a network error (Node's
          // parser already refuses CR and LF, but lets NUL through).
          if (res.rawHeaders[i + 1].includes('\0')) {
            res.destroy();
            throw new Error('a response header contains a NUL byte');
          }
          pairs.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]]);
        }
        return { status, statusText: res.statusMessage ?? '', url: url.href, urlList, redirected: hop > 0, headers: pairs };
      }
    } catch (err) {
      finish(id);
      throw failure(err, f);
    }
  }

  async function read(rawId: unknown): Promise<Buffer | null> {
    const f = typeof rawId === 'number' ? inFlight.get(rawId) : undefined;
    if (!f) throw new TypeError('fetch: the response body is closed');
    if (f.wake) throw new TypeError('fetch: another read is already waiting');
    while (f.chunks.length === 0 && !f.ended && !f.error) {
      await new Promise<void>((r) => (f.wake = r));
    }
    if (f.chunks.length) {
      const data = f.chunks.length === 1 ? f.chunks[0] : Buffer.concat(f.chunks);
      f.chunks = [];
      f.buffered = 0;
      f.res?.resume();
      return data;
    }
    finish(rawId as number);
    if (f.error) throw f.error;
    return null; // end of the body
  }

  async function write(rawId: unknown, chunk: unknown): Promise<void> {
    const f = typeof rawId === 'number' ? inFlight.get(rawId) : undefined;
    const upload = f?.upload;
    if (!f || !upload) throw new TypeError('fetch: the request body is closed');
    if (f.error || f.abort.signal.aborted) throw failure(f.error ?? new Error('fetch was cancelled'), f);
    if (upload.writableEnded) throw new TypeError('fetch: the request body has ended');
    if (chunk === null) {
      upload.end();
      return;
    }
    if (!(chunk instanceof Uint8Array)) throw new TypeError('fetch: malformed request body');
    f.sent += chunk.length;
    if (f.sent > maxRequest) {
      const err = new TypeError(`fetch: request body larger than ${maxRequest} bytes`);
      f.abort.abort(err);
      throw err;
    }
    if (!upload.write(chunk)) {
      // Backpressure: the next write waits until the request takes these.
      await new Promise<void>((resolve) => {
        const done = () => {
          upload.off('drain', done);
          upload.off('close', done);
          f.abort.signal.removeEventListener('abort', done);
          resolve();
        };
        upload.on('drain', done);
        upload.on('close', done);
        f.abort.signal.addEventListener('abort', done);
      });
    }
  }

  function cancel(rawId: unknown): void {
    const f = typeof rawId === 'number' ? inFlight.get(rawId) : undefined;
    if (!f) return;
    finish(rawId as number);
    f.abort.abort(new Error('fetch was cancelled'));
    f.upload?.destroy();
    f.res?.destroy();
    f.error ??= new TypeError('fetch was cancelled');
    wake(f);
  }

  const fn: HostFunction = (op: unknown, ...args: unknown[]) => {
    if (op === 'open') return open(args[0], args[1], args[2]);
    if (op === 'read') return read(args[0]);
    if (op === 'write') return write(args[0], args[1]);
    if (op === 'cancel') return cancel(args[0]);
    throw new TypeError('fetch: unknown operation');
  };
  const dispose = () => {
    for (const id of [...inFlight.keys()]) cancel(id);
  };
  return { fn, dispose };
}

// ---- sockets ----

export interface ConnectPolicy {
  /**
   * `host:port` pairs the guest may connect to: `db.example.com:5432`,
   * `*.example.com:443` (subdomains), `cache.example.com:*` (any port), or
   * `[2001:db8::1]:80`. Or a function deciding each connection.
   */
  hosts: readonly string[] | ((hostname: string, port: number) => boolean | Promise<boolean>);
  /** As for `FetchPolicy`: non-public addresses are refused by default. */
  privateNetworks?: boolean;
  /**
   * The certificate authorities TLS connections trust (`secureTransport:
   * 'on'`, and `startTls()`), as PEM. Replaces Node's default roots, as
   * node:tls's `ca` does: for a private CA, such as a cloud database's.
   */
  ca?: string | readonly string[];
  limits?: {
    /** Sockets an isolate may have open at once. Default 8. */
    connections?: number;
    /** Connecting, and each TLS handshake. Default 10 s. */
    connectMs?: number;
    /** Close a socket with no traffic for this long. Default 60 s. */
    idleMs?: number;
  };
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
  /** The connection is gone; the entry stays only until the guest reads what's left. */
  closed?: boolean;
  wake?: () => void;
  /** What the guest gets back from open and startTls. */
  remoteAddress: string;
}

/**
 * The broker behind the guest's `connect()` (runtime/sockets.js): every
 * connection is checked against the policy, then carried out here.
 *   open({ hostname, port, tls }) → { id, remoteAddress }
 *   read(id) → bytes, or null at the end; write(id, bytes); end(id) (half-close);
 *   close(id); startTls(id, { servername }) → { id, remoteAddress }
 */
export function connectBroker(policy: ConnectPolicy, denied: DenialReporter = () => {}): { fn: HostFunction; dispose: () => void } {
  if (!policy || (!Array.isArray(policy.hosts) && typeof policy.hosts !== 'function')) {
    throw new TypeError('isolane: connect.hosts must be a list of host:port patterns or a function');
  }
  const allowPrivate = policy.privateNetworks === true;
  const ca = policy.ca === undefined ? undefined : typeof policy.ca === 'string' ? policy.ca : [...policy.ca];
  const maxConnections = policy.limits?.connections ?? 8;
  const connectTimeoutMs = policy.limits?.connectMs ?? 10_000;
  const idleTimeoutMs = policy.limits?.idleMs ?? 60_000;
  const sockets = new Map<number, GuestSocket>();
  /** Sockets between release and track in startTls: still open, still counted. */
  let upgrading = 0;
  /** Opens not yet connected: counted too. */
  let opening = 0;
  let nextId = 1;
  let disposed = false;

  const get = (id: unknown) => {
    const s = typeof id === 'number' ? sockets.get(id) : undefined;
    if (!s) throw new Error('socket is closed');
    return s;
  };

  /** Resolves with `socket` once `event` fires; destroys it on an error or after connectMs. */
  const established = (socket: Socket, event: 'connect' | 'secureConnect', what: string) =>
    new Promise<Socket>((resolve, reject) => {
      const timer = setTimeout(() => socket.destroy(new Error('timed out')), connectTimeoutMs);
      socket.once(event, () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`${what} failed: ${err.message}`));
      });
    });

  /** Track a connected socket under a new id. */
  const track = (socket: Socket, remoteAddress: string) => {
    if (disposed) {
      socket.destroy();
      throw new Error('socket is closed');
    }
    const id = nextId++;
    const g: GuestSocket = { socket, chunks: [], buffered: 0, ended: false, remoteAddress };
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
      g.closed = true;
      // Nothing left for the guest to read: forget it now, so a closed
      // socket stops counting against connect.limits.connections.
      if (!g.chunks.length && !g.error && !g.wake) sockets.delete(id);
      wake();
    });
    socket.setTimeout(idleTimeoutMs, () => socket.destroy(new Error('idle timeout')));
    sockets.set(id, g);
    return { id, remoteAddress };
  };

  const open = async (raw: unknown) => {
    const r = raw as { hostname?: unknown; port?: unknown; tls?: unknown } | null;
    if (!r || typeof r.hostname !== 'string' || !Number.isInteger(r.port) || (r.port as number) < 1 || (r.port as number) > 65535) {
      throw new TypeError('connect: expected a hostname and a port from 1 to 65535');
    }
    const host = r.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = r.port as number;
    // Counted from here, not once connected: opens racing each other
    // (the policy check and the connection both wait) can't pass the cap.
    if (sockets.size + upgrading + opening >= maxConnections) {
      denied('connect', `${host}:${port}`, `already has ${maxConnections} sockets open`);
      throw new Error(`connect: this isolate already has ${maxConnections} sockets open (connect.limits.connections)`);
    }
    opening++;
    try {
      if (!allowPrivate && isIP(host) && !isPublicAddress(host)) {
        denied('connect', `${host}:${port}`, 'not a public address');
        throw new Error(`connect to ${host}:${port} is not allowed: not a public address`);
      }
      const allowed = typeof policy.hosts === 'function' ? await policy.hosts(host, port) : socketAllowed(policy.hosts, host, port);
      if (allowed !== true) {
        denied('connect', `${host}:${port}`, 'not allowed by the connect policy');
        throw new Error(`connect to ${host}:${port} is not allowed by the connect policy`);
      }
      const lookup = pinnedLookup(allowPrivate, () => denied('connect', `${host}:${port}`, 'not a public address'));
      const socket =
        r.tls === true
          ? await established(
              tlsConnect({ host, port, servername: isIP(host) ? undefined : host, ca, lookup: lookup as never }),
              'secureConnect',
              `connect to ${host}:${port}`,
            )
          : await established(netConnect({ host, port, lookup: lookup as never }), 'connect', `connect to ${host}:${port}`);
      const address = socket.remoteAddress ?? host;
      return track(socket, `${isIP(address) === 6 ? `[${address}]` : address}:${socket.remotePort ?? port}`);
    } finally {
      opening--;
    }
  };

  const read = async (id: unknown): Promise<Buffer | null> => {
    // A socket forgotten when its connection closed reads as ended.
    if (typeof id === 'number' && id > 0 && id < nextId && !sockets.has(id)) return null;
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
      return data;
    }
    // Everything's read: a closed connection's entry goes.
    if (g.closed) sockets.delete(id as number);
    if (g.error) throw new Error(`socket error: ${g.error.message}`);
    return null; // end of stream
  };

  const write = async (id: unknown, data: unknown) => {
    const g = get(id);
    if (!(data instanceof Uint8Array)) throw new TypeError('socket.write: malformed data');
    if (g.error) throw new Error(`socket error: ${g.error.message}`);
    await new Promise<void>((resolve, reject) =>
      g.socket.write(data, (err) => (err ? reject(new Error(`socket error: ${err.message}`)) : resolve())),
    );
  };

  const end = async (id: unknown) => {
    const g = get(id);
    await new Promise<void>((resolve) => g.socket.end(resolve));
  };

  /** Forget a socket without closing the connection (it's being upgraded). */
  const release = (id: number, g: GuestSocket) => {
    sockets.delete(id);
    g.socket.removeAllListeners('data');
    g.socket.removeAllListeners('end');
    g.socket.removeAllListeners('error');
    g.socket.removeAllListeners('close');
    g.socket.setTimeout(0);
    g.ended = true;
    const w = g.wake;
    g.wake = undefined;
    w?.();
  };

  const startTls = async (id: unknown, raw: unknown) => {
    const g = get(id);
    const servername = (raw as { servername?: unknown } | null)?.servername;
    if (typeof servername !== 'string' || servername.length === 0 || servername.length > 253) {
      throw new TypeError('startTls: expected a server hostname');
    }
    if (g.error || g.ended) throw new Error('startTls: the socket is closed');
    // Bytes that arrived before the handshake and weren't read would be
    // taken as coming over TLS: refuse, as STARTTLS clients must (a
    // man-in-the-middle can inject them). That's the broker's queue and
    // Node's own buffer; bytes still in the kernel are read by the TLS
    // layer as handshake records, so they fail the handshake instead.
    if (g.chunks.length || g.socket.readableLength > 0) throw new Error('startTls: the server sent data before the TLS handshake');
    release(id as number, g);
    upgrading++;
    try {
      g.socket.resume();
      const tls = tlsConnect({ socket: g.socket, servername: isIP(servername) ? undefined : servername, ca });
      const socket = await established(tls, 'secureConnect', 'startTls');
      return track(socket, g.remoteAddress);
    } catch (err) {
      g.socket.destroy();
      throw err;
    } finally {
      upgrading--;
    }
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
    if (op === 'end') return end(args[0]);
    if (op === 'startTls') return startTls(args[0], args[1]);
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
  limits?: {
    /** Largest file the guest may read or write. Default 10 MiB. */
    fileBytes?: number;
    /** Bytes the isolate may write in all, over its life. Default 100 MiB. */
    writtenBytes?: number;
    /** Operations in flight at once (each holds a file handle). Default 16. */
    operations?: number;
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

export function fsBroker(policy: FsPolicy, denied: DenialReporter = () => {}): HostFunction {
  if (!policy || typeof policy.root !== 'string') throw new TypeError('isolane: fs.root must be a directory path');
  const maxBytes = policy.limits?.fileBytes ?? 10 * MiB;
  const maxWritten = policy.limits?.writtenBytes ?? 100 * MiB;
  const maxOperations = policy.limits?.operations ?? 16;
  let written = 0;
  let running = 0;
  let rootReal: Promise<string> | undefined;
  const root = () => (rootReal ??= realpath(policy.root));
  const inside = (r: string, p: string) => p === r || p.startsWith(r + sep);

  // The host path for a guest path, with every symlink resolved, refused if
  // it lands outside the root. Guests can't create symlinks, but the root
  // may already contain some.
  const resolveExisting = async (path: string) => {
    const r = await root();
    const real = await realpath(join(r, posix.normalize('/' + path)));
    if (!inside(r, real)) {
      denied('fs', path, 'outside the root');
      throw new FsError(`fs: ${JSON.stringify(path)} is outside the root`, 'EACCES');
    }
    return real;
  };
  // For creating or removing an entry: its parent must resolve inside the
  // root, and the entry itself is never followed if it's a symlink.
  const resolveEntry = async (path: string) => {
    const guest = posix.normalize('/' + path);
    if (guest === '/') {
      denied('fs', path, 'the root itself cannot be replaced or removed');
      throw new FsError('fs: the root itself cannot be replaced or removed', 'EPERM');
    }
    const parent = await resolveExisting(posix.dirname(guest));
    return join(parent, posix.basename(guest));
  };

  const ops: Record<string, (path: string, arg: unknown) => Promise<unknown>> = {
    async readFile(path) {
      const fh = await open(await resolveExisting(path), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const st = await fh.stat();
        if (!st.isFile()) throw new FsError(`fs.readFile ${JSON.stringify(path)}: not a file`, 'EISDIR');
        if (st.size > maxBytes) throw new FsError(`fs.readFile ${JSON.stringify(path)}: larger than ${maxBytes} bytes (fs.limits.fileBytes)`, 'EFBIG');
        return await fh.readFile();
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
      if (!(data instanceof Uint8Array)) throw new FsError('fs.writeFile: malformed data', 'EINVAL');
      const bytes = data;
      if (bytes.length > maxBytes) throw new FsError(`fs.writeFile ${JSON.stringify(path)}: larger than ${maxBytes} bytes (fs.limits.fileBytes)`, 'EFBIG');
      if (written + bytes.length > maxWritten) {
        throw new FsError(`fs.writeFile ${JSON.stringify(path)}: this isolate has written its ${maxWritten} bytes (fs.limits.writtenBytes)`, 'EDQUOT');
      }
      written += bytes.length;
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
      if (st.isDirectory() && recursive !== true) throw new FsError(`fs.rm ${JSON.stringify(path)}: is a directory`, 'EISDIR');
      await rm(entry, { recursive: recursive === true });
    },
  };
  const writes = new Set(['writeFile', 'mkdir', 'rm']);

  return async (op: unknown, path: unknown, arg: unknown) => {
    if (typeof op !== 'string' || !Object.hasOwn(ops, op)) throw new FsError('fs: unknown operation', 'EINVAL');
    if (typeof path !== 'string' || path.includes('\0')) throw new FsError(`fs.${op}: path must be a string`, 'EINVAL');
    if (writes.has(op) && policy.write !== true) {
      denied('fs', path, `fs.${op}: the filesystem is read-only`);
      throw new FsError(`fs.${op}: the filesystem is read-only`, 'EROFS');
    }
    if (running >= maxOperations) {
      throw new FsError(`fs.${op}: ${maxOperations} operations are already running (fs.limits.operations)`, 'EMFILE');
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

// ---- guest side ----

export const FETCH_HOST_FUNCTION = '__isolane_fetch';
export const FS_HOST_FUNCTION = '__isolane_fs';
export const SOCKET_HOST_FUNCTION = '__isolane_socket';

/**
 * The hooks an isolate's web platform (runtime/globals.js) leaves for the
 * prelude: the prelude hands each the raw host function, and the web
 * platform's `fetch` and `connect()` use it. The worker deletes the hooks
 * before guest code runs.
 */
export const WEB_FETCH_HOOK = '__isolane_web_fetch';
/** The same for `connect()`: the Sockets API (runtime/sockets.js) over the socket broker. */
export const WEB_CONNECT_HOOK = '__isolane_web_connect';

/**
 * Trusted setup the worker runs in a VM's context before any guest code:
 * hands the raw `fetch` and socket host functions to the web platform,
 * wraps the raw `fs` one in an `fs` object, then deletes the raw ones.
 * Config resolution only allows these policies with the web platform on.
 * Bytes cross as Uint8Arrays (host calls carry them raw). Guest code can
 * tamper with the wrappers, which only affects itself: the brokers above
 * validate every request on their own.
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
  const handOver = (hook, raw, api) => {
    if (typeof g[hook] !== 'function') throw new TypeError(api + ' needs the web platform');
    g[hook](raw);
  };
  if (rawFetch) handOver('${WEB_FETCH_HOOK}', rawFetch, 'fetch');
  if (rawSocket) handOver('${WEB_CONNECT_HOOK}', rawSocket, 'connect');

  if (rawFs) {
    if (typeof g.TextEncoder !== 'function') throw new TypeError('fs needs the web platform');
    const encoder = new g.TextEncoder();
    const decoder = new g.TextDecoder();
    // A guest's text, bytes, or buffer as a Uint8Array (the bytes cross to
    // the host as they are when called).
    const toBytes = (data) => {
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return encoder.encode(String(data));
    };
    const encodingOf = (options) => (typeof options === 'string' ? options : options?.encoding);
    g.fs = Object.freeze({
      async readFile(path, options) {
        const bytes = await rawFs('readFile', path);
        const enc = encodingOf(options);
        if (enc == null) return bytes;
        if (enc === 'utf8' || enc === 'utf-8') return decoder.decode(bytes);
        throw new TypeError('fs.readFile: unsupported encoding ' + enc);
      },
      writeFile: (path, data) => rawFs('writeFile', path, toBytes(data)),
      readdir: (path) => rawFs('readdir', path),
      stat: (path) => rawFs('stat', path),
      exists: (path) => rawFs('exists', path),
      mkdir: (path, options) => rawFs('mkdir', path, options?.recursive === true),
      rm: (path, options) => rawFs('rm', path, options?.recursive === true),
    });
  }
})();`;

export interface Capabilities {
  /** The brokers, as host functions. */
  entries: HostEntry[];
  prelude?: string;
  /** Release what the isolate holds open (sockets, fetches) when it goes away. */
  dispose(): void;
}

/**
 * The brokers, setup script, and cleanup for an isolate's policies.
 * `topLevel`: the guest-global names its host functions take (they can't
 * collide with the policies' globals or `globals`).
 */
export function capabilities(
  config: { fetch?: FetchPolicy; fs?: FsPolicy; connect?: ConnectPolicy; globals: Readonly<Record<string, unknown>> },
  topLevel: ReadonlySet<string>,
  denied: DenialReporter,
): Capabilities {
  const entries: HostEntry[] = [];
  const reserved = new Map<string, string>();
  const disposers: (() => void)[] = [];
  if (config.fetch) {
    const broker = fetchBroker(config.fetch, denied);
    entries.push(internalEntry(FETCH_HOST_FUNCTION, broker.fn));
    disposers.push(broker.dispose);
    for (const n of ['fetch', 'Headers', 'Response']) reserved.set(n, 'fetch');
  }
  if (config.fs) {
    entries.push(internalEntry(FS_HOST_FUNCTION, fsBroker(config.fs, denied)));
    reserved.set('fs', 'fs');
  }
  if (config.connect) {
    const broker = connectBroker(config.connect, denied);
    entries.push(internalEntry(SOCKET_HOST_FUNCTION, broker.fn));
    disposers.push(broker.dispose);
    reserved.set('connect', 'connect');
  }
  for (const name of topLevel) {
    const policy = reserved.get(name);
    if (policy) throw new TypeError(`host.${name} is taken by the ${policy} policy's global`);
  }
  let prelude = reserved.size ? PRELUDE : '';
  const globalNames = Object.keys(config.globals);
  if (globalNames.length) {
    for (const name of globalNames) {
      if (reserved.has(name)) throw new TypeError(`globals.${name} is taken by the ${reserved.get(name)} policy's global`);
      if (topLevel.has(name)) throw new TypeError(`globals.${name} is also a host function or namespace`);
    }
    // JSON text inside a JS string literal: values arrive as plain data.
    const json = JSON.stringify(config.globals);
    prelude = `Object.assign(globalThis, JSON.parse(${JSON.stringify(json)}));\n` + prelude;
  }
  return {
    entries,
    prelude: prelude || undefined,
    dispose: () => disposers.forEach((d) => d()),
  };
}
