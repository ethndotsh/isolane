// Copyright 2018-2026 the Deno authors. MIT license.
//! Ported from Deno's ext/crypto/key.rs (denoland/deno@eb4061f6f367) to
//! isolane's ops: see mod.rs. The aws-lc-rs algorithm mappings are gone
//! (ops.rs uses RustCrypto directly).

use serde::Deserialize;
use serde::Serialize;

#[derive(Serialize, Deserialize, Copy, Clone, Eq, PartialEq)]
pub enum CryptoHash {
    #[serde(rename = "SHA-1")]
    Sha1,
    #[serde(rename = "SHA-256")]
    Sha256,
    #[serde(rename = "SHA-384")]
    Sha384,
    #[serde(rename = "SHA-512")]
    Sha512,
    #[serde(rename = "SHA3-256")]
    Sha3_256,
    #[serde(rename = "SHA3-384")]
    Sha3_384,
    #[serde(rename = "SHA3-512")]
    Sha3_512,
}

#[derive(Serialize, Deserialize, Copy, Clone)]
pub enum CryptoNamedCurve {
    #[serde(rename = "P-256")]
    P256,
    #[serde(rename = "P-384")]
    P384,
    #[serde(rename = "P-521")]
    P521,
}

#[derive(Serialize, Deserialize, Clone, Copy)]
pub enum Algorithm {
    #[serde(rename = "RSASSA-PKCS1-v1_5")]
    RsassaPkcs1v15,
    #[serde(rename = "RSA-PSS")]
    RsaPss,
    #[serde(rename = "RSA-OAEP")]
    RsaOaep,
    #[serde(rename = "ECDSA")]
    Ecdsa,
    #[serde(rename = "ECDH")]
    Ecdh,
    #[serde(rename = "AES-CTR")]
    AesCtr,
    #[serde(rename = "AES-CBC")]
    AesCbc,
    #[serde(rename = "AES-GCM")]
    AesGcm,
    #[serde(rename = "AES-KW")]
    AesKw,
    #[serde(rename = "HMAC")]
    Hmac,
    #[serde(rename = "PBKDF2")]
    Pbkdf2,
    #[serde(rename = "HKDF")]
    Hkdf,
}
