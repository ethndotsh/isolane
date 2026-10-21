// Bytes from the network that the guest hasn't read yet, for the fetch and
// connect brokers: one reader at a time, and the source paused while the
// queue is past its high-water mark.

/** What a queue's bytes come from: an http.IncomingMessage or a net.Socket. */
interface Source {
  pause(): unknown;
  resume(): unknown;
}

export class ByteQueue {
  /** Paused past the high-water mark, resumed once the reader takes what's queued. */
  source: Source | undefined;
  #highWater: number;
  #chunks: Buffer[] = [];
  #bytes = 0;
  #ended = false;
  #error: Error | undefined;
  #wake: (() => void) | undefined;

  constructor(highWater: number) {
    this.#highWater = highWater;
  }

  /** Unread bytes. */
  get size(): number {
    return this.#bytes;
  }
  get ended(): boolean {
    return this.#ended;
  }
  get error(): Error | undefined {
    return this.#error;
  }
  /** A read is waiting for bytes. */
  get waiting(): boolean {
    return this.#wake !== undefined;
  }

  push(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;
    if (this.#bytes >= this.#highWater) this.source?.pause();
    this.wake();
  }

  /** No more bytes come; what's queued can still be read. */
  end(): void {
    this.#ended = true;
    this.wake();
  }

  /** Fail the reader once what's queued is read. The first error stays. */
  fail(err: Error): void {
    this.#error ??= err;
    this.wake();
  }

  /** Let a waiting read look again. */
  wake(): void {
    const w = this.#wake;
    this.#wake = undefined;
    w?.();
  }

  /** Everything queued, waiting for bytes if there are none; null at the
   * end, or the error. One read at a time (check `waiting` first). */
  async read(): Promise<Buffer | null> {
    while (this.#chunks.length === 0 && !this.#ended && !this.#error) {
      await new Promise<void>((r) => (this.#wake = r));
    }
    if (this.#chunks.length) {
      const data = this.#chunks.length === 1 ? this.#chunks[0] : Buffer.concat(this.#chunks, this.#bytes);
      this.#chunks = [];
      this.#bytes = 0;
      this.source?.resume();
      return data;
    }
    if (this.#error) throw this.#error;
    return null;
  }
}
