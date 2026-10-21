//! A program's ES modules: the file tree a `load` sends, compiled,
//! instantiated (its imports resolved), and evaluated in the VM's context;
//! `isolane:env`; `import.meta.url`; and the handlers calls find among the
//! program's exports.
//!
//! A program is its main module for now, which may import only
//! `isolane:env`. Multi-file programs (imports between files, resolved over
//! `files` with `oxc_resolver`) go in `resolve`.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use crate::js;
use crate::proto::{fail, ErrorCode, Failure};

/// The module that exports the program's `env`.
const ENV_SPECIFIER: &str = "isolane:env";

/// Longest specifier quoted in an error.
const SPECIFIER_MAX: usize = 1024;

/// A VM's program (an isolate slot: one per VM).
#[derive(Default)]
struct Program {
    /// The program's `env`, made with the context (absent without one).
    env: RefCell<Option<v8::Global<v8::Object>>>,
    /// `isolane:env`, made the first time it's imported.
    env_module: RefCell<Option<v8::Global<v8::Module>>>,
    /// The main module, once compiled (a VM loads one program), and its path.
    main: RefCell<Option<v8::Global<v8::Module>>>,
    main_path: RefCell<String>,
    /// Its namespace, once it evaluated: where calls find handlers.
    namespace: RefCell<Option<v8::Global<v8::Object>>>,
}

fn program(isolate: &v8::Isolate) -> Rc<Program> {
    isolate
        .get_slot::<Rc<Program>>()
        .cloned()
        .expect("module::install ran when the VM started")
}

/// Give the isolate its program slot, set `import.meta`, and refuse
/// dynamic `import()`.
pub(super) fn install(isolate: &mut v8::Isolate) {
    isolate.set_slot(Rc::new(Program::default()));
    isolate.set_host_import_module_dynamically_callback(dynamic_import);
    isolate.set_host_initialize_import_meta_object_callback(import_meta);
}

/// The program's `env` (what `isolane:env` exports).
pub(super) fn set_env(scope: &mut v8::PinScope, env: v8::Local<v8::Object>) {
    *program(scope).env.borrow_mut() = Some(v8::Global::new(scope, env));
}

/// Why a load failed before its evaluation started.
pub(super) enum LoadError {
    /// The module didn't compile: the exception (a SyntaxError) is pending.
    Compile,
    /// Instantiating it threw (an import that can't be resolved).
    Threw,
    Failed(Failure),
}

/// Compile and instantiate the program's main module and start evaluating
/// it. Returns the promise its evaluation settles (top-level await may
/// leave it pending), which the eval drives like any other.
pub(super) fn load<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    main: &str,
    files: &BTreeMap<String, String>,
) -> Result<v8::Local<'s, v8::Value>, LoadError> {
    let program = program(scope);
    if program.main.borrow().is_some() {
        return Err(LoadError::Failed(fail(
            ErrorCode::Internal,
            "this isolate already has a program",
        )));
    }
    let Some(code) = files.get(main) else {
        return Err(LoadError::Failed(fail(
            ErrorCode::Internal,
            "the main module isn't among the program's files",
        )));
    };
    let (Some(code), Some(name)) = (v8::String::new(scope, code), v8::String::new(scope, main))
    else {
        return Err(LoadError::Failed(fail(
            ErrorCode::Internal,
            "source too large",
        )));
    };
    let origin = v8::ScriptOrigin::new(
        scope,
        name.into(),
        0,
        0,
        false,
        0,
        None,
        false,
        false,
        /* is_module */ true,
        None,
    );
    let mut source = v8::script_compiler::Source::new(code, Some(&origin));
    let Some(module) = v8::script_compiler::compile_module(scope, &mut source) else {
        return Err(LoadError::Compile);
    };
    *program.main.borrow_mut() = Some(v8::Global::new(scope, module));
    *program.main_path.borrow_mut() = main.to_string();
    if module.instantiate_module(scope, resolve) != Some(true) {
        return Err(LoadError::Threw);
    }
    module.evaluate(scope).ok_or(LoadError::Threw)
}

/// The program evaluated: calls look up handlers in its namespace from now on.
pub(super) fn loaded(scope: &mut v8::PinScope) {
    let program = program(scope);
    let main = program.main.borrow();
    let Some(main) = main.as_ref() else {
        return;
    };
    let main = v8::Local::new(scope, main);
    if let Ok(namespace) = v8::Local::<v8::Object>::try_from(main.get_module_namespace()) {
        *program.namespace.borrow_mut() = Some(v8::Global::new(scope, namespace));
    }
}

/// The module an `import` names. Only `isolane:env` resolves for now.
fn resolve<'s>(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    _attributes: v8::Local<'s, v8::FixedArray>,
    _referrer: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    // SAFETY: V8 calls this during `instantiate_module`, on the VM's thread,
    // with `context` entered: a scope over it is valid for the call.
    v8::callback_scope!(unsafe scope, context);
    let wanted = js::string(scope, specifier.into(), SPECIFIER_MAX);
    if wanted == ENV_SPECIFIER {
        return Some(env_module(scope));
    }
    let message = format!(
        "Cannot import {wanted:?}: a program is a single module for now, which can import only {ENV_SPECIFIER:?}"
    );
    js::throw_type(scope, &message);
    None
}

