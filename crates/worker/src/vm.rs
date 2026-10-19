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
use crate::proto::{fail, ErrorCode, Failure, GuestError, Out, Usage};

pub type Output = Arc<Writer<Stdout>>;

static PLATFORM: std::sync::OnceLock<v8::SharedRef<v8::Platform>> = std::sync::OnceLock::new();

/// The platform V8 was initialized with, for running each isolate's
/// foreground tasks.
pub fn set_platform(platform: v8::SharedRef<v8::Platform>) {
    let _ = PLATFORM.set(platform);
}

/// Run the foreground tasks V8 has posted for this isolate: the results of
/// background work (async WebAssembly compilation) and GC steps. Returns
/// whether any ran.
fn pump_tasks(isolate: &v8::Isolate) -> bool {
    let Some(platform) = PLATFORM.get() else { return false };
    let mut ran = false;
    while v8::Platform::pump_message_loop(platform, isolate, false) {
        ran = true;
    }
    ran
}

/// How often to look for V8's foreground tasks while it has background work
/// in flight and nothing else to wait for.
const BACKGROUND_POLL: Duration = Duration::from_millis(1);

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
    /// CPU time the VM thread may use per eval (or continuation).
    pub cpu_limit: Option<Duration>,
    pub host_functions: Vec<String>,
    /// Host functions that return their result directly instead of a Promise.
    pub sync_host_functions: Vec<String>,
    pub clock: crate::clock::Mode,
    pub random_seed: Option<u64>,
    pub allow_code_generation: bool,
    pub allow_web_assembly: bool,
    pub web_platform: bool,
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
    HostReply { call: u64, reply: Reply },
    Dispose,
}

/// The supervisor's answer to a host call.
pub struct Reply {
    pub ok: bool,
    /// JSON text; absent for `undefined`.
    pub value: Option<String>,
    pub error: Option<String>,
    /// The error's class in the guest (`TypeError`, ...), and a Node-style
    /// `code` property (`ENOENT`, ...).
    pub error_name: Option<String>,
    pub error_code: Option<String>,
}

/// A VM's incoming messages. A sync host call waits for its own reply and
/// sets everything else aside here, in order: replies to async calls (and a
/// dispose) to handle next, evals to run after the current one.
struct Mailbox {
    rx: Receiver<VmMsg>,
    replies: RefCell<VecDeque<VmMsg>>,
    later: RefCell<VecDeque<VmMsg>>,
}

impl Mailbox {
    /// The next message during an eval: held replies first. Evals that
    /// arrive are deferred.
    fn during_eval(&self, timeout: Option<Duration>) -> Result<VmMsg, RecvTimeoutError> {
        loop {
            if let Some(m) = self.replies.borrow_mut().pop_front() {
                return Ok(m);
            }
            let m = match timeout {
                Some(t) => self.rx.recv_timeout(t)?,
                None => self.rx.recv().map_err(|_| RecvTimeoutError::Disconnected)?,
            };
            match m {
                eval @ VmMsg::Eval { .. } => self.later.borrow_mut().push_back(eval),
                other => return Ok(other),
            }
        }
    }

    /// The next message between evals.
    fn idle(&self) -> Option<VmMsg> {
        if let Some(m) = self.replies.borrow_mut().pop_front() {
            return Some(m);
        }
        if let Some(m) = self.later.borrow_mut().pop_front() {
            return Some(m);
        }
        self.rx.recv().ok()
    }
}

pub fn spawn(id: u64, config: VmConfig, rx: Receiver<VmMsg>, out: Output) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name(format!("vm-{id}"))
        .stack_size(VM_THREAD_STACK)
        .spawn(move || vm_main(id, config, rx, out))
        .map(drop)
}

// ---- watchdog ----

/// A thread's CPU clock, readable from another thread (Linux:
/// `pthread_getcpuclockid`). Elsewhere CPU budgets aren't enforced.
#[derive(Clone, Copy)]
struct CpuClock(#[cfg(target_os = "linux")] libc::clockid_t);

impl CpuClock {
    /// The calling thread's clock.
    fn current() -> Option<CpuClock> {
        #[cfg(target_os = "linux")]
        unsafe {
            let mut id: libc::clockid_t = 0;
            (libc::pthread_getcpuclockid(libc::pthread_self(), &mut id) == 0).then_some(CpuClock(id))
        }
        #[cfg(not(target_os = "linux"))]
        None
    }

    fn now(self) -> Duration {
        #[cfg(target_os = "linux")]
        unsafe {
            let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
            libc::clock_gettime(self.0, &mut ts);
            Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
        }
        #[cfg(not(target_os = "linux"))]
        Duration::ZERO
    }
}

/// How often the watchdog samples a CPU budget.
const CPU_POLL: Duration = Duration::from_millis(2);

/// Which budget ran out.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Fired {
    No,
    Wall,
    Cpu,
}

