//! A program's ES modules: the file tree a `load` sends, resolved,
//! transformed, compiled, instantiated, and evaluated in the VM's context;
//! the built-in modules (`isolane:env`, `isolane:files`,
//! `cloudflare:sockets`, host modules, the transform's helpers); `import()`
//! and `import.meta`; guests' own stacks, mapped; the handlers
//! calls find among the program's exports; and its fetch handler, called
//! through runtime/serve.js for `program.fetch`.
//!
//! Everything a program's code becomes is decided here, in the locked-down
//! worker: the supervisor only sends the files.
//!
//! - `tree`: the files, and `oxc_resolver` over them
//! - `transform`: TypeScript, JSX, and `define`, with oxc
//! - `source_map`: maps back to the original files, for stacks
//! - `code_cache`: V8 code caches of the compiled modules, per worker
//! - `files`: `isolane:files`, the program's files read as `node:fs` reads

pub(crate) mod code_cache;
mod files;
mod source_map;
mod transform;
mod tree;

use std::cell::{Cell, RefCell};
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
    /// Modules compiled without a code cache, to make one for once the
    /// program has evaluated.
    uncached: RefCell<Vec<(code_cache::Key, v8::Global<v8::Module>)>>,
    /// What compiling the program's code took from the code cache.
    compiled: Cell<Compiled>,
    /// runtime/serve.js's `{ serve, finish, drain }`, for `program.fetch`
    /// (absent without the web platform).
    serving: RefCell<Option<v8::Global<v8::Object>>>,
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
    isolate.set_prepare_stack_trace_callback(prepare_stack_trace);
}

/// The program's `env` (what `isolane:env` exports).
pub(super) fn set_env(scope: &mut v8::PinScope, env: v8::Local<v8::Object>) {
    *program(scope).env.borrow_mut() = Some(v8::Global::new(scope, env));
}

/// The Sockets API's `connect` (what `cloudflare:sockets` exports).
pub(super) fn set_connect(scope: &mut v8::PinScope, connect: v8::Local<v8::Function>) {
    *program(scope).connect.borrow_mut() = Some(v8::Global::new(scope, connect));
}

/// What `program.fetch` calls the program's handler through (see
/// runtime/serve.js).
pub(super) fn set_serving(scope: &mut v8::PinScope, serving: v8::Local<v8::Object>) {
    *program(scope).serving.borrow_mut() = Some(v8::Global::new(scope, serving));
}

/// Call runtime/serve.js's `method` with `args`. None if the VM has no web
/// platform (`Ok(None)`), or if the call threw (`Err`, with the exception
/// caught by the caller's TryCatch).
fn call_serving<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    method: &str,
    args: &[v8::Local<'s, v8::Value>],
) -> Result<Option<v8::Local<'s, v8::Value>>, ()> {
    let serving = program(scope).serving.borrow().clone();
    let Some(serving) = serving else {
        return Ok(None);
    };
    let serving = v8::Local::new(scope, serving);
    let key = js::short_string(scope, method);
    let function = serving
        .get(scope, key.into())
        .and_then(|f| v8::Local::<v8::Function>::try_from(f).ok())
        .ok_or(())?;
    let this: v8::Local<v8::Value> = v8::undefined(scope).into();
    function.call(scope, this, args).map(Some).ok_or(())
}

/// Call the fetch handler `handler` (with `this`) for a request: `head`
/// (`{ url, method, headers }`) and `body` (bytes, or null). Returns what
/// the handler returned, as `call_serving` does.
pub(super) fn serve<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    (handler, this): (v8::Local<'s, v8::Function>, v8::Local<'s, v8::Value>),
    head: v8::Local<'s, v8::Value>,
    body: v8::Local<'s, v8::Value>,
) -> Result<Option<v8::Local<'s, v8::Value>>, ()> {
    let env: v8::Local<v8::Value> = match program(scope).env.borrow().as_ref() {
        Some(env) => v8::Local::new(scope, env).into(),
        None => v8::Object::new(scope).into(),
    };
    call_serving(scope, "serve", &[handler.into(), this, head, body, env])
}

