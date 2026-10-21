// The worker protocol's framing (crates/worker/src/frame.rs on the other
// side): each frame is a u32 little-endian body length, then the body. A
// body is UTF-8 JSON (starting with `{`), or bytes attached to JSON: a 0x00
// tag, a u32 little-endian JSON length, the JSON, then raw bytes that the
// JSON's `bin` field claims, all of them, in order.

/** Largest frame accepted from a worker (matches the worker's own cap). */
export const MAX_FRAME = 64 << 20;

const BINARY_TAG = 0;
const BINARY_HEADER = 5;

/** One frame from a worker: its JSON, parsed but unchecked. */
export interface Frame {
  json: unknown;
  /** A binary frame's attached bytes. */
  bytes?: Buffer;
  /** The body's length. */
  size: number;
}

/** A worker broke the framing: the stream can't be trusted past here. */
export class FrameError extends Error {}

/** A message's frame: `json`, with `attached` bytes after it (a binary frame) if any. */
export function encodeFrame(json: Buffer, attached: readonly Uint8Array[] = []): Buffer {
  if (attached.length === 0) {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    return Buffer.concat([header, json]);
  }
  const bytes = attached.reduce((n, b) => n + b.length, 0);
  const header = Buffer.alloc(4 + BINARY_HEADER);
  header.writeUInt32LE(BINARY_HEADER + json.length + bytes, 0);
  header[4] = BINARY_TAG;
  header.writeUInt32LE(json.length, 5);
  return Buffer.concat([header, json, ...attached]);
}

/** Whether a message of `json` bytes plus `attached` bytes fits in a frame. */
export function fits(json: number, attached: number): boolean {
  return json + attached + (attached > 0 ? BINARY_HEADER : 0) <= MAX_FRAME;
}

/** Splits a worker's output into frames as it arrives. */
export class FrameReader {
  #buf: Buffer = Buffer.alloc(0);
  // Chunks of a frame still arriving, joined once it's complete (joining
  // on every chunk would copy a large frame over and over).
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #need = 0;

  /** The frames `chunk` completes. Throws a FrameError at a frame over
   * MAX_FRAME or one that doesn't decode. */
  *push(chunk: Buffer): Generator<Frame> {
    if (this.#need > 0 && this.#pendingBytes + chunk.length < this.#need) {
      this.#pending.push(chunk);
      this.#pendingBytes += chunk.length;
      return;
    }
    if (this.#pending.length) {
      this.#pending.push(chunk);
      chunk = Buffer.concat(this.#pending, this.#pendingBytes + chunk.length);
      this.#pending = [];
      this.#pendingBytes = 0;
    }
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    this.#need = 0;
    while (this.#buf.length >= 4) {
      const len = this.#buf.readUInt32LE(0);
      if (len > MAX_FRAME) throw new FrameError(`frame of ${len} bytes`);
      if (this.#buf.length < 4 + len) {
        // Hold the partial frame until all of it is here.
        this.#need = 4 + len;
        this.#pending = [this.#buf];
        this.#pendingBytes = this.#buf.length;
        this.#buf = Buffer.alloc(0);
        return;
      }
      const body = this.#buf.subarray(4, 4 + len);
      this.#buf = this.#buf.subarray(4 + len);
      yield decode(body);
    }
  }
}

function decode(body: Buffer): Frame {
  try {
    if (body[0] !== BINARY_TAG) return { json: JSON.parse(body.toString('utf8')), size: body.length };
    if (body.length < BINARY_HEADER) throw new Error('truncated binary frame');
    const jsonLen = body.readUInt32LE(1);
    if (jsonLen > body.length - BINARY_HEADER) throw new Error('binary frame JSON overruns the frame');
    const json = body.subarray(BINARY_HEADER, BINARY_HEADER + jsonLen).toString('utf8');
    // Copied: host functions may keep these bytes, and they shouldn't
    // keep the rest of the stream's buffer alive.
    const bytes = Buffer.from(body.subarray(BINARY_HEADER + jsonLen));
    return { json: JSON.parse(json), bytes, size: body.length };
  } catch {
    throw new FrameError('malformed message');
  }
}
