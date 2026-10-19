//! The per-isolate watchdog: a thread that terminates the isolate when an
//! armed budget runs out, either a wall-clock deadline or CPU time used by
//! the VM thread. `TerminateExecution` is thread-safe and stops
//! JIT-compiled code as well as the interpreter.

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const WATCHDOG_STACK: usize = 64 << 10;

/// How often the watchdog samples a CPU budget.
const CPU_POLL: Duration = Duration::from_millis(2);

/// A thread's CPU clock, readable from another thread (Linux:
/// `pthread_getcpuclockid`). Elsewhere CPU budgets aren't enforced.
#[derive(Clone, Copy)]
pub(super) struct CpuClock(#[cfg(target_os = "linux")] libc::clockid_t);

impl CpuClock {
    /// The calling thread's clock.
    pub(super) fn current() -> Option<CpuClock> {
        #[cfg(target_os = "linux")]
        // SAFETY: pthread_self() is always valid for the calling thread, and
        // `id` is a valid out-pointer.
        unsafe {
            let mut id: libc::clockid_t = 0;
            (libc::pthread_getcpuclockid(libc::pthread_self(), &mut id) == 0).then_some(CpuClock(id))
        }
        #[cfg(not(target_os = "linux"))]
        None
    }

    pub(super) fn now(self) -> Duration {
        #[cfg(target_os = "linux")]
        // SAFETY: `ts` is a valid out-pointer; the clock id came from
        // pthread_getcpuclockid for a thread that outlives this watchdog.
        unsafe {
            let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
            libc::clock_gettime(self.0, &mut ts);
            Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
        }
        #[cfg(not(target_os = "linux"))]
        Duration::ZERO
    }
}

/// Which budget ran out.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Fired {
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

pub(super) struct Watchdog {
    state: Mutex<WatchState>,
    cv: Condvar,
    cpu: Option<CpuClock>,
}

impl Watchdog {
    /// Call on the VM thread (its CPU clock is the one budgets measure).
    pub(super) fn start(handle: v8::IsolateHandle) -> std::io::Result<Arc<Watchdog>> {
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
    pub(super) fn arm(&self, wall: Option<Duration>, cpu: Option<Duration>) -> Option<Instant> {
        let deadline = wall.map(|t| Instant::now() + t);
        let cpu_deadline = cpu.and_then(|c| self.cpu.map(|clock| clock.now() + c));
        let mut s = self.state.lock().unwrap();
        s.deadline = deadline;
        s.cpu_deadline = cpu_deadline;
        s.fired = Fired::No;
        self.cv.notify_one();
        deadline
    }

    /// Has a budget run out since the last `arm`?
    pub(super) fn fired(&self) -> bool {
        self.state.lock().unwrap().fired != Fired::No
    }

    /// Disarm; returns which budget ran out, if one did.
    pub(super) fn disarm(&self) -> Fired {
        let mut s = self.state.lock().unwrap();
        s.deadline = None;
        s.cpu_deadline = None;
        std::mem::replace(&mut s.fired, Fired::No)
    }

    pub(super) fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.cv.notify_one();
    }
}