/// Read the handler's Response (after the `after` shims) for the host:
/// a promise for `{ status, statusText, headers, body, waiting }`, or for
/// `{ tooLarge }` past `max_body` bytes.
pub(super) fn finish<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    response: v8::Local<'s, v8::Value>,
    max_body: f64,
) -> Result<Option<v8::Local<'s, v8::Value>>, ()> {
    let max = v8::Number::new(scope, max_body);
    call_serving(scope, "finish", &[response, max.into()])
}

/// A promise that settles once the instance's `ctx.waitUntil` work has.
pub(super) fn drain<'s>(
    scope: &mut v8::PinScope<'s, '_>,
) -> Result<Option<v8::Local<'s, v8::Value>>, ()> {
    call_serving(scope, "drain", &[])
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
        resolver: Resolver::new(Arc::clone(&tree), &options.tsconfig),
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

/// The program evaluated: calls look up handlers in its namespace from now
/// on. Returns how the program's code was compiled.
pub(super) fn loaded(scope: &mut v8::PinScope) -> Compiled {
    let program = program(scope);
    let compiled = program.compiled.get();
    let main = program.main.borrow();
    let Some(main) = main.as_ref() else {
        return compiled;
    };
    let main = v8::Local::new(scope, main);
    if let Ok(namespace) = v8::Local::<v8::Object>::try_from(main.get_module_namespace()) {
        *program.namespace.borrow_mut() = Some(v8::Global::new(scope, namespace));
    }
    compiled
}

/// Make code caches for the modules compiled without one. Run once the
/// program has evaluated, after its load's result is sent (it's off the
/// load's path), so the caches hold the functions setup ran too.
pub(super) fn make_code_caches(scope: &mut v8::PinScope) {
    let uncached = program(scope).uncached.take();
    if !code_cache::enabled() {
        return;
    }
    for (key, module) in uncached {
        let module = v8::Local::new(scope, module);
        let script = module.get_unbound_module_script(scope);
        if let Some(data) = script.create_code_cache() {
            code_cache::put(key, Arc::new(data.to_vec()));
        }
    }
}

