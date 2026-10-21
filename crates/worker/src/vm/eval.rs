//! Running guest code: one eval (compile and run code, load a program, or
//! call a function the isolate defined; then drive microtasks, timers, and
//! host replies until its value settles), idle timers between evals, and
//! the results sent back.

use std::rc::Rc;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::value::RawValue;

use super::context::Shims;
use super::errors;
use super::host_call::{apply_host_reply, Bridge};
use super::mailbox::Mailbox;
use super::module::{self, Handler, LoadError};
use super::watchdog::CpuClock;
use super::{pump_tasks, Job, Output, VmMsg};
use crate::js;
use crate::proto::{fail, limit, CallKind, ErrorCode, Failure, Out, ShimRef, Usage};
use crate::web::timers::NextTimer;

/// How often to look for V8's foreground tasks while it has background work
/// in flight and nothing else to wait for.
const BACKGROUND_POLL: Duration = Duration::from_millis(1);

/// Room left in a frame for everything around a guest-sized value.
const FRAME_SLACK: usize = 1 << 20;

pub(super) enum EvalEnd {
    Done(Result<Outcome, Failure>),
    /// The supervisor disposed the VM while an eval waited on a host call.
    Disposed,
}

/// What an eval's value settled to, ready to send.
pub(super) enum Outcome {
    /// JSON text.
    Json(String),
    /// A call's result that is bytes (an ArrayBuffer or a view of one).
    Bytes(Vec<u8>),
    /// A fetch call's result: the Response's head (JSON) and its body.
    Response { head: String, body: Vec<u8> },
}

/// "Message\nstack" for thrown errors, or the value's string form, at most
/// `errors::TEXT_MAX` bytes (copied out of V8 no further than that).
pub(super) fn describe(scope: &mut v8::PinScope, exception: v8::Local<v8::Value>) -> String {
    if let Ok(obj) = v8::Local::<v8::Object>::try_from(exception) {
        let key = js::short_string(scope, "stack");
        if let Some(stack) = obj.get(scope, key.into()) {
            if stack.is_string() {
                return js::string(scope, stack, errors::TEXT_MAX);
            }
        }
    }
    js::text(scope, exception, errors::TEXT_MAX).unwrap_or_default()
}

/// `ERR_GUEST_EXCEPTION` for a thrown value: the one-line message ("stack"
/// or the value), plus the value described (see `errors::guest_error`).
fn guest_failure<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    exception: v8::Local<'s, v8::Value>,
) -> Failure {
    let mut f = fail(ErrorCode::GuestException, describe(scope, exception));
    f.guest = Some(Box::new(errors::guest_error(scope, exception)));
    f
}

/// `ERR_GUEST_EXCEPTION` for code that didn't compile: with where, and the
/// stack (and message) saying so, since a SyntaxError has no frames.
fn compile_failure(tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>) -> Failure {
    let Some(exception) = tc.exception() else {
        return fail(ErrorCode::GuestException, "unknown error");
    };
    let mut f = guest_failure(tc, exception);
    let location = tc.message().and_then(|m| errors::compile_location(tc, m));
    if let (Some(guest), Some((location, caret))) = (f.guest.as_mut(), location) {
        errors::with_location(guest, location, &caret);
        f.message = clip(guest.stack.clone().unwrap_or_default());
    }
    f
}

/// `ERR_GUEST_EXCEPTION` for a program that didn't load: with where, for a
/// module that didn't compile.
fn load_failure(tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>) -> Failure {
    let Some(exception) = tc.exception() else {
        return fail(ErrorCode::GuestException, "unknown error");
    };
    let mut f = guest_failure(tc, exception);
    if let (Some(guest), Some((location, caret))) = (f.guest.as_mut(), module::take_failed_at(tc)) {
        errors::with_location(guest, location, &caret);
        f.message = clip(guest.stack.clone().unwrap_or_default());
    }
    f
}

/// `ERR_SHIM`: the embedder's shim failed, not the guest's code.
pub(super) fn shim_failure(shim: &ShimRef, what: String) -> Failure {
    let mut f = fail(
        ErrorCode::Shim,
        clip(format!("the {} shim {} {what}", shim.phase, shim.filename)),
    );
    f.shim = Some(shim.clone());
    f
}

