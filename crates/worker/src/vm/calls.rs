//! Concurrent calls (`instances.concurrency` above 1): a program's instance
//! runs up to that many calls at once on its one thread and event loop, and
//! sends each call's result as soon as it settles. Calls that arrive while
//! others run join them, until every call has settled.
//!
//! Each call has its own wall clock (`limits.timeoutMs` from its start).
//! The other per-eval budgets belong to the instance while its calls run:
//! `limits.cpuMs`, `hostCalls`, and `logBytes` each grow by their amount
//! for every call that joins, and a call that settles after a count limit
//! was hit fails with it. A call stopped part-way (its timeout, the shared
//! CPU budget, its signal, or the heap limit) stops them all and retires
//! the instance: the calls that hit the limit fail with it, and the rest
//! with `ERR_ISOLATE_RETIRED`.

use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use super::context::Shims;
use super::eval::{self, send_result, usage, Flight, Outcome};
use super::watchdog::{CpuClock, Fired};
use super::{errors, memory_limit_hit, pump_tasks, Guard, Job, Output, VmMsg};
use crate::proto::{fail, limit, ErrorCode, Failure};
use crate::web::timers::NextTimer;

/// How often to look for V8's foreground tasks while it has background work
/// in flight and nothing else to wait for (as `eval::settle` does).
const BACKGROUND_POLL: Duration = Duration::from_millis(1);

/// A call in flight.
struct InFlight {
    req: u64,
    flight: Flight,
    /// When its `limits.timeoutMs` runs out.
    deadline: Option<Instant>,
}

/// What the instance's concurrent calls need of the VM.
pub(super) struct Calls<'a> {
    pub(super) id: u64,
    pub(super) out: &'a Output,
    pub(super) context: &'a v8::Global<v8::Context>,
    pub(super) shims: &'a Shims,
    pub(super) guard: &'a Guard<'a>,
    pub(super) cpu_clock: Option<CpuClock>,
    pub(super) concurrency: usize,
    pub(super) timeout: Option<Duration>,
    pub(super) cpu: Option<Duration>,
    pub(super) heap_limit: usize,
}

/// How the calls ended.
pub(super) enum CallsEnd {
    /// Every call settled (and its result was sent).
    Settled,
    /// Calls were stopped part-way (their results were sent): what the
    /// isolate's later evals fail with.
    Retired(Failure),
    Disposed,
}

/// How driving the calls ended, inside the guarded run.
enum Drive {
    Settled,
    /// Stopped: the calls still in flight, and those whose own deadline
    /// passed while they waited.
    Stopped {
        flights: Vec<(u64, Option<Instant>)>,
        late: Vec<u64>,
    },
    Disposed,
}

