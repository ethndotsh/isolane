//! A program's ES modules: the file tree a `load` sends, resolved,
//! transformed, compiled, instantiated, and evaluated in the VM's context;
//! the built-in modules (`isolane:env`, `cloudflare:sockets`, host modules,
//! the transform's helpers); `import()` and `import.meta`; and the
//! handlers calls find among the program's exports.
//!
//! Everything a program's code becomes is decided here, in the locked-down
//! worker: the supervisor only sends the files.
//!
//! - `tree`: the files, and `oxc_resolver` over them
//! - `transform`: TypeScript, JSX, and `define`, with oxc
//! - `source_map`: maps back to the original files, for reported stacks

mod source_map;
mod transform;
mod tree;

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;
use std::sync::Arc;

use source_map::Maps;
use transform::Transforms;
use tree::Resolver;
pub(crate) use tree::{Source, Tree};

use crate::js;
use crate::proto::{fail, Alias, ErrorCode, Failure, Location, ModuleOptions};

/// The module that exports the program's `env`.
const ENV_SPECIFIER: &str = "isolane:env";
/// The Sockets API as Cloudflare's module (postgres.js and others import it).
const SOCKETS_SPECIFIER: &str = "cloudflare:sockets";

/// Longest specifier quoted in an error.
const SPECIFIER_MAX: usize = 1024;

/// What a module is made from its file as.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Kind {
    /// JavaScript (or TypeScript or JSX, transformed).
    Code,
    /// `with { type: 'json' }`, or a `.json` file.
    Json,
    /// `with { type: 'text' }`: the file as a string.
    Text,
    /// `with { type: 'bytes' }`: the file as a Uint8Array.
    Bytes,
}

/// A loaded program's files and how they're resolved and transformed.
struct Files {
    tree: Arc<Tree>,
    resolver: Resolver,
    transforms: Transforms,
    aliases: BTreeMap<String, Alias>,
}

/// Something per module, by its identity hash (and then the module).
type ByModule<T> = HashMap<i32, Vec<(v8::Global<v8::Module>, T)>>;

/// A VM's program (an isolate slot: one per VM).
#[derive(Default)]
struct Program {
    /// The program's `env`, made with the context (absent without one).
    env: RefCell<Option<v8::Global<v8::Object>>>,
    /// The Sockets API's `connect`, as the context had it.
    connect: RefCell<Option<v8::Global<v8::Function>>>,
    /// Host modules' exports, by specifier (made with the context).
    host_modules: RefCell<BTreeMap<String, v8::Global<v8::Object>>>,
    files: RefCell<Option<Rc<Files>>>,
    /// Modules made so far, by path (or built-in specifier) and kind.
    modules: RefCell<HashMap<(String, Kind), v8::Global<v8::Module>>>,
    /// Each module's path, by identity hash.
    paths: RefCell<ByModule<String>>,
    /// Synthetic modules' exports, by identity hash.
    synthetic: RefCell<ByModule<v8::Global<v8::Object>>>,
    /// Source maps, by module path.
    maps: RefCell<HashMap<String, Maps>>,
    /// Where the last module that didn't compile failed, for the load's
    /// error (a SyntaxError has no frames to say).
    failed_at: RefCell<Option<(Location, String)>>,
    /// `import()`s waiting for their microtask, oldest first.
    imports: RefCell<Vec<Request>>,
    /// The main module, once compiled (a VM loads one program).
    main: RefCell<Option<v8::Global<v8::Module>>>,
    /// Its namespace, once it evaluated: where calls find handlers.
    namespace: RefCell<Option<v8::Global<v8::Object>>>,
}

fn program(isolate: &v8::Isolate) -> Rc<Program> {
    isolate
        .get_slot::<Rc<Program>>()
        .cloned()
        .expect("module::install ran when the VM started")
}

