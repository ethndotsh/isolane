//! CompressionStream / DecompressionStream ops (Deno's op_compression_*,
//! ported from ext/web/compression.rs, MIT): gzip, deflate (zlib), and
//! deflate-raw through flate2's pure-Rust backend, and brotli through the
//! pure-Rust brotli crate.
//!
//! Handles are ids into a per-VM-thread table (runtime/core.js frees an
//! abandoned one when its JS handle is collected). Output is bounded per
//! call (limits.decompressedBytes), and the decoders check it as they
//! decode, in steps of at most a few hundred KiB, so a decompression bomb
//! fails with a TypeError near the limit: it never fills a buffer first
//! (421 bytes of brotli are 256 MiB of output).
//! A write that fails partway (input after the end of the compressed data)
//! returns what it decoded, and the stream fails right after that output is
//! enqueued (native.compressionCheck, from 14_compression.js's transform;
//! see patches/deno-compression-errors.patch).
//!
//! Unlike Deno's, the deflate and deflate-raw decoders drive flate2's
//! inflater directly, to know where the compressed data ends: input after
//! the end is an error, and so is input that ends before it (flate2's
//! write::ZlibDecoder accepts both), as the Compression Standard has it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Write;

use brotli::enc::encode::{BrotliEncoderOperation, BrotliEncoderParameter, BrotliEncoderStateStruct};
use brotli::enc::StandardAlloc;
use brotli::{BrotliDecompressStream, BrotliResult, BrotliState};
use flate2::write::{DeflateEncoder, GzDecoder, GzEncoder, ZlibEncoder};
use flate2::{Compression, Decompress, FlushDecompress, Status};

use super::{copy_bytes, new_u8array, string_arg, throw_type, Args, Rv};

/// Most output one call may produce (limits.decompressedBytes).
fn max_output() -> usize {
    crate::limits::get().decompressed_bytes
}
/// Input is fed in slices this big, checking the output size in between.
const INPUT_SLICE: usize = 64 << 10;
/// gzip input goes to flate2's write decoder in pieces this small: deflate
/// expands at most ~1032:1, so each produces at most ~530 KB before the
/// output size is checked again.
const GZIP_PIECE: usize = 512;
/// The brotli decoder's output step.
const BROTLI_STEP: usize = 64 << 10;

fn too_large() -> std::io::Error {
    std::io::Error::other(format!("output larger than {} bytes", max_output()))
}

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

/// A zlib (deflate) or raw deflate decoder that knows where the compressed
/// data ends.
struct Inflater {
    inflate: Decompress,
    ended: bool,
}

fn invalid(msg: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, msg.to_string())
}

impl Inflater {
    fn new(zlib_header: bool) -> Self {
        Inflater { inflate: Decompress::new(zlib_header), ended: false }
    }

    /// Decode `input` into `out`; an error after some output carries it
    /// (PartialOutput), like the write decoders' errors.
    fn write(&mut self, mut input: &[u8], flush: FlushDecompress, budget: usize) -> std::io::Result<Vec<u8>> {
        let mut out = Vec::new();
        let fail = |out: Vec<u8>, e: std::io::Error| {
            if out.is_empty() {
                e
            } else {
                std::io::Error::new(e.kind(), PartialOutput(out, e.to_string()))
            }
        };
        loop {
            if self.ended {
                if input.is_empty() {
                    return Ok(out);
                }
                return Err(fail(out, invalid("junk after the end of the compressed data")));
            }
            if out.capacity() - out.len() < 32 << 10 {
                out.reserve(64 << 10);
            }
            let (in_before, out_before) = (self.inflate.total_in(), out.len());
            let status = match self.inflate.decompress_vec(input, &mut out, flush) {
                Ok(status) => status,
                Err(e) => return Err(fail(out, invalid(&e.to_string()))),
            };
            let consumed = (self.inflate.total_in() - in_before) as usize;
            input = &input[consumed..];
            if status == Status::StreamEnd {
                self.ended = true;
                continue;
            }
            if out.len() > budget {
                return Err(too_large());
            }
            let full = out.len() == out.capacity();
            let progressed = consumed > 0 || out.len() > out_before;
            if !full && (input.is_empty() || !progressed) {
                break; // needs more input
            }
        }
        if flush == FlushDecompress::Finish && !self.ended {
            return Err(fail(out, invalid("the compressed data ends early")));
        }
        Ok(out)
    }
}

/// A brotli decoder driven directly (its Writer decodes a whole write into
/// one buffer before the size can be checked), in steps of BROTLI_STEP.
struct BrotliDecoder {
    state: BrotliState<StandardAlloc, StandardAlloc, StandardAlloc>,
    ended: bool,
}

impl BrotliDecoder {
    fn new() -> Self {
        // Strict: RFC 7932's window (up to 16 MiB), not the large-window
        // extension's 1 GiB.
        let a = StandardAlloc::default;
        BrotliDecoder { state: BrotliState::new_strict(a(), a(), a()), ended: false }
    }

    fn write(&mut self, input: &[u8], finish: bool, budget: usize) -> std::io::Result<Vec<u8>> {
        let mut out = Vec::new();
        let fail = |out: Vec<u8>, e: std::io::Error| {
            if out.is_empty() {
                e
            } else {
                std::io::Error::new(e.kind(), PartialOutput(out, e.to_string()))
            }
        };
        let mut step = vec![0u8; BROTLI_STEP];
        let (mut available_in, mut input_offset, mut total_out) = (input.len(), 0, 0);
        loop {
            if self.ended {
                if available_in == 0 {
                    return Ok(out);
                }
                return Err(fail(out, invalid("junk after the end of the compressed data")));
            }
            let (mut available_out, mut output_offset) = (step.len(), 0);
            let result = BrotliDecompressStream(
                &mut available_in,
                &mut input_offset,
                input,
                &mut available_out,
                &mut output_offset,
                &mut step,
                &mut total_out,
                &mut self.state,
            );
            out.extend_from_slice(&step[..output_offset]);
            if out.len() > budget {
                return Err(too_large());
            }
            match result {
                BrotliResult::ResultSuccess => self.ended = true,
                BrotliResult::NeedsMoreOutput => {}
                BrotliResult::NeedsMoreInput => break,
                BrotliResult::ResultFailure => return Err(fail(out, invalid("brotli decompression failed"))),
            }
        }
        if finish {
            return Err(fail(out, invalid("the compressed data ends early")));
        }
        Ok(out)
    }
}

