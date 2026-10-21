//! Host calls: guest-facing host functions (async and sync), the per-isolate
//! bridge they share, and applying the supervisor's replies.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use serde_json::value::RawValue;

use super::errors;
use super::mailbox::Mailbox;
use super::{Output, Reply, VmMsg};
use crate::js;
use crate::proto::{limit, Failure, Out, PathSegment};

/// Per-isolate state reachable from host-function callbacks (isolate slot).
pub(super) struct Bridge {
    pub(super) vm: u64,
    pub(super) out: Output,
    pub(super) mailbox: Mailbox,
    pub(super) next_call: Cell<u64>,
    /// Console bytes left this eval.
    pub(super) log_budget: Cell<usize>,
    /// Async host calls waiting for replies, with each one's frame size,
    /// function, and (for the embedder's functions) the call site's Error.
    pub(super) pending: RefCell<HashMap<u64, Pending>>,
    /// The frame bytes of host calls waiting for replies (`limits.pendingHostCallBytes`).
    pub(super) pending_bytes: Cell<usize>,
    /// When the running eval or continuation must stop (a sync host call
    /// waits no longer than this).
    pub(super) deadline: Cell<Option<Instant>>,
    /// A sync host call gave up at the deadline. The guest code may finish
    /// before the termination lands (or before the watchdog notices), so
    /// this, not only the watchdog, makes the eval a timeout.
    pub(super) timed_out: Cell<bool>,
    /// An eval is running (not a timer or continuation between evals).
    pub(super) in_eval: Cell<bool>,
    /// Time spent blocked in sync host calls since it was last taken: the
    /// background budget charges it (it's wall time the VM thread is held,
    /// with little CPU to show for it).
    pub(super) blocked: Cell<Duration>,
    /// Host calls the running eval has made (`limits.hostCalls`).
    pub(super) host_calls: Cell<u64>,
    /// A count limit the running eval hit: it fails with this even if the
    /// guest caught the RangeError.
    pub(super) limit_hit: RefCell<Option<Failure>>,
    /// By function index: isolane's own brokers (fetch, connect, fs), which
    /// `limits.hostCalls` doesn't count (their own limits bound them).
    pub(super) internal: Vec<bool>,
    /// By function index: its dotted name (`db.getUser`), for the frame a
    /// failed call's error gets.
    pub(super) names: Vec<String>,
}

/// An async host call waiting for its reply.
pub(super) struct Pending {
    pub(super) resolver: v8::Global<v8::PromiseResolver>,
    pub(super) size: usize,
    pub(super) function: u32,
    /// Made when the call was: its stack is where the guest called (see
    /// `errors::attribute`). Not kept for isolane's own brokers.
    pub(super) site: Option<v8::Global<v8::Value>>,
}

/// Serialize a host call's arguments and send it; returns the call id and
/// the frame's size. None if the call is refused or its arguments can't be
/// serialized (the exception is pending). Arguments that are bytes
/// (ArrayBuffers and views of them) cross as raw bytes, not JSON, when
/// passed directly; nested inside other values they serialize as JSON as
/// before. The function's data is its index in the isolate's function list.
fn send_host_call(
    scope: &mut v8::PinScope,
    args: &v8::FunctionCallbackArguments,
    bridge: &Bridge,
) -> Option<(u64, usize)> {
    let function = args.data().uint32_value(scope).unwrap_or(u32::MAX);
    let limits = crate::limits::get();
    let internal = bridge
        .internal
        .get(function as usize)
        .copied()
        .unwrap_or(false);
    let counted = bridge.in_eval.get() && !internal;
    let pending = bridge.pending.borrow().len();
    if pending >= limits.pending_host_calls {
        let message = format!("{pending} host calls are already waiting for replies, the most this isolate may have (limits.pendingHostCalls)");
        return refuse(scope, bridge, "pendingHostCalls", message);
    }
    if counted && bridge.host_calls.get() >= limits.host_calls {
        let message = format!(
            "this eval made {} host calls, the most it may make (limits.hostCalls)",
            limits.host_calls
        );
        return refuse(scope, bridge, "hostCalls", message);
    }
    let arr = v8::Array::new(scope, args.length());
    let mut bin: Vec<(u32, usize)> = Vec::new();
    let mut attached: Vec<Vec<u8>> = Vec::new();
    for i in 0..args.length() {
        let arg = args.get(i);
        if let Some(b) = crate::bytes::copy_bytes(scope, arg) {
            bin.push((i as u32, b.len()));
            attached.push(b);
            let null: v8::Local<v8::Value> = v8::null(scope).into();
            arr.set_index(scope, i as u32, null);
        } else {
            arr.set_index(scope, i as u32, arg);
        }
    }
    // A throw here (BigInt, cycles) propagates to the guest caller.
    let json = v8::json::stringify(scope, arr.into())?.to_rust_string_lossy(scope);
    let attached_len: usize = attached.iter().map(Vec::len).sum();
    if !crate::frame::fits(json.len() + 128, attached_len) {
        js::throw_range(scope, "host function arguments are larger than 64 MiB");
        return None;
    }
    let call = bridge.next_call.get();
    let args = RawValue::from_string(json).expect("V8 produced JSON");
    let attached: Vec<&[u8]> = attached.iter().map(Vec::as_slice).collect();
    let frame = serde_json::to_vec(&Out::HostCall {
        vm: bridge.vm,
        call,
        function,
        args: &args,
        bin: &bin,
    })
    .expect("protocol messages serialize");
    let size = crate::frame::body_len(frame.len(), &attached);
    let waiting = bridge.pending_bytes.get();
    if waiting.saturating_add(size) > limits.pending_host_call_bytes {
        let message = format!(
            "this call's {size} bytes, with the {waiting} bytes of calls already waiting, are more than the isolate may have waiting (limits.pendingHostCallBytes)"
        );
        return refuse(scope, bridge, "pendingHostCallBytes", message);
    }
    bridge.next_call.set(call + 1);
    if counted {
        bridge.host_calls.set(bridge.host_calls.get() + 1);
    }
    bridge.out.send_json(&frame, &attached);
    Some((call, size))
}

