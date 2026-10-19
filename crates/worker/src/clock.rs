//! The wall clock guest code sees (Date, Intl's default "now", Temporal.Now),
//! chosen per VM:
//! - Frozen (default): moves forward only at I/O, when an eval starts and
//!   when a host function's reply arrives (Cloudflare Workers' rule). Guest
//!   code can't time itself, which, with SharedArrayBuffer and Atomics gone,
//!   leaves it no high-resolution timer for side channels.
//! - Realtime: the real clock.
//! - Fixed: one instant, forever (reproducible runs).
//! Each VM runs on its own thread, so the state is thread-local. Threads that
//! never set a clock (V8's background threads) see real time.

use std::cell::Cell;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum Mode {
    #[default]
    Frozen,
    Realtime,
    #[serde(rename_all = "camelCase")]
    Fixed { fixed_ms: f64 },
}

thread_local! {
    static MODE: Cell<Mode> = const { Cell::new(Mode::Realtime) };
    static NOW: Cell<Option<f64>> = const { Cell::new(None) };
}

/// Use `mode` for this thread's VM.
pub fn set_mode(mode: Mode) {
    MODE.with(|m| m.set(mode));
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
    }
}

/// The platform's clock callback.
pub extern "C" fn platform_clock(real_ms: f64) -> f64 {
    NOW.with(|now| now.get()).unwrap_or(real_ms)
}
