//! The wall clock guest code sees (Date, Intl's default "now", Temporal.Now),
//! chosen per VM:
//! - Frozen (default): moves forward only at I/O, when an eval starts and
//!   when a host function's reply arrives (Cloudflare Workers' rule). Guest
//!   code can't time itself, which, with SharedArrayBuffer and Atomics gone,
//!   leaves it no high-resolution timer for side channels.
//! - Real: the real clock.
//! - Fixed: one instant, forever (reproducible runs).
//! Each VM runs on its own thread, so the state is thread-local. Threads that
//! never set a clock (V8's background threads) see real time.

use std::cell::Cell;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum Mode {
    #[default]
    Frozen,
    Real,
    #[serde(rename_all = "camelCase")]
    Fixed { fixed_ms: f64 },
}

thread_local! {
    static MODE: Cell<Mode> = const { Cell::new(Mode::Real) };
    static NOW: Cell<Option<f64>> = const { Cell::new(None) };
    // The monotonic clock behind `performance` (web platform): when the VM
    // started, its wall-clock time then, and (frozen mode) the elapsed time
    // as of the last I/O.
    static START: Cell<Option<Instant>> = const { Cell::new(None) };
    static ORIGIN_MS: Cell<f64> = const { Cell::new(0.0) };
    static ELAPSED: Cell<Duration> = const { Cell::new(Duration::ZERO) };
}

fn wall_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

/// Use `mode` for this thread's VM.
pub fn set_mode(mode: Mode) {
    MODE.with(|m| m.set(mode));
    START.with(|s| s.set(Some(Instant::now())));
    ELAPSED.with(|e| e.set(Duration::ZERO));
    ORIGIN_MS.with(|o| {
        o.set(match mode {
            Mode::Fixed { fixed_ms } => fixed_ms,
            _ => wall_ms().floor(),
        })
    });
    NOW.with(|now| {
        now.set(match mode {
            Mode::Fixed { fixed_ms } => Some(fixed_ms),
            _ => None,
        })
    });
    advance();
}

/// I/O happened: a frozen clock moves to the current time, in whole ms.
pub fn advance() {
    if let Mode::Frozen = MODE.with(|m| m.get()) {
        let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
        NOW.with(|now| now.set(Some(ms)));
        let elapsed = START.with(|s| s.get()).map(|s| s.elapsed()).unwrap_or_default();
        // Whole milliseconds, like the frozen Date.
        ELAPSED.with(|e| e.set(Duration::from_millis(elapsed.as_millis() as u64)));
    }
}

/// `performance.now()`: time since the VM started, under the VM's clock
/// mode (frozen: as of the last I/O; fixed: always zero).
pub fn performance_now() -> Duration {
    match MODE.with(|m| m.get()) {
        Mode::Frozen => ELAPSED.with(|e| e.get()),
        Mode::Real => START.with(|s| s.get()).map(|s| s.elapsed()).unwrap_or_default(),
        Mode::Fixed { .. } => Duration::ZERO,
    }
}

/// `performance.timeOrigin`: the VM's start, in ms since the epoch.
pub fn time_origin_ms() -> f64 {
    ORIGIN_MS.with(|o| o.get())
}

/// The platform's clock callback.
#[cfg_attr(feature = "dev-prebuilt", allow(dead_code))]
pub extern "C" fn platform_clock(real_ms: f64) -> f64 {
    NOW.with(|now| now.get()).unwrap_or(real_ms)
}
