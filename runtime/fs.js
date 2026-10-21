// The guest's `fs` object, over isolane's file broker (ts/brokers/fs.ts),
// which checks every path against the isolate's fs policy and does the
// work on the host. The broker is a host function the prelude hands over
// (ts/capabilities.ts):
//   readFile(path) → bytes; writeFile(path, bytes); readdir(path) → names;
//   stat(path); exists(path); mkdir(path, recursive); rm(path, recursive)
// Bytes cross as Uint8Arrays (host calls carry them raw).
(function () {
const { core, primordials } = __bootstrap;
const {
  DataViewPrototypeGetBuffer,
  DataViewPrototypeGetByteLength,
  DataViewPrototypeGetByteOffset,
  ObjectFreeze,
  String,
  TypeError,
  TypedArrayPrototypeGetBuffer,
  TypedArrayPrototypeGetByteLength,
  TypedArrayPrototypeGetByteOffset,
  Uint8Array,
} = primordials;

const { TextDecoder, TextEncoder } = core.loadExtScript("ext:deno_web/08_text_encoding.js");

/** The `fs` global over the broker's host function. */
function createFs(transport) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // A guest's text, bytes, or buffer as a Uint8Array (the bytes cross to
  // the host as they are when called).
  const toBytes = (data) => {
    if (core.isArrayBuffer(data)) return new Uint8Array(data);
    if (core.isDataView(data)) {
      return new Uint8Array(
        DataViewPrototypeGetBuffer(data),
        DataViewPrototypeGetByteOffset(data),
        DataViewPrototypeGetByteLength(data),
      );
    }
    if (core.isArrayBufferView(data)) {
      return new Uint8Array(
        TypedArrayPrototypeGetBuffer(data),
        TypedArrayPrototypeGetByteOffset(data),
        TypedArrayPrototypeGetByteLength(data),
      );
    }
    return encoder.encode(String(data));
  };
  const encodingOf = (options) => (typeof options === "string" ? options : options?.encoding);
  return ObjectFreeze({
    async readFile(path, options) {
      const bytes = await transport("readFile", path);
      const enc = encodingOf(options);
      if (enc == null) return bytes;
      if (enc === "utf8" || enc === "utf-8") return decoder.decode(bytes);
      throw new TypeError("fs.readFile: unsupported encoding " + enc);
    },
    writeFile: (path, data) => transport("writeFile", path, toBytes(data)),
    readdir: (path) => transport("readdir", path),
    stat: (path) => transport("stat", path),
    exists: (path) => transport("exists", path),
    mkdir: (path, options) => transport("mkdir", path, options?.recursive === true),
    rm: (path, options) => transport("rm", path, options?.recursive === true),
  });
}

return { createFs };
})();
