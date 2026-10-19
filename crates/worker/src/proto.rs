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
        #[serde(default)]
        host_functions: Vec<String>,
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
        /// Trusted setup run in the context before guest code (the
        /// supervisor's fetch/fs wrappers).
        prelude: Option<String>,
    },
    Eval {
        vm: u64,
        req: u64,
        code: String,
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
    },
    Dispose {
        vm: u64,
    },
}

/// Why an eval failed. Mirrors clockwork's `LaneError` codes, plus
/// `ERR_MEMORY_LIMIT`.
#[derive(Clone, Copy, Serialize)]
pub enum ErrorCode {
    #[serde(rename = "ERR_TIMEOUT")]
    Timeout,
    #[serde(rename = "ERR_GUEST_EXCEPTION")]
    GuestException,
    #[serde(rename = "ERR_MEMORY_LIMIT")]
    MemoryLimit,
    #[serde(rename = "ERR_VM_TERMINATED")]
    VmTerminated,
    #[serde(rename = "ERR_VM_DISPOSED")]
    VmDisposed,
    #[serde(rename = "ERR_NOT_SERIALIZABLE")]
    NotSerializable,
    #[serde(rename = "ERR_UNSETTLED")]
    Unsettled,
    #[serde(rename = "ERR_INTERNAL")]
    Internal,
}

#[derive(Clone)]
pub struct Failure {
    pub code: ErrorCode,
    pub message: String,
}

pub fn fail(code: ErrorCode, message: impl Into<String>) -> Failure {
    Failure {
        code,
        message: message.into(),
    }
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
    },
}