/// How a program's code modules were compiled: how many, how many from a
/// code cache, and how many caches V8 rejected (and compiled from source).
#[derive(Clone, Copy, Default, serde::Serialize)]
pub(crate) struct Compiled {
    pub compiled: u32,
    pub cached: u32,
    pub rejected: u32,
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

/// What a specifier names.
enum Target {
    /// A file of the program, by its path.
    File(String),
    Env,
    Files,
    Sockets,
    /// A host module, by its specifier.
    Host(String),
    /// One of the transform's helpers, by its name, with its code.
    Helper(String, &'static str),
}

impl Target {
    /// Its URL, as `import.meta.resolve` gives it: a file's `file:` URL,
    /// or a built-in module's specifier.
    fn url(&self) -> String {
        match self {
            Target::File(path) => file_url(path),
            Target::Env => ENV_SPECIFIER.into(),
            Target::Files => files::SPECIFIER.into(),
            Target::Sockets => SOCKETS_SPECIFIER.into(),
            Target::Host(specifier) => specifier.clone(),
            Target::Helper(name, _) => format!("{}{name}", transform::HELPERS),
        }
    }
}

/// The `file:` URL of the program's file `path` (`src/a.js` is
/// `file:///src/a.js`).
fn file_url(path: &str) -> String {
    url::Url::from_file_path(format!("/{path}"))
        .map(String::from)
        .unwrap_or_else(|()| format!("file:///{path}"))
}

/// What `specifier` names, imported from the file `from` (None: the
/// program's root): an alias's target, a built-in module, a file by its
/// `file:` URL, or what the resolver finds.
fn locate(files: &Files, specifier: &str, from: Option<&str>) -> Result<Target, Miss> {
    let mut specifier = specifier;
    match files.aliases.get(specifier) {
        Some(Alias::File(path)) => return Ok(Target::File(path.clone())),
        Some(Alias::Specifier(other)) => specifier = other,
        Some(Alias::Host) => return Ok(Target::Host(specifier.to_string())),
        None => {}
    }
    let importer = from.unwrap_or("the program");
    if let Some(name) = specifier.strip_prefix(transform::HELPERS) {
        if let Some(code) = helper_code(name) {
            return Ok(Target::Helper(name.to_string(), code));
        }
    }
    match specifier {
        ENV_SPECIFIER => return Ok(Target::Env),
        files::SPECIFIER => return Ok(Target::Files),
        SOCKETS_SPECIFIER => return Ok(Target::Sockets),
        _ => {}
    }
    if specifier.starts_with("file:") {
        let path = url::Url::parse(specifier)
            .ok()
            .and_then(|url| url.to_file_path().ok())
            .and_then(|path| tree::tree_path(&path))
            .filter(|path| files.tree.contains(path));
        return path.map(Target::File).ok_or_else(|| {
            Miss::Message(format!(
                "Cannot find module {specifier:?} imported from {importer}"
            ))
        });
    }
    if let Some((scheme, _)) = specifier.split_once(':') {
        let is_scheme = !scheme.is_empty()
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c));
        if is_scheme {
            let hint = if scheme == "node" {
                "isolane has no Node.js built-in modules; give the program one with the modules option ({ 'node:x': './x.js' }), or read its files with isolane:files"
            } else {
                "only the program's files, isolane:env, isolane:files, cloudflare:sockets, and the modules option's specifiers can be imported"
            };
            return Err(Miss::Message(format!(
                "Cannot import {specifier:?} from {importer}: {hint}"
            )));
        }
    }
    files
        .resolver
        .resolve(from, specifier)
        .map(Target::File)
        .map_err(|why| Miss::Message(format!("{why} imported from {importer}")))
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
    match locate(&files, specifier, from)? {
        Target::File(path) => file_module(scope, &path, kind_of(&path, kind)),
        Target::Env => Ok(env_module(scope)),
        Target::Files => Ok(files_module(scope)),
        Target::Sockets => Ok(sockets_module(scope)),
        Target::Host(specifier) => Ok(host_module(scope, &specifier)),
        Target::Helper(name, code) => helper_module(scope, &name, code),
    }
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
    let hash = files.tree.hash(path).expect("the file is in the tree");
    let applies = files.transforms.applies(path);
    let fingerprint = if applies {
        files.transforms.fingerprint()
    } else {
        ""
    };
    let key = code_cache::key(&[path.as_bytes(), &hash, fingerprint.as_bytes()]);
    let code = if applies {
        match files.transforms.run(path, text, &hash) {
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
    compile(scope, path, code, key)
}

/// Compile module source `code`, named `name` in stack traces, from the
/// worker's code cache for `key` when it has one (see `code_cache`). A
/// failure notes where it was (mapped to the original file), and throws.
fn compile<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    name: &str,
    code: &str,
    key: code_cache::Key,
) -> Result<v8::Local<'s, v8::Module>, Miss> {
    let cached = code_cache::get(&key);
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
    let (mut source, options) = match &cached {
        Some(bytes) => (
            v8::script_compiler::Source::new_with_cached_data(
                source,
                Some(&origin),
                v8::CachedData::new(bytes),
            ),
            v8::script_compiler::CompileOptions::ConsumeCodeCache,
        ),
        None => (
            v8::script_compiler::Source::new(source, Some(&origin)),
            v8::script_compiler::CompileOptions::NoCompileOptions,
        ),
    };
    v8::tc_scope!(let tc, scope);
    let compiled = v8::script_compiler::compile_module2(
        tc,
        &mut source,
        options,
        v8::script_compiler::NoCacheReason::NoReason,
    );
    if let Some(module) = compiled {
        let rejected = source.get_cached_data().is_some_and(|data| data.rejected());
        let program = program(tc);
        let mut counts = program.compiled.get();
        counts.compiled += 1;
        if cached.is_some() && !rejected {
            counts.cached += 1;
        } else {
            if rejected {
                counts.rejected += 1;
                code_cache::remove(&key);
            }
            program
                .uncached
                .borrow_mut()
                .push((key, v8::Global::new(tc, module)));
        }
        program.compiled.set(counts);
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

// ---- stacks ----

/// `error.stack`, made when it's first read: as V8 writes it, with the
/// frames in transformed modules (and bundles with maps) pointing at the
/// original files, as Deno does, so the guest's own stacks and the ones
/// isolane reports agree. A program that sets `Error.prepareStackTrace`
/// gets V8's call sites, with generated positions, as V8 gives them when
/// it formats stacks itself; one that throws falls back to the default
/// form (an exception can't leave this callback).
fn prepare_stack_trace<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    error: v8::Local<'s, v8::Value>,
    sites: v8::Local<'s, v8::Array>,
) -> v8::Local<'s, v8::Value> {
    v8::tc_scope!(let tc, scope);
    if let Some(prepare) = user_prepare_stack_trace(tc) {
        let this = v8::undefined(tc).into();
        if let Some(stack) = prepare.call(tc, this, &[error, sites.into()]) {
            return stack;
        }
        if tc.has_terminated() {
            return v8::undefined(tc).into();
        }
        tc.reset();
    }
    let mut stack = stack_header(tc, error);
    if tc.has_terminated() {
        return v8::undefined(tc).into();
    }
    tc.reset();
    let to_string = js::short_string(tc, "toString");
    for i in 0..sites.length() {
        let frame = sites
            .get_index(tc, i)
            .and_then(|site| v8::Local::<v8::Object>::try_from(site).ok())
            .and_then(|site| {
                let method = site.get(tc, to_string.into())?;
                let method = v8::Local::<v8::Function>::try_from(method).ok()?;
                method.call(tc, site.into(), &[])
            })
            .map(|frame| js::string(tc, frame, FRAME_MAX));
        if tc.has_terminated() {
            return v8::undefined(tc).into();
        }
        tc.reset();
        stack.push_str("\n    at ");
        stack.push_str(frame.as_deref().unwrap_or("<error>"));
    }
    let stack = map_stack(tc, stack);
    match v8::String::new(tc, &stack) {
        Some(stack) => stack.into(),
        None => v8::undefined(tc).into(),
    }
}

