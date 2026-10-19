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
    ArrayPrototypeFilter,
    ArrayPrototypeMap,
    ArrayPrototypePop,
    ArrayPrototypePush,
    ErrorPrototype,
    FinalizationRegistry,
    FinalizationRegistryPrototypeRegister,
    MathTrunc,
    NumberIsFinite,
    ObjectAssign,
    ObjectCreate,
    ObjectFreeze,
    ObjectPrototypeIsPrototypeOf,
    Promise,
    PromisePrototypeThen,
    PromiseResolve,
    RangeError,
    SafeMap,
    MapPrototypeDelete,
    MapPrototypeGet,
    MapPrototypeHas,
    MapPrototypeSet,
    String,
    StringFromCharCode,
    RegExpPrototypeExec,
    StringPrototypeIndexOf,
    StringPrototypeSlice,
    StringPrototypeStartsWith,
    SymbolFor,
    SymbolSpecies,
    SymbolToStringTag,
    TypedArrayPrototypeGetLength,
    TypedArrayPrototypeSlice,
    TypedArrayPrototypeSubarray,
    TypeError,
  } = primordials;

  // Guests have no SharedArrayBuffer, but primordials expect deno_core to
  // register one before anything reads its methods (06_streams.js does at
  // load). This stand-in is never reachable from guest code, and nothing is
  // ever a SharedArrayBuffer, so its methods never run.
  const noSharedArrayBuffer = () => {
    throw new TypeError("SharedArrayBuffer is not available");
  };
  primordials.setSharedArrayBuffer(
    class SharedArrayBuffer {
      constructor() {
        noSharedArrayBuffer();
      }
      static get [SymbolSpecies]() {
        return this;
      }
      get byteLength() {
        return noSharedArrayBuffer();
      }
      get growable() {
        return noSharedArrayBuffer();
      }
      get maxByteLength() {
        return noSharedArrayBuffer();
      }
      slice() {
        noSharedArrayBuffer();
      }
      grow() {
        noSharedArrayBuffer();
      }
      get [SymbolToStringTag]() {
        return "SharedArrayBuffer";
      }
    },
  );

  // primordials.queueMicrotask, which streams use (deno_core binds V8's).
  // Exceptions are reported like any uncaught error.
  primordials.setQueueMicrotask((callback) => {
    PromisePrototypeThen(PromiseResolve(), () => {
      try {
        callback();
      } catch (error) {
        reportException(error);
      }
    });
  });

  // ---- timers ----
  // The JS half of the event loop (the Rust half: crates/worker/src/web/
  // timers.rs). A binary heap ordered by (deadline, creation order) on the
  // worker's monotonic timer clock. Rust learns the earliest deadline and
  // the ref'd count through native.timerState, and calls runTimer(now) to
  // run one due timer per task. Cancelled timers stay in the heap until
  // they surface, or until there are more dead entries than live ones.
  const MAX_TIMERS = native.maxTimers; // limits.timers
  const TIMEOUT_MAX = 2 ** 31 - 1;
  const heap = [];
  let order = 0;
  let live = 0;
  let dead = 0;
  let refed = 0;
  let nextTimerId = 1;
  let running = null; // the timer whose callback is running
  let reportException = native.reportUnhandledException;

  const before = (a, b) => a.deadline < b.deadline || (a.deadline === b.deadline && a.order < b.order);
  function heapPush(t) {
    let i = ArrayPrototypePush(heap, t) - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(heap[i], heap[parent])) break;
      const tmp = heap[i];
      heap[i] = heap[parent];
      heap[parent] = tmp;
      i = parent;
    }
  }
  function heapPop() {
    const top = heap[0];
    const last = ArrayPrototypePop(heap);
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && before(heap[l], heap[m])) m = l;
        if (r < heap.length && before(heap[r], heap[m])) m = r;
        if (m === i) break;
        const tmp = heap[i];
        heap[i] = heap[m];
        heap[m] = tmp;
        i = m;
      }
    }
    return top;
  }
  function compact() {
    const keep = ArrayPrototypeFilter(heap, (t) => !t.destroyed);
    heap.length = 0;
    dead = 0;
    for (let i = 0; i < keep.length; i++) heapPush(keep[i]);
  }
  function report() {
    while (heap.length > 0 && heap[0].destroyed) {
      heapPop();
      dead--;
    }
    native.timerState(heap.length > 0 ? heap[0].deadline : Infinity, refed);
  }
  function schedule(timer, after) {
    // HTML: past nesting level 5, a timeout shorter than 4 ms becomes 4 ms.
    if (timer.level > 5 && after < 4) after = 4;
    timer.deadline = native.timerNow() + after;
    timer.order = order++;
    heapPush(timer);
  }
  function retire(timer) {
    timer.destroyed = true;
    live--;
    if (timer.refed) refed--;
  }

  // core.createTimer, as Deno's ext/web/02_timers.js calls it.
  function createTimer(callback, after, args, isRepeat, isRefed) {
    if (live >= MAX_TIMERS) {
      throw new RangeError(`isolane: more than ${MAX_TIMERS} active timers in this isolate`);
    }
    after = MathTrunc(+after);
    if (!NumberIsFinite(after) || after < 0) after = 0;
    if (after > TIMEOUT_MAX) after = 1;
    const timer = {
      __proto__: null,
      _timerId: nextTimerId++,
      callback,
      args,
      interval: after,
      repeat: !!isRepeat,
      refed: !!isRefed,
      destroyed: false,
      // HTML's timer nesting level: one more than the running timer's.
      level: (running ? running.level : 0) + 1,
      deadline: 0,
      order: 0,
    };
    live++;
    if (timer.refed) refed++;
    schedule(timer, after);
    report();
    return timer;
  }
  function cancelTimer(timer) {
    if (!timer || timer.destroyed) return;
    retire(timer);
    dead++;
    if (dead > 1024 && dead > live) compact();
    report();
  }
  function refTimer(timer) {
    if (timer && !timer.refed) {
      timer.refed = true;
      if (!timer.destroyed) refed++;
      report();
    }
  }
  function unrefTimer(timer) {
    if (timer && timer.refed) {
      timer.refed = false;
      if (!timer.destroyed) refed--;
      report();
    }
  }
  // Called from Rust with the timer clock's now: run the earliest timer if
  // it's due. Its exceptions are reported, as HTML has it, not thrown.
  function runTimer(now) {
    report();
    if (heap.length === 0 || heap[0].deadline > now) return;
    const timer = heapPop();
    const prev = running;
    running = timer;
    try {
      if (timer.args === undefined) timer.callback();
      else timer.callback(...timer.args);
    } catch (error) {
      reportException(error);
    } finally {
      running = prev;
      if (!timer.destroyed) {
        if (timer.repeat) {
          timer.level++;
          schedule(timer, timer.interval);
        } else {
          retire(timer);
        }
      } else {
        dead--; // cancelled by its own callback, already off the heap
      }
      report();
    }
  }
  native.setTimerRunner(runTimer);

  // ---- blobs ----
  // Deno keeps blob parts in a native store; here they're Uint8Arrays in
  // the isolate's own heap (bounded by its memory limits). A part is a view
  // [start, start + len) of an immutable copy; slices share it.
  const parts = new SafeMap();
  const objectUrls = new SafeMap();
  let nextPart = 1;
  function addPart(part) {
    const id = `${nextPart++}`;
    MapPrototypeSet(parts, id, part);
    return id;
  }
  function getPart(id) {
    const part = MapPrototypeGet(parts, id);
    if (part === undefined) throw new TypeError("Blob part not found");
    return part;
  }
  const blobOps = {
    op_blob_create_part(data) {
      const copy = TypedArrayPrototypeSlice(data);
      return addPart({ __proto__: null, buf: copy, start: 0, len: TypedArrayPrototypeGetLength(copy) });
    },
    op_blob_slice_part(id, { start, len }) {
      const part = getPart(id);
      if (start + len > part.len) throw new TypeError("Size larger than blob part");
      return addPart({ __proto__: null, buf: part.buf, start: part.start + start, len });
    },
    op_blob_read_part(id) {
      const part = getPart(id);
      return PromiseResolve(TypedArrayPrototypeSlice(part.buf, part.start, part.start + part.len));
    },
    op_blob_remove_part(id) {
      MapPrototypeDelete(parts, id);
    },
    op_blob_clone_part(id) {
      const part = getPart(id);
      return { uuid: addPart(part), size: part.len };
    },
    op_blob_create_object_url(mediaType, ids) {
      // The origin is the isolate's base URL's (web.baseUrl), else opaque.
      const url = `blob:${blobOrigin}/${native.randomUUID()}`;
      MapPrototypeSet(objectUrls, url, { mediaType, parts: ArrayPrototypeMap(ids, getPart) });
      return url;
    },
    op_blob_revoke_object_url(url) {
      MapPrototypeDelete(objectUrls, url);
    },
    op_blob_from_object_url(url) {
      if (!StringPrototypeStartsWith(url, "blob:")) return null;
      // Blob URL resolution ignores the fragment (FileAPI: "blob URL entry").
      const hash = StringPrototypeIndexOf(url, "#");
      if (hash !== -1) url = StringPrototypeSlice(url, 0, hash);
      const entry = MapPrototypeGet(objectUrls, url);
      if (entry === undefined) return null;
      return {
        mediaType: entry.mediaType,
        parts: ArrayPrototypeMap(entry.parts, (part) => ({ uuid: addPart(part), size: part.len })),
      };
    },
  };

  // FileReader's readAsBinaryString.
  function op_encode_binary_string(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      out += StringFromCharCode(...TypedArrayPrototypeSubarray(bytes, i, i + 8192));
    }
    return out;
  }

  // Compression stream handles, freed if abandoned (like decoders below).
  const compressors = new FinalizationRegistry((id) => native.compressionFree(id));
  const compressionOps = {
    op_compression_new(format, isDecoder) {
      const id = native.compressionNew(format, isDecoder);
      const handle = ObjectFreeze({ __proto__: null, id });
      FinalizationRegistryPrototypeRegister(compressors, handle, id);
      return handle;
    },
    op_compression_write(handle, chunk) {
      return native.compressionWrite(handle.id, chunk);
    },
    op_compression_finish(handle, reportErrors) {
      return native.compressionFinish(handle.id, reportErrors);
    },
  };

  // A macrotask: resolves when a 0 ms timer fires.
  function op_defer() {
    return new Promise((resolve) => createTimer(resolve, 0, undefined, false, true));
  }

  // TextDecoder stream handles: native decoder ids, wrapped so a handle the
  // guest abandons mid-stream frees its decoder when collected.
  const decoders = new FinalizationRegistry((id) => native.freeDecoder(id));
  const ops = ObjectFreeze(
    ObjectAssign(ObjectCreate(null), rawOps, blobOps, compressionOps, { op_encode_binary_string, op_defer }, {
      // (No op_http_new_response_native_headers / op_http_drop_response_native:
      // 23_response.js skips Deno.serve's native responses when they're absent.)
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
    // The location is the isolate's base URL (`web.baseUrl`), if it has one:
    // relative URLs in Request/Response.redirect resolve against it, and
    // throw without one, as in a worker without a base URL.
    "ext:deno_web/12_location.js": ObjectFreeze({ getLocationHref: () => native.baseUrl }),
    // Deno.HttpClient doesn't exist here, so no RequestInit.client is valid.
    "ext:deno_fetch/22_http_client.js": ObjectFreeze({ HttpClientPrototype: ObjectFreeze(ObjectCreate(null)) }),
  };

  const loaded = new SafeMap();
  let bootstrap;
  function loadExtScript(specifier) {
    if (MapPrototypeHas(loaded, specifier)) return MapPrototypeGet(loaded, specifier);
    const exports = stubs[specifier] ?? native.compileExt(specifier)(bootstrap);
    MapPrototypeSet(loaded, specifier, exports);
    return exports;
  }

  // structuredClone of platform objects (Blob, File): their hostObjectBrand
  // method describes them, and these rebuild them (see web/clone.rs).
  const cloneableDeserializers = { __proto__: null };
  const hostObjectBrand = SymbolFor("Deno.core.hostObject");

  const BadResourcePrototype = ObjectFreeze({ __proto__: null });
  // An http(s) base URL's origin is its scheme, host, and port: the part
  // before the path. (core.js runs before URL exists.)
  const blobOrigin = (native.baseUrl && RegExpPrototypeExec(/^https?:\/\/[^/?#]+/i, native.baseUrl)?.[0]) || "null";

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
    baseUrl: native.baseUrl,
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
    structuredClone: (value) => native.structuredClone(value, hostObjectBrand, cloneableDeserializers),
    hostObjectBrand,
    registerCloneableResource(name, deserialize) {
      cloneableDeserializers[name] = deserialize;
    },
    // Transfer (postMessage, structuredClone's transfer list) isn't
    // supported: there is nothing to transfer to.
    registerTransferableResource() {},
    destructureError,
    // deno_core's error for a closed resource. isolane has no resources, so
    // nothing is ever one, but the vendored body and stream code checks for
    // it when a read fails (and must not throw while checking).
    BadResourcePrototype: BadResourcePrototype,
    reportUnhandledException: native.reportUnhandledException,
    print(message, isError) {
      native.log(isError ? "error" : "log", String(message));
    },
    createTimer,
    createSystemTimer: (callback, after, isRefed) => createTimer(callback, after, undefined, false, isRefed),
    cancelTimer,
    refTimer,
    unrefTimer,
    // No AsyncContext: these keep Deno's timer wrapper working.
    getAsyncContext() {},
    setAsyncContext() {},
    // Not part of deno_core: globals.js routes timer exceptions to the
    // global object's error event.
    setReportException(fn) {
      reportException = fn;
    },
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
