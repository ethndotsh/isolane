//! Messages between the supervisor (the isolane library in the application's
//! Node process) and a worker. Values cross as raw JSON text so the worker
//! never re-parses what V8 already serialized.

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

/// Supervisor → worker.
#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum In {
    #[serde(rename_all = "camelCase")]
    Create {
        vm: u64,
        /// Cap on the isolate's heap. Exceeding it retires the VM.
        heap_bytes: Option<u64>,
        /// Wall-clock budget for each eval, and for each host-reply
        /// continuation that runs between evals.
        timeout_ms: Option<u64>,
        /// CPU-time budget for each eval and continuation.
        cpu_time_limit_ms: Option<u64>,
        #[serde(default)]
        host_functions: Vec<String>,
        /// Host functions that return directly instead of a Promise.
        #[serde(default)]
        sync_host_functions: Vec<String>,
        #[serde(default)]
        clock: crate::clock::Mode,
        /// Seeds the isolate's entropy (Math.random, hash seeds).
        random_seed: Option<u64>,
        /// eval and new Function.
        #[serde(default)]
        allow_code_generation: bool,
        /// Keep the WebAssembly global and allow compiling modules.
        #[serde(default)]
        allow_web_assembly: bool,
        /// Limits enforced inside the guest.
        #[serde(default)]
        limits: crate::limits::GuestLimits,
        /// Install the WinterTC web platform globals (src/web/).
        #[serde(default)]
        web_platform: bool,
        /// Trusted setup run in the context before guest code (the
        /// supervisor's fetch/fs wrappers).
        prelude: Option<String>,
    },
    Eval {
        vm: u64,
        req: u64,
        code: String,
        /// The VM is disposed after this eval (a one-shot run): it exits
        /// once the result is sent, and pending timers never run.
        #[serde(default)]
        last: bool,
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
    Dispose {
        vm: u64,
    },
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
#[derive(Clone, Copy, Serialize)]
pub enum ErrorCode {
    #[serde(rename = "ERR_TIMEOUT")]
    Timeout,
    #[serde(rename = "ERR_CPU_LIMIT")]
    CpuLimit,
    #[serde(rename = "ERR_RESOURCE_LIMIT")]
    ResourceLimit,
    #[serde(rename = "ERR_GUEST_EXCEPTION")]
    GuestException,
    #[serde(rename = "ERR_MEMORY_LIMIT")]
    MemoryLimit,
    #[serde(rename = "ERR_ISOLATE_RETIRED")]
    IsolateRetired,
    #[serde(rename = "ERR_ISOLATE_DISPOSED")]
    IsolateDisposed,
    #[serde(rename = "ERR_NOT_SERIALIZABLE")]
    NotSerializable,
    #[serde(rename = "ERR_UNSETTLED")]
    Unsettled,
    #[serde(rename = "ERR_INTERNAL")]
    Internal,
}

/// What the guest threw, for `ERR_GUEST_EXCEPTION`.
#[derive(Clone, Serialize)]
pub struct GuestError {
    /// `error.name` when the guest threw an object with one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `error.message`, or the thrown value as a string.
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
}

#[derive(Clone)]
pub struct Failure {
    pub code: ErrorCode,
    pub message: String,
    pub guest: Option<GuestError>,
}

pub fn fail(code: ErrorCode, message: impl Into<String>) -> Failure {
    Failure {
        code,
        message: message.into(),
        guest: None,
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
        v8: &'a str,
        sandbox_secure: bool,
        lockdown: crate::lockdown::Report,
    },
    Result {
        req: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<&'a RawValue>,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<ErrorCode>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        guest: Option<&'a GuestError>,
        #[serde(flatten)]
        usage: Usage,
    },
    /// CPU used by work outside an eval (host-reply continuations).
    #[serde(rename_all = "camelCase")]
    Usage {
        vm: u64,
        #[serde(flatten)]
        usage: Usage,
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
        name: &'a str,
        args: &'a RawValue,
        /// Arguments sent as bytes, in the order their bytes follow the
        /// frame's JSON: `[argument index, length]`. `args` has null there.
        #[serde(skip_serializing_if = "<[_]>::is_empty")]
        bin: &'a [(u32, usize)],
    },
}
