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

/// Native stack for VM threads; V8's own stack limit (about 1 MiB) sits
/// well inside it. Stacks count against the worker's memory limit, so keep
/// them modest.
const VM_THREAD_STACK: usize = 4 << 20;
const WATCHDOG_STACK: usize = 64 << 10;

/// Bytes of console output a VM may send per eval; the rest is dropped.
const LOG_BUDGET: usize = 1 << 20;
/// Longest single console message.
const LOG_MESSAGE_MAX: usize = 16 << 10;

pub struct VmConfig {
    pub heap_bytes: Option<u64>,
    pub timeout: Option<Duration>,
    pub host_functions: Vec<String>,
    pub clock: crate::clock::Mode,
    pub random_seed: Option<u64>,
    pub allow_code_generation: bool,
    pub allow_web_assembly: bool,
    pub prelude: Option<String>,
}

// ---- seeded entropy ----

thread_local! {
    /// SplitMix64 state for a VM created with a random seed. V8 draws its
    /// entropy on the thread that creates or first uses the isolate, which
    /// is the VM's own thread.
    static SEED: Cell<Option<u64>> = const { Cell::new(None) };
}

/// Fill `buf` from this thread's seeded stream, if it has one.
pub fn seeded_entropy(buf: &mut [u8]) -> bool {
    SEED.with(|seed| {
        let Some(mut state) = seed.get() else { return false };
        for chunk in buf.chunks_mut(8) {
            state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            z ^= z >> 31;
            chunk.copy_from_slice(&z.to_le_bytes()[..chunk.len()]);
        }
        seed.set(Some(state));
        true
    })
}

pub enum VmMsg {
    Eval { req: u64, code: String },
    HostReply { call: u64, ok: bool, value: Option<String>, error: Option<String> },
    Dispose,
}

