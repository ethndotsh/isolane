//! One VM = one V8 isolate on its own OS thread, plus a watchdog thread that
//! terminates execution at the deadline. Isolates are never shared or reused
//! across VMs.
//!
//! - `context`: the context: web platform, removed globals, console, host
//!   functions in their namespaces, the prelude, the embedder's shims
//! - `eval`: running guest code and sending results
//! - `host_call`: host functions and their replies
//! - `console`: guest console output
//! - `errors`: guest errors described, host-call attribution, and errors
//!   nothing handled
//! - `mailbox`: messages held while a sync host call waits
//! - `watchdog`: wall-clock and CPU budgets
//! - `background`: the budget for work between evals

mod background;
mod console;
mod context;
mod errors;
mod eval;
mod host_call;
mod mailbox;
mod watchdog;

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::c_void;
use std::io::Stdout;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;

use crate::frame::Writer;
use crate::proto::{fail, limit, ErrorCode, Failure, Usage};
pub use console::guest_log;
pub use errors::{report as report_guest_error, RejectionReporter};
use context::{allow_wasm, deny_wasm, new_context, Shims};
use background::Background;
use eval::{eval, refuse_all, run_idle_timers, send_result, usage, EvalEnd};
use host_call::{apply_host_reply, Bridge};
use mailbox::Mailbox;
use watchdog::{CpuClock, Fired, Watchdog};

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

/// Native stack for VM threads; V8's own stack limit (about 1 MiB) sits
/// well inside it. Stacks count against the worker's memory limit, so keep
/// them modest.
const VM_THREAD_STACK: usize = 4 << 20;

