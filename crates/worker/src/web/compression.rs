//! CompressionStream / DecompressionStream ops (Deno's op_compression_*,
//! ported from ext/web/compression.rs, MIT): gzip, deflate (zlib), and
//! deflate-raw through flate2's pure-Rust backend, and brotli through the
//! pure-Rust brotli crate.
//!
//! Handles are ids into a per-VM-thread table (runtime/core.js frees an
//! abandoned one when its JS handle is collected). Output is bounded per
//! call, so a decompression bomb fails with a TypeError instead of growing
//! one buffer until the allocator gives up (which would abort the worker).
//! A write that fails partway (trailing garbage after the end of a gzip
//! member) returns what it decoded and fails the stream on the next call.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Write;

use brotli::enc::encode::{BrotliEncoderOperation, BrotliEncoderParameter, BrotliEncoderStateStruct};
use brotli::enc::StandardAlloc;
use brotli::DecompressorWriter as BrotliDecoder;
use flate2::write::{DeflateDecoder, DeflateEncoder, GzDecoder, GzEncoder, ZlibDecoder, ZlibEncoder};
use flate2::Compression;

use super::{bytes, new_u8array, string_arg, throw_type, Args, Rv};

/// Most bytes one write (or the finish) may produce.
/// Most output one call may produce (limits.decompressedBytes).
fn max_output() -> usize {
    crate::limits::get().decompressed_bytes
}
/// Input is fed in slices this big, checking the output size in between.
const INPUT_SLICE: usize = 64 << 10;

const BROTLI_QUALITY: u32 = 6;
const BROTLI_LGWIN: u32 = 22;

/// A brotli encoder driven directly (its Writer can't produce output per
/// chunk without flushing, which would change the compressed bytes).
struct RawBrotliEncoder(BrotliEncoderStateStruct<StandardAlloc>);

impl RawBrotliEncoder {
    fn new() -> Self {
        let mut s = BrotliEncoderStateStruct::new(StandardAlloc::default());
        s.set_parameter(BrotliEncoderParameter::BROTLI_PARAM_QUALITY, BROTLI_QUALITY);
        s.set_parameter(BrotliEncoderParameter::BROTLI_PARAM_LGWIN, BROTLI_LGWIN);
        RawBrotliEncoder(s)
    }

    fn compress(&mut self, input: &[u8], op: BrotliEncoderOperation) -> std::io::Result<Vec<u8>> {
        let mut input_offset = 0;
        let mut available_in = input.len();
        let mut output = vec![0; (input.len() + (input.len() >> 14) * 4 + 7).max(1024)];
        let mut output_offset = 0;
        let mut total_out = Some(0);
        loop {
            let mut available_out = output.len() - output_offset;
            let ok = self.0.compress_stream(
                op,
                &mut available_in,
                input,
                &mut input_offset,
                &mut available_out,
                &mut output,
                &mut output_offset,
                &mut total_out,
                &mut |_, _, _, _| (),
            );
            if !ok {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "brotli compression failed"));
            }
            let done = match op {
                BrotliEncoderOperation::BROTLI_OPERATION_FINISH => self.0.is_finished(),
                _ => available_in == 0 && !self.0.has_more_output(),
            };
            if done {
                output.truncate(output_offset);
                return Ok(output);
            }
            if output_offset == output.len() {
                if output.len() > max_output() {
                    return Err(std::io::Error::other(format!("output larger than {} bytes", max_output())));
                }
                output.resize(output.len() + 64 * 1024, 0);
            }
        }
    }
}

enum Inner {
    DeflateDecoder(ZlibDecoder<Vec<u8>>),
    DeflateEncoder(ZlibEncoder<Vec<u8>>),
    DeflateRawDecoder(DeflateDecoder<Vec<u8>>),
    DeflateRawEncoder(DeflateEncoder<Vec<u8>>),
    GzDecoder(GzDecoder<Vec<u8>>),
    GzEncoder(GzEncoder<Vec<u8>>),
    BrotliDecoder(Box<BrotliDecoder<Vec<u8>>>),
    BrotliEncoder(Box<RawBrotliEncoder>),
}

enum Entry {
    Live(Inner),
    /// An earlier write failed after producing output; the next call throws.
    Failed(String),
}

thread_local! {
    static STREAMS: RefCell<HashMap<u32, Entry>> = RefCell::new(HashMap::new());
    static NEXT: std::cell::Cell<u32> = const { std::cell::Cell::new(1) };
}

/// native.compressionNew(format, isDecoder) → id
pub fn compression_new(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let format = string_arg(scope, &args, 0);
    let is_decoder = args.get(1).boolean_value(scope);
    let w = Vec::new();
    let inner = match (format.as_str(), is_decoder) {
        ("deflate", true) => Inner::DeflateDecoder(ZlibDecoder::new(w)),
        ("deflate", false) => Inner::DeflateEncoder(ZlibEncoder::new(w, Compression::default())),
        ("deflate-raw", true) => Inner::DeflateRawDecoder(DeflateDecoder::new(w)),
        ("deflate-raw", false) => Inner::DeflateRawEncoder(DeflateEncoder::new(w, Compression::default())),
        ("gzip", true) => Inner::GzDecoder(GzDecoder::new(w)),
        ("gzip", false) => Inner::GzEncoder(GzEncoder::new(w, Compression::default())),
        ("brotli", true) => Inner::BrotliDecoder(Box::new(BrotliDecoder::new(w, 4096))),
        ("brotli", false) => Inner::BrotliEncoder(Box::new(RawBrotliEncoder::new())),
        _ => {
            throw_type(scope, "Unsupported format");
            return;
        }
    };
    let id = NEXT.with(|n| {
        let id = n.get();
        n.set(id.wrapping_add(1).max(1));
        id
    });
    STREAMS.with(|s| s.borrow_mut().insert(id, Entry::Live(inner)));
    rv.set_uint32(id);
}