/// `isolane:env`: a synthetic module whose one export is `env`.
fn env_module<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module> {
    let program = program(scope);
    if let Some(module) = program.env_module.borrow().as_ref() {
        return v8::Local::new(scope, module);
    }
    let name = js::short_string(scope, ENV_SPECIFIER);
    let export = js::short_string(scope, "env");
    let module = v8::Module::create_synthetic_module(scope, name, &[export], env_exports);
    *program.env_module.borrow_mut() = Some(v8::Global::new(scope, module));
    module
}

/// `isolane:env`'s evaluation: export the program's env (an empty object
/// for a program given none).
fn env_exports<'s>(
    context: v8::Local<'s, v8::Context>,
    module: v8::Local<v8::Module>,
) -> Option<v8::Local<'s, v8::Value>> {
    // SAFETY: V8 calls this while evaluating the module graph, on the VM's
    // thread, with `context` entered.
    v8::callback_scope!(unsafe scope, context);
    let program = program(scope);
    let env: v8::Local<v8::Value> = match program.env.borrow().as_ref() {
        Some(env) => v8::Local::new(scope, env).into(),
        None => v8::Object::new(scope).into(),
    };
    let name = js::short_string(scope, "env");
    module.set_synthetic_module_export(scope, name, env)?;
    Some(v8::undefined(scope).into())
}

/// `import.meta.url`: the module's path as a `file:` URL
/// (`src/index.js` is `file:///src/index.js`).
unsafe extern "C" fn import_meta(
    context: v8::Local<v8::Context>,
    module: v8::Local<v8::Module>,
    meta: v8::Local<v8::Object>,
) {
    // SAFETY: V8 calls this on the VM's thread, the first time a module
    // reads `import.meta`, with `context` entered.
    v8::callback_scope!(unsafe scope, context);
    let program = program(scope);
    let is_main = program.main.borrow().as_ref().is_some_and(|main| {
        v8::Local::new(scope, main).get_identity_hash() == module.get_identity_hash()
    });
    if !is_main {
        return;
    }
    let root = url::Url::parse("file:///").expect("a valid URL");
    let Ok(url) = root.join(&program.main_path.borrow()) else {
        return;
    };
    let key = js::short_string(scope, "url");
    let value = js::short_string(scope, url.as_str());
    meta.create_data_property(scope, key.into(), value.into());
}

/// `import()`: refused, since what a program can import is resolved when it
/// loads.
fn dynamic_import<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    _options: v8::Local<'s, v8::Data>,
    _resource: v8::Local<'s, v8::Value>,
    specifier: v8::Local<'s, v8::String>,
    _attributes: v8::Local<'s, v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
    let resolver = v8::PromiseResolver::new(scope)?;
    let wanted = js::string(scope, specifier.into(), SPECIFIER_MAX);
    let message = js::short_string(
        scope,
        &format!("Cannot import {wanted:?}: dynamic import() isn't supported"),
    );
    let error = v8::Exception::type_error(scope, message);
    resolver.reject(scope, error);
    Some(resolver.get_promise(scope))
}

/// Where a call's handler is.
pub(super) enum Handler<'s> {
    /// The VM has no program: the call looks on the global object.
    NoProgram,
    Missing,
    /// The function, and the `this` to call it with.
    Found(v8::Local<'s, v8::Function>, v8::Local<'s, v8::Value>),
}

/// The handler `name` in the program: its named export, or else a method
/// of its default export, called with the default export as `this`
/// (`export default { fetch }`, a Hono app, a class instance), but not one
/// every object inherits (`toString`, `hasOwnProperty`). Err if reading it
/// threw (a getter, or an export still in its temporal dead zone), with
/// the exception caught.
pub(super) fn handler<'s>(scope: &mut v8::PinScope<'s, '_>, name: &str) -> Result<Handler<'s>, ()> {
    let namespace = program(scope).namespace.borrow().clone();
    let Some(namespace) = namespace else {
        return Ok(Handler::NoProgram);
    };
    let namespace = v8::Local::new(scope, namespace);
    let Some(key) = v8::String::new(scope, name) else {
        return Ok(Handler::Missing);
    };
    let undefined: v8::Local<v8::Value> = v8::undefined(scope).into();
    if namespace.has_own_property(scope, key.into()) == Some(true) {
        let export = namespace.get(scope, key.into()).ok_or(())?;
        if let Ok(function) = v8::Local::<v8::Function>::try_from(export) {
            return Ok(Handler::Found(function, undefined));
        }
    }
    let default = js::short_string(scope, "default");
    let Some(object) = namespace
        .get(scope, default.into())
        .and_then(|d| v8::Local::<v8::Object>::try_from(d).ok())
    else {
        return Ok(Handler::Missing);
    };
    if object.has_own_property(scope, key.into()) != Some(true) {
        let plain = v8::Object::new(scope);
        if plain.has(scope, key.into()) != Some(false) {
            return Ok(Handler::Missing);
        }
    }
    let method = object.get(scope, key.into()).ok_or(())?;
    match v8::Local::<v8::Function>::try_from(method) {
        Ok(function) => Ok(Handler::Found(function, object.into())),
        Err(_) => Ok(Handler::Missing),
    }
}
