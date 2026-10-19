//! One VM = one V8 isolate on its own OS thread, plus a watchdog thread that
//! terminates execution at the deadline. Isolates are never shared or reused
//! across VMs.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::ffi::c_void;
use std::io::Stdout;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::value::RawValue;

use crate::frame::Writer;
use crate::proto::{fail, ErrorCode, Failure, Out};

pub type Output = Arc<Writer<Stdout>>;

/// Native stack for VM threads; V8's own stack limit sits well inside it.
const VM_THREAD_STACK: usize = 8 << 20;

pub struct VmConfig {
    pub heap_bytes: Option<u64>,
    pub timeout: Option<Duration>,
    pub host_functions: Vec<String>,
}

pub enum VmMsg {
    Eval { req: u64, code: String },
    HostReply { call: u64, ok: bool, value: Option<String>, error: Option<String> },
    Dispose,
}

pub fn spawn(id: u64, config: VmConfig, rx: Receiver<VmMsg>, out: Output) {
    std::thread::Builder::new()
        .name(format!("vm-{id}"))
        .stack_size(VM_THREAD_STACK)
        .spawn(move || vm_main(id, config, rx, out))
        .expect("spawn VM thread");
}

// ---- watchdog ----

#[derive(Default)]
struct WatchState {
    deadline: Option<Instant>,
    fired: bool,
    closed: bool,
}

/// Terminates the isolate when an armed deadline passes. `TerminateExecution`
/// is thread-safe and stops JIT-compiled code as well as the interpreter.
struct Watchdog {
    state: Mutex<WatchState>,
    cv: Condvar,
}

impl Watchdog {
    fn start(handle: v8::IsolateHandle) -> Arc<Watchdog> {
        let w = Arc::new(Watchdog {
            state: Mutex::new(WatchState::default()),
            cv: Condvar::new(),
        });
        let watch = w.clone();
        std::thread::spawn(move || {
            let mut s = watch.state.lock().unwrap();
            loop {
                if s.closed {
                    return;
                }
                match s.deadline {
                    None => s = watch.cv.wait(s).unwrap(),
                    Some(d) => {
                        let now = Instant::now();
                        if now >= d {
                            s.deadline = None;
                            s.fired = true;
                            handle.terminate_execution();
                        } else {
                            s = watch.cv.wait_timeout(s, d - now).unwrap().0;
                        }
                    }
                }
            }
        });
        w
    }

    fn arm(&self, budget: Duration) -> Instant {
        let deadline = Instant::now() + budget;
        let mut s = self.state.lock().unwrap();
        s.deadline = Some(deadline);
        s.fired = false;
        self.cv.notify_one();
        deadline
    }

    /// Disarm; returns whether the deadline fired.
    fn disarm(&self) -> bool {
        let mut s = self.state.lock().unwrap();
        s.deadline = None;
        std::mem::take(&mut s.fired)
    }

    fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.cv.notify_one();
    }
}

// ---- heap limit ----

struct OomState {
    handle: v8::IsolateHandle,
    hit: AtomicBool,
}

/// Near the heap limit: terminate instead of letting V8 abort the process,
/// and grant headroom so the termination can unwind. The VM is retired after.
unsafe extern "C" fn near_heap_limit(data: *mut c_void, current: usize, _initial: usize) -> usize {
    let st = unsafe { &*(data as *const OomState) };
    st.hit.store(true, Ordering::SeqCst);
    st.handle.terminate_execution();
    current * 2
}

// ---- host functions ----

/// Per-isolate state reachable from host-function callbacks (isolate slot).
struct Bridge {
    vm: u64,
    out: Output,
    next_call: Cell<u64>,
    pending: RefCell<HashMap<u64, v8::Global<v8::PromiseResolver>>>,
}

/// Guest-facing host function: serialize the arguments, send a `hostCall`,
/// and return a Promise that the supervisor's reply settles.
fn host_function(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue<v8::Value>) {
    let name = args.data().to_rust_string_lossy(scope);
    let arr = v8::Array::new(scope, args.length());
    for i in 0..args.length() {
        arr.set_index(scope, i as u32, args.get(i));
    }
    // A throw here (BigInt, cycles) propagates to the guest caller.
    let Some(json) = v8::json::stringify(scope, arr.into()) else { return };
    let json = json.to_rust_string_lossy(scope);
    let Some(resolver) = v8::PromiseResolver::new(scope) else { return };
    let bridge = scope.get_slot::<Rc<Bridge>>().expect("bridge slot").clone();
    let call = bridge.next_call.get();
    bridge.next_call.set(call + 1);
    bridge.pending.borrow_mut().insert(call, v8::Global::new(scope, resolver));
    let args = RawValue::from_string(json).expect("V8 produced JSON");
    bridge.out.send(&Out::HostCall { vm: bridge.vm, call, name: &name, args: &args });
    rv.set(resolver.get_promise(scope).into());
}

