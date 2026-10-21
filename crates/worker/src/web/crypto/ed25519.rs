// Copyright 2018-2026 the Deno authors. MIT license.
//! Ported from Deno's ext/crypto/ed25519.rs (denoland/deno@eb4061f6f367) to
//! isolane's ops: see mod.rs. Signing is ed25519-dalek's (pure Rust), not
//! aws-lc-rs's, and buffer lengths are checked before copying (a mismatch
//! would panic, which aborts the worker).

use base64::prelude::BASE64_URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::Signer;
use ed25519_dalek::SigningKey;
use ed25519_dalek::VerifyingKey;
use elliptic_curve::pkcs8::PrivateKeyInfo;
use rand_core::RngCore;
use spki::der::asn1::BitString;
use spki::der::Decode;
use spki::der::Encode;

#[derive(Debug, thiserror::Error, deno_error::JsError)]
pub enum Ed25519Error {
    #[class("DOMExceptionOperationError")]
    #[error("Failed to export key")]
    FailedExport,
    #[class(generic)]
    #[error(transparent)]
    Der(#[from] rsa::pkcs1::der::Error),
    #[class("DOMExceptionOperationError")]
    #[error("Invalid key data")]
    InvalidKey,
}

/// A signing key from its 32-byte seed (the private key's bytes).
fn signing_key(seed: &[u8]) -> Option<SigningKey> {
    Some(SigningKey::from_bytes(seed.try_into().ok()?))
}

pub fn op_crypto_generate_ed25519_keypair(pkey: &mut [u8], pubkey: &mut [u8]) -> bool {
    if pkey.len() != 32 || pubkey.len() != 32 {
        return false;
    }
    if super::IsolaneRng.try_fill_bytes(pkey).is_err() {
        return false;
    }

    let Some(pair) = signing_key(pkey) else {
        return false;
    };
    pubkey.copy_from_slice(pair.verifying_key().as_bytes());
    true
}

pub fn op_crypto_sign_ed25519(key: &[u8], data: &[u8], signature: &mut [u8]) -> bool {
    let Some(pair) = signing_key(key) else {
        return false;
    };
    if signature.len() != 64 {
        return false;
    }
    signature.copy_from_slice(&pair.sign(data).to_bytes());
    true
}

pub fn op_crypto_verify_ed25519(pubkey: &[u8], data: &[u8], signature: &[u8]) -> bool {
    let Ok(pubkey) = <&[u8; 32]>::try_from(pubkey) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(pubkey) else {
        return false;
    };
    let Ok(signature) = ed25519_dalek::Signature::from_slice(signature) else {
        return false;
    };
    // Strict (RFC 8032) verification: WebCrypto rejects small-order public
    // keys and non-canonical encodings (aws-lc-rs, in Deno, doesn't).
    key.verify_strict(data, &signature).is_ok()
}

// id-Ed25519 OBJECT IDENTIFIER ::= { 1 3 101 112 }
pub const ED25519_OID: const_oid::ObjectIdentifier =
    const_oid::ObjectIdentifier::new_unwrap("1.3.101.112");

pub fn op_crypto_import_spki_ed25519(key_data: &[u8], out: &mut [u8]) -> bool {
    // 2-3.
    let pk_info = match spki::SubjectPublicKeyInfoRef::try_from(key_data) {
        Ok(pk_info) => pk_info,
        Err(_) => return false,
    };
    // 4.
    let alg = pk_info.algorithm.oid;
    if alg != ED25519_OID {
        return false;
    }
    // 5.
    if pk_info.algorithm.parameters.is_some() {
        return false;
    }
    let key = pk_info.subject_public_key.raw_bytes();
    if key.len() != out.len() {
        return false;
    }
    out.copy_from_slice(key);
    true
}

pub fn op_crypto_import_pkcs8_ed25519(key_data: &[u8], out: &mut [u8]) -> bool {
    // 2-3.
    // This should probably use OneAsymmetricKey instead
    let pk_info = match PrivateKeyInfo::from_der(key_data) {
        Ok(pk_info) => pk_info,
        Err(_) => return false,
    };
    // 4.
    let alg = pk_info.algorithm.oid;
    if alg != ED25519_OID {
        return false;
    }
    // 5.
    if pk_info.algorithm.parameters.is_some() {
        return false;
    }
    // 6.
    // CurvePrivateKey ::= OCTET STRING
    if pk_info.private_key.len() != 34 || out.len() != 32 {
        return false;
    }
    out.copy_from_slice(&pk_info.private_key[2..]);
    true
}

pub fn op_crypto_export_spki_ed25519(pubkey: &[u8]) -> Result<Vec<u8>, Ed25519Error> {
    let key_info = spki::SubjectPublicKeyInfo {
        algorithm: spki::AlgorithmIdentifierOwned {
            // id-Ed25519
            oid: ED25519_OID,
            parameters: None,
        },
        subject_public_key: BitString::from_bytes(pubkey)?,
    };
    key_info.to_der().map_err(|_| Ed25519Error::FailedExport)
}

pub fn op_crypto_export_pkcs8_ed25519(pkey: &[u8]) -> Result<Vec<u8>, Ed25519Error> {
    use rsa::pkcs1::der::Encode;

    // This should probably use OneAsymmetricKey instead
    let pk_info = rsa::pkcs8::PrivateKeyInfo {
        public_key: None,
        algorithm: rsa::pkcs8::AlgorithmIdentifierRef {
            // id-Ed25519
            oid: ED25519_OID,
            parameters: None,
        },
        private_key: pkey, // OCTET STRING
    };

    let mut buf = Vec::new();
    pk_info.encode_to_vec(&mut buf)?;
    Ok(buf)
}

// 'x' from Section 2 of RFC 8037
// https://www.rfc-editor.org/rfc/rfc8037#section-2
pub fn op_crypto_jwk_x_ed25519(pkey: &[u8]) -> Result<String, Ed25519Error> {
    let pair = signing_key(pkey).ok_or(Ed25519Error::InvalidKey)?;
    Ok(BASE64_URL_SAFE_NO_PAD.encode(pair.verifying_key().as_bytes()))
}
