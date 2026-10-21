//! Timers (setTimeout, setInterval, AbortSignal.timeout): the Rust half of
//! the event loop. The timers themselves live in JS (runtime/core.js keeps
//! a heap); this side tells the VM's loop when the next one is due and runs
//! the due ones, one task at a time.
//!
//! - Scheduling uses the real monotonic clock (ms since the VM thread first
//!   asked), whatever the guest's wall clock does.
//! - Firing a timer is an I/O event: a frozen guest clock moves forward
//!   first, so `Date.now()` after a 50 ms timer has moved about 50 ms.
//! - Each call runs at most one timer callback, so the VM loop runs a
//!   microtask checkpoint between callbacks, as HTML's task model has it.
//! - Each VM runs on its own thread, so the state is thread-local.

use std::cell::Cell;
use std::time::{Duration, Instant};

use super::{Args, Rv};

thread_local! {
    static ORIGIN: Cell<Option<Instant>> = const { Cell::new(None) };
    /// What JS last reported: the earliest live timer's deadline (ms on the
    /// timer clock; infinite for none), and how many live timers are
    /// ref'd (keep a pending eval waiting for them).
    static NEXT: Cell<f64> = const { Cell::new(f64::INFINITY) };
    static REFED: Cell<u32> = const { Cell::new(0) };
}

/// The function runtime/core.js registers to run one due timer.
pub struct TimerRunner(pub v8::Global<v8::Function>);

fn now_ms() -> f64 {
    let origin = ORIGIN.with(|o| match o.get() {
        Some(t) => t,
        None => {
            let t = Instant::now();
            o.set(Some(t));
            t
        }
    });
    origin.elapsed().as_secs_f64() * 1000.0
}

/// native.timerNow() → ms on the timer clock.
pub fn timer_now(_: &mut v8::PinScope, _args: Args, mut rv: Rv) {
    rv.set_double(now_ms());
}

/// native.timerState(nextDeadline, refedCount): called by JS whenever the
/// earliest deadline or the ref'd count changes.
pub fn timer_state(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    let next = args.get(0).number_value(scope).unwrap_or(f64::INFINITY);
    let refed = args.get(1).uint32_value(scope).unwrap_or(0);
    NEXT.with(|n| n.set(if next.is_nan() { f64::INFINITY } else { next }));
    REFED.with(|r| r.set(refed));
}

/// native.setTimerRunner(fn), once per context.
pub fn set_timer_runner(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    if let Ok(f) = v8::Local::<v8::Function>::try_from(args.get(0)) {
        let runner = TimerRunner(v8::Global::new(scope, f));
        scope.set_slot(std::rc::Rc::new(runner));
    }
}

/// When the next timer is due, and whether any ref'd timer is live.
#[derive(Clone, Copy)]
pub struct NextTimer {
    pub due: Duration,
    /// A ref'd timer keeps a pending eval from being unsettled.
    pub refed: bool,
}

/// The next timer, if any.
pub fn next_timer() -> Option<NextTimer> {
    let next = NEXT.with(|n| n.get());
    if !next.is_finite() {
        return None;
    }
    let wait = (next - now_ms()).max(0.0);
    Some(NextTimer {
        due: Duration::from_secs_f64(wait / 1000.0),
        refed: REFED.with(|r| r.get()) > 0,
    })
}

/// Run one due timer's callback (after moving a frozen clock forward).
/// Returns whether one ran. Exceptions in callbacks are reported by the JS
/// side; a termination propagates.
pub fn run_due_timer(scope: &mut v8::PinScope) -> bool {
    let now = now_ms();
    if NEXT.with(|n| n.get()) > now {
        return false;
    }
    let Some(runner) = scope.get_slot::<std::rc::Rc<TimerRunner>>().cloned() else {
        return false;
    };
    crate::clock::advance();
    let f = v8::Local::new(scope, &runner.0);
    let recv: v8::Local<v8::Value> = v8::undefined(scope).into();
    let now: v8::Local<v8::Value> = v8::Number::new(scope, now).into();
    f.call(scope, recv, &[now]);
    true
}
