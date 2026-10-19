// connect(): TCP sockets as streams, the Sockets API of Cloudflare Workers
// (https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/,
// also the WinterTC sockets draft), over isolane's socket broker instead of
// a network stack. The broker is a host function the prelude hands over
// (ts/capabilities.ts); it checks every connection against the isolate's
// connect policy and carries it out:
//   open({ hostname, port, tls }) → { id, remoteAddress }
//   read(id) → the next bytes, or null at the end
//   write(id, bytes), end(id) (half-close), close(id)
//   startTls(id, { servername }) → { id, remoteAddress } (the upgraded socket)
//
// The readable side reads from the broker only when the guest reads
// (highWaterMark 0), so bytes the guest hasn't asked for stay in the broker,
// where startTls() can refuse to upgrade over them.
(function () {
const { core, primordials } = __bootstrap;
const {
  DataViewPrototypeGetBuffer,
  DataViewPrototypeGetByteLength,
  DataViewPrototypeGetByteOffset,
  NumberIsInteger,
  ObjectFreeze,
  Promise,
  PromisePrototypeCatch,
  PromisePrototypeThen,
  PromiseReject,
  StringPrototypeIndexOf,
  StringPrototypeLastIndexOf,
  StringPrototypeSlice,
  Symbol,
  TypeError,
  TypedArrayPrototypeGetBuffer,
  TypedArrayPrototypeGetByteLength,
  TypedArrayPrototypeGetByteOffset,
  Uint8Array,
} = primordials;

const { ReadableStream, WritableStream } = core.loadExtScript("ext:deno_web/06_streams.js");

/** The broker's host function, or null: this VM has no connect policy. */
let transport = null;

function setTransport(fn) {
  if (transport === null) transport = fn;
}

const ignore = (promise) => PromisePrototypeCatch(promise, () => {});

/** "host:port", "[v6]:port", or { hostname, port }. */
function parseAddress(address) {
  let hostname;
  let port;
  if (typeof address === "string") {
    const at = StringPrototypeLastIndexOf(address, ":");
    if (at <= 0) throw new TypeError("connect: the address must be \"hostname:port\"");
    hostname = StringPrototypeSlice(address, 0, at);
    port = +StringPrototypeSlice(address, at + 1);
  } else if (address !== null && typeof address === "object") {
    hostname = address.hostname;
    port = +address.port;
  } else {
    throw new TypeError("connect: the address must be \"hostname:port\" or { hostname, port }");
  }
  if (typeof hostname !== "string" || hostname === "") {
    throw new TypeError("connect: the address has no hostname");
  }
  if (hostname[0] === "[" && hostname[hostname.length - 1] === "]") {
    hostname = StringPrototypeSlice(hostname, 1, -1);
  } else if (StringPrototypeIndexOf(hostname, ":") !== -1) {
    throw new TypeError("connect: write an IPv6 address in brackets: \"[::1]:5432\"");
  }
  if (!NumberIsInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("connect: expected a port from 1 to 65535");
  }
  return { hostname, port };
}

function toBytes(chunk) {
  if (core.isArrayBufferView(chunk)) {
    if (!core.isDataView(chunk)) {
      return new Uint8Array(
        TypedArrayPrototypeGetBuffer(chunk),
        TypedArrayPrototypeGetByteOffset(chunk),
        TypedArrayPrototypeGetByteLength(chunk),
      );
    }
    return new Uint8Array(
      DataViewPrototypeGetBuffer(chunk),
      DataViewPrototypeGetByteOffset(chunk),
      DataViewPrototypeGetByteLength(chunk),
    );
  }
  if (core.isArrayBuffer(chunk)) return new Uint8Array(chunk);
  throw new TypeError("socket.writable takes bytes (a Uint8Array, another ArrayBuffer view, or an ArrayBuffer)");
}

const illegal = Symbol("Socket");

class Socket {
  #secureTransport;
  #hostname;
  #allowHalfOpen;
  #readable;
  #writable;
  #opened;
  #closed;
  #resolveClosed;
  #rejectClosed;
  #readController;
  #writeController;
  #id; // a promise of the broker's id
  #done = false;
  #readEnded = false;
  #writeEnded = false;
  #upgraded = false;

  constructor(key, hostname, secureTransport, allowHalfOpen, info) {
    if (key !== illegal) throw new TypeError("Illegal constructor: use connect()");
    this.#hostname = hostname;
    this.#secureTransport = secureTransport;
    this.#allowHalfOpen = allowHalfOpen;
    this.#closed = new Promise((resolve, reject) => {
      this.#resolveClosed = resolve;
      this.#rejectClosed = reject;
    });
    ignore(this.#closed);
    this.#opened = PromisePrototypeThen(info, (i) => ObjectFreeze({ __proto__: null, remoteAddress: i.remoteAddress }));
    ignore(this.#opened);
    this.#id = PromisePrototypeThen(info, (i) => i.id);
    PromisePrototypeCatch(info, (err) => this.#fail(err));

    this.#readable = new ReadableStream({
      __proto__: null,
      type: "bytes",
      start: (c) => {
        this.#readController = c;
      },
      pull: async (c) => {
        const id = await this.#id;
        let chunk;
        try {
          chunk = await transport("read", id);
        } catch (err) {
          this.#fail(err);
          return;
        }
        if (this.#done) return;
        if (chunk === null) {
          this.#readEnded = true;
          c.close();
          c.byobRequest?.respond(0);
          if (!this.#allowHalfOpen) this.#finish();
          else if (this.#writeEnded) this.#finish();
        } else if (chunk.length > 0) {
          c.enqueue(chunk);
        }
      },
      cancel: () => {
        this.#readEnded = true;
        if (!this.#allowHalfOpen || this.#writeEnded) this.#finish();
      },
    }, { __proto__: null, highWaterMark: 0 });

    this.#writable = new WritableStream({
      __proto__: null,
      start: (c) => {
        this.#writeController = c;
      },
      write: async (chunk) => {
        const bytes = toBytes(chunk);
        const id = await this.#id;
        if (this.#done) throw new TypeError("the socket is closed");
        try {
          await transport("write", id, bytes);
        } catch (err) {
          this.#fail(err);
          throw err;
        }
      },
      close: async () => {
        const id = await this.#id;
        this.#writeEnded = true;
        if (this.#done) return;
        await transport("end", id);
        if (this.#readEnded) this.#finish();
      },
      abort: () => {
        this.#writeEnded = true;
        this.#finish();
      },
    });
  }

  get readable() {
    return this.#readable;
  }
  get writable() {
    return this.#writable;
  }
  get opened() {
    return this.#opened;
  }
  get closed() {
    return this.#closed;
  }
  get upgraded() {
    return this.#upgraded;
  }
  get secureTransport() {
    return this.#secureTransport;
  }

  /** Close both directions; resolves with `closed`. */
  close() {
    this.#finish();
    return this.#closed;
  }

  /** Upgrade a `secureTransport: 'starttls'` socket to TLS. This socket is
   * done with; the returned one carries the connection. */
  startTls(options = undefined) {
    if (this.#secureTransport !== "starttls") {
      throw new TypeError("startTls() needs a socket opened with secureTransport: 'starttls'");
    }
    if (this.#upgraded) throw new TypeError("startTls() was already called on this socket");
    if (this.#done) throw new TypeError("the socket is closed");
    let servername = this.#hostname;
    if (options?.expectedServerHostname !== undefined) {
      servername = options.expectedServerHostname;
      if (typeof servername !== "string" || servername === "") {
        throw new TypeError("startTls: expectedServerHostname must be a hostname");
      }
    }
    this.#upgraded = true;
    const info = PromisePrototypeThen(this.#id, (id) => transport("startTls", id, { servername }));
    const tls = new Socket(illegal, this.#hostname, "on", this.#allowHalfOpen, info);
    // This socket's streams end here (nothing more comes through them), and
    // its `closed` resolves once the upgrade is settled.
    this.#done = true;
    this.#endStreams(new TypeError("the socket was upgraded with startTls()"));
    const settle = () => this.#resolveClosed();
    PromisePrototypeThen(info, settle, settle);
    return tls;
  }

  #endStreams(reason) {
    try {
      this.#readController.close();
      this.#readController.byobRequest?.respond(0);
    } catch {
      // Already closed or errored.
    }
    try {
      this.#writeController.error(reason);
    } catch {
      // Already errored.
    }
  }

  /** The socket closed normally (or by close()). */
  #finish() {
    if (this.#done) return;
    this.#done = true;
    this.#endStreams(new TypeError("the socket is closed"));
    PromisePrototypeThen(
      this.#id,
      (id) => PromisePrototypeThen(transport("close", id), () => this.#resolveClosed(), (err) => this.#rejectClosed(err)),
      () => this.#resolveClosed(),
    );
  }

  /** The connection failed: both streams error, `closed` rejects. */
  #fail(err) {
    if (this.#done) return;
    this.#done = true;
    try {
      this.#readController.error(err);
    } catch {
      // Already closed.
    }
    try {
      this.#writeController.error(err);
    } catch {
      // Already errored.
    }
    this.#rejectClosed(err);
    PromisePrototypeThen(this.#id, (id) => ignore(transport("close", id)), () => {});
  }
}

const SECURE_TRANSPORTS = ["off", "on", "starttls"];

function connect(address, options = undefined) {
  if (transport === null) throw new TypeError("connect() isn't available: this isolate has no connect policy");
  const { hostname, port } = parseAddress(address);
  const secureTransport = options?.secureTransport ?? "off";
  if (SECURE_TRANSPORTS[0] !== secureTransport && SECURE_TRANSPORTS[1] !== secureTransport && SECURE_TRANSPORTS[2] !== secureTransport) {
    throw new TypeError("connect: secureTransport must be 'off', 'on', or 'starttls'");
  }
  const allowHalfOpen = options?.allowHalfOpen === true;
  let info;
  try {
    info = transport("open", { hostname, port, tls: secureTransport === "on" });
  } catch (err) {
    info = PromiseReject(err);
  }
  return new Socket(illegal, hostname, secureTransport, allowHalfOpen, info);
}

return { connect, Socket, setTransport };
})();