enum Inner {
    DeflateDecoder(Inflater),
    DeflateEncoder(ZlibEncoder<Vec<u8>>),
    DeflateRawDecoder(Inflater),
    DeflateRawEncoder(DeflateEncoder<Vec<u8>>),
    GzDecoder(GzDecoder<Vec<u8>>),
    GzEncoder(GzEncoder<Vec<u8>>),
    BrotliDecoder(Box<BrotliDecoder>),
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
        ("deflate", true) => Inner::DeflateDecoder(Inflater::new(true)),
        ("deflate", false) => Inner::DeflateEncoder(ZlibEncoder::new(w, Compression::default())),
        ("deflate-raw", true) => Inner::DeflateRawDecoder(Inflater::new(false)),
        ("deflate-raw", false) => Inner::DeflateRawEncoder(DeflateEncoder::new(w, Compression::default())),
        ("gzip", true) => Inner::GzDecoder(GzDecoder::new(w)),
        ("gzip", false) => Inner::GzEncoder(GzEncoder::new(w, Compression::default())),
        ("brotli", true) => Inner::BrotliDecoder(Box::new(BrotliDecoder::new())),
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

/// Feed one slice; returns the output it produced, at most about `budget`
/// bytes (a decoder fails with too_large() past it).
fn write_slice(inner: &mut Inner, input: &[u8], budget: usize) -> std::io::Result<Vec<u8>> {
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
        Inner::DeflateDecoder(d) => d.write(input, FlushDecompress::None, budget),
        Inner::DeflateEncoder(d) => drain(d, false, input, |d| d.get_mut()),
        Inner::DeflateRawDecoder(d) => d.write(input, FlushDecompress::None, budget),
        Inner::DeflateRawEncoder(d) => drain(d, false, input, |d| d.get_mut()),
        Inner::GzDecoder(d) => {
            let mut out = Vec::new();
            for piece in input.chunks(GZIP_PIECE) {
                match drain(d, true, piece, |d| d.get_mut()) {
                    Ok(produced) => out.extend_from_slice(&produced),
                    Err(e) if out.is_empty() => return Err(e),
                    Err(e) => {
                        let msg = e.to_string();
                        if let Some(partial) = e.into_inner().and_then(|inner| inner.downcast::<PartialOutput>().ok()) {
                            out.extend_from_slice(&partial.0);
                        }
                        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, PartialOutput(out, msg)));
                    }
                }
                if out.len() > budget {
                    return Err(too_large());
                }
            }
            Ok(out)
        }
        Inner::GzEncoder(d) => drain(d, false, input, |d| d.get_mut()),
        Inner::BrotliDecoder(d) => d.write(input, false, budget),
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
    let Some(input) = copy_bytes(scope, args.get(1)) else {
        throw_type(scope, "expected a buffer");
        return;
    };
    let result = STREAMS.with(|s| {
        let mut s = s.borrow_mut();
        let inner = match s.get_mut(&id) {
            Some(Entry::Live(inner)) => inner,
            Some(Entry::Failed(e)) => return Err(e.clone()),
            None => return Err("resource is closed".to_string()),
        };
        let mut out = Vec::new();
        for slice in input.chunks(INPUT_SLICE) {
            let budget = max_output().saturating_sub(out.len());
            match write_slice(inner, slice, budget) {
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
        Inner::DeflateDecoder(mut d) => d.write(&[], FlushDecompress::Finish, max_output()),
        Inner::DeflateEncoder(d) => d.finish(),
        Inner::DeflateRawDecoder(mut d) => d.write(&[], FlushDecompress::Finish, max_output()),
        Inner::DeflateRawEncoder(d) => d.finish(),
        Inner::GzDecoder(d) => d.finish(),
        Inner::GzEncoder(d) => d.finish(),
        Inner::BrotliDecoder(mut d) => d.write(&[], true, max_output()),
        Inner::BrotliEncoder(mut e) => e.compress(&[], BrotliEncoderOperation::BROTLI_OPERATION_FINISH),
    };
    match out {
        Ok(out) if out.len() <= max_output() => rv.set(new_u8array(scope, &out).into()),
        Ok(_) if report => throw_type(scope, &format!("output larger than {} bytes", max_output())),
        Err(e) if report => throw_type(scope, &e.to_string()),
        _ => rv.set(new_u8array(scope, &[]).into()),
    }
}

/// native.compressionCheck(id): throws if the last write failed after its
/// output (which the caller has enqueued by now).
pub fn compression_check(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    let failed = STREAMS.with(|s| {
        let mut s = s.borrow_mut();
        match s.get(&id) {
            Some(Entry::Failed(e)) => {
                let e = e.clone();
                s.remove(&id);
                Some(e)
            }
            _ => None,
        }
    });
    if let Some(e) = failed {
        throw_type(scope, &e);
    }
}

/// native.compressionFree(id): an abandoned stream's JS handle was collected.
pub fn compression_free(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    STREAMS.with(|s| s.borrow_mut().remove(&id));
}