fn clip(s: String) -> String {
    js::clip(s, errors::TEXT_MAX)
}

/// The function a call names: an own property of the global object (a
/// classic script's function declaration, or one set on `globalThis`), not
/// one inherited from its prototypes, and not one of isolane's own
/// (`__isolane_*`). Ok(None) if there is no such function; Err if reading
/// the property threw (a getter), with the exception caught.
///
/// A VM with a program looks among its exports instead (`module::handler`).
fn handler<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    name: &str,
) -> Result<Option<v8::Local<'s, v8::Function>>, ()> {
    if name.starts_with("__isolane_") {
        return Ok(None);
    }
    let Some(key) = v8::String::new(scope, name) else {
        return Ok(None);
    };
    let global = scope.get_current_context().global(scope);
    if global.has_own_property(scope, key.into()) != Some(true) {
        return Ok(None);
    }
    let Some(value) = global.get(scope, key.into()) else {
        return Err(());
    };
    Ok(v8::Local::<v8::Function>::try_from(value).ok())
}

/// A call's result: bytes as they are, anything else as JSON. Bytes count
/// against `limits.resultBytes` as JSON does.
fn to_outcome(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Result<Outcome, Failure> {
    let max = crate::limits::get()
        .result_bytes
        .min(crate::frame::MAX_FRAME - FRAME_SLACK);
    match crate::bytes::copy_bytes_max(scope, value, max) {
        Some(Ok(bytes)) => Ok(Outcome::Bytes(bytes)),
        Some(Err(len)) => Err(limit(
            "resultBytes",
            format!(
                "the result is {len} bytes, more than the {max}-byte limit (limits.resultBytes)"
            ),
        )),
        None => to_json(scope, value).map(Outcome::Json),
    }
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
            let max = crate::limits::get()
                .result_bytes
                .min(crate::frame::MAX_FRAME - FRAME_SLACK);
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
            let msg = tc
                .exception()
                .map(|e| js::string(tc, e, errors::TEXT_MAX))
                .unwrap_or_default();
            Err(fail(ErrorCode::NotSerializable, msg))
        }
    }
}

/// Run one eval: the `before` shims, then compile and run the code (or call
/// the function), then drive microtasks and host replies until the
/// completion value (or the promise it returned) settles; then each `after`
/// shim the same way.
pub(super) fn eval(
    isolate: &mut v8::Isolate,
    context: &v8::Global<v8::Context>,
    shims: &Shims,
    job: &Job,
    mailbox: &Mailbox,
    deadline: Option<Instant>,
) -> EvalEnd {
    v8::scope_with_context!(scope, isolate, context);
    v8::tc_scope!(let tc, scope);
    let end = run(tc, shims, job, mailbox, deadline);
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
    job: &Job,
    mailbox: &Mailbox,
    deadline: Option<Instant>,
) -> EvalEnd {
    let mut flight = match start(tc, shims, job) {
        Ok(flight) => flight,
        Err(f) => return EvalEnd::Done(Err(f)),
    };
    loop {
        if let Some(result) = flight.advance(tc, shims) {
            return EvalEnd::Done(result);
        }
        let Some(promise) = flight.promise(tc) else {
            return EvalEnd::Done(Err(fail(ErrorCode::Internal, "nothing to settle")));
        };
        match settle(tc, promise, mailbox, deadline) {
            Settled::Fulfilled | Settled::Rejected => {}
            Settled::Failed(f) => return EvalEnd::Done(Err(flight.failed(f, shims))),
            Settled::Disposed => return EvalEnd::Disposed,
        }
    }
}

/// `ERR_GUEST_EXCEPTION` for the exception `tc` caught.
fn caught(tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>) -> Failure {
    match tc.exception() {
        Some(e) => guest_failure(tc, e),
        None => fail(ErrorCode::GuestException, "unknown error"),
    }
}

/// `ERR_SHIM` for the exception `tc` caught in shim `at`.
fn shim_threw(tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>, at: &ShimRef) -> Failure {
    let what = match tc.exception() {
        Some(e) => format!("threw: {}", describe(tc, e)),
        None => "failed".into(),
    };
    shim_failure(at, what)
}