struct WatchState {
    deadline: Option<Instant>,
    /// The VM thread's CPU time at which to stop.
    cpu_deadline: Option<Duration>,
    fired: Fired,
    closed: bool,
}

/// Terminates the isolate when an armed budget runs out: a wall-clock
/// deadline, or CPU time used by the VM thread. `TerminateExecution` is
/// thread-safe and stops JIT-compiled code as well as the interpreter.
struct Watchdog {
    state: Mutex<WatchState>,
    cv: Condvar,
    cpu: Option<CpuClock>,
}

impl Watchdog {
    /// Call on the VM thread (its CPU clock is the one budgets measure).
    fn start(handle: v8::IsolateHandle) -> std::io::Result<Arc<Watchdog>> {
        let w = Arc::new(Watchdog {
            state: Mutex::new(WatchState { deadline: None, cpu_deadline: None, fired: Fired::No, closed: false }),
            cv: Condvar::new(),
            cpu: CpuClock::current(),
        });
        let watch = w.clone();
        let spawned = std::thread::Builder::new().stack_size(WATCHDOG_STACK).spawn(move || {
            let mut s = watch.state.lock().unwrap();
            loop {
                if s.closed {
                    return;
                }
                let now = Instant::now();
                if s.deadline.is_some_and(|d| now >= d) {
                    s.deadline = None;
                    s.cpu_deadline = None;
                    s.fired = Fired::Wall;
                    handle.terminate_execution();
                    continue;
                }
                if let (Some(limit), Some(clock)) = (s.cpu_deadline, watch.cpu) {
                    if clock.now() >= limit {
                        s.deadline = None;
                        s.cpu_deadline = None;
                        s.fired = Fired::Cpu;
                        handle.terminate_execution();
                        continue;
                    }
                }
                let wall = s.deadline.map(|d| d - now);
                let cpu = s.cpu_deadline.and(watch.cpu).map(|_| CPU_POLL);
                s = match (wall, cpu) {
                    (None, None) => watch.cv.wait(s).unwrap(),
                    (w, c) => {
                        let wait = w.unwrap_or(Duration::MAX).min(c.unwrap_or(Duration::MAX));
                        watch.cv.wait_timeout(s, wait).unwrap().0
                    }
                };
            }
        });
        spawned.map(|_| w)
    }

    /// Arm for one eval or continuation; returns the wall-clock deadline.
    /// Call on the VM thread.
    fn arm(&self, wall: Option<Duration>, cpu: Option<Duration>) -> Option<Instant> {
        let deadline = wall.map(|t| Instant::now() + t);
        let cpu_deadline = cpu.and_then(|c| self.cpu.map(|clock| clock.now() + c));
        let mut s = self.state.lock().unwrap();
        s.deadline = deadline;
        s.cpu_deadline = cpu_deadline;
        s.fired = Fired::No;
        self.cv.notify_one();
        deadline
    }

