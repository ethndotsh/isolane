// Copyright 2018-2026 the Deno authors. MIT license.
//! Ported from Deno's ext/crypto/x448.rs (denoland/deno@eb4061f6f367) to
//! isolane's ops: see mod.rs. Buffer lengths are checked before copying (a
//! mismatch would panic, which aborts the worker). The curve arithmetic is
//! RustCrypto's x448 crate (RFC 7748's X448, scalar clamping included), not
//! ed448-goldilocks directly, whose prerelease Deno pins.

use elliptic_curve::subtle::ConstantTimeEq;
use elliptic_curve::pkcs8::PrivateKeyInfo;
use rand_core::RngCore;
use spki::der::Decode;
use spki::der::Encode;
use spki::der::asn1::BitString;

#[derive(Debug, thiserror::Error, deno_error::JsError)]
pub enum X448Error {
  #[class("DOMExceptionOperationError")]
  #[error("Failed to export key")]
  FailedExport,
  #[class("DOMExceptionDataError")]
  #[error("Invalid key data")]
  InvalidKeyLength,
  #[class(generic)]
  #[error(transparent)]
  Der(#[from] spki::der::Error),
}

pub fn op_crypto_generate_x448_keypair(
  pkey: &mut [u8],
  pubkey: &mut [u8],
) -> bool {
  if pkey.len() != 56 || pubkey.len() != 56 {
    return false;
  }
  if super::IsolaneRng.try_fill_bytes(pkey).is_err() {
    return false;
  }

  // x448(pkey, 5)
  let Ok(scalar) = <[u8; 56]>::try_from(&*pkey) else {
    return false;
  };
  pubkey.copy_from_slice(&x448::x448_unchecked(scalar, x448::X448_BASEPOINT_BYTES));
  true
}

/// The public key (base64url) for a private one: isolane's, for X448 JWKs
/// (Deno's X25519 has the same op; its X448 had no private JWKs).
pub fn op_crypto_x448_public_key(
  private_key: &[u8],
) -> Result<String, X448Error> {
  use base64::Engine;
  let private_key: [u8; 56] = private_key
    .try_into()
    .map_err(|_| X448Error::InvalidKeyLength)?;
  Ok(base64::prelude::BASE64_URL_SAFE_NO_PAD.encode(x448::x448_unchecked(
    private_key,
    x448::X448_BASEPOINT_BYTES,
  )))
}

const MONTGOMERY_IDENTITY: [u8; 56] = [0; 56];

pub fn op_crypto_derive_bits_x448(
  k: &[u8],
  u: &[u8],
  secret: &mut [u8],
) -> Result<bool, X448Error> {
  let k: [u8; 56] = k.try_into().map_err(|_| X448Error::InvalidKeyLength)?;
  let u: [u8; 56] = u.try_into().map_err(|_| X448Error::InvalidKeyLength)?;

  // x448(k, u)
  let point = x448::x448_unchecked(k, u);
  if point.ct_eq(&MONTGOMERY_IDENTITY).unwrap_u8() == 1 {
    return Ok(true);
  }

  if secret.len() != 56 {
    return Err(X448Error::InvalidKeyLength);
  }
  secret.copy_from_slice(&point);
  Ok(false)
}

// id-X448 OBJECT IDENTIFIER ::= { 1 3 101 111 }
const X448_OID: const_oid::ObjectIdentifier =
  const_oid::ObjectIdentifier::new_unwrap("1.3.101.111");

pub fn op_crypto_export_spki_x448(
  pubkey: &[u8],
) -> Result<Vec<u8>, X448Error> {
  let key_info = spki::SubjectPublicKeyInfo {
    algorithm: spki::AlgorithmIdentifierRef {
      oid: X448_OID,
      parameters: None,
    },
    subject_public_key: BitString::from_bytes(pubkey)?,
  };
  key_info
      .to_der()
      .map_err(|_| X448Error::FailedExport)
}

pub fn op_crypto_export_pkcs8_x448(
  pkey: &[u8],
) -> Result<Vec<u8>, X448Error> {
  use rsa::pkcs1::der::Encode;

  let pk_info = rsa::pkcs8::PrivateKeyInfo {
    public_key: None,
    algorithm: rsa::pkcs8::AlgorithmIdentifierRef {
      oid: X448_OID,
      parameters: None,
    },
    private_key: pkey, // OCTET STRING
  };

  let mut buf = Vec::new();
  pk_info.encode_to_vec(&mut buf)?;
  Ok(buf)
}

pub fn op_crypto_import_spki_x448(
  key_data: &[u8],
  out: &mut [u8],
) -> bool {
  // 2-3.
  let pk_info = match spki::SubjectPublicKeyInfoRef::try_from(key_data) {
    Ok(pk_info) => pk_info,
    Err(_) => return false,
  };
  // 4.
  let alg = pk_info.algorithm.oid;
  if alg != X448_OID {
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

pub fn op_crypto_import_pkcs8_x448(
  key_data: &[u8],
  out: &mut [u8],
) -> bool {
  // 2-3.
  let pk_info = match PrivateKeyInfo::from_der(key_data) {
    Ok(pk_info) => pk_info,
    Err(_) => return false,
  };
  // 4.
  let alg = pk_info.algorithm.oid;
  if alg != X448_OID {
    return false;
  }
  // 5.
  if pk_info.algorithm.parameters.is_some() {
    return false;
  }
  // 6.
  // CurvePrivateKey ::= OCTET STRING: 2 bytes of header, then 56 of key.
  // (Deno at this commit checked for 56 here, and then panicked copying
  // 54 bytes into 56; fixed upstream in denoland/deno#34578.)
  if pk_info.private_key.len() != 58 || out.len() != 56 {
    return false;
  }
  out.copy_from_slice(&pk_info.private_key[2..]);
  true
}
