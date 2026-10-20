//! Web Crypto (`crypto.subtle`, WinterTC phase 4): the native half of
//! Deno's ext/crypto. The JS (runtime/crypto.js) is
//! Deno's, from the last commit before Deno moved SubtleCrypto into
//! deno_core's cppgc objects; the other files here are that commit's Rust
//! ops, ported from deno_core's `#[op2]` to plain functions, which this
//! module calls from V8 callbacks with Deno's op names and conventions:
//!
//! - serde arguments and results cross through `bridge` (in place of
//!   serde_v8); buffer arguments are copied in; buffers an op writes into
//!   are filled from a Rust buffer of the same length, after the op;
//! - errors carry deno_error's classes; runtime/core.js turns the
//!   `DOMException*` ones into DOMExceptions;
//! - "async" ops run inline on the VM thread (Deno's spawn_blocking), as
//!   guest CPU time;
//! - randomness is the isolate's (`IsolaneRng`): seeded when the isolate's
//!   `random` policy is, else the OS.
//!
//! Every op is panic-free on any input the JS could pass: a panic aborts
//! the worker (release builds abort on panic), so lengths are checked where
//! Deno's code assumed them.

mod bridge;
mod decrypt;
mod ed25519;
mod encrypt;
mod export_key;
mod gcm;
mod generate_key;
mod import_key;
mod key;
mod ops;
mod shared;
mod x25519;
mod x448;


use deno_error::JsErrorClass;
use serde::de::DeserializeOwned;
use serde::Serialize;

use super::{copy_bytes, new_u8array, with_bytes, with_bytes_mut, Args, Natives, Rv};

/// The isolate's randomness, as a `rand_core` generator for the RustCrypto
/// crates: its seeded stream if it has one, else the OS (`fill_random`).
#[derive(Clone, Copy)]
pub struct IsolaneRng;