fn apply_host_reply(
    scope: &mut v8::PinScope,
    call: u64,
    ok: bool,
    value: Option<String>,
    error: Option<String>,
) {
    let bridge = scope.get_slot::<Rc<Bridge>>().expect("bridge slot").clone();
    let Some(resolver) = bridge.pending.borrow_mut().remove(&call) else { return };
    // I/O completed: the guest's clock moves forward.
    crate::clock::advance();
    let resolver = v8::Local::new(scope, resolver);
    if ok {
        let parsed = match &value {
            None => Some(v8::undefined(scope).into()),
            Some(json) => v8::String::new(scope, json).and_then(|s| v8::json::parse(scope, s)),
        };
        match parsed {
            Some(v) => {
                resolver.resolve(scope, v);
            }
            None => {
                let msg = v8::String::new(scope, "host function returned invalid JSON").unwrap();
                let e = v8::Exception::error(scope, msg);
                resolver.reject(scope, e);
            }
        }
    } else {
        let msg = v8::String::new(scope, error.as_deref().unwrap_or("host function failed")).unwrap();
        let e = v8::Exception::error(scope, msg);
        resolver.reject(scope, e);
    }
}

// ---- context setup ----

/// Refuse every WebAssembly compilation (the global is also deleted).
unsafe extern "C" fn deny_wasm(_: v8::Local<v8::Context>, _: v8::Local<v8::String>) -> bool {
    false
}

/// Globals removed from every context: no WebAssembly, and nothing to build
/// a shared-memory timer from.
const REMOVED_GLOBALS: &[&str] = &["WebAssembly", "SharedArrayBuffer", "Atomics"];

fn new_context(isolate: &mut v8::Isolate, host_functions: &[String]) -> v8::Global<v8::Context> {
    v8::scope!(let scope, isolate);
    let context = v8::Context::new(scope, Default::default());
    context.set_allow_generation_from_strings(false);
    let scope = &mut v8::ContextScope::new(scope, context);
    let global = context.global(scope);
    for name in REMOVED_GLOBALS {
        let key = v8::String::new(scope, name).unwrap();
        global.delete(scope, key.into());
    }
    for name in host_functions {
        let key = v8::String::new(scope, name).unwrap();
        let func = v8::Function::builder(host_function)
            .data(key.into())
            .build(scope)
            .expect("build host function");
        global.set(scope, key.into(), func.into());
    }
    v8::Global::new(scope, context)
}

// ---- evaluation ----

enum EvalEnd {
    Done(Result<String, Failure>),
    /// The supervisor disposed the VM while an eval waited on a host call.
    Disposed,
}

