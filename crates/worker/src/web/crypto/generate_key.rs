// Copyright 2018-2026 the Deno authors. MIT license.
//! Ported from Deno's ext/crypto/generate_key.rs (denoland/deno@eb4061f6f367)
//! to isolane's ops: see mod.rs. Keys come from the isolate's randomness
//! (`IsolaneRng`), and P-256/P-384 keys from RustCrypto, not aws-lc-rs.

use std::sync::LazyLock as Lazy;

use elliptic_curve::pkcs8::EncodePrivateKey;
use rand_core::RngCore;
use rsa::pkcs1::EncodeRsaPrivateKey;
use rsa::BigUint;
use rsa::RsaPrivateKey;
use serde::Deserialize;

use super::shared::{EcNamedCurve, ShaHash, SharedError};
use super::IsolaneRng;

#[derive(Debug, thiserror::Error, deno_error::JsError)]
#[class("DOMExceptionOperationError")]
pub enum GenerateKeyError {
    #[class(inherit)]
    #[error(transparent)]
    General(
        #[from]
        #[inherit]
        SharedError,
    ),
    #[error("Bad public exponent")]
    BadPublicExponent,
    #[error("Invalid HMAC key length")]
    InvalidHMACKeyLength,
    #[error("Failed to serialize RSA key")]
    FailedRSAKeySerialization,
    #[error("Invalid AES key length")]
    InvalidAESKeyLength,
    #[error("Failed to generate RSA key")]
    FailedRSAKeyGeneration,
    #[error("Failed to generate EC key")]
    FailedECKeyGeneration,
    #[error("Failed to generate key")]
    FailedKeyGeneration,
    #[error("Unsupported algorithm")]
    UnsupportedAlgorithm,
    #[error("RSA modulus length over isolane's limit of 4096 bits")]
    UnsupportedModulusLength,
}

/// The largest RSA key isolane generates. Key generation runs on the VM
/// thread, where the watchdog can't stop it until it returns to JavaScript;
/// a 4096-bit key takes a second or two, a 16384-bit one can take minutes.
const MAX_RSA_MODULUS_LENGTH: u32 = 4096;

// Allowlist for RSA public exponents.
static PUB_EXPONENT_1: Lazy<BigUint> = Lazy::new(|| BigUint::from(3u64));
static PUB_EXPONENT_2: Lazy<BigUint> = Lazy::new(|| BigUint::from(65537u64));

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "algorithm")]
pub enum GenerateKeyOptions {
    #[serde(rename = "RSA", rename_all = "camelCase")]
    Rsa {
        modulus_length: u32,
        #[serde(with = "serde_bytes")]
        public_exponent: Vec<u8>,
    },
    #[serde(rename = "EC", rename_all = "camelCase")]
    Ec { named_curve: EcNamedCurve },
    #[serde(rename = "AES", rename_all = "camelCase")]
    Aes { length: usize },
    #[serde(rename = "HMAC", rename_all = "camelCase")]
    Hmac {
        hash: ShaHash,
        length: Option<usize>,
    },
}

pub fn op_crypto_generate_key(opts: GenerateKeyOptions) -> Result<Vec<u8>, GenerateKeyError> {
    match opts {
        GenerateKeyOptions::Rsa {
            modulus_length,
            public_exponent,
        } => generate_key_rsa(modulus_length, &public_exponent),
        GenerateKeyOptions::Ec { named_curve } => generate_key_ec(named_curve),
        GenerateKeyOptions::Aes { length } => generate_key_aes(length),
        GenerateKeyOptions::Hmac { hash, length } => generate_key_hmac(hash, length),
    }
}

fn generate_key_rsa(
    modulus_length: u32,
    public_exponent: &[u8],
) -> Result<Vec<u8>, GenerateKeyError> {
    // isolane: the allowed exponents fit in 3 bytes; a longer one (leading
    // zeros aside) is refused before it's turned into a big integer.
    if public_exponent.iter().skip_while(|b| **b == 0).count() > 3 {
        return Err(GenerateKeyError::BadPublicExponent);
    }
    let exponent = BigUint::from_bytes_be(public_exponent);
    if exponent != *PUB_EXPONENT_1 && exponent != *PUB_EXPONENT_2 {
        return Err(GenerateKeyError::BadPublicExponent);
    }
    if modulus_length > MAX_RSA_MODULUS_LENGTH {
        return Err(GenerateKeyError::UnsupportedModulusLength);
    }

    let mut rng = IsolaneRng;

    let private_key = RsaPrivateKey::new_with_exp(&mut rng, modulus_length as usize, &exponent)
        .map_err(|_| GenerateKeyError::FailedRSAKeyGeneration)?;

    let private_key = private_key
        .to_pkcs1_der()
        .map_err(|_| GenerateKeyError::FailedRSAKeySerialization)?;

    Ok(private_key.as_bytes().to_vec())
}

fn generate_key_ec(named_curve: EcNamedCurve) -> Result<Vec<u8>, GenerateKeyError> {
    let mut rng = IsolaneRng;
    let pkcs8 = match named_curve {
        EcNamedCurve::P256 => p256::SecretKey::random(&mut rng).to_pkcs8_der(),
        EcNamedCurve::P384 => p384::SecretKey::random(&mut rng).to_pkcs8_der(),
        EcNamedCurve::P521 => p521::SecretKey::random(&mut rng).to_pkcs8_der(),
    }
    .map_err(|_| GenerateKeyError::FailedECKeyGeneration)?;
    Ok(pkcs8.as_bytes().to_vec())
}

fn generate_key_aes(length: usize) -> Result<Vec<u8>, GenerateKeyError> {
    if !length.is_multiple_of(8) || length > 256 {
        return Err(GenerateKeyError::InvalidAESKeyLength);
    }

    let mut key = vec![0u8; length / 8];
    IsolaneRng
        .try_fill_bytes(&mut key)
        .map_err(|_| GenerateKeyError::FailedKeyGeneration)?;

    Ok(key)
}

fn generate_key_hmac(hash: ShaHash, length: Option<usize>) -> Result<Vec<u8>, GenerateKeyError> {
    // The hash's block size, in bytes: the default key length.
    let block_len = match hash {
        ShaHash::Sha1 | ShaHash::Sha256 => 64,
        ShaHash::Sha384 | ShaHash::Sha512 => 128,
        // As in Deno (whose HMAC was aws-lc-rs's): no SHA-3 HMAC.
        ShaHash::Sha3_256 | ShaHash::Sha3_384 | ShaHash::Sha3_512 => {
            return Err(GenerateKeyError::UnsupportedAlgorithm);
        }
    };

    let length = if let Some(length) = length {
        if length % 8 != 0 {
            return Err(GenerateKeyError::InvalidHMACKeyLength);
        }

        let length = length / 8;
        // aws-lc-rs's MAX_BLOCK_LEN (SHA-512's block), as in Deno.
        if length > 128 {
            return Err(GenerateKeyError::InvalidHMACKeyLength);
        }

        length
    } else {
        block_len
    };

    let mut key = vec![0u8; length];
    IsolaneRng
        .try_fill_bytes(&mut key)
        .map_err(|_| GenerateKeyError::FailedKeyGeneration)?;

    Ok(key)
}
