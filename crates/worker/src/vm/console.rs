//! `console` for guest code: formatted lines sent one-way to the supervisor,
//! within the isolate's per-eval budget (`limits.logBytes`) and line length
//! (`limits.logLineBytes`).

use std::rc::Rc;

use super::host_call::Bridge;
use crate::proto::Out;

/// `console.log` and friends: format the arguments like a terminal would
/// (strings as-is, other values as JSON where possible) and send a one-way
/// log frame. Output past the VM's per-eval budget is dropped.
fn console_method(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue<v8::Value>) {
    let level = args.data().to_rust_string_lossy(scope);
    let max_line = crate::limits::get().log_line_bytes;
    let Some(bridge) = scope.get_slot::<Rc<Bridge>>().cloned() else { return };
    if bridge.log_budget.get() == 0 {
        return;
    }
    let mut message = String::new();
    for i in 0..args.length() {
        if i > 0 {
            message.push(' ');
        }
        let v = args.get(i);
        let part = if v.is_string() {
            v.to_rust_string_lossy(scope)
        } else if v.is_function() || v.is_symbol() || v.is_undefined() || v.is_big_int() {
            v.to_rust_string_lossy(scope)
        } else {
            v8::tc_scope!(let tc, scope);
            match v8::json::stringify(tc, v) {
                Some(s) => s.to_rust_string_lossy(tc),
                None => {
                    tc.reset();
                    v.to_rust_string_lossy(tc)
                }
            }
        };
        message.push_str(&part);
        if message.len() >= max_line {
            break;
        }
    }
    if message.len() > max_line {
        let mut cut = max_line;
        while !message.is_char_boundary(cut) {
            cut -= 1;
        }
        message.truncate(cut);
        message.push('…');
    }
    let left = bridge.log_budget.get();
    if message.len() >= left {
        bridge.log_budget.set(0);
        message = "[isolane] console output limit reached for this eval; further output dropped".into();
    } else {
        bridge.log_budget.set(left - message.len());
    }
    bridge.out.send(&Out::Log { vm: bridge.vm, level: &level, message: &message });
}

/// A console line from the runtime itself (the web platform's unhandled
/// errors), subject to the same per-eval budget as guest console output.
pub fn guest_log(scope: &mut v8::PinScope, level: &str, message: &str) {
    let Some(bridge) = scope.get_slot::<Rc<Bridge>>().cloned() else { return };
    let left = bridge.log_budget.get();
    if left == 0 {
        return;
    }
    bridge.log_budget.set(left.saturating_sub(message.len()));
    bridge.out.send(&Out::Log { vm: bridge.vm, level, message });
}

pub(super) fn install_console(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
    let console = v8::Object::new(scope);
    for (name, level) in [("log", "log"), ("info", "info"), ("debug", "debug"), ("warn", "warn"), ("error", "error"), ("trace", "debug")] {
        let level = v8::String::new(scope, level).unwrap();
        let func = v8::Function::builder(console_method).data(level.into()).build(scope).expect("build console method");
        let key = v8::String::new(scope, name).unwrap();
        console.set(scope, key.into(), func.into());
    }
    let key = v8::String::new(scope, "console").unwrap();
    global.set(scope, key.into(), console.into());
}
