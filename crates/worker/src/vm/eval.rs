//! Running guest code: one eval (compile, run, drive microtasks, timers, and
//! host replies until its value settles), idle timers between evals, and the
//! results sent back.

use std::rc::Rc;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::value::RawValue;

use super::host_call::{apply_host_reply, Bridge};
use super::mailbox::Mailbox;
use super::watchdog::CpuClock;
use super::{pump_tasks, Output, VmMsg};
use crate::proto::{fail, limit, ErrorCode, Failure, GuestError, Out, Usage};

/// How often to look for V8's foreground tasks while it has background work
/// in flight and nothing else to wait for.
const BACKGROUND_POLL: Duration = Duration::from_millis(1);

/// Longest error text sent for a guest exception (its message, its stack):
/// a guest can throw an Error with any size of message.
const ERROR_TEXT_MAX: usize = 64 << 10;

pub(super) enum EvalEnd {
    Done(Result<String, Failure>),
    /// The supervisor disposed the VM while an eval waited on a host call.
    Disposed,
}

/// "Message\nstack" for thrown errors, or the value's string form.
pub(super) fn describe(scope: &mut v8::PinScope, exception: v8::Local<v8::Value>) -> String {
    if let Ok(obj) = v8::Local::<v8::Object>::try_from(exception) {
        let key = v8::String::new(scope, "stack").unwrap();
        if let Some(stack) = obj.get(scope, key.into()) {
            if stack.is_string() {
                return stack.to_rust_string_lossy(scope);
            }
        }
    }
    exception.to_rust_string_lossy(scope)
}

/// `ERR_GUEST_EXCEPTION` for a thrown value: the one-line message ("stack"
/// or the value), plus name/message/stack as separate fields.
fn guest_failure(scope: &mut v8::PinScope, exception: v8::Local<v8::Value>) -> Failure {
    let mut f = fail(ErrorCode::GuestException, clip(describe(scope, exception)));
    let get = |scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, key: &str| {
        let k = v8::String::new(scope, key).unwrap();
        obj.get(scope, k.into()).filter(|v| v.is_string()).map(|v| clip(v.to_rust_string_lossy(scope)))
    };
    f.guest = Some(match v8::Local::<v8::Object>::try_from(exception) {
        Ok(obj) => GuestError {
            name: get(scope, obj, "name"),
            message: get(scope, obj, "message").unwrap_or_else(|| clip(exception.to_rust_string_lossy(scope))),
            stack: get(scope, obj, "stack"),
        },
        Err(_) => GuestError { name: None, message: clip(exception.to_rust_string_lossy(scope)), stack: None },
    });
    f
}

fn clip(mut s: String) -> String {
    if s.len() > ERROR_TEXT_MAX {
        let mut cut = ERROR_TEXT_MAX;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push('…');
    }
    s
}

