//! Guest errors as the supervisor sees them, and errors nothing handled.
//!
//! - `guest_error`: a thrown value's name, message, and stack, plus its
//!   `cause` chain, an AggregateError's `errors`, and its own enumerable
//!   JSON properties (like `code`), every part bounded
//! - `compile_location`: where code failed to compile, with the source line
//!   and a caret, for SyntaxErrors (which have no stack frames)
//! - `attribute`: a failed host call's error, with the guest's stack from
//!   where it made the call and a frame naming the host function
//! - uncaught exceptions (timers, tasks) and unhandled rejections: logged,
//!   and sent as `guestError` frames

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;

use serde_json::value::RawValue;

use super::console::guest_log;
use super::host_call::Bridge;
use crate::proto::{GuestError, Location, Out};
use crate::js;

/// Longest text sent for one part (message, stack) of a thrown value: a
/// guest can throw an Error with any size of message.
pub(super) const TEXT_MAX: usize = 64 << 10;
/// The same, for the errors inside it (causes, an AggregateError's).
const NESTED_TEXT_MAX: usize = 8 << 10;
/// How deep a `cause` chain is followed.
const MAX_DEPTH: usize = 8;
/// Errors described in all, the thrown one included.
const MAX_NODES: usize = 32;
/// An AggregateError's errors described, at most.
const MAX_ERRORS: usize = 16;
/// Own properties sent per error, and each one's JSON size, at most.
const MAX_PROPERTIES: usize = 16;
const PROPERTY_BYTES: usize = 4 << 10;
const KEY_BYTES: usize = 128;
/// Characters of a source line shown around a compile error.
const SOURCE_WINDOW: usize = 240;
/// Unhandled rejections remembered at once (until they're reported).
const MAX_REJECTIONS: usize = 1000;

fn get<'s>(scope: &mut v8::PinScope<'s, '_>, obj: v8::Local<'s, v8::Object>, key: &str) -> Option<v8::Local<'s, v8::Value>> {
    let key = v8::String::new(scope, key)?;
    v8::tc_scope!(let tc, scope);
    let v = obj.get(tc, key.into());
    if tc.has_caught() {
        tc.reset();
        return None;
    }
    v
}

fn has_own<'s>(scope: &mut v8::PinScope<'s, '_>, obj: v8::Local<'s, v8::Object>, key: &str) -> bool {
    let Some(key) = v8::String::new(scope, key) else { return false };
    v8::tc_scope!(let tc, scope);
    let has = obj.has_own_property(tc, key.into()).unwrap_or(false);
    if tc.has_caught() {
        tc.reset();
        return false;
    }
    has
}

fn string_prop<'s>(scope: &mut v8::PinScope<'s, '_>, obj: v8::Local<'s, v8::Object>, key: &str, max: usize) -> Option<String> {
    get(scope, obj, key).filter(|v| v.is_string()).and_then(|v| js::text(scope, v, max))
}

/// The thrown `value`, described for the supervisor.
pub(super) fn guest_error<'s>(scope: &mut v8::PinScope<'s, '_>, value: v8::Local<'s, v8::Value>) -> GuestError {
    described(scope, value, TEXT_MAX)
}

/// `guest_error` with each part of the thrown value at most `max` bytes.
fn described<'s>(scope: &mut v8::PinScope<'s, '_>, value: v8::Local<'s, v8::Value>, max: usize) -> GuestError {
    let mut nodes = MAX_NODES;
    node(scope, value, 0, max, &mut nodes)
}