/// Give the isolate its program slot, and the callbacks for `import()` and
/// `import.meta`.
pub(super) fn install(isolate: &mut v8::Isolate) {
    isolate.set_slot(Rc::new(Program::default()));
    isolate.set_host_import_module_dynamically_callback(dynamic_import);
    isolate.set_host_initialize_import_meta_object_callback(import_meta);
}

/// The program's `env` (what `isolane:env` exports).
pub(super) fn set_env(scope: &mut v8::PinScope, env: v8::Local<v8::Object>) {
    *program(scope).env.borrow_mut() = Some(v8::Global::new(scope, env));
}

/// The Sockets API's `connect` (what `cloudflare:sockets` exports).
pub(super) fn set_connect(scope: &mut v8::PinScope, connect: v8::Local<v8::Function>) {
    *program(scope).connect.borrow_mut() = Some(v8::Global::new(scope, connect));
}

/// The exports object of host module `specifier`, made the first time it's
/// asked for, for its host functions to go in.
pub(super) fn host_module_exports<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    specifier: &str,
) -> v8::Local<'s, v8::Object> {
    let program = program(scope);
    if let Some(exports) = program.host_modules.borrow().get(specifier) {
        return v8::Local::new(scope, exports);
    }
    let exports = v8::Object::new(scope);
    program
        .host_modules
        .borrow_mut()
        .insert(specifier.to_string(), v8::Global::new(scope, exports));
    exports
}

/// Why a load failed before its evaluation started.
pub(super) enum LoadError {
    /// It threw (a module that didn't compile or resolve): the exception
    /// is pending, and `take_failed_at` may say where.
    Threw,
    Failed(Failure),
}

/// Compile and instantiate the program's modules from `main` and start
/// evaluating it. Returns the promise its evaluation settles (top-level
/// await may leave it pending), which the eval drives like any other.
///
/// Transforms run here, on the VM's thread, so their CPU time counts
/// against the load's `startupCpuMs` (or, for `import()` later, the
/// call's `cpuMs`); what they can take is bounded by the program's size.
pub(super) fn load<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    main: &str,
    tree: &Result<Arc<Tree>, String>,
    options: &ModuleOptions,
) -> Result<v8::Local<'s, v8::Value>, LoadError> {
    let program = program(scope);
    if program.main.borrow().is_some() {
        return Err(LoadError::Failed(fail(
            ErrorCode::Internal,
            "this isolate already has a program",
        )));
    }
    let internal = |message: String| LoadError::Failed(fail(ErrorCode::Internal, message));
    let tree = Arc::clone(tree.as_ref().map_err(|e| internal(e.clone()))?);
    if !tree.contains(main) {
        return Err(internal(
            "the main module isn't among the program's files".into(),
        ));
    }
    let transforms = Transforms::new(options).map_err(internal)?;
    *program.files.borrow_mut() = Some(Rc::new(Files {
        resolver: Resolver::new(Arc::clone(&tree)),
        tree,
        transforms,
        aliases: options.aliases.clone(),
    }));
    let module = match file_module(scope, main, Kind::Code) {
        Ok(module) => module,
        Err(miss) => return Err(thrown(scope, miss)),
    };
    *program.main.borrow_mut() = Some(v8::Global::new(scope, module));
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

/// Where the load's module that didn't compile failed, if one didn't.
pub(super) fn take_failed_at(scope: &mut v8::PinScope) -> Option<(Location, String)> {
    program(scope).failed_at.borrow_mut().take()
}

/// Why a module couldn't be had.
enum Miss {
    /// Say so with a TypeError.
    Message(String),
    /// Say so with a SyntaxError (an import attribute no host supports).
    Syntax(String),
    /// An exception is pending (a SyntaxError, from compiling it).
    Thrown,
}

fn thrown(scope: &mut v8::PinScope, miss: Miss) -> LoadError {
    match miss {
        Miss::Message(message) => js::throw_type(scope, &message),
        Miss::Syntax(message) => js::throw(scope, js::Class::Syntax, &message),
        Miss::Thrown => {}
    }
    LoadError::Threw
}

