//! Messages between the supervisor (the isolane library in the application's
//! Node process) and a worker. Values cross as raw JSON text so the worker
//! never re-parses what V8 already serialized.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

/// The protocol version. The worker reports it in `ready`; a supervisor
/// that speaks another version refuses the worker.
pub const PROTOCOL_VERSION: u32 = 11;

/// Supervisor → worker.
#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum In {
    /// A new isolate, its config inline beside `vm`.
    Create {
        vm: u64,
        #[serde(flatten)]
        config: Box<crate::vm::VmConfig>,
    },
    #[serde(rename_all = "camelCase")]
    Eval {
        vm: u64,
        req: u64,
        code: String,
        /// The code's name in stack traces (`acme/eval-1.js`).
        filename: Option<String>,
        /// The VM is disposed after this eval (a one-shot run): it exits
        /// once the result is sent, and pending timers never run.
        #[serde(default)]
        last: bool,
    },
    /// Load a program into the isolate: compile its main module (and, with
    /// multi-file programs, what it imports), instantiate it, and evaluate
    /// it under the setup rules (`limits.startupCpuMs`, no I/O). Runs as an
    /// eval (`req` names it in `result` and `abort`); an isolate takes one.
    Load {
        vm: u64,
        req: u64,
        /// The main module's path in `files`.
        main: String,
        /// The program's files, by a hash of their contents: sent with
        /// `files` the first time, the worker keeps them under it (until
        /// `forget`), and later loads name it alone.
        tree: String,
        /// Module sources by path (their names in stack traces), when the
        /// worker doesn't have `tree` yet. Files sent as bytes are in `bin`
        /// instead.
        files: Option<std::collections::BTreeMap<String, String>>,
        /// Files sent as bytes, in the order their bytes follow the frame's
        /// JSON: `[path, length]`.
        #[serde(default)]
        bin: Vec<(String, usize)>,
        /// How the program's modules are resolved and transformed.
        #[serde(default)]
        options: ModuleOptions,
    },
    /// Call the function the isolate's code defined as `name` (a program's
    /// export), with arguments as data: nothing is compiled. Runs and is
    /// budgeted as an eval (`req` names it in `result` and `abort`).
    #[serde(rename_all = "camelCase")]
    Call {
        vm: u64,
        req: u64,
        name: String,
        /// The arguments as a JSON array (text, as for `HostReply::value`).
        args: String,
        /// Arguments sent as bytes, in the order their bytes follow the
        /// frame's JSON: `[argument index, length]`. `args` has null there.
        #[serde(default)]
        bin: Vec<(u32, usize)>,
        #[serde(default)]
        kind: CallKind,
        /// For a `fetch` call: the most bytes the response's body may have
        /// (`limits.bodyBytes`).
        #[serde(default)]
        max_body: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    HostReply {
        vm: u64,
        call: u64,
        ok: bool,
        /// Result as JSON text, handed to V8's JSON.parse; absent for
        /// `undefined`. (Text, because serde can't buffer a RawValue inside
        /// a tagged enum, and a parsed Value would conflate null with absent.)
        value: Option<String>,
        error: Option<String>,
        /// The error's class in the guest, and its `code` property.
        error_name: Option<String>,
        error_code: Option<String>,
        /// Byte values in the result, in the order their bytes follow the
        /// frame's JSON: where each goes in the parsed value (`[]` for the
        /// value itself), and its length. `value` has null there.
        #[serde(default)]
        bin: Vec<(Vec<PathSegment>, usize)>,
    },
    /// Stop eval `req` (its `signal` was aborted): now if it's running,
    /// before it starts if it's queued.
    Abort {
        vm: u64,
        req: u64,
    },
    Dispose {
        vm: u64,
    },
    /// Drop the files kept as `tree` (isolates that loaded them keep theirs).
    Forget {
        tree: String,
    },
}

/// What a `call` invokes.
#[derive(Deserialize, Default, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CallKind {
    /// The function `name` (a program's export, or a global function).
    #[default]
    Export,
    /// A program's `fetch` handler, for `program.fetch`: `args` is
    /// `[{ url, method, headers }, body]` (body: bytes, or null), and the
    /// result is the Response's head as JSON with its body attached.
    Fetch,
    /// Wait for the instance's `ctx.waitUntil` work (before it's closed).
    Drain,
}

#[derive(Deserialize, Default)]
pub struct Random {
    /// Seeds the isolate's entropy (Math.random, crypto, hash seeds).
    pub seed: Option<u64>,
}

/// A host function: where it goes in the guest's global scope
/// (`["db", "getUser"]` is `db.getUser`), and whether the guest calls it
/// synchronously.
#[derive(Deserialize)]
pub struct FunctionSpec {
    pub path: Vec<String>,
    #[serde(default)]
    pub sync: bool,
    /// Under the program's `env` object (`isolane:env`), not the global.
    #[serde(default)]
    pub env: bool,
    /// An export of the program's host module with this specifier
    /// (`modules: { 'isolane:kv': { get } }`), not on the global.
    #[serde(default)]
    pub module: Option<String>,
}