fn node<'s>(scope: &mut v8::PinScope<'s, '_>, value: v8::Local<'s, v8::Value>, depth: usize, top: usize, nodes: &mut usize) -> GuestError {
    *nodes = nodes.saturating_sub(1);
    let max = if depth == 0 { top } else { NESTED_TEXT_MAX.min(top) };
    let Ok(obj) = v8::Local::<v8::Object>::try_from(value) else {
        return GuestError { message: js::text(scope, value, max).unwrap_or_default(), ..Default::default() };
    };
    if scope.is_execution_terminating() {
        return GuestError { message: "(terminated)".into(), ..Default::default() };
    }
    let name = string_prop(scope, obj, "name", max);
    let message = string_prop(scope, obj, "message", max).or_else(|| js::text(scope, value, max)).unwrap_or_default();
    let stack = string_prop(scope, obj, "stack", max);
    let mut cause = None;
    if depth + 1 < MAX_DEPTH && *nodes > 0 && has_own(scope, obj, "cause") {
        if let Some(c) = get(scope, obj, "cause") {
            cause = Some(Box::new(node(scope, c, depth + 1, top, nodes)));
        }
    }
    let mut errors = None;
    if obj.is_native_error() && depth + 1 < MAX_DEPTH && has_own(scope, obj, "errors") {
        if let Some(arr) = get(scope, obj, "errors").and_then(|v| v8::Local::<v8::Array>::try_from(v).ok()) {
            let mut list = Vec::new();
            for i in 0..arr.length().min(MAX_ERRORS as u32) {
                if *nodes == 0 {
                    break;
                }
                let item = {
                    v8::tc_scope!(let tc, scope);
                    let item = arr.get_index(tc, i);
                    if tc.has_caught() {
                        tc.reset();
                    }
                    item
                };
                if let Some(item) = item {
                    list.push(node(scope, item, depth + 1, top, nodes));
                }
            }
            errors = Some(list);
        }
    }
    let properties = properties(scope, obj);
    GuestError { name, message, stack, location: None, cause, errors, properties }
}

/// Own enumerable string-keyed properties other than the ones described
/// separately, whose values are JSON (and small): `code`, `status`, ...
fn properties<'s>(scope: &mut v8::PinScope<'s, '_>, obj: v8::Local<'s, v8::Object>) -> Option<BTreeMap<String, Box<RawValue>>> {
    let args = v8::GetPropertyNamesArgs {
        mode: v8::KeyCollectionMode::OwnOnly,
        property_filter: v8::PropertyFilter::ONLY_ENUMERABLE | v8::PropertyFilter::SKIP_SYMBOLS,
        index_filter: v8::IndexFilter::SkipIndices,
        key_conversion: v8::KeyConversionMode::ConvertToString,
    };
    let names = {
        v8::tc_scope!(let tc, scope);
        let names = obj.get_own_property_names(tc, args);
        if tc.has_caught() {
            tc.reset();
        }
        names
    }?;
    let mut out = BTreeMap::new();
    for i in 0..names.length().min(4 * MAX_PROPERTIES as u32) {
        if out.len() >= MAX_PROPERTIES {
            break;
        }
        let Some(key) = names.get_index(scope, i).filter(|k| k.is_string()) else { continue };
        let Some(key) = js::text(scope, key, KEY_BYTES + 1).filter(|k| k.len() <= KEY_BYTES) else { continue };
        if matches!(key.as_str(), "name" | "message" | "stack" | "cause" | "errors") {
            continue;
        }
        let Some(value) = get(scope, obj, &key) else { continue };
        if value.is_undefined() || value.is_function() || value.is_symbol() {
            continue;
        }
        let json = {
            v8::tc_scope!(let tc, scope);
            let json = v8::json::stringify(tc, value);
            if tc.has_caught() {
                tc.reset();
                None
            } else {
                json.filter(|s| s.utf8_length(tc) <= PROPERTY_BYTES).map(|s| s.to_rust_string_lossy(tc))
            }
        };
        if let Some(raw) = json.filter(|j| j != "undefined").and_then(|j| RawValue::from_string(j).ok()) {
            out.insert(key, raw);
        }
    }
    (!out.is_empty()).then_some(out)
}

/// Where code failed to compile, from V8's message for it, and the caret
/// line that goes under its source line.
pub(super) fn compile_location(scope: &mut v8::PinScope, message: v8::Local<v8::Message>) -> Option<(Location, String)> {
    let file = message.get_script_resource_name(scope).and_then(|n| js::text(scope, n, 1024)).unwrap_or_default();
    let line = message.get_line_number(scope)? as u32;
    let start = message.get_start_column();
    let end = message.get_end_column().max(start + 1);
    let mut caret = String::new();
    let source_line = message.get_source_line(scope).map(|s| s.to_rust_string_lossy(scope)).map(|src| {
        // A window around the column (minified code has very long lines).
        let chars: Vec<char> = src.chars().collect();
        let from = start.saturating_sub(SOURCE_WINDOW / 2).min(chars.len());
        let to = (from + SOURCE_WINDOW).min(chars.len());
        let mut shown: String = chars[from..to].iter().collect();
        caret = chars[from..start.min(to)].iter().map(|&c| if c == '\t' { '\t' } else { ' ' }).collect();
        if from > 0 {
            shown.insert(0, '…');
            caret.insert(0, ' ');
        }
        if to < chars.len() {
            shown.push('…');
        }
        caret.push_str(&"^".repeat((end.min(to).saturating_sub(start.min(to))).max(1)));
        shown
    });
    Some((Location { file, line, column: start as u32 + 1, source_line }, caret))
}

