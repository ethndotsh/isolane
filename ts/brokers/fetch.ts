// The fetch broker: the guest's fetch (runtime/fetch.js), carried out by
// the supervisor after checking each request, and each redirect hop,
// against the policy.

import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { PassThrough } from 'node:stream';

import { DEFAULT_POLICY_LIMITS } from '../config.js';
import { ByteQueue } from './byte-queue.js';
import { isPublicAddress, matchHost, MiB, NO_REPORTER, pinnedLookup, redacted, type BrokerFunction, type BrokerReporter } from './net.js';

export interface FetchPolicy {
  /**
   * Hosts the guest may fetch from: exact (`api.example.com`) or any
   * subdomain (`*.example.com`, not the apex), on the scheme's default port
   * unless a port is named (`api.example.com:8443`, `[2001:db8::1]:8080`,
   * `host:*`). Or a function that decides each request (and each redirect
   * hop).
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
    /** Fetches per isolate over its lifetime. Default 1,000. */
    requests?: number;
    /** Request and response body bytes per isolate over its lifetime. Default 1 GiB. */
    transferBytes?: number;
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
  /** The response body, unread. */
  body: ByteQueue;
  received: number;
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
export function fetchBroker(policy: FetchPolicy, report: BrokerReporter = NO_REPORTER): { fn: BrokerFunction; dispose: () => void } {
  if (!policy || (!Array.isArray(policy.hosts) && typeof policy.hosts !== 'function')) {
    throw new TypeError('isolane: fetch.hosts must be a list of hostnames or a function');
  }
  const methods = new Set((policy.methods ?? DEFAULT_METHODS).map((m) => m.toUpperCase()));
  const defaults = DEFAULT_POLICY_LIMITS.fetch;
  const maxResponse = policy.limits?.responseBytes ?? defaults.responseBytes;
  const maxRequest = policy.limits?.requestBytes ?? defaults.requestBytes;
  const timeoutMs = policy.limits?.timeoutMs ?? defaults.timeoutMs;
  const maxRedirects = policy.limits?.redirects ?? defaults.redirects;
  const maxRequests = policy.limits?.requests ?? defaults.requests;
  const maxTransfer = policy.limits?.transferBytes ?? defaults.transferBytes;
  /** A policy limit reached: reported to `onLimit`, and the guest's TypeError. */
  const overLimit = (name: keyof typeof defaults, message: string) => {
    report.limit(`fetch.limits.${name}`, message);
    return new TypeError(message);
  };
  let transferred = 0;
  /** Count body bytes against transferBytes; the error to fail with past it. */
  const transfer = (n: number): TypeError | undefined => {
    transferred += n;
    if (transferred <= maxTransfer) return undefined;
    return overLimit('transferBytes', `fetch: this isolate has moved its ${maxTransfer} bytes (fetch.limits.transferBytes)`);
  };
  const allowPrivate = policy.privateNetworks === true;
  let requests = 0;
  const inFlight = new Map<number, InFlight>();

  const check = async (url: URL, method: string) => {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new TypeError(`fetch: ${url.protocol} URLs are not supported`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const defaultPort = url.protocol === 'https:' ? 443 : 80;
    if (!allowPrivate && isIP(host) && !isPublicAddress(host)) {
      report.denied('fetch', redacted(url), 'not a public address');
      throw new Error(`fetch to ${url.origin} is not allowed: not a public address`);
    }
    const allowed =
      typeof policy.hosts === 'function'
        ? await policy.hosts(new URL(url), method)
        : matchHost(policy.hosts, host.toLowerCase(), Number(url.port) || defaultPort, defaultPort);
    if (allowed !== true) {
      report.denied('fetch', redacted(url), 'not allowed by the fetch policy');
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
      const lookup = pinnedLookup(allowPrivate, () => report.denied('fetch', redacted(url), 'not a public address'));
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
    if (given && given.length > maxRequest) throw overLimit('requestBytes', `fetch: request body larger than ${maxRequest} bytes (fetch.limits.requestBytes)`);
    if (inFlight.size >= MAX_OPEN_FETCHES) throw new TypeError(`fetch: more than ${MAX_OPEN_FETCHES} fetches in flight`);
    if (requests >= maxRequests) throw overLimit('requests', `fetch: this isolate has used its ${maxRequests} requests (fetch.limits.requests)`);
    const over = given ? transfer(given.length) : undefined;
    if (over) {
      throw over;
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
      report.denied('fetch', redacted(url), `method ${method} is not allowed`);
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
      timer: setTimeout(() => abort.abort(overLimit('timeoutMs', `fetch timed out after ${timeoutMs}ms (fetch.limits.timeoutMs)`)), timeoutMs),
      body: new ByteQueue(FETCH_HIGH_WATER),
      received: 0,
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
          if (hop >= maxRedirects) throw overLimit('redirects', `fetch: more than ${maxRedirects} redirects (fetch.limits.redirects)`);
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
        f.res = f.body.source = res;
        res.on('data', (chunk: Buffer) => {
          f.received += chunk.length;
          const over = f.received > maxResponse ? overLimit('responseBytes', `fetch: response larger than ${maxResponse} bytes (fetch.limits.responseBytes)`) : transfer(chunk.length);
          if (over) {
            f.body.fail(over);
            res.destroy();
            return;
          }
          f.body.push(chunk);
        });
        res.on('end', () => {
          clearTimeout(f.timer);
          f.body.end();
        });
        res.on('error', (err) => f.body.fail(failure(err, f)));
        res.on('close', () => {
          if (!f.body.ended) f.body.fail(failure(new Error('the response was cut off'), f));
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
    if (f.body.waiting) throw new TypeError('fetch: another read is already waiting');
    try {
      const data = await f.body.read();
      if (data === null) finish(rawId as number); // end of the body
      return data;
    } catch (err) {
      finish(rawId as number);
      throw err;
    }
  }

  async function write(rawId: unknown, chunk: unknown): Promise<void> {
    const f = typeof rawId === 'number' ? inFlight.get(rawId) : undefined;
    const upload = f?.upload;
    if (!f || !upload) throw new TypeError('fetch: the request body is closed');
    if (f.body.error || f.abort.signal.aborted) throw failure(f.body.error ?? new Error('fetch was cancelled'), f);
    if (upload.writableEnded) throw new TypeError('fetch: the request body has ended');
    if (chunk === null) {
      upload.end();
      return;
    }
    if (!(chunk instanceof Uint8Array)) throw new TypeError('fetch: malformed request body');
    f.sent += chunk.length;
    const over = f.sent > maxRequest ? overLimit('requestBytes', `fetch: request body larger than ${maxRequest} bytes (fetch.limits.requestBytes)`) : transfer(chunk.length);
    if (over) {
      f.abort.abort(over);
      throw over;
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
    f.body.fail(new TypeError('fetch was cancelled'));
  }

  const fn: BrokerFunction = (op: unknown, ...args: unknown[]) => {
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