/// "Message\nstack" for thrown errors, or the value's string form.
fn describe(scope: &mut v8::PinScope, exception: v8::Local<v8::Value>) -> String {
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

fn to_json(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Result<String, Failure> {
    if value.is_undefined() {
        return Ok("null".into());
    }
    v8::tc_scope!(let tc, scope);
    match v8::json::stringify(tc, value) {
        Some(s) => {
            let s = s.to_rust_string_lossy(tc);
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
fn eval(
    isolate: &mut v8::Isolate,
    context: &v8::Global<v8::Context>,
    code: &str,
    rx: &Receiver<VmMsg>,
    backlog: &mut VecDeque<VmMsg>,
    deadline: Option<Instant>,
) -> EvalEnd {
    v8::scope_with_context!(scope, isolate, context);
    v8::tc_scope!(let tc, scope);

    let guest_error = |tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>| {
        let msg = tc.exception().map(|e| describe(tc, e)).unwrap_or_else(|| "unknown error".into());
        fail(ErrorCode::GuestException, msg)
    };

    crate::clock::advance();
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
            return EvalEnd::Done(Err(fail(ErrorCode::Timeout, "terminated")));
        }
        match promise.state() {
            v8::PromiseState::Fulfilled => {
                let v = promise.result(tc);
                return EvalEnd::Done(to_json(tc, v));
            }
            v8::PromiseState::Rejected => {
                let e = promise.result(tc);
                return EvalEnd::Done(Err(fail(ErrorCode::GuestException, describe(tc, e))));
            }
            v8::PromiseState::Pending => {}
        }
        let waiting = tc.get_slot::<Rc<Bridge>>().map(|b| !b.pending.borrow().is_empty()).unwrap_or(false);
        if !waiting {
            return EvalEnd::Done(Err(fail(
                ErrorCode::Unsettled,
                "promise never settled: there are no timers or I/O, only host functions",
            )));
        }
        let msg = match deadline {
            Some(d) => match rx.recv_timeout(d.saturating_duration_since(Instant::now())) {
                Ok(m) => m,
                Err(RecvTimeoutError::Timeout) => {
                    return EvalEnd::Done(Err(fail(ErrorCode::Timeout, "timed out waiting for a host function")))
                }
                Err(RecvTimeoutError::Disconnected) => return EvalEnd::Disposed,
            },
            None => match rx.recv() {
                Ok(m) => m,
                Err(_) => return EvalEnd::Disposed,
            },
        };
        match msg {
            VmMsg::HostReply { call, ok, value, error } => apply_host_reply(tc, call, ok, value, error),
            VmMsg::Dispose => return EvalEnd::Disposed,
            eval @ VmMsg::Eval { .. } => backlog.push_back(eval),
        }
    }
}

fn send_result(out: &Output, req: u64, result: Result<String, Failure>) {
    match result {
        Ok(json) => {
            let value = RawValue::from_string(json).expect("V8 produced JSON");
            out.send(&Out::Result { req, ok: true, value: Some(&value), code: None, message: None });
        }
        Err(f) => out.send(&Out::Result {
            req,
            ok: false,
            value: None,
            code: Some(f.code),
            message: Some(&f.message),
        }),
    }
}

fn vm_main(id: u64, config: VmConfig, rx: Receiver<VmMsg>, out: Output) {
    let mut params = v8::CreateParams::default();
    if let Some(max) = config.heap_bytes {
        params = params.heap_limits(0, max as usize);
    }
    let mut isolate = v8::Isolate::new(params);
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    isolate.set_allow_wasm_code_generation_callback(deny_wasm);

    let handle = isolate.thread_safe_handle();
    let watchdog = Watchdog::start(handle.clone());
    let oom = Box::new(OomState { handle, hit: AtomicBool::new(false) });
    isolate.add_near_heap_limit_callback(near_heap_limit, &*oom as *const OomState as *mut c_void);

    isolate.set_slot(Rc::new(Bridge {
        vm: id,
        out: out.clone(),
        next_call: Cell::new(1),
        pending: RefCell::new(HashMap::new()),
    }));
    let context = new_context(&mut isolate, &config.host_functions);

    let mut backlog: VecDeque<VmMsg> = VecDeque::new();
    // Set once the VM can't safely run again (it hit its heap limit).
    let mut retired: Option<String> = None;

    loop {
        let msg = match backlog.pop_front() {
            Some(m) => m,
            None => match rx.recv() {
                Ok(m) => m,
                Err(_) => break,
            },
        };
        match msg {
            VmMsg::Dispose => break,
            VmMsg::Eval { req, code } => {
                if let Some(cause) = &retired {
                    send_result(&out, req, Err(fail(ErrorCode::VmTerminated, cause.clone())));
                    continue;
                }
                let deadline = config.timeout.map(|t| watchdog.arm(t));
                let end = eval(&mut isolate, &context, &code, &rx, &mut backlog, deadline);
                let fired = watchdog.disarm();
                if isolate.is_execution_terminating() || fired || oom.hit.load(Ordering::SeqCst) {
                    isolate.cancel_terminate_execution();
                }
                let result = match end {
                    EvalEnd::Disposed => break,
                    EvalEnd::Done(r) => r,
                };
                let result = if oom.hit.load(Ordering::SeqCst) {
                    let cause = "vm exceeded its heap limit";
                    retired = Some(format!("vm was terminated by an earlier eval ({cause}); create a new one"));
                    Err(fail(ErrorCode::MemoryLimit, cause))
                } else if fired {
                    let ms = config.timeout.map(|t| t.as_millis()).unwrap_or(0);
                    Err(fail(ErrorCode::Timeout, format!("execution timed out after {ms}ms")))
                } else {
                    result
                };
                send_result(&out, req, result);
            }
            VmMsg::HostReply { call, ok, value, error } => {
                // A reply after its eval finished: the continuation it wakes
                // runs under the same budget as an eval.
                if retired.is_some() {
                    continue;
                }
                if let Some(t) = config.timeout {
                    watchdog.arm(t);
                }
                {
                    v8::scope_with_context!(scope, &mut isolate, &context);
                    apply_host_reply(scope, call, ok, value, error);
                    scope.perform_microtask_checkpoint();
                }
                let fired = watchdog.disarm();
                if isolate.is_execution_terminating() || fired || oom.hit.load(Ordering::SeqCst) {
                    isolate.cancel_terminate_execution();
                }
                if oom.hit.load(Ordering::SeqCst) {
                    retired = Some("vm was terminated by an earlier continuation (heap limit); create a new one".into());
                }
            }
        }
    }
    watchdog.close();
    // The isolate holds a raw pointer to `oom`, and the context handle needs
    // a live isolate: drop in that order.
    drop(context);
    drop(isolate);
    drop(oom);
}
