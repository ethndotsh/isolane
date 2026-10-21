//! `console` for guest code: formatted lines sent one-way to the supervisor,
//! within the isolate's per-eval budget (`limits.logBytes`) and line length
//! (`limits.logLineBytes`).

use std::rc::Rc;

use super::host_call::Bridge;
use crate::proto::Out;
use crate::js;

/// Send one console line within the eval's budget: the line that would
/// exhaust it becomes a single notice, and later lines are dropped.
fn emit(bridge: &Bridge, level: &str, message: &str) {
    let left = bridge.log_budget.get();
    if left == 0 {
        return;
    }
    if message.len() >= left {
        bridge.log_budget.set(0);
        let notice = "[isolane] console output limit reached for this eval; further output dropped";
        bridge.out.send(&Out::Log { vm: bridge.vm, level, message: notice });
    } else {
        bridge.log_budget.set(left - message.len());
        bridge.out.send(&Out::Log { vm: bridge.vm, level, message });
    }
}

/// The longest line sent: `limits.logLineBytes`, but never more than a
/// frame carries (an oversized frame is a protocol violation).
fn max_line() -> usize {
    crate::limits::get().log_line_bytes.min(crate::frame::MAX_FRAME / 2)
}

/// `console.log` and friends: format the arguments like a terminal would
/// (strings as-is, other values as JSON where possible) and send a one-way
/// log frame. Output past the VM's per-eval budget is dropped.
fn console_method(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue<v8::Value>) {
    let level = args.data().to_rust_string_lossy(scope);
    let max_line = max_line();
    let Some(bridge) = scope.get_slot::<Rc<Bridge>>().cloned() else { return };
    if bridge.log_budget.get() == 0 {
        return;
    }
    let mut message = String::new();
    for i in 0..args.length() {
        if i > 0 {
            message.push(' ');
        }
        let room = max_line.saturating_sub(message.len());
        let v = args.get(i);
        // Strings as-is, and values JSON can't represent by their string form.
        let part = if v.is_string() || v.is_function() || v.is_symbol() || v.is_undefined() || v.is_big_int() {
            js::string(scope, v, room)
        } else {
            v8::tc_scope!(let tc, scope);
            match v8::json::stringify(tc, v) {
                Some(s) => js::string(tc, s.into(), room),
                None if tc.has_terminated() => {
                    tc.rethrow();
                    return;
                }
                None => {
                    tc.reset();
                    js::string(tc, v, room)
                }
            }
        };
        message.push_str(&part);
        if message.len() >= max_line {
            break;
        }
    }
    emit(&bridge, &level, &message);
}

/// A console line from the runtime itself (the web platform's console and
/// its unhandled errors): `prefix` then `value`'s string form, held to the
/// same line length and per-eval budget as guest console output.
pub fn guest_log(scope: &mut v8::PinScope, level: &str, prefix: &str, value: v8::Local<v8::Value>) {
    let Some(bridge) = scope.get_slot::<Rc<Bridge>>().cloned() else { return };
    if bridge.log_budget.get() == 0 {
        return;
    }
    let max_line = max_line();
    let mut message = String::from(prefix);
    message.push_str(&js::string(scope, value, max_line.saturating_sub(prefix.len())));
    emit(&bridge, level, &message);
}

pub(super) fn install_console(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    let console = v8::Object::new(scope);
    for (name, level) in [("log", "log"), ("info", "info"), ("debug", "debug"), ("warn", "warn"), ("error", "error"), ("trace", "debug")] {
        let level = js::short_string(scope, level);
        let func = v8::Function::builder(console_method).data(level.into()).build(scope).expect("build console method");
        let key = js::short_string(scope, name);
        console.set(scope, key.into(), func.into());
    }
    let key = js::short_string(scope, "console");
    global.set(scope, key.into(), console.into());
}
