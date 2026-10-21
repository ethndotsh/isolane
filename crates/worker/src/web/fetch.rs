//! Natives for runtime/fetch.js: the data: URL processor (Fetch's, through
//! Servo's `data-url` crate, as Deno's fetch uses), and digests for
//! Subresource Integrity.

use sha2::Digest;

use super::{guest_string, new_u8array, string_arg, throw_type, with_bytes, Args, Rv};

/// native.dataUrl(href) → [contentType, Uint8Array], or null if `href`
/// isn't a valid data: URL. The fragment, if any, isn't part of the body.
pub fn data_url(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let href = string_arg(scope, &args, 0);
    let Ok(url) = data_url::DataUrl::process(&href) else {
        rv.set_null();
        return;
    };
    let Ok((body, _fragment)) = url.decode_to_vec() else {
        rv.set_null();
        return;
    };
    let mime = url.mime_type().to_string();
    let Some(mime) = guest_string(scope, &mime) else {
        return;
    };
    let mime: v8::Local<v8::Value> = mime.into();
    let body: v8::Local<v8::Value> = new_u8array(scope, &body).into();
    rv.set(v8::Array::new_with_elements(scope, &[mime, body]).into());
}

/// native.digest(algorithm, bytes) → Uint8Array: SHA-256, SHA-384, or
/// SHA-512 ("sha256", "sha384", "sha512") of an ArrayBuffer or view.
pub fn digest(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let algorithm = string_arg(scope, &args, 0);
    let hash = with_bytes(scope, args.get(1), |b| match algorithm.as_str() {
        "sha256" => Some(sha2::Sha256::digest(b).to_vec()),
        "sha384" => Some(sha2::Sha384::digest(b).to_vec()),
        "sha512" => Some(sha2::Sha512::digest(b).to_vec()),
        _ => None,
    });
    match hash {
        Some(Some(hash)) => rv.set(new_u8array(scope, &hash).into()),
        Some(None) => throw_type(scope, "unsupported digest algorithm"),
        None => throw_type(scope, "expected a buffer"),
    }
}