pub fn spawn(id: u64, config: VmConfig, rx: Receiver<VmMsg>, out: Output) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name(format!("vm-{id}"))
        .stack_size(VM_THREAD_STACK)
        .spawn(move || vm_main(id, config, rx, out))
        .map(drop)
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
    fn start(handle: v8::IsolateHandle) -> std::io::Result<Arc<Watchdog>> {
        let w = Arc::new(Watchdog {
            state: Mutex::new(WatchState::default()),
            cv: Condvar::new(),
        });
        let watch = w.clone();
        let spawned = std::thread::Builder::new().stack_size(WATCHDOG_STACK).spawn(move || {
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
        spawned.map(|_| w)
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
    /// Console bytes left this eval.
    log_budget: Cell<usize>,
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

// ---- console ----

/// `console.log` and friends: format the arguments like a terminal would
/// (strings as-is, other values as JSON where possible) and send a one-way
/// log frame. Output past the VM's per-eval budget is dropped.
fn console_method(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue<v8::Value>) {
    let level = args.data().to_rust_string_lossy(scope);
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
        if message.len() >= LOG_MESSAGE_MAX {
            break;
        }
    }
    if message.len() > LOG_MESSAGE_MAX {
        let mut cut = LOG_MESSAGE_MAX;
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

fn install_console(scope: &mut v8::PinScope, global: v8::Local<v8::Object>) {
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

// ---- context setup ----

/// WebAssembly compilation, refused unless the VM allows it (the global is
/// also deleted then).
unsafe extern "C" fn deny_wasm(_: v8::Local<v8::Context>, _: v8::Local<v8::String>) -> bool {
    false
}
unsafe extern "C" fn allow_wasm(_: v8::Local<v8::Context>, _: v8::Local<v8::String>) -> bool {
    true
}

/// V8 couldn't get memory (the worker's memory limit, not a VM's heap
/// limit, which `near_heap_limit` handles). V8 can't continue; exit with a
/// code the supervisor reports as a memory limit, not a crash.
unsafe extern "C" fn out_of_memory(_location: *const std::ffi::c_char, _details: &v8::OomDetails) {
    const MSG: &[u8] = b"isolane-worker: out of memory (worker memory limit)\n";
    #[cfg(target_os = "linux")]
    unsafe {
        libc::write(2, MSG.as_ptr().cast(), MSG.len());
        libc::_exit(OOM_EXIT_CODE);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = MSG;
        std::process::exit(OOM_EXIT_CODE);
    }
}
pub const OOM_EXIT_CODE: i32 = 6;

/// Globals removed from every context: nothing to build a shared-memory
/// timer from, and WebAssembly unless the VM allows it.
const REMOVED_GLOBALS: &[&str] = &["SharedArrayBuffer", "Atomics"];

fn new_context(isolate: &mut v8::Isolate, config: &VmConfig) -> Result<v8::Global<v8::Context>, String> {
    v8::scope!(let scope, isolate);
    let context = v8::Context::new(scope, Default::default());
    context.set_allow_generation_from_strings(config.allow_code_generation);
    let scope = &mut v8::ContextScope::new(scope, context);
    let global = context.global(scope);
    let wasm: &[&str] = if config.allow_web_assembly { &[] } else { &["WebAssembly"] };
    for name in REMOVED_GLOBALS.iter().chain(wasm) {
        let key = v8::String::new(scope, name).unwrap();
        global.delete(scope, key.into());
    }
    install_console(scope, global);
    for name in &config.host_functions {
        let key = v8::String::new(scope, name).unwrap();
        let func = v8::Function::builder(host_function)
            .data(key.into())
            .build(scope)
            .expect("build host function");
        global.set(scope, key.into(), func.into());
    }
    if let Some(prelude) = &config.prelude {
        v8::tc_scope!(let tc, scope);
        let ran = v8::String::new(tc, prelude)
            .and_then(|src| v8::Script::compile(tc, src, None))
            .and_then(|script| script.run(tc));
        if ran.is_none() {
            let msg = tc.exception().map(|e| describe(tc, e)).unwrap_or_else(|| "unknown error".into());
            return Err(format!("vm setup failed: {msg}"));
        }
    }
    Ok(v8::Global::new(scope, context))
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
    if let Some(bridge) = tc.get_slot::<Rc<Bridge>>() {
        bridge.log_budget.set(LOG_BUDGET);
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

/// A VM that couldn't start: fail its evals until it is disposed.
fn refuse_all(rx: &Receiver<VmMsg>, out: &Output, cause: String) {
    while let Ok(msg) = rx.recv() {
        match msg {
            VmMsg::Eval { req, .. } => send_result(out, req, Err(fail(ErrorCode::MemoryLimit, cause.clone()))),
            VmMsg::HostReply { .. } => {}
            VmMsg::Dispose => return,
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
    crate::clock::set_mode(config.clock);
    SEED.with(|seed| seed.set(config.random_seed));
    let mut params = v8::CreateParams::default();
    if let Some(max) = config.heap_bytes {
        params = params.heap_limits(0, max as usize);
    }
    let mut isolate = v8::Isolate::new(params);
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    isolate.set_allow_wasm_code_generation_callback(if config.allow_web_assembly { allow_wasm } else { deny_wasm });
    isolate.set_oom_error_handler(out_of_memory);

    let handle = isolate.thread_safe_handle();
    let watchdog = match Watchdog::start(handle.clone()) {
        Ok(w) => w,
        Err(e) => return refuse_all(&rx, &out, format!("vm could not start: {e}")),
    };
    let oom = Box::new(OomState { handle, hit: AtomicBool::new(false) });
    isolate.add_near_heap_limit_callback(near_heap_limit, &*oom as *const OomState as *mut c_void);

    isolate.set_slot(Rc::new(Bridge {
        vm: id,
        out: out.clone(),
        next_call: Cell::new(1),
        log_budget: Cell::new(LOG_BUDGET),
        pending: RefCell::new(HashMap::new()),
    }));
    let mut backlog: VecDeque<VmMsg> = VecDeque::new();
    // Set once the VM can't safely run again (it hit its heap limit, or its
    // setup failed: then it keeps a bare context and refuses every eval).
    let mut retired: Option<String> = None;
    let context = match new_context(&mut isolate, &config) {
        Ok(context) => context,
        Err(cause) => {
            retired = Some(cause);
            v8::scope!(let scope, &mut isolate);
            let bare = v8::Context::new(scope, Default::default());
            v8::Global::new(scope, bare)
        }
    };

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