/// The module an `import` names, imported from `referrer`.
fn resolve<'s>(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    attributes: v8::Local<'s, v8::FixedArray>,
    referrer: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    // SAFETY: V8 calls this during `instantiate_module`, on the VM's thread,
    // with `context` entered: a scope over it is valid for the call.
    v8::callback_scope!(unsafe scope, context);
    let wanted = js::string(scope, specifier.into(), SPECIFIER_MAX);
    let from = path_of(scope, referrer);
    // A static import's attributes are (key, value, source offset) triples.
    let found = attribute_kind(scope, attributes, 3)
        .and_then(|kind| find(scope, &wanted, from.as_deref(), kind));
    match found {
        Ok(module) => Some(module),
        Err(miss) => {
            thrown(scope, miss);
            None
        }
    }
}

/// The kind an import's attributes ask for: `type` is `json`, `text`, or
/// `bytes`. Any other attribute is a SyntaxError, as the standard has a
/// host do for attributes it doesn't support. `stride` is 3 for static
/// imports (V8 adds each one's source offset), 2 for `import()`.
fn attribute_kind(
    scope: &mut v8::PinScope,
    attributes: v8::Local<v8::FixedArray>,
    stride: usize,
) -> Result<Option<Kind>, Miss> {
    let mut kind = None;
    let mut i = 0;
    while i + 1 < attributes.length() {
        let key = attribute(scope, attributes, i);
        let value = attribute(scope, attributes, i + 1);
        if key != "type" {
            return Err(Miss::Syntax(format!(
                "Import attribute {key:?} is not supported"
            )));
        }
        kind = Some(match value.as_str() {
            "json" => Kind::Json,
            "text" => Kind::Text,
            "bytes" => Kind::Bytes,
            other => {
                return Err(Miss::Message(format!(
                    "Import attribute type {other:?} is not supported (json, text, or bytes)"
                )))
            }
        });
        i += stride;
    }
    Ok(kind)
}

fn attribute(scope: &mut v8::PinScope, attributes: v8::Local<v8::FixedArray>, at: usize) -> String {
    attributes
        .get(scope, at)
        .and_then(|data| v8::Local::<v8::Value>::try_from(data).ok())
        .map(|value| js::string(scope, value, SPECIFIER_MAX))
        .unwrap_or_default()
}

/// The module `specifier` names, imported from the file `from` (None: the
/// program's root), made as `kind` (or by its extension).
fn find<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    specifier: &str,
    from: Option<&str>,
    kind: Option<Kind>,
) -> Result<v8::Local<'s, v8::Module>, Miss> {
    let Some(files) = program(scope).files.borrow().clone() else {
        return Err(Miss::Message("Cannot import outside a program".into()));
    };
    let mut specifier = specifier;
    match files.aliases.get(specifier) {
        Some(Alias::File(path)) => return file_module(scope, path, kind_of(path, kind)),
        Some(Alias::Specifier(other)) => specifier = other,
        Some(Alias::Host) => return Ok(host_module(scope, specifier)),
        None => {}
    }
    let importer = from.unwrap_or("the program");
    if let Some(name) = specifier.strip_prefix(transform::HELPERS) {
        if let Some(module) = helper_module(scope, name)? {
            return Ok(module);
        }
    }
    match specifier {
        ENV_SPECIFIER => return Ok(env_module(scope)),
        SOCKETS_SPECIFIER => return Ok(sockets_module(scope)),
        _ => {}
    }
    if let Some((scheme, _)) = specifier.split_once(':') {
        let is_scheme = !scheme.is_empty()
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c));
        if is_scheme {
            let hint = if scheme == "node" {
                "isolane has no Node.js built-in modules; give the program one with the modules option ({ 'node:x': './x.js' })"
            } else {
                "only the program's files, isolane:env, cloudflare:sockets, and the modules option's specifiers can be imported"
            };
            return Err(Miss::Message(format!(
                "Cannot import {specifier:?} from {importer}: {hint}"
            )));
        }
    }
    let path = files
        .resolver
        .resolve(from, specifier)
        .map_err(|why| Miss::Message(format!("{why} imported from {importer}")))?;
    file_module(scope, &path, kind_of(&path, kind))
}