fn to_json(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Result<String, Failure> {
    if value.is_undefined() {
        return Ok("null".into());
    }
    v8::tc_scope!(let tc, scope);
    match v8::json::stringify(tc, value) {
        Some(s) => {
            let s = s.to_rust_string_lossy(tc);
            let max = crate::limits::get().result_bytes;
            if s.len() > max {
                return Err(limit(
                    "resultBytes",
                    format!("the result is {} bytes as JSON, more than the {max}-byte limit (limits.resultBytes)", s.len()),
                ));
            }
            Ok(if s == "undefined" { "null".into() } else { s })
        }
        None => {
            let msg = tc.exception().map(|e| e.to_rust_string_lossy(tc)).unwrap_or_default();
            Err(fail(ErrorCode::NotSerializable, msg))
        }
    }
}

/// Run one eval: compile, run, then drive microtasks and host replies until
/// the completion value (or the promise it returned) settles.
pub(super) fn eval(
    isolate: &mut v8::Isolate,
    context: &v8::Global<v8::Context>,
    code: &str,
    mailbox: &Mailbox,
    deadline: Option<Instant>,
) -> EvalEnd {
    v8::scope_with_context!(scope, isolate, context);
    v8::tc_scope!(let tc, scope);

    let guest_error = |tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>| match tc.exception() {
        Some(e) => guest_failure(tc, e),
        None => fail(ErrorCode::GuestException, "unknown error"),
    };

    crate::clock::advance();
    if let Some(bridge) = tc.get_slot::<Rc<Bridge>>() {
        bridge.log_budget.set(crate::limits::get().log_bytes);
    }
    let Some(source) = v8::String::new(tc, code) else {
        return EvalEnd::Done(Err(fail(ErrorCode::Internal, "source too large")));
    };
    let Some(script) = v8::Script::compile(tc, source, None) else {
        return EvalEnd::Done(Err(guest_error(tc)));
    };
    let Some(result) = script.run(tc) else {
        return EvalEnd::Done(Err(guest_error(tc)));
    };

    let Ok(promise) = v8::Local::<v8::Promise>::try_from(result) else {
        tc.perform_microtask_checkpoint();
        return EvalEnd::Done(to_json(tc, result));
    };

    loop {
        tc.perform_microtask_checkpoint();
        if tc.has_terminated() {
            return EvalEnd::Done(Err(limit("timeoutMs", "terminated")));
        }
        match promise.state() {
            v8::PromiseState::Fulfilled => {
                let v = promise.result(tc);
                return EvalEnd::Done(to_json(tc, v));
            }
            v8::PromiseState::Rejected => {
                let e = promise.result(tc);
                return EvalEnd::Done(Err(guest_failure(tc, e)));
            }
            v8::PromiseState::Pending => {}
        }
        if pump_tasks(tc) {
            continue;
        }
        // One due timer per turn, then microtasks again.
        if crate::web::timers::run_due_timer(tc) {
            continue;
        }
        let waiting = tc.get_slot::<Rc<Bridge>>().map(|b| !b.pending.borrow().is_empty()).unwrap_or(false);
        let background = tc.has_pending_background_tasks();
        let timer = crate::web::timers::next_timer();
        // Only ref'd timers keep a pending eval waiting (AbortSignal.timeout
        // without listeners doesn't).
        let timers = timer.is_some_and(|(_, refed)| refed);
        if !waiting && !background && !timers {
            return EvalEnd::Done(Err(fail(
                ErrorCode::Unsettled,
                "promise never settled: there are no timers or I/O, only host functions",
            )));
        }
        // Wait for a host reply, the next timer, or (with V8 work in flight)
        // briefly, then look for its results.
        let left = deadline.map(|d| d.saturating_duration_since(Instant::now()));
        if left == Some(Duration::ZERO) {
            return EvalEnd::Done(Err(limit("timeoutMs", "timed out waiting for a host function or timer")));
        }
        let mut wait = left;
        if background {
            wait = Some(wait.map_or(BACKGROUND_POLL, |w| w.min(BACKGROUND_POLL)));
        }
        if let Some((due, _)) = timer {
            wait = Some(wait.map_or(due, |w| w.min(due)));
        }
        let msg = match mailbox.during_eval(wait) {
            Ok(m) => m,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return EvalEnd::Disposed,
        };
        match msg {
            VmMsg::HostReply { call, reply } => apply_host_reply(tc, call, reply),
            VmMsg::Dispose => return EvalEnd::Disposed,
            VmMsg::Eval { .. } => unreachable!("deferred by the mailbox"),
        }
    }
}

/// Timers that came due between evals (a stateful isolate's setInterval, a
/// setTimeout left by an earlier eval): run them, each followed by its
/// microtasks, under the same budget as an eval.
pub(super) fn run_idle_timers(scope: &mut v8::PinScope) {
    loop {
        if scope.is_execution_terminating() {
            return;
        }
        let ran = crate::web::timers::run_due_timer(scope);
        scope.perform_microtask_checkpoint();
        let pumped = pump_tasks(scope);
        if !ran && !pumped {
            return;
        }
    }
}

/// A VM that couldn't start: fail its evals until it is disposed.
pub(super) fn refuse_all(rx: &Receiver<VmMsg>, out: &Output, cause: String) {
    while let Ok(msg) = rx.recv() {
        match msg {
            VmMsg::Eval { req, .. } => send_result(out, req, Err(limit("workerMemoryBytes", cause.clone())), Usage::default()),
            VmMsg::HostReply { .. } => {}
            VmMsg::Dispose => return,
        }
    }
}

pub(super) fn send_result(out: &Output, req: u64, result: Result<String, Failure>, usage: Usage) {
    // A result too large for a frame fails the eval (an oversized frame
    // would read as a protocol violation).
    let result = match result {
        Ok(json) if !crate::frame::fits(json.len() + 256, 0) => {
            Err(fail(ErrorCode::NotSerializable, "the result is larger than 64 MiB as JSON"))
        }
        r => r,
    };
    match result {
        Ok(json) => {
            let value = RawValue::from_string(json).expect("V8 produced JSON");
            out.send(&Out::Result { req, ok: true, value: Some(&value), code: None, message: None, guest: None, limit: None, usage });
        }
        Err(f) => out.send(&Out::Result {
            req,
            ok: false,
            value: None,
            code: Some(f.code),
            message: Some(&f.message),
            guest: f.guest.as_ref(),
            limit: f.limit,
            usage,
        }),
    }
}

/// CPU since `start` (on `clock`) and the isolate's memory now.
pub(super) fn usage(isolate: &mut v8::Isolate, clock: Option<CpuClock>, start: Duration) -> Usage {
    let heap = isolate.get_heap_statistics();
    Usage {
        cpu_us: clock.map(|c| c.now().saturating_sub(start).as_micros() as u64),
        heap_bytes: Some(heap.used_heap_size() as u64),
        external_bytes: Some(heap.external_memory() as u64),
    }
}