/// Start one eval: advance the clock, run the `before` shims, then compile
/// and run the code (or load the program, or call the function). Returns
/// what it started, to settle (`Flight::advance`).
pub(super) fn start(
    tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>,
    shims: &Shims,
    job: &Job,
) -> Result<Flight, Failure> {
    crate::clock::advance();
    if let Some(bridge) = tc.get_slot::<Rc<Bridge>>() {
        bridge.log_budget.set(crate::limits::get().log_bytes);
    }
    // A program's setup runs without the eval shims (they run around its
    // calls), and so does waiting for its ctx.waitUntil work.
    let setup = matches!(job, Job::Module { .. });
    let drain = matches!(
        job,
        Job::Call {
            kind: CallKind::Drain,
            ..
        }
    );
    let shimless = setup || drain;
    if !shimless {
        for (script, at) in &shims.before {
            let script = v8::Local::new(tc, script);
            if script.run(tc).is_none() {
                return Err(shim_threw(tc, at));
            }
        }
    }
    let value: v8::Local<v8::Value> = match job {
        Job::Code { code, filename } => {
            let Some(source) = v8::String::new(tc, code) else {
                return Err(fail(ErrorCode::Internal, "source too large"));
            };
            let Some(name) = v8::String::new(tc, filename.as_deref().unwrap_or("eval.js")) else {
                return Err(fail(ErrorCode::Internal, "filename too large"));
            };
            let origin = v8::ScriptOrigin::new(
                tc,
                name.into(),
                0,
                0,
                false,
                0,
                None,
                false,
                false,
                false,
                None,
            );
            let Some(script) = v8::Script::compile(tc, source, Some(&origin)) else {
                return Err(compile_failure(tc));
            };
            let Some(value) = script.run(tc) else {
                return Err(caught(tc));
            };
            value
        }
        Job::Module {
            main,
            files,
            options,
        } => match module::load(tc, main, files, options) {
            Ok(value) => value,
            Err(LoadError::Threw) => return Err(load_failure(tc)),
            Err(LoadError::Failed(f)) => return Err(f),
        },
        Job::Call {
            name,
            args,
            bytes,
            kind,
            ..
        } => {
            let argv = call_args(tc, args, bytes)?;
            let started = match kind {
                CallKind::Export => match find_handler(tc, name) {
                    Ok((handler, this)) => handler.call(tc, this, &argv).map(Some).ok_or(()),
                    Err(Some(f)) => return Err(f),
                    Err(None) => Err(()),
                },
                CallKind::Fetch => match module::handler(tc, "fetch") {
                    Ok(Handler::Found(handler, this)) => {
                        let undefined: v8::Local<v8::Value> = v8::undefined(tc).into();
                        let head = argv.first().copied().unwrap_or(undefined);
                        let body = argv.get(1).copied().unwrap_or(undefined);
                        module::serve(tc, (handler, this), head, body)
                    }
                    Ok(Handler::Missing) => {
                        let message = "the program has no fetch handler: export a function named fetch, or a default export with a fetch method";
                        return Err(fail(ErrorCode::HandlerNotFound, message));
                    }
                    Ok(Handler::NoProgram) => {
                        return Err(fail(ErrorCode::Internal, "a fetch call needs a program"));
                    }
                    Err(()) => Err(()),
                },
                CallKind::Drain => module::drain(tc),
            };
            match started {
                Ok(Some(value)) => value,
                Ok(None) => return Err(no_web()),
                Err(()) => return Err(caught(tc)),
            }
        }
    };
    let (call, max_body) = match job {
        Job::Call { kind, max_body, .. } => (Some(*kind), *max_body),
        _ => (None, 0),
    };
    Ok(Flight {
        value: v8::Global::new(tc, value),
        result: v8::Global::new(tc, value),
        stage: Stage::Guest,
        call,
        max_body,
        setup,
        shimless,
    })
}

fn no_web() -> Failure {
    fail(ErrorCode::Internal, "a fetch call needs the web platform")
}

/// An eval in flight: the value (or promise) it waits on, and the stage it
/// is in. Handles are global, so a flight outlives the scope it started in
/// (concurrent calls keep theirs between turns).
pub(super) struct Flight {
    /// What's settling now.
    value: v8::Global<v8::Value>,
    /// The result so far: the guest's value, as the `after` shims leave it.
    result: v8::Global<v8::Value>,
    stage: Stage,
    /// For a call, what kind; and a fetch call's body limit.
    call: Option<CallKind>,
    max_body: u64,
    /// A program's setup.
    setup: bool,
    /// Runs without the eval shims (a setup, or a drain).
    shimless: bool,
}