/// Longest frame line kept.
const FRAME_MAX: usize = 4096;

/// `Error.prepareStackTrace`, if the program set it to a function.
fn user_prepare_stack_trace<'s>(
    scope: &mut v8::PinScope<'s, '_>,
) -> Option<v8::Local<'s, v8::Function>> {
    let global = scope.get_current_context().global(scope);
    let key = js::short_string(scope, "Error");
    let error = global.get(scope, key.into())?;
    let error = v8::Local::<v8::Object>::try_from(error).ok()?;
    let key = js::short_string(scope, "prepareStackTrace");
    let prepare = error.get(scope, key.into())?;
    v8::Local::<v8::Function>::try_from(prepare).ok()
}

/// A stack's first line, as V8 writes it: `name: message`, either alone
/// if the other is empty (`Error` and `""` for ones that are undefined).
fn stack_header(scope: &mut v8::PinScope, error: v8::Local<v8::Value>) -> String {
    let Ok(object) = v8::Local::<v8::Object>::try_from(error) else {
        return js::string(scope, error, FRAME_MAX);
    };
    let mut read = |key: &str, default: &str| {
        let key = js::short_string(scope, key);
        match object.get(scope, key.into()) {
            Some(value) if value.is_undefined() => Some(default.to_string()),
            Some(value) => Some(js::string(scope, value, FRAME_MAX)),
            None => None,
        }
    };
    let (Some(name), Some(message)) = (read("name", "Error"), read("message", "")) else {
        return "<error>".into();
    };
    match (name.is_empty(), message.is_empty()) {
        (true, _) => message,
        (false, true) => name,
        (false, false) => format!("{name}: {message}"),
    }
}

