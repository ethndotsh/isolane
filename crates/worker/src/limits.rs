//! Per-isolate limits the worker enforces inside the guest (the supervisor
//! enforces the rest). Each VM runs on its own thread, so the current VM's
//! limits are thread-local; defaults apply when the supervisor sends none.

use std::cell::Cell;

use serde::Deserialize;

#[derive(Clone, Copy, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GuestLimits {
    /// Live timers (setTimeout/setInterval); more throws a RangeError.
    pub timers: u32,
    /// Console output per eval; the rest is dropped.
    pub log_bytes_per_eval: usize,
    /// Longest single console message; longer ones are cut.
    pub log_message_bytes: usize,
    /// Largest completion value (as JSON); larger fails the eval.
    pub result_bytes: usize,
    /// Most output one decompression call may produce.
    pub decompressed_bytes: usize,
}

impl Default for GuestLimits {
    fn default() -> Self {
        GuestLimits {
            timers: 10_000,
            log_bytes_per_eval: 1 << 20,
            log_message_bytes: 16 << 10,
            result_bytes: 16 << 20,
            decompressed_bytes: 128 << 20,
        }
    }
}

thread_local! {
    static CURRENT: Cell<Option<GuestLimits>> = const { Cell::new(None) };
}

/// Use `limits` for this thread's VM.
pub fn set(limits: GuestLimits) {
    CURRENT.with(|c| c.set(Some(limits)));
}

/// The current VM's limits.
pub fn get() -> GuestLimits {
    CURRENT.with(|c| c.get()).unwrap_or_default()
}