/// How a program's modules are resolved and transformed (`tenant.load`'s
/// `ts`, `jsx`, `define`, and `modules` options).
#[derive(Deserialize, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModuleOptions {
    #[serde(default)]
    pub ts: TsOptions,
    #[serde(default)]
    pub jsx: JsxOptions,
    /// Compile-time constants, as esbuild's `define`: an identifier or
    /// member expression, and the expression that replaces it.
    #[serde(default)]
    pub define: Vec<(String, String)>,
    /// Specifiers resolved to something other than what they name.
    #[serde(default)]
    pub aliases: std::collections::BTreeMap<String, Alias>,
    /// Which tsconfig.json's `paths` and `baseUrl` imports resolve with.
    #[serde(default)]
    pub tsconfig: Tsconfig,
}

/// Which tsconfig.json a program's imports resolve with.
#[derive(Deserialize, Serialize, Default, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Tsconfig {
    /// The nearest one above the importing file, as TypeScript finds it
    /// (none for files in `node_modules`).
    #[default]
    Auto,
    /// This file of the program, for every import.
    File(String),
    /// None.
    Off,
}

#[derive(Deserialize, Serialize, Default, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TsMode {
    /// Remove types only, refusing syntax that has runtime meaning (enums,
    /// namespaces with values, parameter properties), as Node does.
    #[default]
    Strip,
    /// Compile that syntax too.
    Transform,
}

#[derive(Deserialize, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TsOptions {
    #[serde(default)]
    pub mode: TsMode,
    /// Legacy (`experimentalDecorators`) decorators, in transform mode.
    #[serde(default)]
    pub decorators: bool,
    /// With `decorators`: `emitDecoratorMetadata`.
    #[serde(default)]
    pub emit_decorator_metadata: bool,
}

#[derive(Deserialize, Serialize, Default, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JsxRuntime {
    /// `jsx()` calls imported from `<importSource>/jsx-runtime`.
    #[default]
    Automatic,
    /// Calls to a factory (`React.createElement`) in scope.
    Classic,
}

#[derive(Deserialize, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JsxOptions {
    #[serde(default)]
    pub runtime: JsxRuntime,
    /// Automatic runtime: the package `jsx-runtime` comes from. Default `react`.
    #[serde(default)]
    pub import_source: Option<String>,
    /// Classic runtime: the element and fragment factories. Default
    /// `React.createElement` and `React.Fragment`.
    #[serde(default)]
    pub factory: Option<String>,
    #[serde(default)]
    pub fragment: Option<String>,
    /// The development runtime (`jsx-dev-runtime`, with source locations).
    #[serde(default)]
    pub development: bool,
}

/// What an aliased specifier resolves to.
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub enum Alias {
    /// A file of the program, by its path.
    File(String),
    /// Another specifier, resolved as if the import had named it.
    Specifier(String),
    /// The program's host module of that name (its functions are the
    /// `FunctionSpec`s with this `module`).
    Host,
}

/// Trusted embedder code run around guest code. `setup` runs once, after
/// the prelude; `before` before each eval's code; `after` once its value
/// settles, each as the body of `async function (result)`.
#[derive(Deserialize, Default)]
pub struct Shims {
    #[serde(default)]
    pub setup: Vec<Shim>,
    #[serde(default)]
    pub before: Vec<Shim>,
    #[serde(default)]
    pub after: Vec<Shim>,
}

#[derive(Deserialize)]
pub struct Shim {
    pub code: String,
    /// Its name in stack traces and in `ERR_SHIM` errors.
    pub filename: String,
}

/// Which shim failed, for `ERR_SHIM`.
#[derive(Clone, Serialize)]
pub struct ShimRef {
    pub phase: &'static str,
    pub index: u32,
    pub filename: String,
}

/// A step into a JSON value: an object key or an array index.
#[derive(Deserialize, Clone)]
#[serde(untagged)]
pub enum PathSegment {
    Index(u32),
    Key(String),
}

/// Why an eval failed (`IsolaneError` codes; the supervisor adds its own
/// for worker-level failures).
#[derive(Clone, Copy, PartialEq, Serialize)]
pub enum ErrorCode {
    /// A limit ran out; `Failure::limit` names it.
    #[serde(rename = "ERR_LIMIT")]
    Limit,
    #[serde(rename = "ERR_GUEST_EXCEPTION")]
    GuestException,
    #[serde(rename = "ERR_ISOLATE_RETIRED")]
    IsolateRetired,
    #[serde(rename = "ERR_ISOLATE_CLOSED")]
    IsolateClosed,
    #[serde(rename = "ERR_NOT_SERIALIZABLE")]
    NotSerializable,
    #[serde(rename = "ERR_UNSETTLED")]
    Unsettled,
    /// A shim (embedder code) threw or never settled; `Failure::shim` says which.
    #[serde(rename = "ERR_SHIM")]
    Shim,
    /// The supervisor aborted the eval (its `signal`).
    #[serde(rename = "ERR_ABORTED")]
    Aborted,
    /// A call named no function the isolate's code defined.
    #[serde(rename = "ERR_HANDLER_NOT_FOUND")]
    HandlerNotFound,
    /// A program's setup failed after trying I/O, which setup can't do.
    #[serde(rename = "ERR_SETUP_IO")]
    SetupIo,
    #[serde(rename = "ERR_INTERNAL")]
    Internal,
}