impl Calls<'_> {
    /// Run call `req` (`job`), and every call that joins it, until all have
    /// settled.
    pub(super) fn run(&self, isolate: &mut v8::OwnedIsolate, req: u64, job: Job) -> CallsEnd {
        let bridge = self.guard.bridge;
        let watchdog = self.guard.watchdog;
        if !watchdog.begin_eval(req) {
            let aborted = fail(ErrorCode::Aborted, "the eval was aborted");
            send_result(
                self.out,
                (self.id, req),
                Err(aborted),
                Default::default(),
                None,
            );
            return CallsEnd::Settled;
        }
        let limits = crate::limits::get();
        bridge.in_eval.set(true);
        bridge.in_setup.set(false);
        bridge.setup_io.set(false);
        bridge.host_calls.set(0);
        bridge.host_call_budget.set(limits.host_calls);
        bridge.limit_hit.replace(None);
        let mut cpu_start = self.cpu_clock.map(|c| c.now()).unwrap_or_default();
        let ((drive, (which, aborted)), fired) =
            self.guard
                .run(isolate, self.timeout, self.cpu, |isolate, deadline| {
                    v8::scope_with_context!(scope, isolate, self.context);
                    v8::tc_scope!(let tc, scope);
                    let drive = self.drive(tc, (req, job, deadline), &mut cpu_start);
                    if !matches!(drive, Drive::Disposed) {
                        tc.reset();
                        errors::report_rejections(tc);
                    }
                    // Which budget ran out, and whose abort, before the guard disarms.
                    (drive, watchdog.peek())
                });
        let fired = if which == Fired::No { fired } else { which };
        bridge.in_eval.set(false);
        let hit = bridge.limit_hit.take().is_some();
        let (flights, late) = match drive {
            Drive::Disposed => return CallsEnd::Disposed,
            Drive::Settled => {
                if hit {
                    bridge.pending.borrow_mut().clear();
                    bridge.pending_bytes.set(0);
                }
                return CallsEnd::Settled;
            }
            Drive::Stopped { flights, late } => (flights, late),
        };
        // Stopped part-way: say which limit, fail every call in flight, and
        // retire the isolate.
        let ms = |v: Option<u64>| v.unwrap_or(0);
        let oom = self
            .guard
            .oom
            .hit()
            .then(|| memory_limit_hit(isolate, self.heap_limit));
        let (why, culprits, failure): (&str, Vec<u64>, Failure) = if let Some((which, cause)) = oom
        {
            let all = flights.iter().map(|(r, _)| *r).collect();
            (which, all, limit(which, cause))
        } else {
            match fired {
                Fired::Cpu => (
                    "limits.cpuMs",
                    flights.iter().map(|(r, _)| *r).collect(),
                    limit(
                        "cpuMs",
                        format!(
                            "the instance's calls used more than their {}ms of CPU time each (limits.cpuMs, shared by the calls running at once)",
                            ms(limits.cpu_ms)
                        ),
                    ),
                ),
                Fired::Aborted => (
                    "its signal was aborted",
                    aborted.into_iter().collect(),
                    fail(ErrorCode::Aborted, "the eval was aborted"),
                ),
                Fired::Wall | Fired::No => {
                    let now = Instant::now();
                    let mut late = late;
                    let passed: Vec<u64> = flights
                        .iter()
                        .filter(|(r, d)| d.is_some_and(|d| d <= now) && !late.contains(r))
                        .map(|(r, _)| *r)
                        .collect();
                    late.extend(passed);
                    // The watchdog fired for the earliest deadline.
                    if late.is_empty() {
                        late.extend(flights.first().map(|(r, _)| *r));
                    }
                    (
                        "limits.timeoutMs",
                        late,
                        limit(
                            "timeoutMs",
                            format!("execution timed out after {}ms (limits.timeoutMs)", ms(limits.timeout_ms)),
                        ),
                    )
                }
            }
        };
        let retired = fail(
            ErrorCode::IsolateRetired,
            format!("the isolate was retired: an earlier eval was stopped part-way ({why}), so its state may be inconsistent; create a new one"),
        );
        let sibling = fail(
            ErrorCode::IsolateRetired,
            format!("the instance was retired while this call ran: another call in it was stopped part-way ({why})"),
        );
        bridge.pending.borrow_mut().clear();
        bridge.pending_bytes.set(0);
        let mut spent = usage(isolate, self.cpu_clock, cpu_start);
        for (req, _) in flights {
            let result = if culprits.contains(&req) {
                failure.clone()
            } else {
                sibling.clone()
            };
            send_result(self.out, (self.id, req), Err(result), spent, Some(&retired));
            // The CPU went to the first result.
            spent.cpu_us = spent.cpu_us.map(|_| 0);
        }
        CallsEnd::Retired(retired)
    }

    fn drive(
        &self,
        tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>,
        (req, job, deadline): (u64, Job, Option<Instant>),
        cpu_start: &mut Duration,
    ) -> Drive {
        let bridge = self.guard.bridge;
        let watchdog = self.guard.watchdog;
        let limits = crate::limits::get();
        let mut flights: Vec<InFlight> = Vec::with_capacity(self.concurrency);
        let stopped = |flights: &[InFlight], late: Vec<u64>| Drive::Stopped {
            flights: flights.iter().map(|f| (f.req, f.deadline)).collect(),
            late,
        };
        // Stopped while call `req` was starting.
        let stopped_starting = |flights: &[InFlight], req: u64, deadline: Option<Instant>| {
            let mut all: Vec<(u64, Option<Instant>)> =
                flights.iter().map(|f| (f.req, f.deadline)).collect();
            all.push((req, deadline));
            Drive::Stopped {
                flights: all,
                late: Vec::new(),
            }
        };
        let terminated = |tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>| {
            tc.has_terminated()
                || watchdog.fired()
                || self.guard.oom.hit()
                || bridge.timed_out.get()
        };
        let mut joining = Some((req, job, deadline));
        loop {
            // A call to start: the first, or one that joined.
            if let Some((req, job, deadline)) = joining.take() {
                let log_left = bridge.log_budget.get();
                let started = eval::start(tc, self.shims, &job);
                if !flights.is_empty() {
                    bridge
                        .log_budget
                        .set(log_left.saturating_add(limits.log_bytes));
                }
                if terminated(tc) {
                    return stopped_starting(&flights, req, deadline);
                }
                match started {
                    Ok(flight) => flights.push(InFlight {
                        req,
                        flight,
                        deadline,
                    }),
                    Err(f) => self.finish(tc, req, Err(f), cpu_start),
                }
            }
            tc.perform_microtask_checkpoint();
            if terminated(tc) {
                return stopped(&flights, Vec::new());
            }
            let mut i = 0;
            while i < flights.len() {
                match flights[i].flight.advance(tc, self.shims) {
                    None => i += 1,
                    Some(result) => {
                        if terminated(tc) {
                            return stopped(&flights, Vec::new());
                        }
                        let done = flights.remove(i);
                        self.finish(tc, done.req, result, cpu_start);
                        self.rearm(&flights);
                    }
                }
            }
            if flights.is_empty() {
                return Drive::Settled;
            }
            let now = Instant::now();
            let late: Vec<u64> = flights
                .iter()
                .filter(|f| f.deadline.is_some_and(|d| d <= now))
                .map(|f| f.req)
                .collect();
            if !late.is_empty() {
                return stopped(&flights, late);
            }
            // The stages just started may have queued microtasks that settle
            // them: run those and look again before waiting.
            tc.perform_microtask_checkpoint();
            let settled = flights.iter().any(|f| {
                f.flight
                    .promise(tc)
                    .is_none_or(|p| p.state() != v8::PromiseState::Pending)
            });
            if settled {
                continue;
            }
            if pump_tasks(tc) {
                continue;
            }
            // One due timer per turn, then microtasks again.
            if crate::web::timers::run_due_timer(tc) {
                continue;
            }
            let waiting = !bridge.pending.borrow().is_empty();
            let background = tc.has_pending_background_tasks();
            let timer = crate::web::timers::next_timer();
            let timers = timer.is_some_and(|timer| timer.refed);
            if !waiting && !background && !timers {
                // Nothing can settle the calls still in flight.
                let unsettled = fail(
                    ErrorCode::Unsettled,
                    "promise never settled: there are no timers or I/O, only host functions",
                );
                for done in flights.drain(..) {
                    let result = Err(done.flight.failed(unsettled.clone(), self.shims));
                    self.finish(tc, done.req, result, cpu_start);
                }
                return Drive::Settled;
            }
            errors::report_rejections(tc);
            // Wait for a host reply, the next timer, a call to join, or
            // (with V8 work in flight) briefly.
            let earliest = flights.iter().filter_map(|f| f.deadline).min();
            let mut wait = earliest.map(|d| d.saturating_duration_since(now));
            if background {
                wait = Some(wait.map_or(BACKGROUND_POLL, |w| w.min(BACKGROUND_POLL)));
            }
            if let Some(NextTimer { due, .. }) = timer {
                wait = Some(wait.map_or(due, |w| w.min(due)));
            }
            let room = flights.len() < self.concurrency;
            let msg = match bridge.mailbox.during_calls(wait, room) {
                Ok(m) => m,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return Drive::Disposed,
            };
            match msg {
                VmMsg::HostReply { call, reply } => {
                    super::host_call::apply_host_reply(tc, call, reply)
                }
                VmMsg::Dispose => return Drive::Disposed,
                VmMsg::Wake => {}
                VmMsg::Eval { req, job, .. } => {
                    if !watchdog.begin_eval(req) {
                        let aborted = fail(ErrorCode::Aborted, "the eval was aborted");
                        send_result(
                            self.out,
                            (self.id, req),
                            Err(aborted),
                            Default::default(),
                            None,
                        );
                        continue;
                    }
                    // Its own budgets: its wall clock, and one more call's
                    // worth of the instance's.
                    let deadline = self.timeout.map(|t| Instant::now() + t);
                    bridge.host_call_budget.set(
                        bridge
                            .host_call_budget
                            .get()
                            .saturating_add(limits.host_calls),
                    );
                    let earliest = flights
                        .iter()
                        .filter_map(|f| f.deadline)
                        .chain(deadline)
                        .min();
                    watchdog.extend(earliest, self.cpu);
                    bridge.deadline.set(earliest);
                    joining = Some((req, job, deadline));
                }
            }
        }
    }

    /// Call `req` settled: send its result (failing it with a count limit
    /// the calls hit) with the CPU since the last result.
    fn finish(
        &self,
        tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>,
        req: u64,
        result: Result<Outcome, Failure>,
        cpu_start: &mut Duration,
    ) {
        let bridge = self.guard.bridge;
        self.guard.watchdog.end_eval(req);
        let result = match bridge.limit_hit.borrow().as_ref() {
            Some(hit) => Err(hit.clone()),
            None => result,
        };
        let spent = usage(tc, self.cpu_clock, *cpu_start);
        *cpu_start = self.cpu_clock.map(|c| c.now()).unwrap_or_default();
        send_result(self.out, (self.id, req), result, spent, None);
    }

    /// The calls left in flight: the wall-clock deadline is the earliest of theirs.
    fn rearm(&self, flights: &[InFlight]) {
        let earliest = flights.iter().filter_map(|f| f.deadline).min();
        self.guard.watchdog.extend(earliest, None);
        self.guard.bridge.deadline.set(earliest);
    }
}
