//! A VM's context: the web platform (if on), removed globals, console, host
//! functions (in their namespaces), and the trusted prelude.

use super::console::install_console;
use super::eval::describe;
use super::host_call::{host_function, sync_host_function};
use super::VmConfig;

/// WebAssembly compilation, refused unless the VM allows it (the global is
/// also deleted then).
pub(super) unsafe extern "C" fn deny_wasm(_: v8::Local<v8::Context>, _: v8::Local<v8::String>) -> bool {
    false
}
pub(super) unsafe extern "C" fn allow_wasm(_: v8::Local<v8::Context>, _: v8::Local<v8::String>) -> bool {
    true
}

/// Globals removed from every context: nothing to build a shared-memory
/// timer from, and WebAssembly unless the VM allows it.
const REMOVED_GLOBALS: &[&str] = &["SharedArrayBuffer", "Atomics"];

pub(super) fn new_context(isolate: &mut v8::Isolate, config: &VmConfig) -> Result<v8::Global<v8::Context>, String> {
    v8::scope!(let scope, isolate);
    let context = v8::Context::new(scope, Default::default());
    context.set_allow_generation_from_strings(config.eval);
    let scope = &mut v8::ContextScope::new(scope, context);
    let global = context.global(scope);
    if config.web {
        crate::web::install(scope, global)?;
    }
    let wasm: &[&str] = if config.wasm { &[] } else { &["WebAssembly"] };
    for name in REMOVED_GLOBALS.iter().chain(wasm) {
        let key = v8::String::new(scope, name).unwrap();
        global.delete(scope, key.into());
    }
    install_console(scope, global);
    install_functions(scope, global, config)?;
    if let Some(prelude) = &config.prelude {
        v8::tc_scope!(let tc, scope);
        let ran = v8::String::new(tc, prelude)
            .and_then(|src| v8::Script::compile(tc, src, None))
            .and_then(|script| script.run(tc));
        if ran.is_none() {
            let msg = tc.exception().map(|e| describe(tc, e)).unwrap_or_else(|| "unknown error".into());
            return Err(format!("vm setup failed: {msg}"));
        }
    }
    if config.web {
        // The web platform's hook for the prelude to hand over the network
        // broker: gone before guest code runs, whether or not it was used.
        let key = v8::String::new(scope, crate::web::FETCH_HOOK).unwrap();
        global.delete(scope, key.into());
    }
    Ok(v8::Global::new(scope, context))
}

/// Host functions at their paths: `["db", "getUser"]` is a function on a
/// `db` object on the global. Namespace objects are frozen once every
/// function is in place, so guest code can't swap one out for another
/// tenant's view of it (it could only shadow its own).
fn install_functions(scope: &mut v8::PinScope, global: v8::Local<v8::Object>, config: &VmConfig) -> Result<(), String> {
    // Namespaces this VM made, by path: a host namespace replaces whatever
    // global had its name (the configuration chose it), and is never merged
    // into an existing object.
    let mut namespaces: Vec<(Vec<String>, v8::Local<v8::Object>)> = Vec::new();
    for (index, spec) in config.functions.iter().enumerate() {
        let Some((name, parents)) = spec.path.split_last() else {
            return Err("vm setup failed: a host function with an empty path".into());
        };
        let mut holder = global;
        for depth in 1..=parents.len() {
            let prefix = &parents[..depth];
            holder = match namespaces.iter().find(|(p, _)| p.as_slice() == prefix) {
                Some((_, obj)) => *obj,
                None => {
                    let obj = v8::Object::new(scope);
                    let key = v8::String::new(scope, &prefix[depth - 1]).unwrap();
                    holder.set(scope, key.into(), obj.into());
                    namespaces.push((prefix.to_vec(), obj));
                    obj
                }
            };
        }
        let data = v8::Integer::new_from_unsigned(scope, index as u32);
        let builder =
            if spec.sync { v8::Function::builder(sync_host_function) } else { v8::Function::builder(host_function) };
        let func = builder.data(data.into()).build(scope).expect("build host function");
        let key = v8::String::new(scope, name).unwrap();
        holder.set(scope, key.into(), func.into());
    }
    for (_, ns) in namespaces {
        ns.set_integrity_level(scope, v8::IntegrityLevel::Frozen);
    }
    Ok(())
}