fn kind_of(path: &str, asked: Option<Kind>) -> Kind {
    asked.unwrap_or(if path.ends_with(".json") {
        Kind::Json
    } else {
        Kind::Code
    })
}

/// The module made of the program's file `path`, as `kind`, made once.
fn file_module<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    path: &str,
    kind: Kind,
) -> Result<v8::Local<'s, v8::Module>, Miss> {
    let program = program(scope);
    let key = (path.to_string(), kind);
    if let Some(module) = program.modules.borrow().get(&key) {
        return Ok(v8::Local::new(scope, module));
    }
    let Some(files) = program.files.borrow().clone() else {
        return Err(Miss::Message("Cannot import outside a program".into()));
    };
    let Some(source) = files.tree.get(path) else {
        return Err(Miss::Message(format!("Cannot find module {path:?}")));
    };
    let text = |kind: &str| {
        source.text().ok_or_else(|| {
            Miss::Message(format!(
                "{path} is not UTF-8 text, so it can't be imported as {kind}"
            ))
        })
    };
    let module = match kind {
        Kind::Code => compile_code(scope, &files, path, text("JavaScript")?)?,
        Kind::Json => {
            let json = js::guest_string(scope, text("JSON")?).ok_or(Miss::Thrown)?;
            let value = v8::json::parse(scope, json).ok_or(Miss::Thrown)?;
            default_module(scope, path, value)
        }
        Kind::Text => {
            let string = js::guest_string(scope, text("text")?).ok_or(Miss::Thrown)?;
            default_module(scope, path, string.into())
        }
        Kind::Bytes => {
            // Copied into a V8-allocated buffer: the V8 sandbox refuses
            // backing stores from Rust memory.
            let array = crate::bytes::new_u8array(scope, source.bytes());
            default_module(scope, path, array.into())
        }
    };
    remember(scope, key, module);
    Ok(module)
}

/// Keep `module` as the one for `key`, and know its path.
fn remember(scope: &mut v8::PinScope, key: (String, Kind), module: v8::Local<v8::Module>) {
    let program = program(scope);
    let global = v8::Global::new(scope, module);
    program
        .paths
        .borrow_mut()
        .entry(module.get_identity_hash().get())
        .or_default()
        .push((global.clone(), key.0.clone()));
    program.modules.borrow_mut().insert(key, global);
}

/// The path of a module of the program, if it's one of its files.
fn path_of(scope: &mut v8::PinScope, module: v8::Local<v8::Module>) -> Option<String> {
    let program = program(scope);
    let paths = program.paths.borrow();
    let candidates = paths.get(&module.get_identity_hash().get())?;
    candidates
        .iter()
        .find(|(m, _)| v8::Local::new(scope, m) == module)
        .map(|(_, path)| path.clone())
}