impl Flight {
    fn after<'a>(&self, shims: &'a Shims) -> &'a [(v8::Global<v8::Function>, ShimRef)] {
        if self.shimless {
            &[]
        } else {
            &shims.after
        }
    }

    /// The promise the flight waits on, if it does.
    pub(super) fn promise<'s>(
        &self,
        scope: &mut v8::PinScope<'s, '_>,
    ) -> Option<v8::Local<'s, v8::Promise>> {
        let value = v8::Local::new(scope, &self.value);
        v8::Local::<v8::Promise>::try_from(value).ok()
    }

    /// `f`, a failure while waiting, as this flight's (an `after` shim that
    /// never settled is the shim's failure).
    pub(super) fn failed(&self, f: Failure, shims: &Shims) -> Failure {
        match self.stage {
            Stage::After(i) if f.code == ErrorCode::Unsettled => {
                shim_failure(&self.after(shims)[i].1, "never settled".into())
            }
            _ => f,
        }
    }

    /// Go through every stage whose value has settled: the guest's value,
    /// then each `after` shim, then (for a fetch call) reading the
    /// Response. Some(result) once done; None while its promise is pending.
    pub(super) fn advance(
        &mut self,
        tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>,
        shims: &Shims,
    ) -> Option<Result<Outcome, Failure>> {
        let after = self.after(shims);
        loop {
            let value = v8::Local::new(tc, &self.value);
            let settled = match v8::Local::<v8::Promise>::try_from(value) {
                Err(_) => {
                    tc.perform_microtask_checkpoint();
                    Ok(value)
                }
                Ok(promise) => match promise.state() {
                    v8::PromiseState::Pending => return None,
                    v8::PromiseState::Fulfilled => Ok(promise.result(tc)),
                    v8::PromiseState::Rejected => {
                        // Its rejection is the eval's (or shim's) result, not unhandled.
                        errors::forget(tc, promise);
                        Err(promise.result(tc))
                    }
                },
            };
            let mut result = v8::Local::new(tc, &self.result);
            match (settled, self.stage) {
                (Err(e), Stage::Guest | Stage::Finish) => return Some(Err(guest_failure(tc, e))),
                (Err(e), Stage::After(i)) => {
                    let what = format!("threw: {}", describe(tc, e));
                    return Some(Err(shim_failure(&after[i].1, what)));
                }
                (Ok(v), Stage::Guest | Stage::Finish) => result = v,
                // An `after` shim's value replaces the result unless it's undefined.
                (Ok(v), Stage::After(_)) if !v.is_undefined() => result = v,
                (Ok(_), Stage::After(_)) => {}
            }
            self.result = v8::Global::new(tc, result);
            let next = match self.stage {
                Stage::Guest => Some(0),
                Stage::After(i) => Some(i + 1),
                Stage::Finish => None,
            };
            if let Some((i, (func, at))) = next.and_then(|i| after.get(i).map(|shim| (i, shim))) {
                self.stage = Stage::After(i);
                let func = v8::Local::new(tc, func);
                let this: v8::Local<v8::Value> = v8::undefined(tc).into();
                let Some(promise) = func.call(tc, this, &[result]) else {
                    return Some(Err(shim_threw(tc, at)));
                };
                self.value = v8::Global::new(tc, promise);
                continue;
            }
            // A fetch call reads the Response (as the shims left it) last.
            if self.call == Some(CallKind::Fetch) && self.stage != Stage::Finish {
                let promise = match module::finish(tc, result, self.max_body as f64) {
                    Ok(Some(promise)) => promise,
                    Ok(None) => return Some(Err(no_web())),
                    Err(()) => return Some(Err(caught(tc))),
                };
                self.stage = Stage::Finish;
                self.value = v8::Global::new(tc, promise);
                continue;
            }
            if self.setup {
                module::loaded(tc);
                return Some(Ok(Outcome::Json("null".into())));
            }
            return Some(match self.call {
                Some(CallKind::Fetch) => to_response(tc, result, self.max_body),
                Some(CallKind::Drain) => Ok(Outcome::Json("null".into())),
                Some(CallKind::Export) => to_outcome(tc, result),
                None => to_json(tc, result).map(Outcome::Json),
            });
        }
    }
}

