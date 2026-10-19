//! A VM's context: the web platform (if on), removed globals, console, host
//! functions (in their namespaces), the trusted prelude, and the
//! embedder's shims.

use super::console::install_console;
use super::eval::{describe, shim_failure};
use super::host_call::{host_function, sync_host_function};
use super::VmConfig;
use crate::proto::{fail, ErrorCode, Failure, Shim, ShimRef};

/// The `before` and `after` shims, compiled once when the VM starts: each
/// `before` a script, each `after` an `async function (result)`.
pub(super) struct Shims {
    pub before: Vec<(v8::Global<v8::Script>, ShimRef)>,
    pub after: Vec<(v8::Global<v8::Function>, ShimRef)>,
}

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

/// The VM's context and its compiled shims. On failure, what every eval
/// gets instead: `ERR_ISOLATE_RETIRED`, or `ERR_SHIM` when a shim failed.
/// `from_snapshot`: the isolate was created from the web platform's
/// snapshot, so its context already has the platform, and only needs
/// configuring.
pub(super) fn new_context(
    isolate: &mut v8::Isolate,
    config: &VmConfig,
    from_snapshot: bool,
) -> Result<(v8::Global<v8::Context>, Shims), Failure> {
    v8::scope!(let scope, isolate);
    let context = v8::Context::new(scope, Default::default());
    context.set_allow_generation_from_strings(config.eval);
    let scope = &mut v8::ContextScope::new(scope, context);
    let global = context.global(scope);
    if config.web {
        let base_url = config.base_url.as_deref();
        let set_up = if from_snapshot {
            crate::web::configure(scope, global, base_url)
        } else {
            crate::web::install(scope, global, base_url)
        };
        set_up.map_err(|e| fail(ErrorCode::IsolateRetired, e))?;
    }
    let wasm: &[&str] = if config.wasm { &[] } else { &["WebAssembly"] };
    for name in REMOVED_GLOBALS.iter().chain(wasm) {
        let key = v8::String::new(scope, name).unwrap();
        global.delete(scope, key.into());
    }
    install_console(scope, global);
    install_functions(scope, global, config).map_err(|e| fail(ErrorCode::IsolateRetired, e))?;
    if let Some(prelude) = &config.prelude {
        v8::tc_scope!(let tc, scope);
        let ran = v8::String::new(tc, prelude)
            .and_then(|src| v8::Script::compile(tc, src, None))
            .and_then(|script| script.run(tc));
        if ran.is_none() {
            let msg = tc.exception().map(|e| describe(tc, e)).unwrap_or_else(|| "unknown error".into());
            return Err(fail(ErrorCode::IsolateRetired, format!("vm setup failed: {msg}")));
        }
    }
    if config.web {
        // The web platform's hook for the prelude to hand over the network
        // broker: gone before guest code runs, whether or not it was used.
        let key = v8::String::new(scope, crate::web::FETCH_HOOK).unwrap();
        global.delete(scope, key.into());
    }
    let shims = compile_shims(scope, &config.shims)?;
    Ok((v8::Global::new(scope, context), shims))
}

/// A shim's script, named in stack traces by its filename. `line_offset`
/// makes up for lines the wrapper adds before the shim's own first line.
fn shim_script<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    code: &str,
    filename: &str,
    line_offset: i32,
) -> Option<v8::Local<'s, v8::Script>> {
    let source = v8::String::new(scope, code)?;
    let name = v8::String::new(scope, filename)?;
    let origin = v8::ScriptOrigin::new(scope, name.into(), line_offset, 0, false, 0, None, false, false, false, None);
    v8::Script::compile(scope, source, Some(&origin))
}

fn shim_ref(phase: &'static str, index: usize, shim: &Shim) -> ShimRef {
    ShimRef { phase, index: index as u32, filename: shim.filename.clone() }
}

/// Run the `setup` shims, then compile `before` and `after`. Compiled here,
/// by the embedder, so they work with `eval` off.
fn compile_shims(scope: &mut v8::PinScope, shims: &crate::proto::Shims) -> Result<Shims, Failure> {
    v8::tc_scope!(let tc, scope);
    let threw = |tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>, at: &ShimRef| {
        let what = match tc.exception() {
            Some(e) => format!("threw: {}", describe(tc, e)),
            None => "failed".into(),
        };
        shim_failure(at, what)
    };
    for (i, shim) in shims.setup.iter().enumerate() {
        let at = shim_ref("setup", i, shim);
        if shim_script(tc, &shim.code, &shim.filename, 0).and_then(|s| s.run(tc)).is_none() {
            return Err(threw(tc, &at));
        }
    }
    let mut before = Vec::with_capacity(shims.before.len());
    for (i, shim) in shims.before.iter().enumerate() {
        let at = shim_ref("before", i, shim);
        let Some(script) = shim_script(tc, &shim.code, &shim.filename, 0) else { return Err(threw(tc, &at)) };
        before.push((v8::Global::new(tc, script), at));
    }
    let mut after = Vec::with_capacity(shims.after.len());
    for (i, shim) in shims.after.iter().enumerate() {
        let at = shim_ref("after", i, shim);
        // The wrapper's first line is its own: line 1 of the shim stays line 1.
        let wrapped = format!("(async function (result) {{\n{}\n}})", shim.code);
        let func = shim_script(tc, &wrapped, &shim.filename, -1)
            .and_then(|s| s.run(tc))
            .and_then(|f| v8::Local::<v8::Function>::try_from(f).ok());
        let Some(func) = func else { return Err(threw(tc, &at)) };
        after.push((v8::Global::new(tc, func), at));
    }
    Ok(Shims { before, after })
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