    /// Disarm; returns which budget ran out, if one did.
    fn disarm(&self) -> Fired {
        let mut s = self.state.lock().unwrap();
        s.deadline = None;
        s.cpu_deadline = None;
        std::mem::replace(&mut s.fired, Fired::No)
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
    mailbox: Mailbox,
    next_call: Cell<u64>,
    /// Console bytes left this eval.
    log_budget: Cell<usize>,
    pending: RefCell<HashMap<u64, v8::Global<v8::PromiseResolver>>>,
    /// When the running eval or continuation must stop (a sync host call
    /// waits no longer than this).
    deadline: Cell<Option<Instant>>,
    /// A sync host call gave up at the deadline. The guest code may finish
    /// before the termination lands (or before the watchdog notices), so
    /// this, not only the watchdog, makes the eval a timeout.
    timed_out: Cell<bool>,
}

/// Serialize a host call's arguments and send it; returns the call id.
/// None if the arguments can't be serialized (the exception is pending).
fn send_host_call(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, bridge: &Bridge) -> Option<u64> {
    let name = args.data().to_rust_string_lossy(scope);
    let arr = v8::Array::new(scope, args.length());
    for i in 0..args.length() {
        arr.set_index(scope, i as u32, args.get(i));
    }
    // A throw here (BigInt, cycles) propagates to the guest caller.
    let json = v8::json::stringify(scope, arr.into())?.to_rust_string_lossy(scope);
    let call = bridge.next_call.get();
    bridge.next_call.set(call + 1);
    let args = RawValue::from_string(json).expect("V8 produced JSON");
    bridge.out.send(&Out::HostCall { vm: bridge.vm, call, name: &name, args: &args });
    Some(call)
}

/// Guest-facing host function: send a `hostCall` and return a Promise that
/// the supervisor's reply settles.
fn host_function(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue<v8::Value>) {
    let bridge = scope.get_slot::<Rc<Bridge>>().expect("bridge slot").clone();
    let Some(resolver) = v8::PromiseResolver::new(scope) else { return };
    let Some(call) = send_host_call(scope, &args, &bridge) else { return };
    bridge.pending.borrow_mut().insert(call, v8::Global::new(scope, resolver));
    rv.set(resolver.get_promise(scope).into());
}

/// Guest-facing sync host function: send a `hostCall`, then block this VM
/// until its reply arrives (or the deadline passes) and return the result
/// directly. Everything else that arrives meanwhile waits in the mailbox.
fn sync_host_function(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue<v8::Value>) {
    let bridge = scope.get_slot::<Rc<Bridge>>().expect("bridge slot").clone();
    let Some(call) = send_host_call(scope, &args, &bridge) else { return };
    loop {
        let left = bridge.deadline.get().map(|d| d.saturating_duration_since(Instant::now()));
        if left == Some(Duration::ZERO) {
            bridge.timed_out.set(true);
            scope.terminate_execution();
            return;
        }
        let msg = match left {
            Some(l) => bridge.mailbox.rx.recv_timeout(l),
            None => bridge.mailbox.rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match msg {
            Ok(VmMsg::HostReply { call: c, reply }) if c == call => {
                crate::clock::advance();
                match settle(scope, reply) {
                    Ok(v) => rv.set(v),
                    Err(e) => {
                        scope.throw_exception(e);
                    }
                }
                return;
            }
            Ok(reply @ VmMsg::HostReply { .. }) => bridge.mailbox.replies.borrow_mut().push_back(reply),
            Ok(eval @ VmMsg::Eval { .. }) => bridge.mailbox.later.borrow_mut().push_back(eval),
            Ok(VmMsg::Dispose) | Err(RecvTimeoutError::Disconnected) => {
                bridge.mailbox.replies.borrow_mut().push_back(VmMsg::Dispose);
                scope.terminate_execution();
                return;
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

/// A reply as the guest sees it: the parsed value, or the error to throw.
fn settle<'s>(scope: &mut v8::PinScope<'s, '_>, reply: Reply) -> Result<v8::Local<'s, v8::Value>, v8::Local<'s, v8::Value>> {
    if reply.ok {
        let parsed = match &reply.value {
            None => Some(v8::undefined(scope).into()),
            Some(json) => v8::String::new(scope, json).and_then(|s| v8::json::parse(scope, s)),
        };
        return parsed.ok_or_else(|| {
            let msg = v8::String::new(scope, "host function returned invalid JSON").unwrap();
            v8::Exception::error(scope, msg)
        });
    }
    let msg = v8::String::new(scope, reply.error.as_deref().unwrap_or("host function failed")).unwrap();
    let e = match reply.error_name.as_deref() {
        Some("TypeError") => v8::Exception::type_error(scope, msg),
        Some("RangeError") => v8::Exception::range_error(scope, msg),
        Some("SyntaxError") => v8::Exception::syntax_error(scope, msg),
        _ => v8::Exception::error(scope, msg),
    };
    if let Ok(obj) = v8::Local::<v8::Object>::try_from(e) {
        if let Some(code) = &reply.error_code {
            let key = v8::String::new(scope, "code").unwrap();
            let val = v8::String::new(scope, code).unwrap();
            obj.set(scope, key.into(), val.into());
        }
    }
    Err(e)
}

fn apply_host_reply(scope: &mut v8::PinScope, call: u64, reply: Reply) {
    let bridge = scope.get_slot::<Rc<Bridge>>().expect("bridge slot").clone();
    let Some(resolver) = bridge.pending.borrow_mut().remove(&call) else { return };
    // I/O completed: the guest's clock moves forward.
    crate::clock::advance();
    let resolver = v8::Local::new(scope, resolver);
    match settle(scope, reply) {
        Ok(v) => resolver.resolve(scope, v),
        Err(e) => resolver.reject(scope, e),
    };
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

/// A console line from the runtime itself (the web platform's unhandled
/// errors), subject to the same per-eval budget as guest console output.
pub(crate) fn guest_log(scope: &mut v8::PinScope, level: &str, message: &str) {
    let Some(bridge) = scope.get_slot::<Rc<Bridge>>().cloned() else { return };
    let left = bridge.log_budget.get();
    if left == 0 {
        return;
    }
    bridge.log_budget.set(left.saturating_sub(message.len()));
    bridge.out.send(&Out::Log { vm: bridge.vm, level, message });
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
pub unsafe extern "C" fn out_of_memory(_location: *const std::ffi::c_char, _details: &v8::OomDetails) {
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
    if config.web_platform {
        crate::web::install(scope, global)?;
    }
    let wasm: &[&str] = if config.allow_web_assembly { &[] } else { &["WebAssembly"] };
    for name in REMOVED_GLOBALS.iter().chain(wasm) {
        let key = v8::String::new(scope, name).unwrap();
        global.delete(scope, key.into());
    }
    install_console(scope, global);
    let sync = config.sync_host_functions.iter().map(|n| (n, true));
    for (name, is_sync) in config.host_functions.iter().map(|n| (n, false)).chain(sync) {
        let key = v8::String::new(scope, name).unwrap();
        let builder = if is_sync { v8::Function::builder(sync_host_function) } else { v8::Function::builder(host_function) };
        let func = builder.data(key.into()).build(scope).expect("build host function");
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

/// `ERR_GUEST_EXCEPTION` for a thrown value: the legacy one-line message
/// ("stack" or the value), plus name/message/stack as separate fields.
fn guest_failure(scope: &mut v8::PinScope, exception: v8::Local<v8::Value>) -> Failure {
    let mut f = fail(ErrorCode::GuestException, describe(scope, exception));
    let get = |scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, key: &str| {
        let k = v8::String::new(scope, key).unwrap();
        obj.get(scope, k.into()).filter(|v| v.is_string()).map(|v| v.to_rust_string_lossy(scope))
    };
    f.guest = Some(match v8::Local::<v8::Object>::try_from(exception) {
        Ok(obj) => GuestError {
            name: get(scope, obj, "name"),
            message: get(scope, obj, "message").unwrap_or_else(|| exception.to_rust_string_lossy(scope)),
            stack: get(scope, obj, "stack"),
        },
        Err(_) => GuestError { name: None, message: exception.to_rust_string_lossy(scope), stack: None },
    });
    f
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
                return EvalEnd::Done(Err(guest_failure(tc, e)));
            }
            v8::PromiseState::Pending => {}
        }
        if pump_tasks(tc) {
            continue;
        }
        let waiting = tc.get_slot::<Rc<Bridge>>().map(|b| !b.pending.borrow().is_empty()).unwrap_or(false);
        let background = tc.has_pending_background_tasks();
        if !waiting && !background {
            return EvalEnd::Done(Err(fail(
                ErrorCode::Unsettled,
                "promise never settled: there are no timers or I/O, only host functions",
            )));
        }
        // Wait for a host reply; with V8 work in flight, only briefly, then
        // look for its results.
        let left = deadline.map(|d| d.saturating_duration_since(Instant::now()));
        if left == Some(Duration::ZERO) {
            return EvalEnd::Done(Err(fail(ErrorCode::Timeout, "timed out waiting for a host function")));
        }
        let wait = match (background, left) {
            (true, Some(l)) => Some(l.min(BACKGROUND_POLL)),
            (true, None) => Some(BACKGROUND_POLL),
            (false, l) => l,
        };
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

/// A VM that couldn't start: fail its evals until it is disposed.
fn refuse_all(rx: &Receiver<VmMsg>, out: &Output, cause: String) {
    while let Ok(msg) = rx.recv() {
        match msg {
            VmMsg::Eval { req, .. } => send_result(out, req, Err(fail(ErrorCode::MemoryLimit, cause.clone())), Usage::default()),
            VmMsg::HostReply { .. } => {}
            VmMsg::Dispose => return,
        }
    }
}

fn send_result(out: &Output, req: u64, result: Result<String, Failure>, usage: Usage) {
    match result {
        Ok(json) => {
            let value = RawValue::from_string(json).expect("V8 produced JSON");
            out.send(&Out::Result { req, ok: true, value: Some(&value), code: None, message: None, guest: None, usage });
        }
        Err(f) => out.send(&Out::Result {
            req,
            ok: false,
            value: None,
            code: Some(f.code),
            message: Some(&f.message),
            guest: f.guest.as_ref(),
            usage,
        }),
    }
}

/// CPU since `start` (on `clock`) and the isolate's memory now.
fn usage(isolate: &mut v8::Isolate, clock: Option<CpuClock>, start: Duration) -> Usage {
    let heap = isolate.get_heap_statistics();
    Usage {
        cpu_us: clock.map(|c| c.now().saturating_sub(start).as_micros() as u64),
        heap_bytes: Some(heap.used_heap_size() as u64),
        external_bytes: Some(heap.external_memory() as u64),
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

    let cpu_clock = CpuClock::current();
    let handle = isolate.thread_safe_handle();
    let watchdog = match Watchdog::start(handle.clone()) {
        Ok(w) => w,
        Err(e) => return refuse_all(&rx, &out, format!("vm could not start: {e}")),
    };
    let oom = Box::new(OomState { handle, hit: AtomicBool::new(false) });
    isolate.add_near_heap_limit_callback(near_heap_limit, &*oom as *const OomState as *mut c_void);

    let bridge = Rc::new(Bridge {
        vm: id,
        out: out.clone(),
        mailbox: Mailbox { rx, replies: RefCell::new(VecDeque::new()), later: RefCell::new(VecDeque::new()) },
        next_call: Cell::new(1),
        log_budget: Cell::new(LOG_BUDGET),
        pending: RefCell::new(HashMap::new()),
        deadline: Cell::new(None),
        timed_out: Cell::new(false),
    });
    isolate.set_slot(bridge.clone());
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
        let Some(msg) = bridge.mailbox.idle() else { break };
        match msg {
            VmMsg::Dispose => break,
            VmMsg::Eval { req, code } => {
                if let Some(cause) = &retired {
                    send_result(&out, req, Err(fail(ErrorCode::IsolateRetired, cause.clone())), Usage::default());
                    continue;
                }
                let cpu_start = cpu_clock.map(|c| c.now()).unwrap_or_default();
                let deadline = watchdog.arm(config.timeout, config.cpu_limit);
                bridge.deadline.set(deadline);
                bridge.timed_out.set(false);
                let end = eval(&mut isolate, &context, &code, &bridge.mailbox, deadline);
                pump_tasks(&isolate);
                bridge.deadline.set(None);
                let fired = match watchdog.disarm() {
                    Fired::No if bridge.timed_out.take() => Fired::Wall,
                    f => f,
                };
                bridge.timed_out.set(false);
                if isolate.is_execution_terminating() || fired != Fired::No || oom.hit.load(Ordering::SeqCst) {
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
                } else if fired == Fired::Wall {
                    let ms = config.timeout.map(|t| t.as_millis()).unwrap_or(0);
                    Err(fail(ErrorCode::Timeout, format!("execution timed out after {ms}ms")))
                } else if fired == Fired::Cpu {
                    let ms = config.cpu_limit.map(|t| t.as_millis()).unwrap_or(0);
                    Err(fail(ErrorCode::CpuLimit, format!("execution used more than {ms}ms of CPU time")))
                } else {
                    result
                };
                let spent = usage(&mut isolate, cpu_clock, cpu_start);
                send_result(&out, req, result, spent);
            }
            VmMsg::HostReply { call, reply } => {
                // A reply after its eval finished: the continuation it wakes
                // runs under the same budget as an eval.
                if retired.is_some() {
                    continue;
                }
                let cpu_start = cpu_clock.map(|c| c.now()).unwrap_or_default();
                bridge.deadline.set(watchdog.arm(config.timeout, config.cpu_limit));
                bridge.timed_out.set(false);
                {
                    v8::scope_with_context!(scope, &mut isolate, &context);
                    apply_host_reply(scope, call, reply);
                    scope.perform_microtask_checkpoint();
                    while pump_tasks(scope) {
                        scope.perform_microtask_checkpoint();
                    }
                }
                bridge.deadline.set(None);
                let fired = watchdog.disarm() != Fired::No || bridge.timed_out.take();
                if isolate.is_execution_terminating() || fired || oom.hit.load(Ordering::SeqCst) {
                    isolate.cancel_terminate_execution();
                }
                if oom.hit.load(Ordering::SeqCst) {
                    retired = Some("vm was terminated by an earlier continuation (heap limit); create a new one".into());
                }
                let spent = usage(&mut isolate, cpu_clock, cpu_start);
                out.send(&Out::Usage { vm: id, usage: spent });
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
