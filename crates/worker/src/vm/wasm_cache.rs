//! Compiled WebAssembly kept per worker (a tenant's), so a module compiled
//! in one isolate is reused by the next isolate that compiles the same
//! bytes.
//!
//! V8 already shares a compiled module (its NativeModule: validated code,
//! and what it tiered up) between the isolates of a process that compile
//! identical wire bytes, but only while some isolate holds it. A program
//! with `reuse: false`, or a tenant's one-shot runs, close each isolate
//! before the next compiles, so every one compiled again. The worker keeps
//! the modules guests compiled most recently, up to its budget of wire
//! bytes (`--wasm-cache-bytes`), which keeps V8's cache warm for them; nothing else is needed, and
//! nothing compiled ever crosses to another tenant's worker.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

/// Most wire bytes of modules kept, by default (their compiled code is a
/// few times this, and counts against the worker's memory limit).
pub(crate) const DEFAULT_BYTES: usize = 32 << 20;

/// Most wire bytes of modules kept (`--wasm-cache-bytes`); 0 keeps none.
static BUDGET: AtomicUsize = AtomicUsize::new(DEFAULT_BYTES);

/// Set how many wire bytes of modules the worker keeps, before any VM
/// starts.
pub(crate) fn set_budget(bytes: usize) {
    BUDGET.store(bytes, Ordering::Relaxed);
}

#[derive(Default)]
struct Kept {
    /// Oldest first.
    modules: VecDeque<v8::CompiledWasmModule>,
    bytes: usize,
}

fn kept() -> &'static Mutex<Kept> {
    static KEPT: OnceLock<Mutex<Kept>> = OnceLock::new();
    KEPT.get_or_init(|| Mutex::new(Kept::default()))
}

/// Keep `module` (most recently compiled), dropping the oldest past the
/// budget. A module already kept moves to the back.
fn keep(module: v8::CompiledWasmModule) {
    let budget = BUDGET.load(Ordering::Relaxed);
    let size = module.get_wire_bytes_ref().len();
    if budget == 0 || size > budget {
        return;
    }
    let Ok(mut kept) = kept().lock() else {
        return;
    };
    // One NativeModule has one copy of its wire bytes: the same pointer is
    // the same module.
    let wire = module.get_wire_bytes_ref().as_ptr();
    if let Some(at) = kept
        .modules
        .iter()
        .position(|m| m.get_wire_bytes_ref().as_ptr() == wire)
    {
        let old = kept.modules.remove(at).expect("the position is in range");
        kept.bytes -= old.get_wire_bytes_ref().len();
    }
    while kept.bytes + size > budget {
        let Some(oldest) = kept.modules.pop_front() else {
            break;
        };
        kept.bytes -= oldest.get_wire_bytes_ref().len();
    }
    kept.bytes += size;
    kept.modules.push_back(module);
}

/// The wasm guard's `keep(module)`: called with each WebAssembly.Module the
/// guest compiles (by the constructor, `compile`, or `instantiate`).
fn keep_module(
    _scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    if let Ok(module) = v8::Local::<v8::WasmModuleObject>::try_from(args.get(0)) {
        keep(module.get_compiled_module());
    }
}

/// The function the wasm guard is given to keep modules with.
pub(super) fn keeper<'s>(scope: &mut v8::PinScope<'s, '_>) -> Option<v8::Local<'s, v8::Function>> {
    v8::Function::new(scope, keep_module)
}