/// Compile `path`'s code as a module: transformed first if it's
/// TypeScript or JSX (or there are defines), with its source maps kept.
fn compile_code<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    files: &Files,
    path: &str,
    text: &str,
) -> Result<v8::Local<'s, v8::Module>, Miss> {
    let mut maps = Maps::default();
    let transformed;
    let code = if files.transforms.applies(path) {
        match files.transforms.run(path, text) {
            Ok(output) => {
                transformed = output;
                maps.push(Arc::clone(&transformed.map));
                transformed.code.as_str()
            }
            Err(problem) => {
                let source_line = text.lines().nth(problem.line as usize - 1);
                let start = problem.column as usize - 1;
                let end = problem.end_column as usize - 1;
                let at =
                    super::errors::location(path.into(), problem.line, start, end, source_line);
                *program(scope).failed_at.borrow_mut() = Some(at);
                js::throw(scope, js::Class::Syntax, &problem.message);
                return Err(Miss::Thrown);
            }
        }
    } else {
        text
    };
    let tree = Arc::clone(&files.tree);
    if let Some(own) = source_map::own_map(path, text, |p| tree.get(p).and_then(Source::text)) {
        maps.push(Arc::new(own));
    }
    if !maps.is_empty() {
        program(scope)
            .maps
            .borrow_mut()
            .insert(path.to_string(), maps);
    }
    compile(scope, path, code)
}

/// Compile module source `code`, named `name` in stack traces. A failure
/// notes where it was (mapped to the original file), and throws.
///
/// A code cache (phase 4) goes here: consume one keyed by the code's hash,
/// and make one after the first compile.
fn compile<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    name: &str,
    code: &str,
) -> Result<v8::Local<'s, v8::Module>, Miss> {
    let source = js::guest_string(scope, code).ok_or(Miss::Thrown)?;
    let name = js::guest_string(scope, name).ok_or(Miss::Thrown)?;
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
    let mut source = v8::script_compiler::Source::new(source, Some(&origin));
    v8::tc_scope!(let tc, scope);
    if let Some(module) = v8::script_compiler::compile_module(tc, &mut source) {
        return Ok(module);
    }
    if let Some(message) = tc.message() {
        let at = super::errors::compile_location(tc, message);
        *program(tc).failed_at.borrow_mut() = at;
    }
    tc.rethrow();
    Err(Miss::Thrown)
}

/// Where generated `line` and `start..end` (0-based columns) of module
/// `file` came from, with the original source line, for a module made by
/// a transform. None for a file without maps.
pub(super) fn original_location(
    scope: &mut v8::PinScope,
    file: &str,
    line: u32,
    start: usize,
    end: usize,
) -> Option<(Location, String)> {
    let program = program(scope);
    let maps = program.maps.borrow();
    let (source, line, column) = maps.get(file)?.original(line, start as u32 + 1)?;
    let files = program.files.borrow().clone()?;
    let text = files.tree.get(&source).and_then(Source::text);
    let source_line = text.and_then(|t| t.lines().nth(line as usize - 1));
    let start = column as usize - 1;
    let width = end.saturating_sub(start).max(1);
    Some(super::errors::location(
        source,
        line,
        start,
        start + width,
        source_line,
    ))
}

/// `stack` with its frames in transformed modules (and bundles with maps)
/// pointing at the original files.
pub(super) fn map_stack(scope: &mut v8::PinScope, stack: String) -> String {
    let program = program(scope);
    let maps = program.maps.borrow();
    if maps.is_empty() {
        return stack;
    }
    source_map::map_stack(&stack, |file, line, column| {
        let (source, line, column) = maps.get(file)?.original(line, column)?;
        Some(format!("{source}:{line}:{column}"))
    })
}

// ---- built-in and synthetic modules ----

/// A synthetic module whose exports are `exports`' own properties.
fn synthetic_module<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    name: &str,
    exports: v8::Local<v8::Object>,
) -> v8::Local<'s, v8::Module> {
    let mut names: Vec<v8::Local<v8::String>> = Vec::new();
    if let Some(keys) = exports.get_own_property_names(scope, v8::GetPropertyNamesArgs::default()) {
        for i in 0..keys.length() {
            if let Some(key) = keys.get_index(scope, i).and_then(|k| k.to_string(scope)) {
                names.push(key);
            }
        }
    }
    let name = js::guest_string(scope, name).unwrap_or_else(|| v8::String::empty(scope));
    let module = v8::Module::create_synthetic_module(scope, name, &names, synthetic_exports);
    program(scope)
        .synthetic
        .borrow_mut()
        .entry(module.get_identity_hash().get())
        .or_default()
        .push((
            v8::Global::new(scope, module),
            v8::Global::new(scope, exports),
        ));
    module
}

