//! An isolate's limits, as the supervisor sends them (`limits` in the public
//! config, same names). The worker enforces these; the supervisor enforces
//! the tenant- and runtime-level ones. Each VM runs on its own thread, so the
//! current VM's limits are thread-local; defaults apply to any field the
//! supervisor leaves out.

use std::cell::Cell;
use std::time::Duration;

use serde::Deserialize;

#[derive(Clone, Copy, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Limits {
    /// Wall-clock budget per eval (and per continuation). None: no limit.
    pub timeout_ms: Option<u64>,
    /// CPU time per eval (and per continuation), Linux only. None: no limit.
    pub cpu_ms: Option<u64>,
    /// CPU time for a program's setup (evaluating its modules), Linux
    /// only, in place of `cpu_ms`. None: no limit.
    pub startup_cpu_ms: Option<u64>,
    /// The V8 heap; exceeding it retires the isolate. None: V8's default.
    pub heap_bytes: Option<u64>,
    /// Live timers (setTimeout/setInterval); more throws a RangeError.
    pub timers: u32,
    /// Time per minute for work between evals (timers, continuations):
    /// CPU time where there's a CPU clock (Linux), wall time elsewhere.
    /// None: no limit.
    pub background_ms: Option<u64>,
    /// The same, for every isolate on this worker together (the tenant's
    /// `limits.workerBackgroundMs`; the same in every create). Running out
    /// pauses background work instead of retiring anything. None: no limit.
    pub worker_background_ms: Option<u64>,
    /// Console output per eval; the rest is dropped.
    pub log_bytes: usize,
    /// Longest single console line; longer ones are cut.
    pub log_line_bytes: usize,
    /// Largest completion value (as JSON); larger fails the eval.
    pub result_bytes: usize,
    /// Most output one decompression call may produce.
    pub decompressed_bytes: usize,
    /// Async host calls waiting for a reply at once; another throws a
    /// RangeError (and fails the eval it's in).
    pub pending_host_calls: usize,
    /// Host calls per eval (isolane's own fetch, connect, and fs calls
    /// aside); another throws a RangeError and fails the eval.
    pub host_calls: u64,
    /// Frame bytes (arguments and all) of host calls waiting for replies
    /// at once; a call past it throws a RangeError and fails the eval.
    pub pending_host_call_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            timeout_ms: None,
            cpu_ms: None,
            startup_cpu_ms: None,
            heap_bytes: None,
            timers: 10_000,
            background_ms: None,
            worker_background_ms: None,
            log_bytes: 1 << 20,
            log_line_bytes: 16 << 10,
            result_bytes: 16 << 20,
            decompressed_bytes: 128 << 20,
            pending_host_calls: 1_000,
            host_calls: 10_000,
            pending_host_call_bytes: 16 << 20,
        }
    }
}

/// The longest budget a deadline is computed from (about 24.8 days, the
/// supervisor's maximum): Instant + Duration panics on overflow, which
/// would abort the worker.
pub const MAX_BUDGET_MS: u64 = (1 << 31) - 1;

impl Limits {
    pub fn timeout(&self) -> Option<Duration> {
        self.timeout_ms
            .map(|ms| Duration::from_millis(ms.min(MAX_BUDGET_MS)))
    }

    pub fn cpu(&self) -> Option<Duration> {
        self.cpu_ms
            .map(|ms| Duration::from_millis(ms.min(MAX_BUDGET_MS)))
    }

    pub fn startup_cpu(&self) -> Option<Duration> {
        self.startup_cpu_ms
            .map(|ms| Duration::from_millis(ms.min(MAX_BUDGET_MS)))
    }
}

thread_local! {
    static CURRENT: Cell<Option<Limits>> = const { Cell::new(None) };
}

/// Use `limits` for this thread's VM.
pub fn set(limits: Limits) {
    CURRENT.with(|c| c.set(Some(limits)));
}

/// The current VM's limits.
pub fn get() -> Limits {
    CURRENT.with(|c| c.get()).unwrap_or_default()
}