/// Refuse a host call over `limits.<name>`: the guest gets a RangeError
/// (code ERR_LIMIT, `limit` the name), and an eval fails with ERR_LIMIT
/// even if the guest catches it.
fn refuse<T>(
    scope: &mut v8::PinScope,
    bridge: &Bridge,
    name: &'static str,
    message: String,
) -> Option<T> {
    if bridge.in_eval.get() && bridge.limit_hit.borrow().is_none() {
        *bridge.limit_hit.borrow_mut() = Some(limit(name, message.clone()));
    }
    js::throw_with(
        scope,
        js::Class::Range,
        &message,
        &[("code", "ERR_LIMIT"), ("limit", name)],
    );
    None
}

/// Put byte values into a parsed host reply at their paths. A path the
/// value doesn't have is ignored (the supervisor built both). Only own
/// properties are followed and set, so no path reaches a prototype
/// (`constructor.prototype.x`, `__proto__`) or runs a setter.
fn place_bytes<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    mut value: v8::Local<'s, v8::Value>,
    bytes: Vec<(Vec<PathSegment>, Vec<u8>)>,
) -> v8::Local<'s, v8::Value> {
    for (path, data) in bytes {
        let u8s: v8::Local<v8::Value> = crate::bytes::new_u8array(scope, &data).into();
        let Some((last, parents)) = path.split_last() else {
            value = u8s;
            continue;
        };
        let key =
            |scope: &mut v8::PinScope<'s, '_>, seg: &PathSegment| -> v8::Local<'s, v8::Name> {
                match seg {
                    PathSegment::Index(i) => js::short_string(scope, &i.to_string()).into(),
                    PathSegment::Key(k) => js::short_string(scope, k).into(),
                }
            };
        let mut holder = Some(value);
        for seg in parents {
            let Some(obj) = holder.and_then(|h| v8::Local::<v8::Object>::try_from(h).ok()) else {
                break;
            };
            let k = key(scope, seg);
            holder = match obj.has_own_property(scope, k) {
                Some(true) => obj.get(scope, k.into()),
                _ => None,
            };
        }
        if let Some(obj) = holder.and_then(|h| v8::Local::<v8::Object>::try_from(h).ok()) {
            let k = key(scope, last);
            if obj.has_own_property(scope, k) == Some(true) {
                obj.create_data_property(scope, k, u8s);
            }
        }
    }
    value
}

/// Guest-facing host function: send a `hostCall` and return a Promise that
/// the supervisor's reply settles.
pub(super) fn host_function(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let bridge = scope.get_slot::<Rc<Bridge>>().expect("bridge slot").clone();
    let Some(resolver) = v8::PromiseResolver::new(scope) else {
        return;
    };
    let Some((call, size)) = send_host_call(scope, &args, &bridge) else {
        return;
    };
    let function = args.data().uint32_value(scope).unwrap_or(u32::MAX);
    let internal = bridge
        .internal
        .get(function as usize)
        .copied()
        .unwrap_or(true);
    let site = (!internal).then(|| {
        let site = errors::call_site(scope);
        v8::Global::new(scope, site)
    });
    let pending = Pending {
        resolver: v8::Global::new(scope, resolver),
        size,
        function,
        site,
    };
    bridge.pending.borrow_mut().insert(call, pending);
    bridge.pending_bytes.set(bridge.pending_bytes.get() + size);
    rv.set(resolver.get_promise(scope).into());
}

/// Takes a sync call's bytes back off `pending_bytes`, and adds its wait to
/// `blocked`, however its wait ends.
struct Uncount<'a>(&'a Bridge, usize, Instant);

impl Drop for Uncount<'_> {
    fn drop(&mut self) {
        self.0
            .pending_bytes
            .set(self.0.pending_bytes.get() - self.1);
        self.0.blocked.set(self.0.blocked.get() + self.2.elapsed());
    }
}

