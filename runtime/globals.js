// The web platform globals (WinterTC Minimum Common API, phases 1–3), defined
// non-enumerable like Deno's 98_global_scope_shared.js. Most are lazy: the
// first access loads the vendored script behind them, so a VM pays only
// for what its code uses. Called once per context by the worker:
//   (bootstrap) => undefined
(function (bootstrap) {
  "use strict";
  const { core, primordials } = bootstrap;
  const {
    ArrayBufferIsView,
    ArrayPrototypeIncludes,
    ObjectDefineProperty,
    ObjectFreeze,
    ObjectHasOwn,
    ObjectSetPrototypeOf,
    PromisePrototypeThen,
    PromiseResolve,
    TypeError,
    TypedArrayPrototypeGetByteLength,
    TypedArrayPrototypeGetSymbolToStringTag,
  } = primordials;
  const load = core.loadExtScript;
  const g = globalThis;

  function define(name, value) {
    ObjectDefineProperty(g, name, {
      __proto__: null,
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  // An accessor that resolves on first use, then becomes a plain value.
  function lazy(name, get) {
    ObjectDefineProperty(g, name, {
      __proto__: null,
      configurable: true,
      enumerable: false,
      get() {
        const value = get();
        define(name, value);
        return value;
      },
      set(value) {
        define(name, value);
      },
    });
  }
  const from = (specifier, name) => () => load(specifier)[name];

  const URL_JS = "ext:deno_web/00_url.js";
  const DOM_EXCEPTION_JS = "ext:deno_web/01_dom_exception.js";
  const EVENT_JS = "ext:deno_web/02_event.js";
  const ABORT_JS = "ext:deno_web/03_abort_signal.js";
  const BASE64_JS = "ext:deno_web/05_base64.js";
  const ENCODING_JS = "ext:deno_web/08_text_encoding.js";
  const PERFORMANCE_JS = "ext:deno_web/15_performance.js";
  const TIMERS_JS = "ext:deno_web/02_timers.js";
  const STREAMS_JS = "ext:deno_web/06_streams.js";
  const FILE_JS = "ext:deno_web/09_file.js";
  const FILE_READER_JS = "ext:deno_web/10_filereader.js";
  const COMPRESSION_JS = "ext:deno_web/14_compression.js";
  const HEADERS_JS = "ext:deno_fetch/20_headers.js";
  const FORMDATA_JS = "ext:deno_fetch/21_formdata.js";
  const REQUEST_JS = "ext:deno_fetch/23_request.js";
  const RESPONSE_JS = "ext:deno_fetch/23_response.js";
  const FETCH_JS = "ext:isolane/fetch.js";

  // The global object is an EventTarget (reportError dispatches "error" on
  // it). Set up the first time anything event-related is used.
  const TARGET_METHODS = ["addEventListener", "removeEventListener", "dispatchEvent"];
  let events;
  function eventModule() {
    if (events) return events;
    events = load(EVENT_JS);
    const webidl = load("ext:deno_webidl/00_webidl.js");
    for (const name of TARGET_METHODS) delete g[name];
    ObjectSetPrototypeOf(g, events.EventTargetPrototype);
    g[webidl.brand] = webidl.brand;
    events.setEventTargetData(g);
    events.saveGlobalThisReference(g);
    return events;
  }
  for (const name of TARGET_METHODS) {
    ObjectDefineProperty(g, name, {
      __proto__: null,
      configurable: true,
      enumerable: false,
      get() {
        eventModule();
        return g[name];
      },
    });
  }

  // URL.createObjectURL and revokeObjectURL come with Blob (09_file.js
  // assigns them when it loads); until then, accessors that load it.
  lazy("URL", () => {
    const URL = load(URL_JS).URL;
    for (const name of ["createObjectURL", "revokeObjectURL"]) {
      if (ObjectHasOwn(URL, name)) continue; // 09_file.js already loaded
      ObjectDefineProperty(URL, name, {
        __proto__: null,
        configurable: true,
        enumerable: true,
        get() {
          load(FILE_JS);
          return URL[name];
        },
        set(value) {
          ObjectDefineProperty(URL, name, { __proto__: null, value, writable: true, configurable: true, enumerable: true });
        },
      });
    }
    return URL;
  });
  lazy("URLSearchParams", from(URL_JS, "URLSearchParams"));
  lazy("DOMException", from(DOM_EXCEPTION_JS, "DOMException"));
  lazy("QuotaExceededError", from(DOM_EXCEPTION_JS, "QuotaExceededError"));
  for (const name of ["Event", "EventTarget", "CustomEvent", "ErrorEvent", "PromiseRejectionEvent"]) {
    lazy(name, () => eventModule()[name]);
  }
  lazy("AbortController", from(ABORT_JS, "AbortController"));
  lazy("AbortSignal", from(ABORT_JS, "AbortSignal"));
  lazy("atob", from(BASE64_JS, "atob"));
  lazy("btoa", from(BASE64_JS, "btoa"));
  lazy("TextEncoder", from(ENCODING_JS, "TextEncoder"));
  lazy("TextDecoder", from(ENCODING_JS, "TextDecoder"));
  lazy("TextEncoderStream", from(ENCODING_JS, "TextEncoderStream"));
  lazy("TextDecoderStream", from(ENCODING_JS, "TextDecoderStream"));

  // Timers. An exception in a callback is reported like any uncaught
  // error: an "error" event on the global object, then the console.
  core.setReportException((error) => eventModule().reportException(error));
  for (const name of ["setTimeout", "setInterval", "clearTimeout", "clearInterval"]) {
    lazy(name, from(TIMERS_JS, name));
  }

  for (
    const name of [
      "ReadableStream",
      "ReadableStreamDefaultReader",
      "ReadableStreamBYOBReader",
      "ReadableStreamBYOBRequest",
      "ReadableByteStreamController",
      "ReadableStreamDefaultController",
      "WritableStream",
      "WritableStreamDefaultWriter",
      "WritableStreamDefaultController",
      "TransformStream",
      "TransformStreamDefaultController",
      "ByteLengthQueuingStrategy",
      "CountQueuingStrategy",
    ]
  ) {
    lazy(name, from(STREAMS_JS, name));
  }
  lazy("Blob", from(FILE_JS, "Blob"));
  lazy("File", from(FILE_JS, "File"));
  lazy("FileReader", from(FILE_READER_JS, "FileReader"));
  lazy("ProgressEvent", () => eventModule().ProgressEvent);
  lazy("CompressionStream", from(COMPRESSION_JS, "CompressionStream"));
  lazy("DecompressionStream", from(COMPRESSION_JS, "DecompressionStream"));
  // Fetch. The network itself is the isolate's fetch policy: the prelude
  // (ts/capabilities.ts) hands its broker's host function to this hook,
  // which the worker deletes before guest code runs. Without a policy,
  // fetch() rejects with a TypeError.
  let fetchTransport = null;
  ObjectDefineProperty(g, "__isolane_web_fetch", {
    __proto__: null,
    configurable: true,
    enumerable: false,
    writable: false,
    value(transport) {
      if (fetchTransport === null) fetchTransport = transport;
    },
  });
  lazy("Headers", from(HEADERS_JS, "Headers"));
  lazy("FormData", from(FORMDATA_JS, "FormData"));
  lazy("Request", from(REQUEST_JS, "Request"));
  lazy("Response", from(RESPONSE_JS, "Response"));
  lazy("fetch", () => {
    const module = load(FETCH_JS);
    if (fetchTransport !== null) module.setTransport(fetchTransport);
    return module.fetch;
  });

  lazy("structuredClone", from("ext:deno_web/02_structured_clone.js", "structuredClone"));
  let perf;
  const performanceModule = () => {
    if (!perf) {
      perf = load(PERFORMANCE_JS);
      perf.setTimeOrigin();
    }
    return perf;
  };
  lazy("performance", () => performanceModule().performance);
  for (const name of ["Performance", "PerformanceEntry", "PerformanceMark", "PerformanceMeasure"]) {
    lazy(name, () => performanceModule()[name]);
  }

  define("reportError", function reportError(error) {
    if (arguments.length < 1) {
      throw new TypeError("Failed to execute 'reportError': 1 argument required, but only 0 present.");
    }
    const { reportError } = eventModule(); // checks `this`: call it unbound
    reportError(error);
  });

  define("queueMicrotask", function queueMicrotask(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("Failed to execute 'queueMicrotask': Argument 1 is not a function.");
    }
    PromisePrototypeThen(PromiseResolve(), () => {
      try {
        callback();
      } catch (error) {
        const { reportException } = eventModule();
        reportException(error);
      }
    });
  });

  define("self", g);
  define("navigator", ObjectFreeze({ __proto__: null, userAgent: "isolane" }));

  const INTEGER_ARRAYS = [
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "BigInt64Array",
    "BigUint64Array",
  ];
  define(
    "crypto",
    ObjectFreeze({
      __proto__: null,
      getRandomValues(array) {
        if (!ArrayBufferIsView(array)) {
          throw new TypeError("Failed to execute 'getRandomValues' on 'Crypto': parameter 1 is not of type 'ArrayBufferView'.");
        }
        const tag = TypedArrayPrototypeGetSymbolToStringTag(array);
        if (!ArrayPrototypeIncludes(INTEGER_ARRAYS, tag)) {
          const { DOMException } = load(DOM_EXCEPTION_JS);
          throw new DOMException(
            "The provided ArrayBufferView is not an integer array type",
            "TypeMismatchError",
          );
        }
        if (TypedArrayPrototypeGetByteLength(array) > 65536) {
          // WebCrypto leaves quota and requested null.
          const { QuotaExceededError } = load(DOM_EXCEPTION_JS);
          throw new QuotaExceededError(
            "The ArrayBufferView's byte length exceeds the number of bytes of entropy available via this API (65536)",
          );
        }
        core.getRandomValues(array);
        return array;
      },
      randomUUID() {
        return core.randomUUID();
      },
    }),
  );
})