/// A compile error's stack, Node's way: where, the line and a caret, then
/// the error (whose own stack has no frames to say where).
pub(super) fn with_location(guest: &mut GuestError, location: Location, caret: &str) {
    let mut stack = format!("{}:{}", location.file, location.line);
    if let Some(src) = &location.source_line {
        stack.push('\n');
        stack.push_str(src);
        stack.push('\n');
        stack.push_str(caret);
    }
    stack.push_str("\n\n");
    match &guest.stack {
        Some(s) => stack.push_str(s),
        None => {
            stack.push_str(guest.name.as_deref().unwrap_or("Error"));
            stack.push_str(": ");
            stack.push_str(&guest.message);
        }
    }
    guest.stack = Some(stack);
    guest.location = Some(location);
}

/// An Error made where the guest called a host function, for its stack (V8
/// captures the frames now and formats them only if `stack` is read).
pub(super) fn call_site<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Value> {
    let empty = v8::String::empty(scope);
    v8::Exception::error(scope, empty)
}

/// Give a failed host call's error the guest's frames: its first line(s)
/// (`TypeError: ...`), a frame for the host function, then the frames of
/// `site` (the call site, for an async call whose reply arrives later) or
/// its own (a sync call's error is made inside the call).
pub(super) fn attribute<'s>(scope: &mut v8::PinScope<'s, '_>, err: v8::Local<'s, v8::Value>, function: &str, site: Option<v8::Local<'s, v8::Value>>) {
    let Ok(obj) = v8::Local::<v8::Object>::try_from(err) else { return };
    let Some(own) = string_prop(scope, obj, "stack", TEXT_MAX) else { return };
    let frames_of = site.and_then(|s| v8::Local::<v8::Object>::try_from(s).ok());
    let frames_text = match frames_of {
        Some(site) => string_prop(scope, site, "stack", TEXT_MAX).unwrap_or_default(),
        None => own.clone(),
    };
    let split = |s: &str| s.find("\n    at ").map(|i| (s[..i].to_string(), s[i + 1..].to_string()));
    let header = split(&own).map_or(own.clone(), |(h, _)| h);
    let frames = split(&frames_text).map(|(_, f)| f).unwrap_or_default();
    let mut stack = format!("{header}\n    at {function} (<host>)");
    if !frames.is_empty() {
        stack.push('\n');
        stack.push_str(&frames);
    }
    let Some(key) = v8::String::new(scope, "stack") else { return };
    let Some(value) = v8::String::new(scope, &stack) else { return };
    v8::tc_scope!(let tc, scope);
    obj.set(tc, key.into(), value.into());
    if tc.has_caught() {
        tc.reset();
    }
}

/// A stack without the frames of isolane's own scripts (`ext:` for the web
/// platform, `isolane:` for the runtime and prelude), as the supervisor
/// reports stacks too. The guest's own `error.stack` keeps them.
fn without_internal_frames(stack: &str) -> String {
    let internal = |line: &str| {
        let line = line.trim_start();
        line.starts_with("at ")
            && ["(ext:", "(isolane:", "at ext:", "at isolane:"].iter().any(|p| line.contains(p))
    };
    stack.lines().filter(|l| !internal(l)).collect::<Vec<_>>().join("\n")
}

// ---- errors nothing handled ----

/// Rejected promises with no handler yet (per isolate, a slot), reported
/// when the work that made them is done unless a handler comes first.
#[derive(Default)]
pub(super) struct Rejections {
    pending: RefCell<Vec<(v8::Global<v8::Promise>, v8::Global<v8::Value>)>>,
    /// Rejections past MAX_REJECTIONS, only counted.
    dropped: Cell<usize>,
}

/// The web platform's `unhandledrejection` dispatch (per isolate): called
/// with (promise, reason), it returns false if a listener handled it.
pub struct RejectionReporter(pub v8::Global<v8::Function>);