/// Guest-facing sync host function: send a `hostCall`, then block this VM
/// until its reply arrives (or the deadline passes) and return the result
/// directly. Everything else that arrives meanwhile waits in the mailbox.
pub(super) fn sync_host_function(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue<v8::Value>,
) {
    let bridge = scope.get_slot::<Rc<Bridge>>().expect("bridge slot").clone();
    let function = args.data().uint32_value(scope).unwrap_or(u32::MAX);
    let Some((call, size)) = send_host_call(scope, &args, &bridge) else {
        return;
    };
    // Counted while it waits, like an async call (the supervisor holds it).
    bridge.pending_bytes.set(bridge.pending_bytes.get() + size);
    let _counted = Uncount(&bridge, size, Instant::now());
    loop {
        let left = bridge
            .deadline
            .get()
            .map(|d| d.saturating_duration_since(Instant::now()));
        if left == Some(Duration::ZERO) {
            bridge.timed_out.set(true);
            scope.terminate_execution();
            return;
        }
        let msg = match left {
            Some(l) => bridge.mailbox.rx.recv_timeout(l),
            None => bridge
                .mailbox
                .rx
                .recv()
                .map_err(|_| RecvTimeoutError::Disconnected),
        };
        match msg {
            Ok(VmMsg::HostReply { call: c, reply }) if c == call => {
                crate::clock::advance();
                match settle(scope, reply) {
                    Ok(v) => rv.set(v),
                    Err(e) => {
                        if let Some(name) = attributed(&bridge, function) {
                            errors::attribute(scope, e, name, None);
                        }
                        scope.throw_exception(e);
                    }
                }
                return;
            }
            Ok(reply @ VmMsg::HostReply { .. }) => {
                bridge.mailbox.replies.borrow_mut().push_back(reply)
            }
            Ok(eval @ VmMsg::Eval { .. }) => bridge.mailbox.later.borrow_mut().push_back(eval),
            Ok(VmMsg::Dispose) | Err(RecvTimeoutError::Disconnected) => {
                bridge
                    .mailbox
                    .replies
                    .borrow_mut()
                    .push_back(VmMsg::Dispose);
                scope.terminate_execution();
                return;
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

/// A reply as the guest sees it: the parsed value, or the error to throw.
fn settle<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    reply: Reply,
) -> Result<v8::Local<'s, v8::Value>, v8::Local<'s, v8::Value>> {
    if reply.ok {
        let parsed = match &reply.value {
            None => Some(v8::undefined(scope).into()),
            Some(json) => v8::String::new(scope, json).and_then(|s| v8::json::parse(scope, s)),
        };
        return match parsed {
            Some(v) => Ok(place_bytes(scope, v, reply.bytes)),
            None => {
                let msg = js::short_string(scope, "host function returned invalid JSON");
                Err(v8::Exception::error(scope, msg))
            }
        };
    }
    let msg = js::short_string(
        scope,
        reply.error.as_deref().unwrap_or("host function failed"),
    );
    let e = match reply.error_name.as_deref() {
        Some("TypeError") => v8::Exception::type_error(scope, msg),
        Some("RangeError") => v8::Exception::range_error(scope, msg),
        Some("SyntaxError") => v8::Exception::syntax_error(scope, msg),
        _ => v8::Exception::error(scope, msg),
    };
    if let Ok(obj) = v8::Local::<v8::Object>::try_from(e) {
        if let Some(code) = &reply.error_code {
            let key = js::short_string(scope, "code");
            let val = js::short_string(scope, code);
            obj.set(scope, key.into(), val.into());
        }
    }
    Err(e)
}

/// The embedder's function `function`'s name, for attributing its errors
/// (not isolane's own brokers: their errors are the web platform's).
fn attributed(bridge: &Bridge, function: u32) -> Option<&str> {
    let i = function as usize;
    match bridge.internal.get(i) {
        Some(false) => bridge.names.get(i).map(String::as_str),
        _ => None,
    }
}

pub(super) fn apply_host_reply(scope: &mut v8::PinScope, call: u64, reply: Reply) {
    let bridge = scope.get_slot::<Rc<Bridge>>().expect("bridge slot").clone();
    let Some(pending) = bridge.pending.borrow_mut().remove(&call) else {
        return;
    };
    bridge
        .pending_bytes
        .set(bridge.pending_bytes.get() - pending.size);
    // I/O completed: the guest's clock moves forward.
    crate::clock::advance();
    let resolver = v8::Local::new(scope, pending.resolver);
    match settle(scope, reply) {
        Ok(v) => resolver.resolve(scope, v),
        Err(e) => {
            if let Some(name) = attributed(&bridge, pending.function) {
                let site = pending.site.map(|s| v8::Local::new(scope, s));
                errors::attribute(scope, e, name, site);
            }
            resolver.reject(scope, e)
        }
    };
}
