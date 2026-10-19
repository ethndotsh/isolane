//! Length-prefixed frames over the worker's stdin/stdout: a u32
//! little-endian byte length, then that many bytes of either
//! - UTF-8 JSON (it starts with `{`), or
//! - a frame with bytes attached: a 0x00 tag, a u32 little-endian length of
//!   the JSON that follows, the JSON, then raw bytes. The JSON says which
//!   values the bytes are (`bin` in host calls and host replies).

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

/// Tags a frame with bytes attached (a JSON frame starts with `{`).
const BINARY_TAG: u8 = 0;
/// Tag and JSON length, before a binary frame's JSON.
const BINARY_HEADER: usize = 5;

/// Whether a message of `json` bytes plus `attached` bytes fits in a frame.
/// Callers check before sending what guest code controls: an oversized
/// frame is a protocol violation for the supervisor.
pub fn fits(json: usize, attached: usize) -> bool {
    let header = if attached > 0 { BINARY_HEADER } else { 0 };
    json.saturating_add(attached).saturating_add(header) <= MAX_FRAME
}

/// A frame's JSON and its attached bytes (empty for a JSON frame).
pub fn split(frame: &[u8]) -> io::Result<(&[u8], &[u8])> {
    if frame.first() != Some(&BINARY_TAG) {
        return Ok((frame, &[]));
    }
    let bad = |m: &str| io::Error::new(io::ErrorKind::InvalidData, m.to_string());
    let header = frame.get(1..BINARY_HEADER).ok_or_else(|| bad("truncated binary frame"))?;
    let json_len = u32::from_le_bytes(header.try_into().unwrap()) as usize;
    let rest = &frame[BINARY_HEADER..];
    if json_len > rest.len() {
        return Err(bad("binary frame's JSON overruns it"));
    }
    Ok(rest.split_at(json_len))
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
        self.send_with_bytes(msg, &[]);
    }

    /// Write one frame with `attached` bytes after its JSON (a binary frame;
    /// a plain JSON frame when nothing is attached). An attachment may be
    /// empty and still needs a binary frame: the JSON lists it, and the
    /// supervisor refuses a listed attachment in a plain frame. Callers check
    /// `fits` first.
    pub fn send_with_bytes(&self, msg: &impl serde::Serialize, attached: &[&[u8]]) {
        let json = serde_json::to_vec(msg).expect("protocol messages serialize");
        let bytes: usize = attached.iter().map(|b| b.len()).sum();
        let mut w = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let ok = if attached.is_empty() {
            w.write_all(&(json.len() as u32).to_le_bytes()).and_then(|_| w.write_all(&json))
        } else {
            let total = BINARY_HEADER + json.len() + bytes;
            let mut r = w
                .write_all(&(total as u32).to_le_bytes())
                .and_then(|_| w.write_all(&[BINARY_TAG]))
                .and_then(|_| w.write_all(&(json.len() as u32).to_le_bytes()))
                .and_then(|_| w.write_all(&json));
            for b in attached {
                r = r.and_then(|_| w.write_all(b));
            }
            r
        };
        if ok.and_then(|_| w.flush()).is_err() {
            std::process::exit(0);
        }
    }
}
