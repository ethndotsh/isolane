//! The Encoding Standard for TextEncoder/TextDecoder, via encoding_rs.
//! Ported from Deno's ext/web/lib.rs (MIT, the Deno authors), keeping its op
//! names and calling conventions. Streaming decoders live in a per-thread
//! table; runtime/core.js wraps their ids in handle objects and frees them
//! when a stream ends or the handle is collected.

use std::cell::RefCell;
use std::collections::HashMap;

use encoding_rs::{CoderResult, Decoder, DecoderResult, Encoding};

use super::{copy_bytes, string_arg, throw_range, throw_type, with_bytes, with_bytes_mut, with_u32s_mut, Args, Rv};
use crate::js;

struct StreamDecoder {
    decoder: Decoder,
    fatal: bool,
}

thread_local! {
    static DECODERS: RefCell<HashMap<u32, StreamDecoder>> = RefCell::new(HashMap::new());
    static NEXT_DECODER: std::cell::Cell<u32> = const { std::cell::Cell::new(1) };
}

fn invalid_label(scope: &mut v8::PinScope, label: &str) {
    throw_range(scope, &format!("The encoding label provided ('{label}') is invalid."));
}

fn utf16_string<'s>(scope: &mut v8::PinScope<'s, '_>, units: &[u16]) -> Option<v8::Local<'s, v8::String>> {
    let s = v8::String::new_from_two_byte(scope, units, v8::NewStringType::Normal);
    if s.is_none() {
        throw_range(scope, "Value too large to decode");
    }
    s
}

/// Decode with `decoder`; `last` flushes it. Err(()) for fatal-mode errors.
fn run_decoder(decoder: &mut Decoder, fatal: bool, data: &[u8], last: bool) -> Result<Vec<u16>, &'static str> {
    let max = decoder.max_utf16_buffer_length(data.len()).ok_or("Value too large to decode")?;
    let mut out = vec![0u16; max];
    if fatal {
        let (result, _, written) = decoder.decode_to_utf16_without_replacement(data, &mut out, last);
        match result {
            DecoderResult::InputEmpty => {
                out.truncate(written);
                Ok(out)
            }
            DecoderResult::OutputFull => Err("Provided buffer too small"),
            DecoderResult::Malformed(_, _) => Err("The encoded data is not valid"),
        }
    } else {
        let (result, _, written, _) = decoder.decode_to_utf16(data, &mut out, last);
        match result {
            CoderResult::InputEmpty => {
                out.truncate(written);
                Ok(out)
            }
            CoderResult::OutputFull => Err("Provided buffer too small"),
        }
    }
}

fn decoder_for(label: &str, ignore_bom: bool) -> Option<Decoder> {
    let encoding = Encoding::for_label(label.as_bytes())?;
    Some(if ignore_bom { encoding.new_decoder_without_bom_handling() } else { encoding.new_decoder_with_bom_removal() })
}

pub fn op_encoding_normalize_label(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let label = string_arg(scope, &args, 0);
    match Encoding::for_label_no_replacement(label.as_bytes()) {
        Some(e) => rv.set(js::short_string(scope, &e.name().to_lowercase()).into()),
        None => invalid_label(scope, &label),
    }
}

pub fn op_encoding_decode_utf8_ascii_only(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let Some(b) = copy_bytes(scope, args.get(0)) else {
        throw_type(scope, "expected a buffer");
        return;
    };
    if b.is_ascii() {
        if let Some(s) = v8::String::new_from_one_byte(scope, &b, v8::NewStringType::Normal) {
            rv.set(s.into());
        }
    } else {
        rv.set_null();
    }
}

pub fn op_encoding_decode_utf8(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let ignore_bom = args.get(1).boolean_value(scope);
    let Some(b) = copy_bytes(scope, args.get(0)) else {
        throw_type(scope, "expected a buffer");
        return;
    };
    let b: &[u8] = if !ignore_bom && b.starts_with(&[0xef, 0xbb, 0xbf]) { &b[3..] } else { &b };
    match v8::String::new_from_utf8(scope, b, v8::NewStringType::Normal) {
        Some(s) => rv.set(s.into()),
        None => throw_type(scope, "buffer exceeds maximum length"),
    }
}

pub fn op_encoding_decode_single(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let label = string_arg(scope, &args, 1);
    let fatal = args.get(2).boolean_value(scope);
    let ignore_bom = args.get(3).boolean_value(scope);
    let Some(mut decoder) = decoder_for(&label, ignore_bom) else {
        invalid_label(scope, &label);
        return;
    };
    let Some(decoded) = with_bytes(scope, args.get(0), |b| run_decoder(&mut decoder, fatal, b, /* last */ true)) else {
        throw_type(scope, "expected a buffer");
        return;
    };
    match decoded {
        Ok(units) => {
            if let Some(s) = utf16_string(scope, &units) {
                rv.set(s.into());
            }
        }
        Err(msg) => throw_type(scope, msg),
    }
}