/// A synthetic module whose one export, `default`, is `value`.
fn default_module<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    name: &str,
    value: v8::Local<v8::Value>,
) -> v8::Local<'s, v8::Module> {
    let exports = v8::Object::new(scope);
    let key = js::short_string(scope, "default");
    exports.create_data_property(scope, key.into(), value);
    synthetic_module(scope, name, exports)
}

/// A synthetic module's evaluation: set each export from its object.
fn synthetic_exports<'s>(
    context: v8::Local<'s, v8::Context>,
    module: v8::Local<v8::Module>,
) -> Option<v8::Local<'s, v8::Value>> {
    // SAFETY: V8 calls this while evaluating the module graph, on the VM's
    // thread, with `context` entered.
    v8::callback_scope!(unsafe scope, context);
    let program = program(scope);
    let exports = {
        let synthetic = program.synthetic.borrow();
        let candidates = synthetic.get(&module.get_identity_hash().get())?;
        let (_, exports) = candidates
            .iter()
            .find(|(m, _)| v8::Local::new(scope, m) == module)?;
        v8::Local::new(scope, exports)
    };
    let keys = exports.get_own_property_names(scope, v8::GetPropertyNamesArgs::default())?;
    for i in 0..keys.length() {
        let key = keys.get_index(scope, i)?;
        let value = exports.get(scope, key)?;
        let name = key.to_string(scope)?;
        module.set_synthetic_module_export(scope, name, value)?;
    }
    // With top-level await, evaluation steps return a promise.
    let done = v8::PromiseResolver::new(scope)?;
    let undefined = v8::undefined(scope);
    done.resolve(scope, undefined.into());
    Some(done.get_promise(scope).into())
}

/// A built-in module, made once, by specifier.
fn built_in<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    specifier: &str,
    make: impl FnOnce(&mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module>,
) -> v8::Local<'s, v8::Module> {
    let key = (specifier.to_string(), Kind::Code);
    if let Some(module) = program(scope).modules.borrow().get(&key) {
        return v8::Local::new(scope, module);
    }
    let module = make(scope);
    let global = v8::Global::new(scope, module);
    program(scope).modules.borrow_mut().insert(key, global);
    module
}

/// `isolane:env`: one export, `env` (an empty object for a program given none).
fn env_module<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module> {
    built_in(scope, ENV_SPECIFIER, |scope| {
        let env = program(scope).env.borrow().clone();
        let env: v8::Local<v8::Value> = match env {
            Some(env) => v8::Local::new(scope, env).into(),
            None => v8::Object::new(scope).into(),
        };
        let exports = v8::Object::new(scope);
        let key = js::short_string(scope, "env");
        exports.create_data_property(scope, key.into(), env);
        synthetic_module(scope, ENV_SPECIFIER, exports)
    })
}

/// `cloudflare:sockets`: `connect`, the Sockets API's (one that throws
/// for a program loaded without a `connect` policy).
fn sockets_module<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module> {
    built_in(scope, SOCKETS_SPECIFIER, |scope| {
        let connect = program(scope).connect.borrow().clone();
        let connect = match connect {
            Some(connect) => v8::Local::new(scope, connect),
            None => v8::Function::new(scope, no_connect).expect("build the connect stub"),
        };
        let exports = v8::Object::new(scope);
        let key = js::short_string(scope, "connect");
        exports.create_data_property(scope, key.into(), connect.into());
        synthetic_module(scope, SOCKETS_SPECIFIER, exports)
    })
}

fn no_connect(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    js::throw_type(
        scope,
        "connect() is not available: the program was loaded without a connect policy",
    );
}