/// Where a flight is.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    /// The guest's own value: the code's, or the handler's.
    Guest,
    /// `after` shim i's promise.
    After(usize),
    /// A fetch call's Response, being read for the host.
    Finish,
}

/// A call's arguments: `args` (a JSON array) parsed in the context, with
/// the byte arguments as Uint8Arrays at their indices.
fn call_args<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    args: &str,
    bytes: &[(u32, Vec<u8>)],
) -> Result<Vec<v8::Local<'s, v8::Value>>, Failure> {
    let parsed = v8::String::new(scope, args).and_then(|s| v8::json::parse(scope, s));
    let Some(array) = parsed.and_then(|v| v8::Local::<v8::Array>::try_from(v).ok()) else {
        return Err(fail(
            ErrorCode::Internal,
            "call arguments are not a JSON array",
        ));
    };
    let mut argv: Vec<v8::Local<v8::Value>> = Vec::with_capacity(array.length() as usize);
    for i in 0..array.length() {
        let arg = array
            .get_index(scope, i)
            .unwrap_or_else(|| v8::undefined(scope).into());
        argv.push(arg);
    }
    for (index, data) in bytes {
        if let Some(slot) = argv.get_mut(*index as usize) {
            *slot = crate::bytes::new_u8array(scope, data).into();
        }
    }
    Ok(argv)
}

/// The function a call names, and its `this`: among a program's exports
/// (`module::handler`), or on the global object (`handler`). Err(Some) if
/// there is none; Err(None) if looking it up threw (the exception caught).
fn find_handler<'s>(
    tc: &mut v8::PinScope<'s, '_>,
    name: &str,
) -> Result<(v8::Local<'s, v8::Function>, v8::Local<'s, v8::Value>), Option<Failure>> {
    let found = match module::handler(tc, name) {
        Ok(Handler::NoProgram) => handler(tc, name)
            .map(|global| global.map(|function| (function, v8::undefined(tc).into()))),
        Ok(Handler::Found(function, this)) => Ok(Some((function, this))),
        Ok(Handler::Missing) => {
            let message = format!("the program has no export named {name}, and its default export no method named {name}");
            return Err(Some(fail(ErrorCode::HandlerNotFound, clip(message))));
        }
        Err(()) => Err(()),
    };
    match found {
        Ok(Some(found)) => Ok(found),
        Ok(None) => {
            let message = format!("the isolate has no function named {name}: define it with a function declaration or on globalThis");
            Err(Some(fail(ErrorCode::HandlerNotFound, clip(message))))
        }
        Err(()) => Err(None),
    }
}