/// Feed one slice; returns the output it produced.
fn write_slice(inner: &mut Inner, input: &[u8]) -> std::io::Result<Vec<u8>> {
    fn drain<W: Write>(w: &mut W, flush: bool, input: &[u8], out: impl FnOnce(&mut W) -> &mut Vec<u8>) -> std::io::Result<Vec<u8>> {
        let r = w.write_all(input).and_then(|_| if flush { w.flush() } else { Ok(()) });
        let produced = std::mem::take(out(w));
        match r {
            Ok(()) => Ok(produced),
            Err(e) if produced.is_empty() => Err(e),
            // Keep what decoded before the failure; report the error next.
            Err(e) => Err(std::io::Error::new(e.kind(), PartialOutput(produced, e.to_string()))),
        }
    }
    match inner {
        Inner::DeflateDecoder(d) => drain(d, true, input, |d| d.get_mut()),
        Inner::DeflateEncoder(d) => drain(d, false, input, |d| d.get_mut()),
        Inner::DeflateRawDecoder(d) => drain(d, true, input, |d| d.get_mut()),
        Inner::DeflateRawEncoder(d) => drain(d, false, input, |d| d.get_mut()),
        Inner::GzDecoder(d) => drain(d, true, input, |d| d.get_mut()),
        Inner::GzEncoder(d) => drain(d, false, input, |d| d.get_mut()),
        Inner::BrotliDecoder(d) => drain(d.as_mut(), true, input, |d| d.get_mut()),
        Inner::BrotliEncoder(e) => e.compress(input, BrotliEncoderOperation::BROTLI_OPERATION_PROCESS),
    }
}

/// An error carrying the output produced before it.
#[derive(Debug)]
struct PartialOutput(Vec<u8>, String);
impl std::fmt::Display for PartialOutput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.1)
    }
}
impl std::error::Error for PartialOutput {}

/// native.compressionWrite(id, chunk) → Uint8Array
pub fn compression_write(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let Some(input) = bytes(scope, args.get(1)) else {
        throw_type(scope, "expected a buffer");
        return;
    };
    let input = input.to_vec();
    let result = STREAMS.with(|s| {
        let mut s = s.borrow_mut();
        let inner = match s.get_mut(&id) {
            Some(Entry::Live(inner)) => inner,
            Some(Entry::Failed(e)) => return Err(e.clone()),
            None => return Err("resource is closed".to_string()),
        };
        let mut out = Vec::new();
        for slice in input.chunks(INPUT_SLICE.max(1)) {
            match write_slice(inner, slice) {
                Ok(produced) => out.extend_from_slice(&produced),
                Err(e) => {
                    let msg = e.to_string();
                    match e.into_inner().and_then(|inner| inner.downcast::<PartialOutput>().ok()) {
                        Some(partial) => {
                            out.extend_from_slice(&partial.0);
                            s.insert(id, Entry::Failed(msg));
                            return Ok(out);
                        }
                        None if !out.is_empty() => {
                            s.insert(id, Entry::Failed(msg));
                            return Ok(out);
                        }
                        None => return Err(msg),
                    }
                }
            }
            if out.len() > max_output() {
                s.remove(&id);
                return Err(format!("output larger than {} bytes from one chunk", max_output()));
            }
        }
        Ok(out)
    });
    match result {
        Ok(out) => rv.set(new_u8array(scope, &out).into()),
        Err(e) => throw_type(scope, &e),
    }
}

/// native.compressionFinish(id, reportErrors) → Uint8Array; frees the stream.
pub fn compression_finish(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let report = args.get(1).boolean_value(scope);
    let inner = match STREAMS.with(|s| s.borrow_mut().remove(&id)) {
        Some(Entry::Live(inner)) => inner,
        Some(Entry::Failed(e)) => {
            if report {
                throw_type(scope, &e);
            } else {
                rv.set(new_u8array(scope, &[]).into());
            }
            return;
        }
        None => {
            throw_type(scope, "resource is closed");
            return;
        }
    };
    let out = match inner {
        Inner::DeflateDecoder(d) => d.finish(),
        Inner::DeflateEncoder(d) => d.finish(),
        Inner::DeflateRawDecoder(d) => d.finish(),
        Inner::DeflateRawEncoder(d) => d.finish(),
        Inner::GzDecoder(d) => d.finish(),
        Inner::GzEncoder(d) => d.finish(),
        Inner::BrotliDecoder(d) => d
            .into_inner()
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "brotli decompression failed")),
        Inner::BrotliEncoder(mut e) => e.compress(&[], BrotliEncoderOperation::BROTLI_OPERATION_FINISH),
    };
    match out {
        Ok(out) if out.len() <= max_output() => rv.set(new_u8array(scope, &out).into()),
        Ok(_) if report => throw_type(scope, &format!("output larger than {} bytes", max_output())),
        Err(e) if report => throw_type(scope, &e.to_string()),
        _ => rv.set(new_u8array(scope, &[]).into()),
    }
}

/// native.compressionFree(id): an abandoned stream's JS handle was collected.
pub fn compression_free(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    STREAMS.with(|s| s.borrow_mut().remove(&id));
}
