// isolane's stand-in for deno_core's JS layer: builds the `__bootstrap`
// object ({ core, internals, primordials }) that Deno's vendored
// web-platform scripts (runtime/deno/) expect, on top of the worker's
// native functions (crates/worker/src/web/). Called once per context by the
// worker, before any guest code runs:
//   (native, ops, primordials) => bootstrap
// The vendored scripts receive `bootstrap` as a parameter; it is never a
// global, so guest code can't reach `core` or the ops.
(function (native, rawOps, primordials) {
  "use strict";
  const {
    ErrorPrototype,
    FinalizationRegistry,
    FinalizationRegistryPrototypeRegister,
    ObjectAssign,
    ObjectCreate,
    ObjectFreeze,
    ObjectPrototypeIsPrototypeOf,
    SafeMap,
    MapPrototypeGet,
    MapPrototypeHas,
    MapPrototypeSet,
    String,
    SymbolFor,
    TypeError,
  } = primordials;

  // TextDecoder stream handles: native decoder ids, wrapped so a handle the
  // guest abandons mid-stream frees its decoder when collected.
  const decoders = new FinalizationRegistry((id) => native.freeDecoder(id));
  const ops = ObjectFreeze(
    ObjectAssign(ObjectCreate(null), rawOps, {
      op_encoding_new_decoder(label, fatal, ignoreBOM) {
        const id = native.newDecoder(label, fatal, ignoreBOM);
        const handle = ObjectFreeze({ __proto__: null, id });
        FinalizationRegistryPrototypeRegister(decoders, handle, id);
        return handle;
      },
      op_encoding_decode(input, handle, stream) {
        return native.decoderDecode(input, handle.id, stream);
      },
    }),
  );

  // Scripts outside phase 1 that the vendored code only touches lazily:
  // inspection for Deno's console, and from MessagePort's script only
  // markNotSerializable (a brand structuredClone refuses, see web/clone.rs).
  const stubs = {
    __proto__: null,
    "ext:deno_web/01_console.js": ObjectFreeze({
      createFilteredInspectProxy: ({ object }) => object,
    }),
    "ext:deno_web/13_message_port.js": ObjectFreeze({
      markNotSerializable: native.markNotSerializable,
      MessagePortPrototype: ObjectFreeze(ObjectCreate(null)),
    }),
  };

  const loaded = new SafeMap();
  let bootstrap;
  function loadExtScript(specifier) {
    if (MapPrototypeHas(loaded, specifier)) return MapPrototypeGet(loaded, specifier);
    const exports = stubs[specifier] ?? native.compileExt(specifier)(bootstrap);
    MapPrototypeSet(loaded, specifier, exports);
    return exports;
  }

  // Timers arrive with the event loop (WinterTC phase 2).
  const noTimers = () => {
    throw new TypeError("timers are not supported yet (AbortSignal.timeout, setTimeout)");
  };

  function destructureError(error) {
    const message = ObjectPrototypeIsPrototypeOf(ErrorPrototype, error)
      ? `${error.name}: ${error.message}`
      : String(error);
    return { exceptionMessage: `Uncaught ${message}`, frames: [] };
  }

  const core = ObjectFreeze({
    __proto__: null,
    ops,
    loadExtScript,
    build: ObjectFreeze({ __proto__: null, os: "isolane", arch: "", target: "" }),
    isAnyArrayBuffer: native.isAnyArrayBuffer,
    isArrayBuffer: native.isArrayBuffer,
    isArrayBufferView: native.isArrayBufferView,
    isDataView: native.isDataView,
    isProxy: native.isProxy,
    isSharedArrayBuffer: native.isSharedArrayBuffer,
    isStringObject: native.isStringObject,
    isTypedArray: native.isTypedArray,
    encode: native.encode,
    decode: native.decode,
    structuredClone: native.structuredClone,
    hostObjectBrand: SymbolFor("Deno.core.hostObject"),
    registerCloneableResource() {},
    destructureError,
    reportUnhandledException: native.reportUnhandledException,
    createSystemTimer: noTimers,
    createTimer: noTimers,
    cancelTimer: noTimers,
    refTimer: noTimers,
    unrefTimer: noTimers,
    // Not part of deno_core: randomness for crypto in runtime/globals.js.
    getRandomValues: native.getRandomValues,
    randomUUID: native.randomUUID,
  });

  bootstrap = ObjectFreeze({
    __proto__: null,
    core,
    internals: { __proto__: null },
    primordials,
  });
  return bootstrap;
})