/// native.newDecoder(label, fatal, ignoreBOM) → id
pub fn new_decoder(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let label = string_arg(scope, &args, 0);
    let fatal = args.get(1).boolean_value(scope);
    let ignore_bom = args.get(2).boolean_value(scope);
    let Some(decoder) = decoder_for(&label, ignore_bom) else {
        invalid_label(scope, &label);
        return;
    };
    let id = NEXT_DECODER.with(|n| {
        let id = n.get();
        n.set(id.wrapping_add(1).max(1));
        id
    });
    DECODERS.with(|d| d.borrow_mut().insert(id, StreamDecoder { decoder, fatal }));
    rv.set_uint32(id);
}

/// native.decoderDecode(bytes, id, stream) → string. A non-streaming call
/// flushes and frees the decoder.
pub fn decoder_decode(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let id = args.get(1).uint32_value(scope).unwrap_or(0);
    let stream = args.get(2).boolean_value(scope);
    let decoded = with_bytes(scope, args.get(0), |b| {
        DECODERS.with(|d| {
            let mut d = d.borrow_mut();
            let r = d.get_mut(&id).map(|sd| run_decoder(&mut sd.decoder, sd.fatal, b, !stream));
            if !stream {
                d.remove(&id);
            }
            r
        })
    });
    let Some(result) = decoded else {
        throw_type(scope, "expected a buffer");
        return;
    };
    match result {
        Some(Ok(units)) => {
            if let Some(s) = utf16_string(scope, &units) {
                rv.set(s.into());
            }
        }
        Some(Err(msg)) => throw_type(scope, msg),
        None => throw_type(scope, "TextDecoder handle is closed"),
    }
}

/// native.freeDecoder(id): a handle was collected mid-stream.
pub fn free_decoder(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    let id = args.get(0).uint32_value(scope).unwrap_or(0);
    DECODERS.with(|d| d.borrow_mut().remove(&id));
}

const ENCODE_INTO_PACKED_SENTINEL: f64 = -1.0;
const ENCODE_INTO_MAX_PACKED_READ: usize = (1 << 21) - 1;
const ENCODE_INTO_PACKED_MULTIPLIER: f64 = (1u64 << 32) as f64;

fn encode_into(scope: &mut v8::PinScope, args: &Args) -> Option<(usize, usize)> {
    let Ok(s) = v8::Local::<v8::String>::try_from(args.get(0)) else {
        throw_type(scope, "expected a string");
        return None;
    };
    // V8 writes the UTF-8 into our own buffer (it needs the scope, so it
    // can't write into the guest's directly); then it's copied over.
    let Some(dest_len) = with_bytes(scope, args.get(1), <[u8]>::len) else {
        throw_type(scope, "expected a Uint8Array");
        return None;
    };
    let mut utf8 = vec![0u8; dest_len];
    let mut nchars = 0;
    let written = s.write_utf8_v2(scope, &mut utf8, v8::WriteFlags::kReplaceInvalidUtf8, Some(&mut nchars));
    with_bytes_mut(scope, args.get(1), |dest| {
        let n = written.min(dest.len());
        dest[..n].copy_from_slice(&utf8[..n]);
    });
    Some((nchars, written))
}

/// Returns `read * 2^32 + written`, or a sentinel when `read` could exceed
/// what packs exactly into a double.
pub fn op_encoding_encode_into(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    if let Ok(s) = v8::Local::<v8::String>::try_from(args.get(0)) {
        let dest_len = with_bytes(scope, args.get(1), <[u8]>::len).unwrap_or(0);
        if s.length() > ENCODE_INTO_MAX_PACKED_READ && dest_len > ENCODE_INTO_MAX_PACKED_READ {
            rv.set_double(ENCODE_INTO_PACKED_SENTINEL);
            return;
        }
    }
    if let Some((read, written)) = encode_into(scope, &args) {
        rv.set_double(read as f64 * ENCODE_INTO_PACKED_MULTIPLIER + written as f64);
    }
}

/// The unpacked form: [read, written] into a Uint32Array.
pub fn op_encoding_encode_into_fallback(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    let Some((read, written)) = encode_into(scope, &args) else { return };
    let stored = with_u32s_mut(scope, args.get(2), |out| {
        if out.len() < 2 {
            return false;
        }
        out[0] = read as u32;
        out[1] = written as u32;
        true
    });
    if stored != Some(true) {
        throw_type(scope, "Provided buffer too small");
    }
}