/// A fetch call's result: the Response's head as JSON, and its body. Past
/// `max_body` bytes, `limits.bodyBytes`.
fn to_response(
    scope: &mut v8::PinScope,
    value: v8::Local<v8::Value>,
    max_body: u64,
) -> Result<Outcome, Failure> {
    let Ok(object) = v8::Local::<v8::Object>::try_from(value) else {
        return Err(fail(ErrorCode::Internal, "the response is not an object"));
    };
    let too_large = js::short_string(scope, "tooLarge");
    if let Some(length) = object
        .get(scope, too_large.into())
        .filter(|v| v.is_number())
    {
        let length = length.number_value(scope).unwrap_or(0.0);
        return Err(limit(
            "bodyBytes",
            format!("the response's body is more than {max_body} bytes ({length} so far; limits.bodyBytes)"),
        ));
    }
    let key = js::short_string(scope, "body");
    let body = object.get(scope, key.into());
    let Some(Some(Ok(bytes))) =
        body.map(|b| crate::bytes::copy_bytes_max(scope, b, max_body as usize))
    else {
        return Err(fail(
            ErrorCode::Internal,
            "the response's body is not bytes",
        ));
    };
    object.delete(scope, key.into());
    let head = to_json(scope, object.into())?;
    Ok(Outcome::Response { head, body: bytes })
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
        // The watchdog may have fired while no JavaScript ran (an abort
        // while waiting), so the termination hasn't landed yet.
        if tc.has_terminated() || super::out_of_time() {
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
        let waiting = tc
            .get_slot::<Rc<Bridge>>()
            .map(|b| !b.pending.borrow().is_empty())
            .unwrap_or(false);
        let background = tc.has_pending_background_tasks();
        let timer = crate::web::timers::next_timer();
        // Only ref'd timers keep a pending eval waiting (AbortSignal.timeout
        // without listeners doesn't).
        let timers = timer.is_some_and(|timer| timer.refed);
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
            return Settled::Failed(limit(
                "timeoutMs",
                "timed out waiting for a host function or timer",
            ));
        }
        let mut wait = left;
        if background {
            wait = Some(wait.map_or(BACKGROUND_POLL, |w| w.min(BACKGROUND_POLL)));
        }
        if let Some(NextTimer { due, .. }) = timer {
            wait = Some(wait.map_or(due, |w| w.min(due)));
        }
        let msg = match mailbox.during_eval(wait) {
            Ok(m) => m,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return Settled::Disposed,
        };
        match msg {
            VmMsg::HostReply { call, reply } => apply_host_reply(tc, call, reply),
            VmMsg::Wake => {}
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
pub(super) fn refuse_all(id: u64, rx: &Receiver<VmMsg>, out: &Output, cause: String) {
    while let Ok(msg) = rx.recv() {
        match msg {
            VmMsg::Eval { req, .. } => send_result(
                out,
                (id, req),
                Err(limit("workerMemoryBytes", cause.clone())),
                Usage::default(),
                None,
            ),
            VmMsg::HostReply { .. } | VmMsg::Wake => {}
            VmMsg::Dispose => return,
        }
    }
}

/// Send eval `req`'s result (`vm` is its isolate). `retired`: what the
/// isolate's later evals fail with, if it is retired.
pub(super) fn send_result(
    out: &Output,
    (vm, req): (u64, u64),
    result: Result<Outcome, Failure>,
    usage: Usage,
    retired: Option<&Failure>,
) {
    // A result too large for a frame fails the eval (an oversized frame
    // would read as a protocol violation).
    let result = match result {
        Ok(Outcome::Json(json)) if !crate::frame::fits(json.len() + 1024, 0) => Err(fail(
            ErrorCode::NotSerializable,
            "the result is larger than 64 MiB as JSON",
        )),
        Ok(Outcome::Bytes(bytes)) if !crate::frame::fits(1024, bytes.len()) => Err(fail(
            ErrorCode::NotSerializable,
            "the result is larger than 64 MiB",
        )),
        Ok(Outcome::Response { head, body })
            if !crate::frame::fits(head.len() + 1024, body.len()) =>
        {
            Err(fail(
                ErrorCode::NotSerializable,
                "the response is larger than 64 MiB",
            ))
        }
        r => r,
    };
    let retired = retired.map(|f| f.message.as_str());
    match result {
        Ok(Outcome::Json(json)) => {
            let value = RawValue::from_string(json).expect("V8 produced JSON");
            out.send(&Out::Result {
                vm,
                req,
                ok: true,
                value: Some(&value),
                bin: None,
                retired,
                code: None,
                message: None,
                guest: None,
                limit: None,
                shim: None,
                usage,
            });
        }
        Ok(Outcome::Bytes(bytes)) => {
            let msg = Out::Result {
                vm,
                req,
                ok: true,
                value: None,
                bin: Some(bytes.len()),
                retired,
                code: None,
                message: None,
                guest: None,
                limit: None,
                shim: None,
                usage,
            };
            out.send_with_bytes(&msg, &[&bytes]);
        }
        Ok(Outcome::Response { head, body }) => {
            let value = RawValue::from_string(head).expect("V8 produced JSON");
            let msg = Out::Result {
                vm,
                req,
                ok: true,
                value: Some(&value),
                bin: Some(body.len()),
                retired,
                code: None,
                message: None,
                guest: None,
                limit: None,
                shim: None,
                usage,
            };
            out.send_with_bytes(&msg, &[&body]);
        }
        Err(f) => out.send(&Out::Result {
            vm,
            req,
            ok: false,
            value: None,
            bin: None,
            retired,
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