/// A host module: its host functions as named exports, and all of them
/// together as the default export.
fn host_module<'s>(scope: &mut v8::PinScope<'s, '_>, specifier: &str) -> v8::Local<'s, v8::Module> {
    built_in(scope, specifier, |scope| {
        let functions = host_module_exports(scope, specifier);
        let exports = v8::Object::new(scope);
        let keys = functions.get_own_property_names(scope, v8::GetPropertyNamesArgs::default());
        if let Some(keys) = keys {
            for i in 0..keys.length() {
                let Some(key) = keys.get_index(scope, i) else {
                    continue;
                };
                let (Some(value), Ok(name)) = (
                    functions.get(scope, key),
                    v8::Local::<v8::Name>::try_from(key),
                ) else {
                    continue;
                };
                exports.create_data_property(scope, name, value);
            }
        }
        let default = js::short_string(scope, "default");
        if exports.has_own_property(scope, default.into()) != Some(true) {
            exports.create_data_property(scope, default.into(), functions.into());
        }
        synthetic_module(scope, specifier, exports)
    })
}

/// The helpers the transform imports for legacy decorators (as tslib's
/// `__decorate`, `__metadata`, and `__param`). None for a name that isn't
/// one.
fn helper_module<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    name: &str,
) -> Result<Option<v8::Local<'s, v8::Module>>, Miss> {
    let code = match name {
        "/helpers/decorate" => DECORATE,
        "/helpers/decorateMetadata" => DECORATE_METADATA,
        "/helpers/decorateParam" => DECORATE_PARAM,
        _ => return Ok(None),
    };
    let specifier = format!("{}{name}", transform::HELPERS);
    let key = (specifier.clone(), Kind::Code);
    if let Some(module) = program(scope).modules.borrow().get(&key) {
        return Ok(Some(v8::Local::new(scope, module)));
    }
    let module = compile(scope, &specifier, code)?;
    let global = v8::Global::new(scope, module);
    program(scope).modules.borrow_mut().insert(key, global);
    Ok(Some(module))
}

const DECORATE: &str = r#"export default function decorate(decorators, target, key, desc) {
  var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
  if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
  else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
  return c > 3 && r && Object.defineProperty(target, key, r), r;
}
"#;

const DECORATE_METADATA: &str = r#"export default function decorateMetadata(k, v) {
  if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
}
"#;

const DECORATE_PARAM: &str = r#"export default function decorateParam(index, decorator) {
  return function (target, key) { decorator(target, key, index); };
}
"#;

// ---- import.meta and import() ----

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
    let Some(path) = path_of(scope, module) else {
        return;
    };
    let root = url::Url::parse("file:///").expect("a valid URL");
    let Ok(url) = root.join(&path) else {
        return;
    };
    let key = js::short_string(scope, "url");
    let value = js::short_string(scope, url.as_str());
    meta.create_data_property(scope, key.into(), value.into());
}

/// `import()`: a module of the program (resolved from the importing
/// module's file), compiled and evaluated if it wasn't yet, in a microtask
/// (so an `import()` made while the graph evaluates can't evaluate a
/// module ahead of its turn). Classic scripts outside a program can't
/// import.
fn dynamic_import<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    _options: v8::Local<'s, v8::Data>,
    resource: v8::Local<'s, v8::Value>,
    specifier: v8::Local<'s, v8::String>,
    attributes: v8::Local<'s, v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
    let resolver = v8::PromiseResolver::new(scope)?;
    let promise = resolver.get_promise(scope);
    let wanted = js::string(scope, specifier.into(), SPECIFIER_MAX);
    let files = program(scope).files.borrow().clone();
    let Some(files) = files else {
        let message = format!(
            "Cannot import {wanted:?}: import() works in programs (tenant.load), not in scripts"
        );
        reject(scope, resolver, Miss::Message(message));
        return Some(promise);
    };
    let kind = match attribute_kind(scope, attributes, 2) {
        Ok(kind) => kind,
        Err(miss) => {
            reject(scope, resolver, miss);
            return Some(promise);
        }
    };
    let from = js::text(scope, resource, SPECIFIER_MAX).filter(|path| files.tree.contains(path));
    let request = Request {
        specifier: wanted,
        from,
        kind,
        resolver: v8::Global::new(scope, resolver),
    };
    program(scope).imports.borrow_mut().push(request);
    let run = v8::Function::new(scope, run_imports)?;
    scope.enqueue_microtask(run);
    Some(promise)
}

