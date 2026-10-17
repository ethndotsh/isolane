//! Length-prefixed JSON frames over the worker's stdin/stdout: a u32
//! little-endian byte length, then that many bytes of UTF-8 JSON.

use std::io::{self, Read, Write};
use std::sync::Mutex;

/// Largest frame either side accepts. Bigger frames are a protocol error,
/// not a reason to allocate.
pub const MAX_FRAME: usize = 64 << 20;

/// Read one frame. `Ok(None)` on a clean EOF between frames.
pub fn read_frame(r: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("frame of {len} bytes exceeds the limit")));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

/// Serializes whole frames from any thread.
pub struct Writer<W: Write> {
    inner: Mutex<W>,
}

impl<W: Write> Writer<W> {
    pub fn new(inner: W) -> Self {
        Writer { inner: Mutex::new(inner) }
    }

    /// Write one frame. A write failure means the supervisor is gone, and a
    /// worker without a supervisor has nothing left to do.
    pub fn send(&self, msg: &impl serde::Serialize) {
        let body = serde_json::to_vec(msg).expect("protocol messages serialize");
        let mut w = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let ok = w
            .write_all(&(body.len() as u32).to_le_bytes())
            .and_then(|_| w.write_all(&body))
            .and_then(|_| w.flush());
        if ok.is_err() {
            std::process::exit(0);
        }
    }
}