/// `stack` with its frames in transformed modules (and bundles with maps)
/// pointing at the original files.
fn map_stack(scope: &mut v8::PinScope, stack: String) -> String {
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

/// `isolane:files`: the program's files, read-only (see `files`).
fn files_module<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module> {
    built_in(scope, files::SPECIFIER, |scope| {
        let exports = files::exports(scope);
        synthetic_module(scope, files::SPECIFIER, exports)
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

/// The code of the helper the transform imports for legacy decorators
/// (as tslib's `__decorate`, `__metadata`, and `__param`) by `name`. None
/// for a name that isn't one.
fn helper_code(name: &str) -> Option<&'static str> {
    match name {
        "/helpers/decorate" => Some(DECORATE),
        "/helpers/decorateMetadata" => Some(DECORATE_METADATA),
        "/helpers/decorateParam" => Some(DECORATE_PARAM),
        _ => None,
    }
}

/// The helper module `name`, made once.
fn helper_module<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    name: &str,
    code: &str,
) -> Result<v8::Local<'s, v8::Module>, Miss> {
    let specifier = format!("{}{name}", transform::HELPERS);
    let key = (specifier.clone(), Kind::Code);
    if let Some(module) = program(scope).modules.borrow().get(&key) {
        return Ok(v8::Local::new(scope, module));
    }
    let cache_key = code_cache::key(&[specifier.as_bytes(), code.as_bytes()]);
    let module = compile(scope, &specifier, code, cache_key)?;
    let global = v8::Global::new(scope, module);
    program(scope).modules.borrow_mut().insert(key, global);
    Ok(module)
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

/// `import.meta`, as Node.js has it for a module at its path under `/`:
/// `url` (`src/index.js` is `file:///src/index.js`), `filename`
/// (`/src/index.js`), `dirname` (`/src`), `main` (whether it's the
/// program's main module), and `resolve(specifier)`, the URL an import of
/// `specifier` from the module would load.
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
    let dirname = match path.rfind('/') {
        Some(i) => format!("/{}", &path[..i]),
        None => "/".to_string(),
    };
    let is_main = program(scope)
        .main
        .borrow()
        .as_ref()
        .is_some_and(|main| v8::Local::new(scope, main) == module);
    for (name, value) in [
        ("url", file_url(&path)),
        ("filename", format!("/{path}")),
        ("dirname", dirname),
    ] {
        let Some(value) = js::guest_string(scope, &value) else {
            return;
        };
        let key = js::short_string(scope, name);
        meta.create_data_property(scope, key.into(), value.into());
    }
    let key = js::short_string(scope, "main");
    let value = v8::Boolean::new(scope, is_main);
    meta.create_data_property(scope, key.into(), value.into());
    let Some(from) = js::guest_string(scope, &path) else {
        return;
    };
    let Some(resolve) = v8::Function::builder(meta_resolve)
        .data(from.into())
        .length(1)
        .build(scope)
    else {
        return;
    };
    let key = js::short_string(scope, "resolve");
    resolve.set_name(key);
    meta.create_data_property(scope, key.into(), resolve.into());
}

/// `import.meta.resolve(specifier)`: the URL an import of `specifier`
/// from the module (its path is the data) would load, without loading it.
/// Throws a TypeError for one that names nothing, as the import would.
fn meta_resolve(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let Some(specifier) = js::text(scope, args.get(0), SPECIFIER_MAX) else {
        return;
    };
    let from = js::string(scope, args.data(), SPECIFIER_MAX);
    let Some(files) = program(scope).files.borrow().clone() else {
        return;
    };
    match locate(&files, &specifier, Some(&from)) {
        Ok(target) => {
            if let Some(url) = js::guest_string(scope, &target.url()) {
                rv.set(url.into());
            }
        }
        Err(Miss::Message(message) | Miss::Syntax(message)) => {
            js::throw_type(scope, &js::clip(message, SPECIFIER_MAX * 2));
        }
        Err(Miss::Thrown) => {}
    }
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
