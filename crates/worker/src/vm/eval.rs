//! Running guest code: one eval (compile, run, drive microtasks, timers, and
//! host replies until its value settles), idle timers between evals, and the
//! results sent back.

use std::rc::Rc;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::value::RawValue;

use super::context::Shims;
use super::host_call::{apply_host_reply, Bridge};
use super::mailbox::Mailbox;
use super::watchdog::CpuClock;
use super::{pump_tasks, Output, VmMsg};
use super::errors;
use crate::proto::{fail, limit, ErrorCode, Failure, Out, ShimRef, Usage};

/// How often to look for V8's foreground tasks while it has background work
/// in flight and nothing else to wait for.
const BACKGROUND_POLL: Duration = Duration::from_millis(1);

/// Room left in a frame for everything around a guest-sized value.
const FRAME_SLACK: usize = 1 << 20;

pub(super) enum EvalEnd {
    Done(Result<String, Failure>),
    /// The supervisor disposed the VM while an eval waited on a host call.
    Disposed,
}

/// "Message\nstack" for thrown errors, or the value's string form, at most
/// `errors::TEXT_MAX` bytes (copied out of V8 no further than that).
pub(super) fn describe(scope: &mut v8::PinScope, exception: v8::Local<v8::Value>) -> String {
    if let Ok(obj) = v8::Local::<v8::Object>::try_from(exception) {
        let key = v8::String::new(scope, "stack").unwrap();
        if let Some(stack) = obj.get(scope, key.into()) {
            if stack.is_string() {
                return crate::js::string(scope, stack, errors::TEXT_MAX);
            }
        }
    }
    crate::js::text(scope, exception, errors::TEXT_MAX).unwrap_or_default()
}

/// `ERR_GUEST_EXCEPTION` for a thrown value: the one-line message ("stack"
/// or the value), plus the value described (see `errors::guest_error`).
fn guest_failure<'s>(scope: &mut v8::PinScope<'s, '_>, exception: v8::Local<'s, v8::Value>) -> Failure {
    let mut f = fail(ErrorCode::GuestException, describe(scope, exception));
    f.guest = Some(Box::new(errors::guest_error(scope, exception)));
    f
}

/// `ERR_GUEST_EXCEPTION` for code that didn't compile: with where, and the
/// stack (and message) saying so, since a SyntaxError has no frames.
fn compile_failure(tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>) -> Failure {
    let Some(exception) = tc.exception() else { return fail(ErrorCode::GuestException, "unknown error") };
    let mut f = guest_failure(tc, exception);
    let location = tc.message().and_then(|m| errors::compile_location(tc, m));
    if let (Some(guest), Some((location, caret))) = (f.guest.as_mut(), location) {
        errors::with_location(guest, location, &caret);
        f.message = clip(guest.stack.clone().unwrap_or_default());
    }
    f
}

/// `ERR_SHIM`: the embedder's shim failed, not the guest's code.
pub(super) fn shim_failure(shim: &ShimRef, what: String) -> Failure {
    let mut f = fail(ErrorCode::Shim, clip(format!("the {} shim {} {what}", shim.phase, shim.filename)));
    f.shim = Some(shim.clone());
    f
}

fn clip(s: String) -> String {
    crate::js::clip(s, errors::TEXT_MAX)
}

