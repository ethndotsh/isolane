//! The wall clock guest code sees (Date, Intl's default "now", Temporal.Now).
//!
//! Each VM thread's clock is frozen, and moves forward only at I/O: when an
//! eval starts and when a host function's reply arrives (Cloudflare Workers'
//! rule). Guest code can't time itself, which, with SharedArrayBuffer and
//! Atomics gone, leaves it no high-resolution timer for side channels.
//! Threads that never froze a clock (V8's background threads) see real time.

use std::cell::Cell;
use std::time::{SystemTime, UNIX_EPOCH};

thread_local! {
    static NOW: Cell<Option<f64>> = const { Cell::new(None) };
}

/// Move this thread's clock to the current time, in whole milliseconds.
pub fn advance() {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
    NOW.with(|now| now.set(Some(ms)));
}

/// The platform's clock callback.
pub extern "C" fn platform_clock(real_ms: f64) -> f64 {
    NOW.with(|now| now.get()).unwrap_or(real_ms)
}