impl rand_core::RngCore for IsolaneRng {
    fn next_u32(&mut self) -> u32 {
        rand_core::impls::next_u32_via_fill(self)
    }
    fn next_u64(&mut self) -> u64 {
        rand_core::impls::next_u64_via_fill(self)
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        // Nothing to return an error through. Without randomness a key
        // would be predictable: stop the worker instead (release builds
        // abort on panic).
        assert!(super::fill_random(dest), "isolane: no randomness available");
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand_core::Error> {
        if super::fill_random(dest) {
            Ok(())
        } else {
            Err(rand_core::Error::from(std::num::NonZeroU32::new(rand_core::Error::CUSTOM_START).unwrap()))
        }
    }
}

impl rand_core::CryptoRng for IsolaneRng {}

// ---- errors ----

/// Throw an op's error as deno_core would: JS built-in classes as
/// themselves, everything else (`DOMException*`, `NotSupported`) as an
/// Error named for its class, which runtime/core.js converts.
fn throw(scope: &mut v8::PinScope, class: &str, message: &str) {
    use crate::js::Class;
    // An error can quote guest input (a serde message names the value it
    // refused): keep it short.
    let message = crate::js::prefix(message, 1024);
    let class = match class {
        "TypeError" => Class::Type,
        "RangeError" => Class::Range,
        "SyntaxError" => Class::Syntax,
        "Error" => Class::Error,
        "NotSupported" => Class::Named("DOMExceptionNotSupportedError"),
        other => Class::Named(other),
    };
    crate::js::throw(scope, class, message);
}

fn fail(scope: &mut v8::PinScope, error: &impl JsErrorClass) {
    throw(scope, &error.get_class(), &error.get_message());
}

fn type_error(scope: &mut v8::PinScope, message: &str) {
    throw(scope, "TypeError", message);
}

// ---- arguments ----

/// Argument `i`, deserialized; or a TypeError (thrown) and None.
fn serde_arg<T: DeserializeOwned>(scope: &mut v8::PinScope, args: &Args, i: i32) -> Option<T> {
    let parsed = bridge::from_v8(scope, args.get(i)).and_then(|v| bridge::deserialize(v).map_err(|e| e.to_string()));
    match parsed {
        Ok(v) => Some(v),
        Err(e) => {
            type_error(scope, &format!("invalid argument {}: {e}", i + 1));
            None
        }
    }
}

/// A copy of buffer argument `i`; or a TypeError (thrown) and None.
fn buf_arg(scope: &mut v8::PinScope, args: &Args, i: i32) -> Option<Vec<u8>> {
    let bytes = copy_bytes(scope, args.get(i));
    if bytes.is_none() {
        type_error(scope, &format!("argument {} is not a buffer", i + 1));
    }
    bytes
}

/// Buffer argument `i`, which may be absent (undefined or null).
fn opt_buf_arg(scope: &mut v8::PinScope, args: &Args, i: i32) -> Option<Option<Vec<u8>>> {
    let value = args.get(i);
    if value.is_null_or_undefined() {
        return Some(None);
    }
    buf_arg(scope, args, i).map(Some)
}

/// A zeroed buffer as long as buffer argument `i`, for an op to write into.
fn out_arg(scope: &mut v8::PinScope, args: &Args, i: i32) -> Option<Vec<u8>> {
    let out = with_bytes(scope, args.get(i), |b| vec![0u8; b.len()]);
    if out.is_none() {
        type_error(scope, &format!("argument {} is not a buffer", i + 1));
    }
    out
}

/// Copy what an op wrote back into buffer argument `i` (the same length,
/// unless guest code changed it in between, which it can't: no JS runs).
fn write_back(scope: &mut v8::PinScope, args: &Args, i: i32, data: &[u8]) {
    with_bytes_mut(scope, args.get(i), |b| {
        if b.len() == data.len() {
            b.copy_from_slice(data);
        }
    });
}

fn string_arg(scope: &mut v8::PinScope, args: &Args, i: i32) -> Option<String> {
    let value = args.get(i);
    if !value.is_string() {
        type_error(scope, &format!("argument {} is not a string", i + 1));
        return None;
    }
    Some(value.to_rust_string_lossy(scope))
}

// ---- results ----

fn set_bytes(scope: &mut v8::PinScope, rv: &mut Rv, data: &[u8]) {
    rv.set(new_u8array(scope, data).into());
}

fn set_string(scope: &mut v8::PinScope, rv: &mut Rv, s: &str) {
    if let Some(s) = v8::String::new(scope, s) {
        rv.set(s.into());
    }
}

fn set_serde(scope: &mut v8::PinScope, rv: &mut Rv, value: &impl Serialize) {
    match bridge::serialize(value) {
        Ok(val) => {
            let v = bridge::to_v8(scope, &val);
            rv.set(v);
        }
        Err(e) => type_error(scope, &e.to_string()),
    }
}

fn bytes_result<E: JsErrorClass>(scope: &mut v8::PinScope, mut rv: Rv, result: Result<Vec<u8>, E>) {
    match result {
        Ok(data) => set_bytes(scope, &mut rv, &data),
        Err(e) => fail(scope, &e),
    }
}

/// `?` for arguments: return from the op (the error is already thrown).
macro_rules! arg {
    ($e:expr) => {
        match $e {
            Some(v) => v,
            None => return,
        }
    };
}

// ---- ops ----

fn op_crypto_get_random_values(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    match with_bytes_mut(scope, args.get(0), ops::op_crypto_get_random_values) {
        None => type_error(scope, "argument 1 is not a buffer"),
        Some(Err(e)) => fail(scope, &e),
        Some(Ok(())) => {}
    }
}

fn op_crypto_random_uuid(scope: &mut v8::PinScope, _args: Args, mut rv: Rv) {
    match ops::op_crypto_random_uuid() {
        Ok(s) => set_string(scope, &mut rv, &s),
        Err(e) => fail(scope, &e),
    }
}

fn op_crypto_generate_key(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    let opts = arg!(serde_arg(scope, &args, 0));
    bytes_result(scope, rv, generate_key::op_crypto_generate_key(opts));
}

fn op_crypto_sign_key(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    let opts = arg!(serde_arg(scope, &args, 0));
    let data = arg!(buf_arg(scope, &args, 1));
    bytes_result(scope, rv, ops::op_crypto_sign_key(opts, &data));
}

fn op_crypto_verify_key(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let opts = arg!(serde_arg(scope, &args, 0));
    let data = arg!(buf_arg(scope, &args, 1));
    match ops::op_crypto_verify_key(opts, &data) {
        Ok(ok) => rv.set_bool(ok),
        Err(e) => fail(scope, &e),
    }
}

fn op_crypto_derive_bits(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    let opts = arg!(serde_arg(scope, &args, 0));
    let salt = arg!(opt_buf_arg(scope, &args, 1));
    bytes_result(scope, rv, ops::op_crypto_derive_bits(opts, salt.map(bridge::JsBuffer)));
}

fn op_crypto_import_key(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let opts = arg!(serde_arg(scope, &args, 0));
    let key_data = arg!(serde_arg(scope, &args, 1));
    match import_key::op_crypto_import_key(opts, key_data) {
        Ok(result) => set_serde(scope, &mut rv, &result),
        Err(e) => fail(scope, &e),
    }
}

fn op_crypto_export_key(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let opts = arg!(serde_arg(scope, &args, 0));
    let key_data = arg!(serde_arg(scope, &args, 1));
    match export_key::op_crypto_export_key(opts, key_data) {
        Ok(result) => set_serde(scope, &mut rv, &result),
        Err(e) => fail(scope, &e),
    }
}

fn op_crypto_encrypt(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    let opts = arg!(serde_arg(scope, &args, 0));
    let data = arg!(buf_arg(scope, &args, 1));
    bytes_result(scope, rv, encrypt::op_crypto_encrypt(opts, &data));
}

fn op_crypto_decrypt(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    let opts = arg!(serde_arg(scope, &args, 0));
    let data = arg!(buf_arg(scope, &args, 1));
    bytes_result(scope, rv, decrypt::op_crypto_decrypt(opts, &data));
}

fn op_crypto_subtle_digest(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    let algorithm = arg!(serde_arg(scope, &args, 0));
    let data = arg!(buf_arg(scope, &args, 1));
    bytes_result(scope, rv, ops::op_crypto_subtle_digest(algorithm, &data));
}

fn op_crypto_wrap_key(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    let opts = arg!(serde_arg(scope, &args, 0));
    let data = arg!(buf_arg(scope, &args, 1));
    bytes_result(scope, rv, ops::op_crypto_wrap_key(opts, &data));
}

fn op_crypto_unwrap_key(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    let opts = arg!(serde_arg(scope, &args, 0));
    let data = arg!(buf_arg(scope, &args, 1));
    bytes_result(scope, rv, ops::op_crypto_unwrap_key(opts, &data));
}

fn op_crypto_base64url_decode(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    let data = arg!(string_arg(scope, &args, 0));
    bytes_result(scope, rv, ops::op_crypto_base64url_decode(data));
}

fn op_crypto_base64url_encode(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let data = arg!(buf_arg(scope, &args, 0));
    set_string(scope, &mut rv, &ops::op_crypto_base64url_encode(&data));
}

/// An op over (input, output) buffers returning whether it worked.
fn in_out(scope: &mut v8::PinScope, args: Args, mut rv: Rv, f: fn(&[u8], &mut [u8]) -> bool) {
    let input = arg!(buf_arg(scope, &args, 0));
    let mut out = arg!(out_arg(scope, &args, 1));
    let ok = f(&input, &mut out);
    if ok {
        write_back(scope, &args, 1, &out);
    }
    rv.set_bool(ok);
}

/// An op that writes a key pair into two buffers, returning whether it
/// worked.
fn keypair(scope: &mut v8::PinScope, args: Args, mut rv: Rv, f: fn(&mut [u8], &mut [u8]) -> bool) {
    let mut private = arg!(out_arg(scope, &args, 0));
    let mut public = arg!(out_arg(scope, &args, 1));
    let ok = f(&mut private, &mut public);
    if ok {
        write_back(scope, &args, 0, &private);
        write_back(scope, &args, 1, &public);
    }
    rv.set_bool(ok);
}

/// X25519 and X448 key generation return nothing in Deno: failing (a
/// buffer of the wrong length, no randomness) is an OperationError.
fn keypair_or_throw(scope: &mut v8::PinScope, args: Args, f: fn(&mut [u8], &mut [u8]) -> bool) {
    let mut private = arg!(out_arg(scope, &args, 0));
    let mut public = arg!(out_arg(scope, &args, 1));
    if !f(&mut private, &mut public) {
        throw(scope, "DOMExceptionOperationError", "Failed to generate key");
        return;
    }
    write_back(scope, &args, 0, &private);
    write_back(scope, &args, 1, &public);
}

/// ECDH over X25519 or X448: (k, u, secret out) → whether the result is
/// the identity (all zero), which the JS rejects.
type DeriveCurve<E> = fn(&[u8], &[u8], &mut [u8]) -> Result<bool, E>;

fn derive_bits_curve<E: JsErrorClass>(scope: &mut v8::PinScope, args: Args, mut rv: Rv, f: DeriveCurve<E>) {
    let k = arg!(buf_arg(scope, &args, 0));
    let u = arg!(buf_arg(scope, &args, 1));
    let mut secret = arg!(out_arg(scope, &args, 2));
    match f(&k, &u, &mut secret) {
        Ok(identity) => {
            if !identity {
                write_back(scope, &args, 2, &secret);
            }
            rv.set_bool(identity);
        }
        Err(e) => fail(scope, &e),
    }
}

fn export_der<E: JsErrorClass>(scope: &mut v8::PinScope, args: Args, rv: Rv, f: fn(&[u8]) -> Result<Vec<u8>, E>) {
    let key = arg!(buf_arg(scope, &args, 0));
    bytes_result(scope, rv, f(&key));
}

fn op_crypto_generate_x25519_keypair(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    keypair_or_throw(scope, args, x25519::op_crypto_generate_x25519_keypair);
}
fn op_crypto_x25519_public_key(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let key = arg!(buf_arg(scope, &args, 0));
    match x25519::op_crypto_x25519_public_key(&key) {
        Ok(s) => set_string(scope, &mut rv, &s),
        Err(e) => fail(scope, &e),
    }
}
fn op_crypto_derive_bits_x25519(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    derive_bits_curve(scope, args, rv, x25519::op_crypto_derive_bits_x25519);
}
fn op_crypto_import_spki_x25519(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    in_out(scope, args, rv, x25519::op_crypto_import_spki_x25519);
}
fn op_crypto_import_pkcs8_x25519(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    in_out(scope, args, rv, x25519::op_crypto_import_pkcs8_x25519);
}
fn op_crypto_export_spki_x25519(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    export_der(scope, args, rv, x25519::op_crypto_export_spki_x25519);
}
fn op_crypto_export_pkcs8_x25519(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    export_der(scope, args, rv, x25519::op_crypto_export_pkcs8_x25519);
}

fn op_crypto_generate_x448_keypair(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    keypair_or_throw(scope, args, x448::op_crypto_generate_x448_keypair);
}
fn op_crypto_x448_public_key(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let key = arg!(buf_arg(scope, &args, 0));
    match x448::op_crypto_x448_public_key(&key) {
        Ok(s) => set_string(scope, &mut rv, &s),
        Err(e) => fail(scope, &e),
    }
}
fn op_crypto_derive_bits_x448(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    derive_bits_curve(scope, args, rv, x448::op_crypto_derive_bits_x448);
}
fn op_crypto_import_spki_x448(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    in_out(scope, args, rv, x448::op_crypto_import_spki_x448);
}
fn op_crypto_import_pkcs8_x448(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    in_out(scope, args, rv, x448::op_crypto_import_pkcs8_x448);
}
fn op_crypto_export_spki_x448(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    export_der(scope, args, rv, x448::op_crypto_export_spki_x448);
}
fn op_crypto_export_pkcs8_x448(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    export_der(scope, args, rv, x448::op_crypto_export_pkcs8_x448);
}

fn op_crypto_generate_ed25519_keypair(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    keypair(scope, args, rv, ed25519::op_crypto_generate_ed25519_keypair);
}
fn op_crypto_import_spki_ed25519(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    in_out(scope, args, rv, ed25519::op_crypto_import_spki_ed25519);
}
fn op_crypto_import_pkcs8_ed25519(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    in_out(scope, args, rv, ed25519::op_crypto_import_pkcs8_ed25519);
}
fn op_crypto_sign_ed25519(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let key = arg!(buf_arg(scope, &args, 0));
    let data = arg!(buf_arg(scope, &args, 1));
    let mut signature = arg!(out_arg(scope, &args, 2));
    let ok = ed25519::op_crypto_sign_ed25519(&key, &data, &mut signature);
    if ok {
        write_back(scope, &args, 2, &signature);
    }
    rv.set_bool(ok);
}
fn op_crypto_verify_ed25519(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let key = arg!(buf_arg(scope, &args, 0));
    let data = arg!(buf_arg(scope, &args, 1));
    let signature = arg!(buf_arg(scope, &args, 2));
    rv.set_bool(ed25519::op_crypto_verify_ed25519(&key, &data, &signature));
}
fn op_crypto_export_spki_ed25519(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    export_der(scope, args, rv, ed25519::op_crypto_export_spki_ed25519);
}
fn op_crypto_export_pkcs8_ed25519(scope: &mut v8::PinScope, args: Args, rv: Rv) {
    export_der(scope, args, rv, ed25519::op_crypto_export_pkcs8_ed25519);
}
fn op_crypto_jwk_x_ed25519(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let key = arg!(buf_arg(scope, &args, 0));
    match ed25519::op_crypto_jwk_x_ed25519(&key) {
        Ok(s) => set_string(scope, &mut rv, &s),
        Err(e) => fail(scope, &e),
    }
}

/// The ops 00_crypto.js calls, by Deno's names.
pub(super) fn op_fns() -> Natives {
    natives!(
        "op_crypto_get_random_values" => op_crypto_get_random_values,
        "op_crypto_random_uuid" => op_crypto_random_uuid,
        "op_crypto_generate_key" => op_crypto_generate_key,
        "op_crypto_sign_key" => op_crypto_sign_key,
        "op_crypto_verify_key" => op_crypto_verify_key,
        "op_crypto_derive_bits" => op_crypto_derive_bits,
        "op_crypto_import_key" => op_crypto_import_key,
        "op_crypto_export_key" => op_crypto_export_key,
        "op_crypto_encrypt" => op_crypto_encrypt,
        "op_crypto_decrypt" => op_crypto_decrypt,
        "op_crypto_subtle_digest" => op_crypto_subtle_digest,
        "op_crypto_wrap_key" => op_crypto_wrap_key,
        "op_crypto_unwrap_key" => op_crypto_unwrap_key,
        "op_crypto_base64url_decode" => op_crypto_base64url_decode,
        "op_crypto_base64url_encode" => op_crypto_base64url_encode,
        "op_crypto_generate_x25519_keypair" => op_crypto_generate_x25519_keypair,
        "op_crypto_x25519_public_key" => op_crypto_x25519_public_key,
        "op_crypto_derive_bits_x25519" => op_crypto_derive_bits_x25519,
        "op_crypto_import_spki_x25519" => op_crypto_import_spki_x25519,
        "op_crypto_import_pkcs8_x25519" => op_crypto_import_pkcs8_x25519,
        "op_crypto_export_spki_x25519" => op_crypto_export_spki_x25519,
        "op_crypto_export_pkcs8_x25519" => op_crypto_export_pkcs8_x25519,
        "op_crypto_generate_x448_keypair" => op_crypto_generate_x448_keypair,
        "op_crypto_x448_public_key" => op_crypto_x448_public_key,
        "op_crypto_derive_bits_x448" => op_crypto_derive_bits_x448,
        "op_crypto_import_spki_x448" => op_crypto_import_spki_x448,
        "op_crypto_import_pkcs8_x448" => op_crypto_import_pkcs8_x448,
        "op_crypto_export_spki_x448" => op_crypto_export_spki_x448,
        "op_crypto_export_pkcs8_x448" => op_crypto_export_pkcs8_x448,
        "op_crypto_generate_ed25519_keypair" => op_crypto_generate_ed25519_keypair,
        "op_crypto_import_spki_ed25519" => op_crypto_import_spki_ed25519,
        "op_crypto_import_pkcs8_ed25519" => op_crypto_import_pkcs8_ed25519,
        "op_crypto_sign_ed25519" => op_crypto_sign_ed25519,
        "op_crypto_verify_ed25519" => op_crypto_verify_ed25519,
        "op_crypto_export_spki_ed25519" => op_crypto_export_spki_ed25519,
        "op_crypto_export_pkcs8_ed25519" => op_crypto_export_pkcs8_ed25519,
        "op_crypto_jwk_x_ed25519" => op_crypto_jwk_x_ed25519,
    )
}
