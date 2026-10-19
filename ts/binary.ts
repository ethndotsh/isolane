// Bytes in host calls and host replies cross as raw bytes after a frame's
// JSON, not as JSON. These find them in a host function's result and say
// where they go (the worker puts them back as Uint8Arrays).

/** A step into a JSON value: an object key or an array index. */
export type PathSegment = string | number;

export interface BinaryPart {
  path: PathSegment[];
  bytes: Uint8Array;
}

/** ArrayBuffers and views of them (Buffer, typed arrays, DataView). */
export function isBytes(v: unknown): v is ArrayBuffer | SharedArrayBuffer | ArrayBufferView {
  return v instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && v instanceof SharedArrayBuffer) || ArrayBuffer.isView(v);
}

export function asUint8Array(v: ArrayBuffer | SharedArrayBuffer | ArrayBufferView): Uint8Array {
  return ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v);
}

/**
 * JSON for `value` with every byte value replaced by null, and the bytes
 * with their paths, in one JSON.stringify pass. Bytes are found wherever
 * JSON.stringify visits (plain objects, arrays, and what toJSON returns);
 * `undefined` when the value has no JSON form (like JSON.stringify).
 */
export function splitBytes(value: unknown): { json: string | undefined; parts: BinaryPart[] } {
  const parts: BinaryPart[] = [];
  const paths = new WeakMap<object, PathSegment[]>();
  let root = true;
  const json = JSON.stringify(value, function (this: unknown, key: string, v: unknown) {
    let path: PathSegment[];
    if (root) {
      root = false;
      path = [];
    } else {
      const parent = paths.get(this as object) ?? [];
      path = [...parent, Array.isArray(this) ? Number(key) : key];
    }
    // Check the value before toJSON: Buffer#toJSON would turn it into an object.
    const raw = (this as Record<string, unknown>)[key];
    if (isBytes(raw)) {
      parts.push({ path, bytes: asUint8Array(raw) });
      return null;
    }
    if (v !== null && typeof v === 'object') paths.set(v, path);
    return v;
  });
  return { json, parts };
}