/// V8's callback for promises rejected with no handler (and handlers added
/// later).
pub(super) extern "C" fn promise_reject(msg: v8::PromiseRejectMessage) {
    v8::callback_scope!(unsafe scope, &msg);
    let Some(state) = scope.get_slot::<Rc<Rejections>>().cloned() else { return };
    let promise = msg.get_promise();
    match msg.get_event() {
        v8::PromiseRejectEvent::PromiseRejectWithNoHandler => {
            let mut pending = state.pending.borrow_mut();
            if pending.len() >= MAX_REJECTIONS {
                state.dropped.set(state.dropped.get() + 1);
                return;
            }
            let value = msg.get_value().unwrap_or_else(|| v8::undefined(scope).into());
            pending.push((v8::Global::new(scope, promise), v8::Global::new(scope, value)));
        }
        v8::PromiseRejectEvent::PromiseHandlerAddedAfterReject => forget(scope, promise),
        _ => {}
    }
}

/// `promise` has a handler now (or its rejection is the eval's result).
pub(super) fn forget(scope: &mut v8::PinScope, promise: v8::Local<v8::Promise>) {
    let Some(state) = scope.get_slot::<Rc<Rejections>>().cloned() else { return };
    state.pending.borrow_mut().retain(|(p, _)| v8::Local::new(scope, p) != promise);
}

pub(super) fn install(isolate: &mut v8::Isolate) {
    isolate.set_slot(Rc::new(Rejections::default()));
    isolate.set_promise_reject_callback(promise_reject);
}

/// Report the rejections still without a handler: the `unhandledrejection`
/// event (with the web platform), then the console and a `guestError`
/// frame unless a listener handled it. Called once the microtasks of a
/// task have run (an eval's, a timer's, a host reply's).
pub(super) fn report_rejections(scope: &mut v8::PinScope) {
    let Some(state) = scope.get_slot::<Rc<Rejections>>().cloned() else { return };
    // Reporting runs JavaScript, which can reject more; a few rounds at most.
    for _ in 0..4 {
        let batch = std::mem::take(&mut *state.pending.borrow_mut());
        if batch.is_empty() {
            break;
        }
        for (promise, reason) in batch {
            if scope.is_execution_terminating() {
                state.pending.borrow_mut().clear();
                return;
            }
            let promise = v8::Local::new(scope, promise);
            let reason = v8::Local::new(scope, reason);
            if dispatch_rejection(scope, promise, reason) {
                report(scope, "rejection", reason);
            }
        }
    }
    let dropped = state.dropped.replace(0);
    if dropped > 0 {
        let note = js::short_string(scope, &format!("{dropped} more promise rejections with no handler weren't reported"));
        guest_log(scope, "error", "", note.into());
    }
}

/// The `unhandledrejection` event; whether nothing handled it.
fn dispatch_rejection(scope: &mut v8::PinScope, promise: v8::Local<v8::Promise>, reason: v8::Local<v8::Value>) -> bool {
    let Some(reporter) = scope.get_slot::<Rc<RejectionReporter>>().cloned() else { return true };
    let f = v8::Local::new(scope, &reporter.0);
    let recv: v8::Local<v8::Value> = v8::undefined(scope).into();
    v8::tc_scope!(let tc, scope);
    let unhandled = f.call(tc, recv, &[promise.into(), reason]).map(|v| v.boolean_value(tc));
    if tc.has_caught() {
        tc.reset();
    }
    unhandled.unwrap_or(true)
}

/// An error nothing handled: "Uncaught …" on the guest's console, and a
/// `guestError` frame, both within the eval's console budget
/// (`limits.logBytes`; each text in the frame at most `limits.logLineBytes`,
/// like a console line). A frame that doesn't fit what's left is dropped.
pub fn report<'s>(scope: &mut v8::PinScope<'s, '_>, kind: &'static str, value: v8::Local<'s, v8::Value>) {
    let Some(bridge) = scope.get_slot::<Rc<Bridge>>().cloned() else { return };
    if bridge.log_budget.get() == 0 || scope.is_execution_terminating() {
        return;
    }
    let guest = described(scope, value, crate::limits::get().log_line_bytes.min(TEXT_MAX));
    let prefix = if kind == "rejection" { "Uncaught (in promise) " } else { "Uncaught " };
    let line = guest.stack.as_deref().map_or_else(|| guest.message.clone(), without_internal_frames);
    if let Some(line) = v8::String::new(scope, &line) {
        guest_log(scope, "error", prefix, line.into());
    }
    let frame = serde_json::to_vec(&Out::GuestError { vm: bridge.vm, kind, guest: &guest }).expect("protocol messages serialize");
    let left = bridge.log_budget.get();
    if frame.len() >= left {
        return;
    }
    bridge.log_budget.set(left - frame.len());
    bridge.out.send_json(&frame, &[]);
}