fn to_json(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Result<String, Failure> {
    if value.is_undefined() {
        return Ok("null".into());
    }
    v8::tc_scope!(let tc, scope);
    match v8::json::stringify(tc, value) {
        Some(s) => {
            // Measured before it's copied out, and never more than a frame
            // can carry (an oversized frame is a protocol violation).
            let max = crate::limits::get().result_bytes.min(crate::frame::MAX_FRAME - FRAME_SLACK);
            let len = s.utf8_length(tc);
            if len > max {
                return Err(limit(
                    "resultBytes",
                    format!("the result is {len} bytes as JSON, more than the {max}-byte limit (limits.resultBytes)"),
                ));
            }
            let s = s.to_rust_string_lossy(tc);
            Ok(if s == "undefined" { "null".into() } else { s })
        }
        None => {
            let msg = tc.exception().map(|e| crate::js::string(tc, e, errors::TEXT_MAX)).unwrap_or_default();
            Err(fail(ErrorCode::NotSerializable, msg))
        }
    }
}

/// Run one eval: the `before` shims, then compile and run the code, then
/// drive microtasks and host replies until the completion value (or the
/// promise it returned) settles; then each `after` shim the same way.
pub(super) fn eval(
    isolate: &mut v8::Isolate,
    context: &v8::Global<v8::Context>,
    shims: &Shims,
    code: &str,
    filename: Option<&str>,
    mailbox: &Mailbox,
    deadline: Option<Instant>,
) -> EvalEnd {
    v8::scope_with_context!(scope, isolate, context);
    v8::tc_scope!(let tc, scope);
    let end = run(tc, shims, code, filename.unwrap_or("eval.js"), mailbox, deadline);
    // Rejections the eval left without a handler, now that it's over.
    if !matches!(end, EvalEnd::Disposed) {
        tc.reset();
        errors::report_rejections(tc);
    }
    end
}

fn run(
    tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>,
    shims: &Shims,
    code: &str,
    filename: &str,
    mailbox: &Mailbox,
    deadline: Option<Instant>,
) -> EvalEnd {

    let guest_error = |tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>| match tc.exception() {
        Some(e) => guest_failure(tc, e),
        None => fail(ErrorCode::GuestException, "unknown error"),
    };

    crate::clock::advance();
    if let Some(bridge) = tc.get_slot::<Rc<Bridge>>() {
        bridge.log_budget.set(crate::limits::get().log_bytes);
    }
    let shim_threw = |tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>, at: &ShimRef| {
        let what = match tc.exception() {
            Some(e) => format!("threw: {}", describe(tc, e)),
            None => "failed".into(),
        };
        shim_failure(at, what)
    };
    for (script, at) in &shims.before {
        let script = v8::Local::new(tc, script);
        if script.run(tc).is_none() {
            return EvalEnd::Done(Err(shim_threw(tc, at)));
        }
    }
    let Some(source) = v8::String::new(tc, code) else {
        return EvalEnd::Done(Err(fail(ErrorCode::Internal, "source too large")));
    };
    let Some(name) = v8::String::new(tc, filename) else {
        return EvalEnd::Done(Err(fail(ErrorCode::Internal, "filename too large")));
    };
    let origin = v8::ScriptOrigin::new(tc, name.into(), 0, 0, false, 0, None, false, false, false, None);
    let Some(script) = v8::Script::compile(tc, source, Some(&origin)) else {
        return EvalEnd::Done(Err(compile_failure(tc)));
    };
    let Some(mut value) = script.run(tc) else {
        return EvalEnd::Done(Err(guest_error(tc)));
    };

    // What's settling: the guest's value (None), or `after` shim i's promise.
    let mut stage: Option<usize> = None;
    let mut result = value;
    loop {
        let settled = match v8::Local::<v8::Promise>::try_from(value) {
            Err(_) => {
                tc.perform_microtask_checkpoint();
                Ok(value)
            }
            Ok(promise) => match settle(tc, promise, mailbox, deadline) {
                Settled::Fulfilled => Ok(promise.result(tc)),
                Settled::Rejected => Err(promise.result(tc)),
                Settled::Failed(f) => {
                    let f = match stage {
                        Some(i) if f.code == ErrorCode::Unsettled => shim_failure(&shims.after[i].1, "never settled".into()),
                        _ => f,
                    };
                    return EvalEnd::Done(Err(f));
                }
                Settled::Disposed => return EvalEnd::Disposed,
            },
        };
        match (settled, stage) {
            (Err(e), None) => return EvalEnd::Done(Err(guest_failure(tc, e))),
            (Err(e), Some(i)) => {
                let what = format!("threw: {}", describe(tc, e));
                return EvalEnd::Done(Err(shim_failure(&shims.after[i].1, what)));
            }
            (Ok(v), None) => result = v,
            // An `after` shim's value replaces the result unless it's undefined.
            (Ok(v), Some(_)) if !v.is_undefined() => result = v,
            (Ok(_), Some(_)) => {}
        }
        let next = stage.map_or(0, |i| i + 1);
        let Some((func, at)) = shims.after.get(next) else {
            return EvalEnd::Done(to_json(tc, result));
        };
        let func = v8::Local::new(tc, func);
        let this = v8::undefined(tc).into();
        let Some(promise) = func.call(tc, this, &[result]) else {
            return EvalEnd::Done(Err(shim_threw(tc, at)));
        };
        value = promise;
        stage = Some(next);
    }
}

enum Settled {
    Fulfilled,
    Rejected,
    Failed(Failure),
    Disposed,
}

/// Drive microtasks, timers, and host replies until `promise` settles.
fn settle(
    tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>,
    promise: v8::Local<v8::Promise>,
    mailbox: &Mailbox,
    deadline: Option<Instant>,
) -> Settled {
    loop {
        tc.perform_microtask_checkpoint();
        if tc.has_terminated() {
            return Settled::Failed(limit("timeoutMs", "terminated"));
        }
        match promise.state() {
            v8::PromiseState::Fulfilled => return Settled::Fulfilled,
            v8::PromiseState::Rejected => {
                // Its rejection is the eval's (or shim's) result, not unhandled.
                errors::forget(tc, promise);
                return Settled::Rejected;
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
            return Settled::Failed(fail(
                ErrorCode::Unsettled,
                "promise never settled: there are no timers or I/O, only host functions",
            ));
        }
        // This task's microtasks have run: rejections still without a
        // handler are unhandled.
        errors::report_rejections(tc);
        // Wait for a host reply, the next timer, or (with V8 work in flight)
        // briefly, then look for its results.
        let left = deadline.map(|d| d.saturating_duration_since(Instant::now()));
        if left == Some(Duration::ZERO) {
            return Settled::Failed(limit("timeoutMs", "timed out waiting for a host function or timer"));
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
            Err(RecvTimeoutError::Disconnected) => return Settled::Disposed,
        };
        match msg {
            VmMsg::HostReply { call, reply } => apply_host_reply(tc, call, reply),
            VmMsg::Dispose => return Settled::Disposed,
            VmMsg::Eval { .. } => unreachable!("deferred by the mailbox"),
        }
    }
}

/// How long one batch of timers between evals runs before going back to
/// the mailbox, so evals and replies waiting for this isolate aren't held
/// up by a timer storm.
const IDLE_SLICE: std::time::Duration = std::time::Duration::from_millis(10);

/// Timers that came due between evals (a stateful isolate's setInterval, a
/// setTimeout left by an earlier eval): run them, each followed by its
/// microtasks, for up to `IDLE_SLICE` (the rest run in the next batch,
/// after any waiting messages), under the eval budgets capped by the
/// background budget (see `background`).
pub(super) fn run_idle_timers(scope: &mut v8::PinScope) {
    let start = std::time::Instant::now();
    loop {
        if scope.is_execution_terminating() || start.elapsed() >= IDLE_SLICE {
            return;
        }
        let ran = crate::web::timers::run_due_timer(scope);
        scope.perform_microtask_checkpoint();
        errors::report_rejections(scope);
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
            out.send(&Out::Result { req, ok: true, value: Some(&value), code: None, message: None, guest: None, limit: None, shim: None, usage });
        }
        Err(f) => out.send(&Out::Result {
            req,
            ok: false,
            value: None,
            code: Some(f.code),
            message: Some(&f.message),
            guest: f.guest.as_deref(),
            limit: f.limit,
            shim: f.shim.as_ref(),
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
