// Run in every context that has WebAssembly, before guest code. WebAssembly
// shared memories can't be turned off in V8 (threads ship unflagged), and a
// shared memory's buffer is a SharedArrayBuffer, which isolane keeps from
// guests. One only reaches JavaScript through the Memory constructor or an
// instance's exports, so those refuse shared memories; compiling a module
// that declares one is fine, as nothing can reach the memory.
//
// It also hands each module the guest compiles to `keep` (the worker's
// wasm cache, vm/wasm_cache.rs), so later isolates reuse its compiled code.
//
// Everything this uses is captured now, and the checks don't call anything
// guest code could have replaced since (no iterators, no prototype lookups
// on objects the guest can reach).
((keep) => {
  "use strict";
  const W = globalThis.WebAssembly;
  const { apply, construct, defineProperty, getOwnPropertyDescriptor, ownKeys } = Reflect;
  const TypeErrorCtor = TypeError;
  const PromiseCtor = Promise;
  const then = Promise.prototype.then;
  const byteLength = getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
  const memoryBuffer = getOwnPropertyDescriptor(W.Memory.prototype, "buffer").get;
  const instanceExports = getOwnPropertyDescriptor(W.Instance.prototype, "exports").get;
  const { Memory, Module, Instance, compile, compileStreaming } = W;
  const moduleExports = Module.exports;

  const refuse = () => {
    throw new TypeErrorCtor("isolane: WebAssembly shared memories are disabled");
  };
  // A Memory whose buffer isn't an ArrayBuffer (byteLength throws for a
  // SharedArrayBuffer) is shared.
  const checkMemory = (value) => {
    let buffer;
    try {
      buffer = apply(memoryBuffer, value, []);
    } catch {
      return; // not a Memory
    }
    try {
      apply(byteLength, buffer, []);
    } catch {
      refuse();
    }
  };
  const checkInstance = (instance) => {
    const exports = apply(instanceExports, instance, []);
    const keys = ownKeys(exports);
    for (let i = 0; i < keys.length; i++) {
      checkMemory(getOwnPropertyDescriptor(exports, keys[i]).value);
    }
    return instance;
  };
  // Constructors that check what they made, standing in for the originals
  // everywhere (the global and the prototype's constructor).
  const guardConstructor = (Original, check) => {
    const Guard = function (...args) {
      if (new.target === undefined) {
        throw new TypeErrorCtor(`WebAssembly.${Original.name} must be invoked with 'new'`);
      }
      const made = construct(Original, args, new.target);
      check(made);
      return made;
    };
    defineProperty(Guard, "name", { value: Original.name });
    defineProperty(Guard, "length", { value: Original.length });
    defineProperty(Guard, "prototype", { value: Original.prototype });
    // Static methods too (Module.exports, imports, customSections).
    const statics = ownKeys(Original);
    for (let i = 0; i < statics.length; i++) {
      const key = statics[i];
      if (key !== "name" && key !== "length" && key !== "prototype") {
        defineProperty(Guard, key, getOwnPropertyDescriptor(Original, key));
      }
    }
    defineProperty(Original.prototype, "constructor", {
      value: Guard,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    return Guard;
  };
  const replace = (name, value) => {
    const d = getOwnPropertyDescriptor(W, name);
    defineProperty(W, name, { ...d, value });
  };
  // A promise's reactions, without the species lookup then() would do
  // through promise.constructor (which guest code can replace, and would
  // then see the promise).
  const after = (promise, onFulfilled) => {
    defineProperty(promise, "constructor", { value: undefined });
    return apply(then, promise, [onFulfilled]);
  };
  const isModule = (value) => {
    try {
      apply(moduleExports, Module, [value]);
      return true;
    } catch {
      return false;
    }
  };
  const newInstance = (module, imports) => checkInstance(construct(Instance, [module, imports]));
  // instantiate and instantiateStreaming compile asynchronously, then
  // instantiate here, synchronously, so the instance is checked before any
  // promise holds it: resolving a promise with an object looks up its
  // `then`, which guest code can define on Object.prototype.
  const guardInstantiate = (name, compileSource) => {
    const guard = {
      [name](source, imports) {
        if (isModule(source)) {
          return after(new PromiseCtor((resolve) => resolve(undefined)), () => newInstance(source, imports));
        }
        return after(compileSource(source), (module) => {
          const instance = newInstance(module, imports);
          return { module, instance };
        });
      },
    }[name];
    defineProperty(guard, "length", { value: 1 });
    return guard;
  };

  // compile and compileStreaming, keeping what they make.
  const guardCompile = (name, original) => {
    const guard = {
      [name](source) {
        return after(apply(original, W, [source]), (module) => {
          keep(module);
          return module;
        });
      },
    }[name];
    defineProperty(guard, "length", { value: 1 });
    return guard;
  };
  const keptCompile = guardCompile("compile", compile);

  replace("Memory", guardConstructor(Memory, checkMemory));
  replace("Instance", guardConstructor(Instance, checkInstance));
  replace("Module", guardConstructor(Module, keep));
  replace("compile", keptCompile);
  replace("instantiate", guardInstantiate("instantiate", (source) => apply(keptCompile, W, [source])));
  if (compileStreaming !== undefined) {
    const keptStreaming = guardCompile("compileStreaming", compileStreaming);
    replace("compileStreaming", keptStreaming);
    replace("instantiateStreaming", guardInstantiate("instantiateStreaming", (source) => apply(keptStreaming, W, [source])));
  }
})
