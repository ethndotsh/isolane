// The socket broker behind the guest's connect() (runtime/sockets.js): each
// connection checked against the policy, then made by the supervisor.

import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import { DEFAULT_POLICY_LIMITS } from '../config.js';
import { ByteQueue } from './byte-queue.js';
import { isPublicAddress, matchHost, MiB, NO_REPORTER, pinnedLookup, type BrokerFunction, type BrokerReporter } from './net.js';

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
    /** Bytes read and written per isolate over its lifetime, all sockets together. Default 1 GiB. */
    transferBytes?: number;
  };
}

/** Buffered, unread bytes per socket before reading from the network pauses. */
const SOCKET_HIGH_WATER = 1 * MiB;

interface GuestSocket {
  socket: Socket;
  /** What the peer sent, unread. */
  queue: ByteQueue;
  /** The connection is gone; the entry stays only until the guest reads what's left. */
  closed?: boolean;
  /** Settles when the connection does (`watch`): rejected if it failed. */
  gone: Promise<void>;
  settle: (err?: Error) => void;
  /** What the guest gets back from open and startTls. */
  remoteAddress: string;
}

/**
 * The broker behind the guest's `connect()` (runtime/sockets.js): every
 * connection is checked against the policy, then carried out here.
 *   open({ hostname, port, tls }) → { id, remoteAddress }
 *   read(id) → bytes, or null at the end; write(id, bytes); end(id) (half-close);
 *   close(id); startTls(id, { servername }) → { id, remoteAddress };
 *   watch(id) → settles when the connection closes, rejecting if it failed
 *   (so the guest's `socket.closed` settles whether or not it reads)
 */
