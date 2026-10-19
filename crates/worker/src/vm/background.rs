//! Work a stateful isolate does between evals: timer callbacks, and
//! continuations of host calls nobody awaits any more. Evals have a budget
//! each; this work has none of its own, and nothing bounds how often it
//! runs, so it gets a budget per minute (`limits.backgroundMs`) as a token
//! bucket: it starts full, refills at `backgroundMs` per minute, and each
//! batch is armed with what's left, so no batch can overdraw it by more
//! than the watchdog's reaction time. An empty bucket retires the isolate.
//!
//! Time is CPU time on the VM thread where there's a CPU clock (Linux), and
//! wall time elsewhere, so the budget holds on every platform. Time blocked
//! in a sync host call counts too (it holds the VM thread without using
//! CPU), so a timer that waits on a slow host function drains the budget. A host-call
//! continuation is charged at least `REPLY_COST`: the round trip costs the
//! supervisor more than the guest's few microseconds of CPU, so a guest
//! looping on host calls after its eval returned (`for (;;) await f()`)
//! drains the budget at the rate it makes the host work.
//!
//! Usage reports for this work are coalesced (one frame per
//! `REPORT_EVERY` at most), so a timer firing every few milliseconds
//! doesn't flood the supervisor with frames.

use std::time::{Duration, Instant};

use crate::proto::{fail, limit, ErrorCode, Failure, Out, Usage};

use super::watchdog::CpuClock;
use super::Output;

const WINDOW: Duration = Duration::from_secs(60);
const REPORT_EVERY: Duration = Duration::from_millis(250);
pub(super) const REPLY_COST: Duration = Duration::from_micros(250);

pub(super) struct Background {
    /// The budget per `WINDOW`; None: unlimited.
    budget: Option<Duration>,
    left: Duration,
    refilled: Instant,
    clock: Option<CpuClock>,
    /// Usage not yet reported, and when the last report went out.
    unreported: Option<Usage>,
    reported: Instant,
}

/// One batch of background work in progress.
pub(super) struct Batch {
    wall_start: Instant,
    cpu_start: Duration,
    /// The least it's charged.
    floor: Duration,
    /// Time it spent blocked in sync host calls (see `blocked`).
    blocked: Duration,
}

impl Batch {
    /// The batch, done, having spent `blocked` waiting in sync host calls.
    pub(super) fn blocked(self, blocked: Duration) -> Batch {
        Batch { blocked, ..self }
    }
}

impl Background {
    pub(super) fn new(budget_ms: Option<u64>, clock: Option<CpuClock>) -> Background {
        let budget = budget_ms.map(|ms| Duration::from_millis(ms.min(crate::limits::MAX_BUDGET_MS)));
        let now = Instant::now();
        Background { budget, left: budget.unwrap_or_default(), refilled: now, clock, unreported: None, reported: now }
    }

    /// What's left of the budget now, if there is one.
    fn remaining(&mut self) -> Option<Duration> {
        let budget = self.budget?;
        let now = Instant::now();
        let refill = budget.mul_f64(now.duration_since(self.refilled).as_secs_f64() / WINDOW.as_secs_f64());
        self.left = (self.left + refill).min(budget);
        self.refilled = now;
        Some(self.left)
    }

    /// The watchdog's budgets for a batch: the eval budgets, capped by
    /// what's left of this one (on the CPU budget where there's a CPU
    /// clock, the wall budget elsewhere).
    pub(super) fn budgets(&mut self, wall: Option<Duration>, cpu: Option<Duration>) -> (Option<Duration>, Option<Duration>) {
        let cap = |limit: Option<Duration>, left: Duration| Some(limit.map_or(left, |l| l.min(left)));
        match self.remaining() {
            None => (wall, cpu),
            Some(left) if self.clock.is_some() => (wall, cap(cpu, left)),
            Some(left) => (cap(wall, left), cpu),
        }
    }

    /// Start a batch, charged at least `floor`.
    pub(super) fn start(&self, floor: Duration) -> Batch {
        Batch { wall_start: Instant::now(), cpu_start: self.clock.map(|c| c.now()).unwrap_or_default(), floor, blocked: Duration::ZERO }
    }

    /// Charge a finished batch, plus the time it spent blocked in sync host
    /// calls where time is CPU time (wall time already includes it);
    /// returns whether the budget ran out.
    fn finish(&mut self, batch: Batch) -> bool {
        let spent = match self.clock {
            Some(c) => c.now().saturating_sub(batch.cpu_start) + batch.blocked,
            None => batch.wall_start.elapsed(),
        }
        .max(batch.floor);
        if self.budget.is_none() {
            return false;
        }
        self.left = self.left.saturating_sub(spent);
        self.left.is_zero()
    }

    /// Add a batch's usage to the next report.
    fn record(&mut self, usage: Usage) {
        self.unreported = Some(match self.unreported.take() {
            None => usage,
            Some(before) => Usage {
                cpu_us: match (before.cpu_us, usage.cpu_us) {
                    (None, None) => None,
                    (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
                },
                // Memory is a level, not a sum: the latest.
                heap_bytes: usage.heap_bytes,
                external_bytes: usage.external_bytes,
            },
        });
    }

    /// How long until unreported usage is due to go out, if there is any.
    pub(super) fn report_due(&self) -> Option<Duration> {
        self.unreported.map(|_| (self.reported + REPORT_EVERY).saturating_duration_since(Instant::now()))
    }

    /// Send unreported usage now if it's due (or `force`), with the limit
    /// this work hit, if any.
    pub(super) fn report(&mut self, out: &Output, vm: u64, force: bool, hit: Option<(&'static str, &str)>) {
        if !force && hit.is_none() && self.report_due().is_none_or(|d| !d.is_zero()) {
            return;
        }
        if self.unreported.is_none() && hit.is_none() {
            return;
        }
        let usage = self.unreported.take().unwrap_or_default();
        self.reported = Instant::now();
        out.send(&Out::Usage { vm, usage, limit: hit.map(|h| h.0), message: hit.map(|h| h.1) });
    }

    /// After a batch: charge it, report its usage, and say whether the
    /// isolate is retired (`heap_hit`: it hit its heap limit; or this
    /// budget ran out, which the next eval fails with).
    pub(super) fn settle(&mut self, batch: Batch, spent: Usage, heap_hit: bool, out: &Output, vm: u64, what: &str) -> Option<(Failure, Option<Failure>)> {
        let exhausted = self.finish(batch);
        self.record(spent);
        let retire = |cause: String| fail(ErrorCode::IsolateRetired, cause);
        if heap_hit {
            self.report(out, vm, true, None);
            return Some((retire(format!("the isolate was terminated by an earlier {what} (heap limit); create a new one")), None));
        }
        if !exhausted {
            self.report(out, vm, false, None);
            return None;
        }
        let ms = self.budget.unwrap_or_default().as_millis();
        let of = if self.clock.is_some() { "CPU time" } else { "time" };
        let cause = format!("the isolate's timers and continuations used more than {ms}ms of {of} per minute between evals (limits.backgroundMs)");
        self.report(out, vm, true, Some(("backgroundMs", &cause)));
        Some((retire(format!("the isolate was retired: {cause}; create a new one")), Some(limit("backgroundMs", cause))))
    }
}
