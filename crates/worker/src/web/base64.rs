//! Forgiving base64 (https://infra.spec.whatwg.org/#forgiving-base64) for
//! atob/btoa and data: URLs. Deno's ops use V8's simdutf, which this V8
//! build doesn't expose; the semantics are the same. Errors are TypeErrors,
//! which the JS side turns into DOMExceptions.

use super::{byte_string, new_u8array, throw_type, with_bytes, Args, Rv};

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn value(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a' + 26) as u32),
        b'0'..=b'9' => Some((c - b'0' + 52) as u32),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

pub fn forgiving_decode(input: &[u8]) -> Option<Vec<u8>> {
    let mut data: Vec<u8> = input.iter().copied().filter(|c| !matches!(c, b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')).collect();
    if data.len().is_multiple_of(4) {
        if data.ends_with(b"==") {
            data.truncate(data.len() - 2);
        } else if data.ends_with(b"=") {
            data.truncate(data.len() - 1);
        }
    }
    if data.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(data.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for &c in &data {
        acc = (acc << 6) | value(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

pub fn encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

/// A string of bytes as a one-byte (Latin-1) JS string.
fn latin1<'s>(scope: &mut v8::PinScope<'s, '_>, b: &[u8]) -> Option<v8::Local<'s, v8::String>> {
    v8::String::new_from_one_byte(scope, b, v8::NewStringType::Normal)
}

pub fn op_base64_decode(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let Some(input) = byte_string(scope, args.get(0)) else {
        throw_type(scope, "Failed to decode base64");
        return;
    };
    match forgiving_decode(&input) {
        Some(out) => rv.set(new_u8array(scope, &out).into()),
        None => throw_type(scope, "Failed to decode base64"),
    }
}

pub fn op_base64_encode_from_buffer(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let offset = args.get(1).uint32_value(scope).unwrap_or(0) as usize;
    let length = args.get(2).uint32_value(scope).unwrap_or(0) as usize;
    let Some(encoded) = with_bytes(scope, args.get(0), |b| offset.checked_add(length).and_then(|end| b.get(offset..end)).map(encode)) else {
        throw_type(scope, "expected a buffer");
        return;
    };
    let Some(s) = encoded else {
        throw_type(scope, "Provided buffer too small");
        return;
    };
    if let Some(s) = latin1(scope, s.as_bytes()) {
        rv.set(s.into());
    }
}

pub fn op_base64_atob(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let decoded = byte_string(scope, args.get(0)).and_then(|input| forgiving_decode(&input));
    match decoded {
        Some(out) => {
            if let Some(s) = latin1(scope, &out) {
                rv.set(s.into());
            }
        }
        None => throw_type(scope, "Failed to decode base64"),
    }
}

pub fn op_base64_btoa(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let Some(input) = byte_string(scope, args.get(0)) else {
        throw_type(scope, "Cannot encode string: string contains characters outside of the Latin1 range");
        return;
    };
    let s = encode(&input);
    if let Some(s) = latin1(scope, s.as_bytes()) {
        rv.set(s.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        for s in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar", &[0, 255, 128]] {
            assert_eq!(forgiving_decode(encode(s).as_bytes()).unwrap(), s);
        }
        assert_eq!(forgiving_decode(b" Zm9v YmE= ").unwrap(), b"fooba");
        assert_eq!(forgiving_decode(b"YQ").unwrap(), b"a");
        assert!(forgiving_decode(b"Y").is_none());
        assert!(forgiving_decode(b"YQ=").is_none());
        assert!(forgiving_decode(b"Y!==").is_none());
    }
}