/// An `import()` waiting for its microtask.
struct Request {
    specifier: String,
    from: Option<String>,
    kind: Option<Kind>,
    resolver: v8::Global<v8::PromiseResolver>,
}

/// The microtask of `import()`: settle the oldest waiting import.
fn run_imports(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue<v8::Value>,
) {
    let request = {
        let program = program(scope);
        let mut imports = program.imports.borrow_mut();
        if imports.is_empty() {
            return;
        }
        imports.remove(0)
    };
    let resolver = v8::Local::new(scope, &request.resolver);
    v8::tc_scope!(let tc, scope);
    let outcome = find(
        tc,
        &request.specifier,
        request.from.as_deref(),
        request.kind,
    )
    .and_then(|module| {
        if module.instantiate_module(tc, resolve) != Some(true) {
            return Err(Miss::Thrown);
        }
        let evaluated = module.evaluate(tc).ok_or(Miss::Thrown)?;
        let namespace = module.get_module_namespace();
        let evaluated = match v8::Local::<v8::Promise>::try_from(evaluated) {
            Ok(promise) => promise,
            Err(_) => {
                let done = v8::PromiseResolver::new(tc).ok_or(Miss::Thrown)?;
                done.resolve(tc, evaluated);
                done.get_promise(tc)
            }
        };
        let give = v8::Function::builder(give_data)
            .data(namespace)
            .build(tc)
            .ok_or(Miss::Thrown)?;
        evaluated.then(tc, give).ok_or(Miss::Thrown)
    });
    match outcome {
        Ok(namespace) => {
            resolver.resolve(tc, namespace.into());
        }
        Err(Miss::Thrown) => {
            if tc.is_execution_terminating() {
                return;
            }
            let error = tc.exception().unwrap_or_else(|| v8::undefined(tc).into());
            tc.reset();
            resolver.reject(tc, error);
        }
        Err(miss) => reject(tc, resolver, miss),
    }
}

/// Reject an `import()` with a miss that says why.
fn reject(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, miss: Miss) {
    let (message, syntax) = match miss {
        Miss::Message(message) => (message, false),
        Miss::Syntax(message) => (message, true),
        Miss::Thrown => return,
    };
    let message = js::short_string(scope, &js::clip(message, SPECIFIER_MAX * 2));
    let error = if syntax {
        v8::Exception::syntax_error(scope, message)
    } else {
        v8::Exception::type_error(scope, message)
    };
    resolver.reject(scope, error);
}

/// Returns its data: `then` with the module's namespace, once it evaluated.
fn give_data(
    _scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    rv.set(args.data());
}

// ---- handlers ----

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_come_from_extensions_unless_asked() {
        assert_eq!(kind_of("a.json", None), Kind::Json);
        assert_eq!(kind_of("a.ts", None), Kind::Code);
        assert_eq!(kind_of("a.json", Some(Kind::Text)), Kind::Text);
    }

    #[test]
    fn line_maps_need_a_mapping_on_the_line() {
        let json = r#"{"version":3,"sources":["a.ts"],"names":[],"mappings":"AAAA;AACA"}"#;
        let map = source_map::LineMap::from_json(json, "src").expect("a map");
        let mut maps = Maps::default();
        maps.push(Arc::new(map));
        assert_eq!(maps.original(2, 5), Some(("src/a.ts".into(), 2, 1)));
        assert_eq!(maps.original(3, 1), None);
    }
}