export function connectBroker(policy: ConnectPolicy, report: BrokerReporter = NO_REPORTER): { fn: BrokerFunction; dispose: () => void } {
  if (!policy || (!Array.isArray(policy.hosts) && typeof policy.hosts !== 'function')) {
    throw new TypeError('isolane: connect.hosts must be a list of host:port patterns or a function');
  }
  const allowPrivate = policy.privateNetworks === true;
  const ca = policy.ca === undefined ? undefined : typeof policy.ca === 'string' ? policy.ca : [...policy.ca];
  const defaults = DEFAULT_POLICY_LIMITS.connect;
  const maxConnections = policy.limits?.connections ?? defaults.connections;
  const connectTimeoutMs = policy.limits?.connectMs ?? defaults.connectMs;
  const idleTimeoutMs = policy.limits?.idleMs ?? defaults.idleMs;
  const maxTransfer = policy.limits?.transferBytes ?? defaults.transferBytes;
  let transferred = 0;
  const overTransfer = (n: number) => (transferred += n) > maxTransfer;
  /** A policy limit reached: reported to `onLimit`, and the guest's error. */
  const overLimit = (name: keyof typeof defaults, message: string) => {
    report.limit(`connect.limits.${name}`, message);
    return new Error(message);
  };
  const transferError = () => overLimit('transferBytes', `connect: this isolate has moved its ${maxTransfer} bytes (connect.limits.transferBytes)`);
  const sockets = new Map<number, GuestSocket>();
  /** Sockets between release and track in startTls: still open, still counted. */
  let upgrading = 0;
  /** Opens not yet connected: counted too. */
  let opening = 0;
  let nextId = 1;
  let disposed = false;
  /** Ids of sockets dropped when their connection closed with nothing unread; the last 1,024. */
  const forgotten = new Set<number>();
  const forget = (id: number) => {
    sockets.delete(id);
    forgotten.add(id);
    if (forgotten.size > 1024) forgotten.delete(forgotten.values().next().value as number);
  };

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
    const queue = new ByteQueue(SOCKET_HIGH_WATER);
    queue.source = socket;
    let settle!: (err?: Error) => void;
    const gone = new Promise<void>((resolve, reject) => {
      settle = (err) => (err ? reject(err) : resolve());
    });
    gone.catch(() => {});
    const g: GuestSocket = { socket, queue, gone, settle, remoteAddress };
    socket.on('data', (chunk: Buffer) => {
      if (overTransfer(chunk.length)) return socket.destroy(transferError());
      queue.push(chunk);
    });
    socket.on('end', () => queue.end());
    socket.on('error', (err) => queue.fail(new Error(`socket error: ${err.message}`)));
    socket.on('close', () => {
      g.closed = true;
      // Nothing left for the guest to read: forget it now, so a closed
      // socket stops counting against connect.limits.connections.
      if (!queue.size && !queue.error && !queue.waiting) forget(id);
      queue.end();
      settle(queue.error);
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
      throw overLimit('connections', `connect: this isolate already has ${maxConnections} sockets open (connect.limits.connections)`);
    }
    opening++;
    try {
      if (!allowPrivate && isIP(host) && !isPublicAddress(host)) {
        report.denied('connect', `${host}:${port}`, 'not a public address');
        throw new Error(`connect to ${host}:${port} is not allowed: not a public address`);
      }
      const allowed = typeof policy.hosts === 'function' ? await policy.hosts(host, port) : matchHost(policy.hosts, host, port);
      if (allowed !== true) {
        report.denied('connect', `${host}:${port}`, 'not allowed by the connect policy');
        throw new Error(`connect to ${host}:${port} is not allowed by the connect policy`);
      }
      const lookup = pinnedLookup(allowPrivate, () => report.denied('connect', `${host}:${port}`, 'not a public address'));
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
    // A socket forgotten when its connection closed reads as ended (once).
    if (typeof id === 'number' && forgotten.delete(id)) return null;
    const g = get(id);
    if (g.queue.waiting) throw new Error('socket.read: another read is already waiting');
    let data: Buffer | null;
    try {
      data = await g.queue.read();
    } catch (err) {
      if (g.closed) sockets.delete(id as number);
      throw err;
    }
    // Everything's read: a closed connection's entry goes.
    if (data === null && g.closed) sockets.delete(id as number);
    return data; // null: end of stream
  };

  /** Settles when the connection closes; one that's already gone and forgotten has. */
  const watch = (id: unknown): Promise<void> => {
    if (typeof id === 'number' && forgotten.has(id)) return Promise.resolve();
    return get(id).gone;
  };

  const write = async (id: unknown, data: unknown) => {
    const g = get(id);
    if (!(data instanceof Uint8Array)) throw new TypeError('socket.write: malformed data');
    if (g.queue.error) throw g.queue.error;
    if (overTransfer(data.length)) {
      const err = transferError();
      g.socket.destroy(err);
      throw err;
    }
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
    g.queue.end();
    g.settle();
  };

  const startTls = async (id: unknown, raw: unknown) => {
    const g = get(id);
    const servername = (raw as { servername?: unknown } | null)?.servername;
    if (typeof servername !== 'string' || servername.length === 0 || servername.length > 253) {
      throw new TypeError('startTls: expected a server hostname');
    }
    if (g.queue.error || g.queue.ended) throw new Error('startTls: the socket is closed');
    // Bytes that arrived before the handshake and weren't read would be
    // taken as coming over TLS: refuse, as STARTTLS clients must (a
    // man-in-the-middle can inject them). That's the broker's queue and
    // Node's own buffer; bytes still in the kernel are read by the TLS
    // layer as handshake records, so they fail the handshake instead.
    if (g.queue.size || g.socket.readableLength > 0) throw new Error('startTls: the server sent data before the TLS handshake');
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
    g.queue.end();
    g.settle();
  };

  const fn: BrokerFunction = (op: unknown, ...args: unknown[]) => {
    if (op === 'open') return open(args[0]);
    if (op === 'read') return read(args[0]);
    if (op === 'write') return write(args[0], args[1]);
    if (op === 'end') return end(args[0]);
    if (op === 'startTls') return startTls(args[0], args[1]);
    if (op === 'close') return close(args[0]);
    if (op === 'watch') return watch(args[0]);
    throw new TypeError('socket: unknown operation');
  };
  const dispose = () => {
    disposed = true;
    for (const id of [...sockets.keys()]) void close(id);
  };
  return { fn, dispose };
}