/// What the guest threw, for `ERR_GUEST_EXCEPTION` (and `guestError`
/// frames). Every part is bounded (see `vm::errors`).
#[derive(Clone, Default, Serialize)]
pub struct GuestError {
    /// `error.name` when the guest threw an object with one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `error.message`, or the thrown value as a string.
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    /// Where code failed to compile (a SyntaxError in the eval's code).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<Location>,
    /// `error.cause`, as a guest error of its own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<Box<GuestError>>,
    /// An AggregateError's `errors`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<GuestError>>,
    /// Own enumerable properties (like `code`) whose values are JSON, as JSON.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub properties: Option<std::collections::BTreeMap<String, Box<RawValue>>>,
}

/// A place in guest code: 1-based line and column.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub file: String,
    pub line: u32,
    pub column: u32,
    /// The line itself (a window around the column, for long lines).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_line: Option<String>,
}

#[derive(Clone)]
pub struct Failure {
    pub code: ErrorCode,
    pub message: String,
    pub guest: Option<Box<GuestError>>,
    /// For `ERR_LIMIT`: which limit, by its public name (`timeoutMs`, ...).
    pub limit: Option<&'static str>,
    /// For `ERR_SHIM`: which shim.
    pub shim: Option<ShimRef>,
}

pub fn fail(code: ErrorCode, message: impl Into<String>) -> Failure {
    Failure {
        code,
        message: message.into(),
        guest: None,
        limit: None,
        shim: None,
    }
}

/// `ERR_LIMIT` for the limit named `limit`.
pub fn limit(limit: &'static str, message: impl Into<String>) -> Failure {
    Failure {
        code: ErrorCode::Limit,
        message: message.into(),
        guest: None,
        limit: Some(limit),
        shim: None,
    }
}

/// What an eval (or continuation) cost.
#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// CPU time on the VM's thread, in microseconds (Linux).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_us: Option<u64>,
    /// The isolate's V8 heap in use afterwards, and memory V8 accounts
    /// outside it (ArrayBuffers, WebAssembly).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heap_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_bytes: Option<u64>,
}

/// Worker → supervisor.
#[derive(Serialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Out<'a> {
    #[serde(rename_all = "camelCase")]
    Ready {
        protocol: u32,
        v8: &'a str,
        sandbox_secure: bool,
        lockdown: crate::lockdown::Report,
    },
    Result {
        vm: u64,
        req: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<&'a RawValue>,
        /// A call's result is bytes, attached after the frame's JSON: their
        /// length (`value` is absent; for a fetch call, `value` is the
        /// Response's head and these bytes are its body).
        #[serde(skip_serializing_if = "Option::is_none")]
        bin: Option<usize>,
        /// This eval retired its isolate (it was stopped part-way, or ran out
        /// of memory): what the isolate's later evals fail with.
        #[serde(skip_serializing_if = "Option::is_none")]
        retired: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<ErrorCode>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        guest: Option<&'a GuestError>,
        #[serde(skip_serializing_if = "Option::is_none")]
        limit: Option<&'static str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        shim: Option<&'a ShimRef>,
        #[serde(flatten)]
        usage: Usage,
    },
    /// CPU used by work outside an eval (timers, host-reply
    /// continuations), and the limit that work hit, if it hit one (the
    /// isolate is retired).
    #[serde(rename_all = "camelCase")]
    Usage {
        vm: u64,
        #[serde(flatten)]
        usage: Usage,
        #[serde(skip_serializing_if = "Option::is_none")]
        limit: Option<&'static str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<&'a str>,
    },
    /// An error nothing handled, outside the eval's own result: an
    /// exception in a timer or task (`kind: "exception"`), or a rejected
    /// promise with no handler (`"rejection"`). One-way: no reply.
    GuestError {
        vm: u64,
        kind: &'static str,
        guest: &'a GuestError,
    },
    /// A console call from guest code. One-way: no reply.
    Log {
        vm: u64,
        level: &'a str,
        message: &'a str,
    },
    HostCall {
        vm: u64,
        call: u64,
        /// The host function, by its index in `VmConfig::functions`.
        #[serde(rename = "fn")]
        function: u32,
        args: &'a RawValue,
        /// Arguments sent as bytes, in the order their bytes follow the
        /// frame's JSON: `[argument index, length]`. `args` has null there.
        #[serde(skip_serializing_if = "<[_]>::is_empty")]
        bin: &'a [(u32, usize)],
    },
}