/// An isolate's configuration, as `create` sends it (named as in the public
/// config).
pub struct VmConfig {
    pub limits: crate::limits::Limits,
    pub time: crate::clock::Mode,
    pub seed: Option<u64>,
    pub eval: bool,
    pub wasm: bool,
    pub web: bool,
    pub base_url: Option<String>,
    pub functions: Vec<crate::proto::FunctionSpec>,
    pub prelude: Option<String>,
    pub shims: crate::proto::Shims,
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

thread_local! {
    /// The VM thread's watchdog, for native code that runs long without
    /// returning to JavaScript (where termination takes effect).
    static WATCHDOG: std::cell::RefCell<Option<Arc<Watchdog>>> = const { std::cell::RefCell::new(None) };
}

/// Has a budget run out for what this VM thread is running? Long native
/// loops (PBKDF2) check it and stop, since the watchdog's termination only
/// lands once they return to JavaScript.
pub fn out_of_time() -> bool {
    WATCHDOG.with(|w| w.borrow().as_ref().is_some_and(|w| w.fired()))
}

// ---- messages ----

pub enum VmMsg {
    /// `last`: the VM is disposed right after (a one-shot run), so timers
    /// left pending never run.
    Eval { req: u64, code: String, filename: Option<String>, last: bool },
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
    /// Byte values in the result and where they go (`[]`: the result itself).
    pub bytes: Vec<(Vec<crate::proto::PathSegment>, Vec<u8>)>,
}

pub fn spawn(id: u64, config: VmConfig, rx: Receiver<VmMsg>, out: Output) -> std::io::Result<Stopper> {
    let stopper = Stopper(Arc::new(std::sync::OnceLock::new()));
    let watchdog = stopper.0.clone();
    std::thread::Builder::new()
        .name(format!("vm-{id}"))
        .stack_size(VM_THREAD_STACK)
        .spawn(move || vm_main(id, config, rx, out, watchdog))
        .map(|_| stopper)
}

/// Stops whatever a VM is running, from another thread: after `Dispose`,
/// so a VM busy in guest code (with no time limit, or a long one) doesn't
/// keep its thread until it finishes.
pub struct Stopper(Arc<std::sync::OnceLock<Arc<Watchdog>>>);

impl Stopper {
    pub fn stop(&self) {
        if let Some(watchdog) = self.0.get() {
            watchdog.stop();
        }
    }
}

// ---- memory ----

struct OomState {
    handle: v8::IsolateHandle,
    hit: AtomicBool,
}

/// Near the heap limit: terminate instead of letting V8 abort the process,
/// and grant headroom so the termination can unwind. The VM is retired after.
unsafe extern "C" fn near_heap_limit(data: *mut c_void, current: usize, _initial: usize) -> usize {
    // SAFETY: `data` is the OomState registered with this callback; it's
    // boxed and dropped only after the isolate (see vm_main's drop order).
    let st = unsafe { &*(data as *const OomState) };
    st.hit.store(true, Ordering::SeqCst);
    st.handle.terminate_execution();
    current * 2
}

/// Which limit stopped an isolate that hit V8's near-heap-limit callback.
/// V8 calls it both when the heap reaches the isolate's limit and when the
/// OS refuses V8 more memory (the worker's RLIMIT_DATA cap). Tell them apart
/// by how much the isolate actually holds (heap plus the external memory,
/// like ArrayBuffers, that V8 charges to it), against the heap limit as
/// configured: at least half of it means the heap limit; well under it
/// means the worker ran out first.
fn memory_limit_hit(isolate: &mut v8::Isolate, heap_limit: usize) -> (&'static str, &'static str) {
    let stats = isolate.get_heap_statistics();
    let held = stats.used_heap_size() + stats.external_memory();
    if held >= heap_limit / 2 {
        ("heapBytes", "the isolate exceeded its heap limit (limits.heapBytes)")
    } else {
        ("workerMemoryBytes", "the tenant's worker ran out of memory (limits.workerMemoryBytes)")
    }
}

/// V8 couldn't get memory (the worker's memory limit, not a VM's heap
/// limit, which `near_heap_limit` handles). V8 can't continue; exit with a
/// code the supervisor reports as a memory limit, not a crash.
pub unsafe extern "C" fn out_of_memory(_location: *const std::ffi::c_char, _details: &v8::OomDetails) {
    const MSG: &[u8] = b"isolane-worker: out of memory (worker memory limit)\n";
    #[cfg(target_os = "linux")]
    // SAFETY: write and _exit are async-signal-safe and take a valid buffer;
    // nothing else is safe to do in a process V8 has declared out of memory.
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

// ---- the VM thread ----

fn vm_main(id: u64, config: VmConfig, rx: Receiver<VmMsg>, out: Output, stopper: Arc<std::sync::OnceLock<Arc<Watchdog>>>) {
    crate::limits::set(config.limits);
    crate::clock::set_mode(config.time);
    SEED.with(|seed| seed.set(config.seed));
    let timeout = config.limits.timeout();
    let cpu = config.limits.cpu();
    let mut params = v8::CreateParams::default();
    if let Some(max) = config.limits.heap_bytes {
        // At most V8's pointer-compression cage (the supervisor's maximum).
        params = params.heap_limits(0, max.min(4 << 30) as usize);
    }
    // A web VM starts from the web platform's snapshot (built on first
    // use), if there is one; other VMs never touch it.
    let snapshot = if config.web { crate::web::snapshot() } else { None };
    let from_snapshot = snapshot.is_some();
    if let Some(blob) = snapshot {
        params = params
            .snapshot_blob(v8::StartupData::from(blob))
            .external_references(std::borrow::Cow::Borrowed(crate::web::external_references()));
    }
    let mut isolate = v8::Isolate::new(params);
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    isolate.set_allow_wasm_code_generation_callback(if config.wasm { allow_wasm } else { deny_wasm });
    isolate.set_oom_error_handler(out_of_memory);
    errors::install(&mut isolate);

    let cpu_clock = CpuClock::current();
    let handle = isolate.thread_safe_handle();
    let watchdog = match Watchdog::start(handle.clone()) {
        Ok(w) => w,
        Err(e) => return refuse_all(&rx, &out, format!("vm could not start: {e}")),
    };
    WATCHDOG.with(|w| *w.borrow_mut() = Some(watchdog.clone()));
    let _ = stopper.set(watchdog.clone());
    let oom = Box::new(OomState { handle, hit: AtomicBool::new(false) });
    isolate.add_near_heap_limit_callback(near_heap_limit, &*oom as *const OomState as *mut c_void);
    // The heap limit as configured (V8's own figure, which adds young
    // generation space, only when none is).
    let heap_limit = match config.limits.heap_bytes {
        Some(bytes) => bytes as usize,
        None => isolate.get_heap_statistics().heap_size_limit(),
    };

    let bridge = Rc::new(Bridge {
        vm: id,
        out: out.clone(),
        mailbox: Mailbox::new(rx),
        next_call: Cell::new(1),
        log_budget: Cell::new(config.limits.log_bytes),
        pending: RefCell::new(HashMap::new()),
        pending_bytes: Cell::new(0),
        deadline: Cell::new(None),
        timed_out: Cell::new(false),
        in_eval: Cell::new(false),
        host_calls: Cell::new(0),
        limit_hit: RefCell::new(None),
        // The supervisor names its brokers __isolane_* and refuses those
        // names for the embedder's functions.
        internal: config.functions.iter().map(|f| f.path.first().is_some_and(|n| n.starts_with("__isolane_"))).collect(),
        names: config.functions.iter().map(|f| f.path.join(".")).collect(),
    });
    isolate.set_slot(bridge.clone());
    // Set once the VM can't safely run again (it hit its heap limit, or its
    // setup failed: then it keeps a bare context and refuses every eval
    // with this).
    let mut retired: Option<Failure> = None;
    let retire = |cause: String| fail(ErrorCode::IsolateRetired, cause);
    // Setup runs the embedder's `setup` shims: under the eval budget.
    bridge.deadline.set(watchdog.arm(timeout, cpu));
    let created = new_context(&mut isolate, &config, from_snapshot);
    bridge.deadline.set(None);
    let fired = watchdog.disarm() != Fired::No || bridge.timed_out.take();
    if isolate.is_execution_terminating() || fired || oom.hit.load(Ordering::SeqCst) {
        isolate.cancel_terminate_execution();
    }
    let (context, shims) = match created {
        Ok(created) if !fired && !oom.hit.load(Ordering::SeqCst) => created,
        failed => {
            retired = Some(match failed {
                _ if oom.hit.load(Ordering::SeqCst) => {
                    let (which, cause) = memory_limit_hit(&mut isolate, heap_limit);
                    limit(which, format!("the isolate's setup stopped: {cause}"))
                }
                _ if fired => limit("timeoutMs", "the isolate's setup shims ran past its time limit (limits.timeoutMs, limits.cpuMs)"),
                Err(f) => f,
                Ok(_) => unreachable!(),
            });
            v8::scope!(let scope, &mut isolate);
            let bare = v8::Context::new(scope, Default::default());
            (v8::Global::new(scope, bare), Shims { before: Vec::new(), after: Vec::new() })
        }
    };

    // Work between evals (timers, continuations) and its budget.
    let mut background = Background::new(config.limits.background_ms, cpu_clock);
    // Set when that budget runs out: the next eval fails with it, and the
    // isolate is retired.
    let mut background_hit: Option<Failure> = None;

    loop {
        // Between evals, wake for the next timer too (stateful isolates keep
        // theirs; see run_idle_timers), and to report background usage.
        let next_timer = if retired.is_none() { crate::web::timers::next_timer().map(|(due, _)| due) } else { None };
        let wake = match (next_timer, background.report_due()) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        let msg = match bridge.mailbox.idle(wake) {
            Ok(m) => m,
            Err(RecvTimeoutError::Timeout) if !crate::web::timers::next_timer().is_some_and(|(due, _)| due.is_zero()) || retired.is_some() => {
                // No timer is due: only a usage report was.
                background.report(&out, id, false, None);
                continue;
            }
            Err(RecvTimeoutError::Timeout) => {
                let cpu_start = cpu_clock.map(|c| c.now()).unwrap_or_default();
                let (wall, cpu_budget) = background.budgets(timeout, cpu);
                let batch = background.start(std::time::Duration::ZERO);
                bridge.deadline.set(watchdog.arm(wall, cpu_budget));
                bridge.timed_out.set(false);
                {
                    v8::scope_with_context!(scope, &mut isolate, &context);
                    run_idle_timers(scope);
                }
                bridge.deadline.set(None);
                let fired = watchdog.disarm() != Fired::No || bridge.timed_out.take();
                if isolate.is_execution_terminating() || fired || oom.hit.load(Ordering::SeqCst) {
                    isolate.cancel_terminate_execution();
                }
                let spent = usage(&mut isolate, cpu_clock, cpu_start);
                let heap_hit = oom.hit.load(Ordering::SeqCst);
                if let Some((r, hit)) = background.settle(batch, spent, heap_hit, &out, id, "timer callback") {
                    retired = Some(r);
                    background_hit = hit;
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        match msg {
            VmMsg::Dispose => break,
            VmMsg::Eval { req, code, filename, last } => {
                // Usage from before this eval goes out first.
                background.report(&out, id, true, None);
                if let Some(cause) = background_hit.take() {
                    send_result(&out, req, Err(cause), Usage::default());
                    continue;
                }
                if let Some(cause) = &retired {
                    send_result(&out, req, Err(cause.clone()), Usage::default());
                    continue;
                }
                let cpu_start = cpu_clock.map(|c| c.now()).unwrap_or_default();
                let deadline = watchdog.arm(timeout, cpu);
                bridge.deadline.set(deadline);
                bridge.timed_out.set(false);
                bridge.in_eval.set(true);
                bridge.host_calls.set(0);
                bridge.limit_hit.replace(None);
                let end = eval(&mut isolate, &context, &shims, &code, filename.as_deref(), &bridge.mailbox, deadline);
                pump_tasks(&isolate);
                bridge.in_eval.set(false);
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
                    let (which, cause) = memory_limit_hit(&mut isolate, heap_limit);
                    retired = Some(retire(format!("the isolate was terminated by an earlier eval ({cause}); create a new one")));
                    Err(limit(which, cause))
                } else if fired == Fired::Wall {
                    let ms = config.limits.timeout_ms.unwrap_or(0);
                    Err(limit("timeoutMs", format!("execution timed out after {ms}ms (limits.timeoutMs)")))
                } else if fired == Fired::Cpu {
                    let ms = config.limits.cpu_ms.unwrap_or(0);
                    Err(limit("cpuMs", format!("execution used more than {ms}ms of CPU time (limits.cpuMs)")))
                } else if let Some(hit) = bridge.limit_hit.take() {
                    Err(hit)
                } else {
                    result
                };
                let spent = usage(&mut isolate, cpu_clock, cpu_start);
                send_result(&out, req, result, spent);
                if last {
                    break;
                }
            }
            VmMsg::HostReply { call, reply } => {
                // A reply after its eval finished: the continuation it wakes
                // runs under the same budget as an eval.
                if retired.is_some() {
                    continue;
                }
                let cpu_start = cpu_clock.map(|c| c.now()).unwrap_or_default();
                let (wall, cpu_budget) = background.budgets(timeout, cpu);
                let batch = background.start(background::REPLY_COST);
                bridge.deadline.set(watchdog.arm(wall, cpu_budget));
                bridge.timed_out.set(false);
                {
                    v8::scope_with_context!(scope, &mut isolate, &context);
                    apply_host_reply(scope, call, reply);
                    scope.perform_microtask_checkpoint();
                    while pump_tasks(scope) {
                        scope.perform_microtask_checkpoint();
                    }
                    errors::report_rejections(scope);
                }
                bridge.deadline.set(None);
                let fired = watchdog.disarm() != Fired::No || bridge.timed_out.take();
                if isolate.is_execution_terminating() || fired || oom.hit.load(Ordering::SeqCst) {
                    isolate.cancel_terminate_execution();
                }
                let spent = usage(&mut isolate, cpu_clock, cpu_start);
                let heap_hit = oom.hit.load(Ordering::SeqCst);
                if let Some((r, hit)) = background.settle(batch, spent, heap_hit, &out, id, "continuation") {
                    retired = Some(r);
                    background_hit = hit;
                }
            }
        }
    }
    background.report(&out, id, true, None);
    watchdog.close();
    // The isolate holds a raw pointer to `oom`, and the context handle needs
    // a live isolate: drop in that order.
    drop(shims);
    drop(context);
    drop(isolate);
    drop(oom);
}
