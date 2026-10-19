// The web platform globals (WinterTC Minimum Common API, phase 1), defined
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

  lazy("URL", from(URL_JS, "URL"));
  lazy("URLSearchParams", from(URL_JS, "URLSearchParams"));
  lazy("DOMException", from(DOM_EXCEPTION_JS, "DOMException"));
  for (const name of ["Event", "EventTarget", "CustomEvent", "ErrorEvent", "PromiseRejectionEvent"]) {
    lazy(name, () => eventModule()[name]);
  }
  lazy("AbortController", from(ABORT_JS, "AbortController"));
  lazy("AbortSignal", from(ABORT_JS, "AbortSignal"));
  lazy("atob", from(BASE64_JS, "atob"));
  lazy("btoa", from(BASE64_JS, "btoa"));
  lazy("TextEncoder", from(ENCODING_JS, "TextEncoder"));
  lazy("TextDecoder", from(ENCODING_JS, "TextDecoder"));
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
          const { DOMException } = load(DOM_EXCEPTION_JS);
          throw new DOMException(
            "The ArrayBufferView's byte length exceeds the number of bytes of entropy available via this API (65536)",
            "QuotaExceededError",
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
