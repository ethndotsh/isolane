// Copyright 2018-2026 the Deno authors. MIT license.
// Ported from Deno's ext/crypto/lib.rs (denoland/deno@eb4061f6f367) to
// isolane's ops: see mod.rs. HMAC, HKDF, PBKDF2, and digests are RustCrypto's
// rather than aws-lc-rs's; randomness is the isolate's (`IsolaneRng`); and
// PBKDF2 stops when the isolate's budget runs out.

use aes_kw::KekAes128;
use aes_kw::KekAes192;
use aes_kw::KekAes256;
use base64::Engine;
use base64::prelude::BASE64_URL_SAFE_NO_PAD;
use deno_error::JsErrorBox;
use hmac::Mac;
use p256::ecdsa::Signature as P256Signature;
use p256::ecdsa::SigningKey as P256SigningKey;
use p256::ecdsa::VerifyingKey as P256VerifyingKey;
use p256::elliptic_curve::sec1::FromEncodedPoint;
use p256::pkcs8::DecodePrivateKey;
use p384::ecdsa::Signature as P384Signature;
use p384::ecdsa::SigningKey as P384SigningKey;
use p384::ecdsa::VerifyingKey as P384VerifyingKey;
use p521::ecdsa::Signature as P521Signature;
use p521::ecdsa::SigningKey as P521SigningKey;
use p521::ecdsa::VerifyingKey as P521VerifyingKey;
use rand_core::RngCore;
use rsa::Pss;
use rsa::RsaPrivateKey;
use rsa::RsaPublicKey;
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs1::DecodeRsaPublicKey;
use rsa::signature::SignatureEncoding;
use rsa::signature::Signer;
use rsa::signature::Verifier;
use rsa::traits::SignatureScheme;
use serde::Deserialize;
use sha1::Sha1;
use sha2::Digest;
use sha2::Sha256;
use sha2::Sha384;
use sha2::Sha512;
use signature::hazmat::PrehashSigner;
use signature::hazmat::PrehashVerifier;

use super::bridge::JsBuffer;
use super::key::Algorithm;
use super::key::CryptoHash;
use super::key::CryptoNamedCurve;
use super::shared::SharedError;
use super::shared::V8RawKeyData;
use super::IsolaneRng;

#[derive(Debug, thiserror::Error, deno_error::JsError)]
#[allow(clippy::upper_case_acronyms, reason = "Deno's names")]
pub enum CryptoError {
  #[class(inherit)]
  #[error(transparent)]
  General(
    #[from]
    #[inherit]
    SharedError,
  ),
  #[class(generic)]
  #[error(transparent)]
  Der(#[from] rsa::pkcs1::der::Error),
  #[class(type)]
  #[error("Missing argument hash")]
  MissingArgumentHash,
  #[class(type)]
  #[error("Missing argument saltLength")]
  MissingArgumentSaltLength,
  #[class(type)]
  #[error("unsupported algorithm")]
  UnsupportedAlgorithm,
  #[class(generic)]
  #[error(transparent)]
  RSA(#[from] rsa::Error),
  #[class(generic)]
  #[error(transparent)]
  Pkcs1(#[from] rsa::pkcs1::Error),
  #[class(type)]
  #[error("Invalid key format")]
  InvalidKeyFormat,
  #[class(generic)]
  #[error(transparent)]
  P256Ecdsa(#[from] p256::ecdsa::Error),
  #[class(type)]
  #[error("Unexpected error decoding private key")]
  DecodePrivateKey,
  #[class(type)]
  #[error("Missing argument publicKey")]
  MissingArgumentPublicKey,
  #[class(type)]
  #[error("Missing argument namedCurve")]
  MissingArgumentNamedCurve,
  #[class(type)]
  #[error("Missing argument info")]
  MissingArgumentInfo,
  #[class("DOMExceptionOperationError")]
  #[error("The length provided for HKDF is too large")]
  HKDFLengthTooLarge,
  #[class(generic)]
  #[error(transparent)]
  Base64Decode(#[from] base64::DecodeError),
  #[class(type)]
  #[error("Data must be multiple of 8 bytes")]
  DataInvalidSize,
  #[class(type)]
  #[error("Invalid key length")]
  InvalidKeyLength,
  #[class("DOMExceptionOperationError")]
  #[error("encryption error")]
  EncryptionError,
  #[class("DOMExceptionOperationError")]
  #[error("decryption error - integrity check failed")]
  DecryptionError,
  #[class("DOMExceptionQuotaExceededError")]
  #[error(
    "The ArrayBufferView's byte length ({0}) exceeds the number of bytes of entropy available via this API (65536)"
  )]
  ArrayBufferViewLengthExceeded(usize),
  #[class("DOMExceptionOperationError")]
  #[error("Invalid key length")]
  InvalidHmacKey,
  #[class("DOMExceptionOperationError")]
  #[error("The operation was stopped: the isolate is out of time")]
  Interrupted,
  #[class(inherit)]
  #[error(transparent)]
  Other(
    #[from]
    #[inherit]
    JsErrorBox,
  ),
}

pub fn op_crypto_base64url_decode(data: String) -> Result<Vec<u8>, CryptoError> {
  let data: Vec<u8> = BASE64_URL_SAFE_NO_PAD.decode(data)?;
  Ok(data)
}

pub fn op_crypto_base64url_encode(data: &[u8]) -> String {
  BASE64_URL_SAFE_NO_PAD.encode(data)
}

pub fn op_crypto_get_random_values(out: &mut [u8]) -> Result<(), CryptoError> {
  if out.len() > 65536 {
    return Err(CryptoError::ArrayBufferViewLengthExceeded(out.len()));
  }
  IsolaneRng
    .try_fill_bytes(out)
    .map_err(|_| JsErrorBox::generic("no randomness available"))?;
  Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyType {
  Secret,
  Private,
  Public,
}

#[derive(Deserialize)]
pub struct KeyData {
  r#type: KeyType,
  data: JsBuffer,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignArg {
  key: KeyData,
  algorithm: Algorithm,
  salt_length: Option<u32>,
  hash: Option<CryptoHash>,
  named_curve: Option<CryptoNamedCurve>,
}

pub fn op_crypto_sign_key(
  args: SignArg,
  zero_copy: &[u8],
) -> Result<Vec<u8>, CryptoError> {
  {
    let data = zero_copy;
    let algorithm = args.algorithm;

    let signature = match algorithm {
      Algorithm::RsassaPkcs1v15 => {
        use rsa::pkcs1v15::SigningKey;
        let private_key = RsaPrivateKey::from_pkcs1_der(&args.key.data)?;
        match args.hash.ok_or_else(|| CryptoError::MissingArgumentHash)? {
          CryptoHash::Sha1 => {
            let signing_key = SigningKey::<Sha1>::new(private_key);
            signing_key.sign(data)
          }
          CryptoHash::Sha256 => {
            let signing_key = SigningKey::<Sha256>::new(private_key);
            signing_key.sign(data)
          }
          CryptoHash::Sha384 => {
            let signing_key = SigningKey::<Sha384>::new(private_key);
            signing_key.sign(data)
          }
          CryptoHash::Sha512 => {
            let signing_key = SigningKey::<Sha512>::new(private_key);
            signing_key.sign(data)
          }
          _ => return Err(CryptoError::UnsupportedAlgorithm),
        }
        .to_vec()
      }
      Algorithm::RsaPss => {
        let private_key = RsaPrivateKey::from_pkcs1_der(&args.key.data)?;

        let salt_len = args
          .salt_length
          .ok_or_else(|| CryptoError::MissingArgumentSaltLength)?
          as usize;

        let mut rng = IsolaneRng;
        match args.hash.ok_or_else(|| CryptoError::MissingArgumentHash)? {
          CryptoHash::Sha1 => {
            let signing_key = Pss::new_with_salt::<Sha1>(salt_len);
            let hashed = Sha1::digest(data);
            signing_key.sign(Some(&mut rng), &private_key, &hashed)?
          }
          CryptoHash::Sha256 => {
            let signing_key = Pss::new_with_salt::<Sha256>(salt_len);
            let hashed = Sha256::digest(data);
            signing_key.sign(Some(&mut rng), &private_key, &hashed)?
          }
          CryptoHash::Sha384 => {
            let signing_key = Pss::new_with_salt::<Sha384>(salt_len);
            let hashed = Sha384::digest(data);
            signing_key.sign(Some(&mut rng), &private_key, &hashed)?
          }
          CryptoHash::Sha512 => {
            let signing_key = Pss::new_with_salt::<Sha512>(salt_len);
            let hashed = Sha512::digest(data);
            signing_key.sign(Some(&mut rng), &private_key, &hashed)?
          }
          _ => return Err(CryptoError::UnsupportedAlgorithm),
        }
        .to_vec()
      }
      Algorithm::Ecdsa => {
        let hash = args.hash.ok_or_else(|| CryptoError::MissingArgumentHash)?;
        let named_curve =
          args.named_curve.ok_or_else(JsErrorBox::not_supported)?;
        match named_curve {
          CryptoNamedCurve::P256 => {
            // Decode PKCS#8 private key.
            let secret_key = p256::SecretKey::from_pkcs8_der(&args.key.data)
              .map_err(|_| CryptoError::InvalidKeyFormat)?;
            let signing_key = P256SigningKey::from(secret_key);
            let prehash = match hash {
              CryptoHash::Sha1 => sha1::Sha1::digest(data).to_vec(),
              CryptoHash::Sha256 => sha2::Sha256::digest(data).to_vec(),
              CryptoHash::Sha384 => sha2::Sha384::digest(data).to_vec(),
              CryptoHash::Sha512 => sha2::Sha512::digest(data).to_vec(),
              _ => return Err(CryptoError::UnsupportedAlgorithm),
            };
            // Sign the prehashed message, producing a raw r||s signature.
            let signature: P256Signature =
              signing_key.sign_prehash(&prehash)?;
            signature.to_bytes().to_vec()
          }
          CryptoNamedCurve::P384 => {
            let secret_key = p384::SecretKey::from_pkcs8_der(&args.key.data)
              .map_err(|_| CryptoError::InvalidKeyFormat)?;
            let signing_key = P384SigningKey::from(secret_key);
            let prehash = match hash {
              CryptoHash::Sha1 => sha1::Sha1::digest(data).to_vec(),
              CryptoHash::Sha256 => sha2::Sha256::digest(data).to_vec(),
              CryptoHash::Sha384 => sha2::Sha384::digest(data).to_vec(),
              CryptoHash::Sha512 => sha2::Sha512::digest(data).to_vec(),
              _ => return Err(CryptoError::UnsupportedAlgorithm),
            };
            // isolane: as for P-521 below; P-384's minimum is 24 bytes,
            // more than SHA-1's 20.
            let prehash = pad_prehash(prehash, 24);
            let signature: P384Signature =
              signing_key.sign_prehash(&prehash)?;
            signature.to_bytes().to_vec()
          }
          CryptoNamedCurve::P521 => {
            let secret_key = p521::SecretKey::from_pkcs8_der(&args.key.data)
              .map_err(|_| CryptoError::InvalidKeyFormat)?;
            let signing_key =
              P521SigningKey::from_bytes(&secret_key.to_bytes())
                .map_err(|_| CryptoError::InvalidKeyFormat)?;
            let prehash = match hash {
              CryptoHash::Sha1 => sha1::Sha1::digest(data).to_vec(),
              CryptoHash::Sha256 => sha2::Sha256::digest(data).to_vec(),
              CryptoHash::Sha384 => sha2::Sha384::digest(data).to_vec(),
              CryptoHash::Sha512 => sha2::Sha512::digest(data).to_vec(),
              _ => return Err(CryptoError::UnsupportedAlgorithm),
            };
            // P-521 field size is 66 bytes; bits2field requires at least
            // half that (33 bytes). Left-pad shorter hashes to meet the
            // minimum.
            let prehash = if prehash.len() < 33 {
              let mut padded = vec![0u8; 33 - prehash.len()];
              padded.extend_from_slice(&prehash);
              padded
            } else {
              prehash
            };
            let signature: P521Signature =
              signing_key.sign_prehash(&prehash)?;
            signature.to_bytes().to_vec()
          }
        }
      }
      Algorithm::Hmac => {
        let hash = args.hash.ok_or_else(JsErrorBox::not_supported)?;
        hmac_sign(hash, &args.key.data, data)?
      }
      _ => return Err(CryptoError::UnsupportedAlgorithm),
    };

    Ok(signature)
  }
}

/// HMAC of `data` under `key` (RustCrypto's, where Deno uses aws-lc-rs's,
/// which has no SHA-3 HMAC either).
fn hmac_sign(hash: CryptoHash, key: &[u8], data: &[u8]) -> Result<Vec<u8>, CryptoError> {
  fn mac<M: Mac + hmac::digest::KeyInit>(key: &[u8], data: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let mut mac = <M as Mac>::new_from_slice(key).map_err(|_| CryptoError::InvalidHmacKey)?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
  }
  match hash {
    CryptoHash::Sha1 => mac::<hmac::Hmac<Sha1>>(key, data),
    CryptoHash::Sha256 => mac::<hmac::Hmac<Sha256>>(key, data),
    CryptoHash::Sha384 => mac::<hmac::Hmac<Sha384>>(key, data),
    CryptoHash::Sha512 => mac::<hmac::Hmac<Sha512>>(key, data),
    CryptoHash::Sha3_256 | CryptoHash::Sha3_384 | CryptoHash::Sha3_512 => Err(CryptoError::UnsupportedAlgorithm),
  }
}

/// A hash left-padded with zeros to the curve's minimum prehash length
/// (half its field size): the same integer, as FIPS 186 has a hash shorter
/// than the order.
fn pad_prehash(prehash: Vec<u8>, min: usize) -> Vec<u8> {
  if prehash.len() >= min {
    return prehash;
  }
  let mut padded = vec![0u8; min - prehash.len()];
  padded.extend_from_slice(&prehash);
  padded
}

/// Constant-time comparison, for HMAC verification.
fn equal(a: &[u8], b: &[u8]) -> bool {
  a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyArg {
  key: KeyData,
  algorithm: Algorithm,
  salt_length: Option<u32>,
  hash: Option<CryptoHash>,
  signature: JsBuffer,
  named_curve: Option<CryptoNamedCurve>,
}

pub fn op_crypto_verify_key(
  args: VerifyArg,
  zero_copy: &[u8],
) -> Result<bool, CryptoError> {
  {
    let data = zero_copy;
    let algorithm = args.algorithm;

    let verification = match algorithm {
      Algorithm::RsassaPkcs1v15 => {
        use rsa::pkcs1v15::Signature;
        use rsa::pkcs1v15::VerifyingKey;
        let public_key = read_rsa_public_key(args.key)?;
        let signature: Signature = (&*args.signature).try_into()?;
        match args.hash.ok_or_else(|| CryptoError::MissingArgumentHash)? {
          CryptoHash::Sha1 => {
            let verifying_key = VerifyingKey::<Sha1>::new(public_key);
            verifying_key.verify(data, &signature).is_ok()
          }
          CryptoHash::Sha256 => {
            let verifying_key = VerifyingKey::<Sha256>::new(public_key);
            verifying_key.verify(data, &signature).is_ok()
          }
          CryptoHash::Sha384 => {
            let verifying_key = VerifyingKey::<Sha384>::new(public_key);
            verifying_key.verify(data, &signature).is_ok()
          }
          CryptoHash::Sha512 => {
            let verifying_key = VerifyingKey::<Sha512>::new(public_key);
            verifying_key.verify(data, &signature).is_ok()
          }
          _ => return Err(CryptoError::UnsupportedAlgorithm),
        }
      }
      Algorithm::RsaPss => {
        let public_key = read_rsa_public_key(args.key)?;
        let signature = args.signature.as_ref();

        let salt_len = args
          .salt_length
          .ok_or_else(|| CryptoError::MissingArgumentSaltLength)?
          as usize;

        match args.hash.ok_or_else(|| CryptoError::MissingArgumentHash)? {
          CryptoHash::Sha1 => {
            let pss = Pss::new_with_salt::<Sha1>(salt_len);
            let hashed = Sha1::digest(data);
            pss.verify(&public_key, &hashed, signature).is_ok()
          }
          CryptoHash::Sha256 => {
            let pss = Pss::new_with_salt::<Sha256>(salt_len);
            let hashed = Sha256::digest(data);
            pss.verify(&public_key, &hashed, signature).is_ok()
          }
          CryptoHash::Sha384 => {
            let pss = Pss::new_with_salt::<Sha384>(salt_len);
            let hashed = Sha384::digest(data);
            pss.verify(&public_key, &hashed, signature).is_ok()
          }
          CryptoHash::Sha512 => {
            let pss = Pss::new_with_salt::<Sha512>(salt_len);
            let hashed = Sha512::digest(data);
            pss.verify(&public_key, &hashed, signature).is_ok()
          }
          _ => return Err(CryptoError::UnsupportedAlgorithm),
        }
      }
      Algorithm::Hmac => {
        let hash = args.hash.ok_or_else(JsErrorBox::not_supported)?;
        equal(&hmac_sign(hash, &args.key.data, data)?, &args.signature)
      }
      Algorithm::Ecdsa => {
        let hash = args.hash.ok_or_else(|| CryptoError::MissingArgumentHash)?;
        let named_curve =
          args.named_curve.ok_or_else(JsErrorBox::not_supported)?;
        match named_curve {
          CryptoNamedCurve::P256 => {
            let verifying_key = match args.key.r#type {
              KeyType::Public => {
                P256VerifyingKey::from_sec1_bytes(&args.key.data)
                  .map_err(|_| CryptoError::InvalidKeyFormat)?
              }
              KeyType::Private => {
                let secret_key =
                  p256::SecretKey::from_pkcs8_der(&args.key.data)
                    .map_err(|_| CryptoError::InvalidKeyFormat)?;
                let signing_key = P256SigningKey::from(secret_key);
                *signing_key.verifying_key()
              }
              _ => return Err(CryptoError::InvalidKeyFormat),
            };
            match P256Signature::from_slice(&args.signature) {
              Ok(signature) => {
                let prehash = match hash {
                  CryptoHash::Sha1 => sha1::Sha1::digest(data).to_vec(),
                  CryptoHash::Sha256 => sha2::Sha256::digest(data).to_vec(),
                  CryptoHash::Sha384 => sha2::Sha384::digest(data).to_vec(),
                  CryptoHash::Sha512 => sha2::Sha512::digest(data).to_vec(),
                  _ => return Err(CryptoError::UnsupportedAlgorithm),
                };
                verifying_key.verify_prehash(&prehash, &signature).is_ok()
              }
              _ => false,
            }
          }
          CryptoNamedCurve::P384 => {
            let verifying_key = match args.key.r#type {
              KeyType::Public => {
                P384VerifyingKey::from_sec1_bytes(&args.key.data)
                  .map_err(|_| CryptoError::InvalidKeyFormat)?
              }
              KeyType::Private => {
                let secret_key =
                  p384::SecretKey::from_pkcs8_der(&args.key.data)
                    .map_err(|_| CryptoError::InvalidKeyFormat)?;
                let signing_key = P384SigningKey::from(secret_key);
                *signing_key.verifying_key()
              }
              _ => return Err(CryptoError::InvalidKeyFormat),
            };
            match P384Signature::from_slice(&args.signature) {
              Ok(signature) => {
                let prehash = match hash {
                  CryptoHash::Sha1 => sha1::Sha1::digest(data).to_vec(),
                  CryptoHash::Sha256 => sha2::Sha256::digest(data).to_vec(),
                  CryptoHash::Sha384 => sha2::Sha384::digest(data).to_vec(),
                  CryptoHash::Sha512 => sha2::Sha512::digest(data).to_vec(),
                  _ => return Err(CryptoError::UnsupportedAlgorithm),
                };
                let prehash = pad_prehash(prehash, 24);
                verifying_key.verify_prehash(&prehash, &signature).is_ok()
              }
              _ => false,
            }
          }
          CryptoNamedCurve::P521 => {
            let verifying_key = match args.key.r#type {
              KeyType::Public => {
                P521VerifyingKey::from_sec1_bytes(&args.key.data)
                  .map_err(|_| CryptoError::InvalidKeyFormat)?
              }
              KeyType::Private => {
                let secret_key =
                  p521::SecretKey::from_pkcs8_der(&args.key.data)
                    .map_err(|_| CryptoError::InvalidKeyFormat)?;
                // Construct inner ecdsa signing key to get verifying key
                let inner_signing_key =
                  ecdsa::SigningKey::<p521::NistP521>::from(secret_key);
                P521VerifyingKey::from(*inner_signing_key.verifying_key())
              }
              _ => return Err(CryptoError::InvalidKeyFormat),
            };
            match P521Signature::from_slice(&args.signature) {
              Ok(signature) => {
                let prehash = match hash {
                  CryptoHash::Sha1 => sha1::Sha1::digest(data).to_vec(),
                  CryptoHash::Sha256 => sha2::Sha256::digest(data).to_vec(),
                  CryptoHash::Sha384 => sha2::Sha384::digest(data).to_vec(),
                  CryptoHash::Sha512 => sha2::Sha512::digest(data).to_vec(),
                  _ => return Err(CryptoError::UnsupportedAlgorithm),
                };
                // P-521 field size is 66 bytes; bits2field requires at least
                // half that (33 bytes). Left-pad shorter hashes to meet the
                // minimum.
                let prehash = if prehash.len() < 33 {
                  let mut padded = vec![0u8; 33 - prehash.len()];
                  padded.extend_from_slice(&prehash);
                  padded
                } else {
                  prehash
                };
                verifying_key.verify_prehash(&prehash, &signature).is_ok()
              }
              _ => false,
            }
          }
        }
      }
      _ => return Err(CryptoError::UnsupportedAlgorithm),
    };

    Ok(verification)
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeriveKeyArg {
  key: KeyData,
  algorithm: Algorithm,
  hash: Option<CryptoHash>,
  length: usize,
  iterations: Option<u32>,
  // ECDH
  public_key: Option<KeyData>,
  named_curve: Option<CryptoNamedCurve>,
  // HKDF
  info: Option<JsBuffer>,
}

pub fn op_crypto_derive_bits(
  args: DeriveKeyArg,
  zero_copy: Option<JsBuffer>,
) -> Result<Vec<u8>, CryptoError> {
  {
    let algorithm = args.algorithm;
    match algorithm {
      Algorithm::Pbkdf2 => {
        let zero_copy = zero_copy.ok_or_else(JsErrorBox::not_supported)?;
        let salt = &*zero_copy;
        // The caller validates these (and an assert would abort the worker).
        if args.length == 0 || !args.length.is_multiple_of(8) {
          return Err(JsErrorBox::not_supported().into());
        }
        let iterations = args.iterations.ok_or_else(JsErrorBox::not_supported)?;
        if iterations == 0 {
          return Err(JsErrorBox::not_supported().into());
        }
        let hash = args.hash.ok_or_else(JsErrorBox::not_supported)?;
        let secret = args.key.data;
        let mut out = vec![0; args.length / 8];
        match hash {
          CryptoHash::Sha1 => pbkdf2::<hmac::Hmac<Sha1>>(&secret, salt, iterations, &mut out)?,
          CryptoHash::Sha256 => pbkdf2::<hmac::Hmac<Sha256>>(&secret, salt, iterations, &mut out)?,
          CryptoHash::Sha384 => pbkdf2::<hmac::Hmac<Sha384>>(&secret, salt, iterations, &mut out)?,
          CryptoHash::Sha512 => pbkdf2::<hmac::Hmac<Sha512>>(&secret, salt, iterations, &mut out)?,
          _ => return Err(CryptoError::UnsupportedAlgorithm),
        }
        Ok(out)
      }
      Algorithm::Ecdh => {
        let named_curve = args
          .named_curve
          .ok_or_else(|| CryptoError::MissingArgumentNamedCurve)?;

        let public_key = args
          .public_key
          .ok_or_else(|| CryptoError::MissingArgumentPublicKey)?;

        match named_curve {
          CryptoNamedCurve::P256 => {
            let secret_key = p256::SecretKey::from_pkcs8_der(&args.key.data)
              .map_err(|_| CryptoError::DecodePrivateKey)?;

            let public_key = match public_key.r#type {
              KeyType::Private => {
                p256::SecretKey::from_pkcs8_der(&public_key.data)
                  .map_err(|_| CryptoError::DecodePrivateKey)?
                  .public_key()
              }
              KeyType::Public => {
                let point = p256::EncodedPoint::from_bytes(public_key.data)
                  .map_err(|_| CryptoError::DecodePrivateKey)?;

                let pk = p256::PublicKey::from_encoded_point(&point);
                // pk is a constant time Option.
                if pk.is_some().into() {
                  pk.unwrap()
                } else {
                  return Err(CryptoError::DecodePrivateKey);
                }
              }
              _ => unreachable!(),
            };

            let shared_secret = p256::elliptic_curve::ecdh::diffie_hellman(
              secret_key.to_nonzero_scalar(),
              public_key.as_affine(),
            );

            // raw serialized x-coordinate of the computed point
            Ok(shared_secret.raw_secret_bytes().to_vec())
          }
          CryptoNamedCurve::P384 => {
            let secret_key = p384::SecretKey::from_pkcs8_der(&args.key.data)
              .map_err(|_| CryptoError::DecodePrivateKey)?;

            let public_key = match public_key.r#type {
              KeyType::Private => {
                p384::SecretKey::from_pkcs8_der(&public_key.data)
                  .map_err(|_| CryptoError::DecodePrivateKey)?
                  .public_key()
              }
              KeyType::Public => {
                let point = p384::EncodedPoint::from_bytes(public_key.data)
                  .map_err(|_| CryptoError::DecodePrivateKey)?;

                let pk = p384::PublicKey::from_encoded_point(&point);
                // pk is a constant time Option.
                if pk.is_some().into() {
                  pk.unwrap()
                } else {
                  return Err(CryptoError::DecodePrivateKey);
                }
              }
              _ => unreachable!(),
            };

            let shared_secret = p384::elliptic_curve::ecdh::diffie_hellman(
              secret_key.to_nonzero_scalar(),
              public_key.as_affine(),
            );

            // raw serialized x-coordinate of the computed point
            Ok(shared_secret.raw_secret_bytes().to_vec())
          }
          CryptoNamedCurve::P521 => {
            let secret_key = p521::SecretKey::from_pkcs8_der(&args.key.data)
              .map_err(|_| CryptoError::DecodePrivateKey)?;

            let public_key = match public_key.r#type {
              KeyType::Private => {
                p521::SecretKey::from_pkcs8_der(&public_key.data)
                  .map_err(|_| CryptoError::DecodePrivateKey)?
                  .public_key()
              }
              KeyType::Public => {
                let point = p521::EncodedPoint::from_bytes(public_key.data)
                  .map_err(|_| CryptoError::DecodePrivateKey)?;

                let pk = p521::PublicKey::from_encoded_point(&point);
                // pk is a constant time Option.
                if pk.is_some().into() {
                  pk.unwrap()
                } else {
                  return Err(CryptoError::DecodePrivateKey);
                }
              }
              _ => unreachable!(),
            };

            let shared_secret = p521::elliptic_curve::ecdh::diffie_hellman(
              secret_key.to_nonzero_scalar(),
              public_key.as_affine(),
            );

            // raw serialized x-coordinate of the computed point
            Ok(shared_secret.raw_secret_bytes().to_vec())
          }
        }
      }
      Algorithm::Hkdf => {
        let zero_copy = zero_copy.ok_or_else(JsErrorBox::not_supported)?;
        let salt = &*zero_copy;
        let hash = args.hash.ok_or_else(JsErrorBox::not_supported)?;

        let info = args.info.ok_or(CryptoError::MissingArgumentInfo)?;
        // IKM
        let secret = args.key.data;
        // L
        let length = args.length / 8;

        let mut r = vec![0u8; length];
        let expanded = match hash {
          CryptoHash::Sha1 => hkdf::Hkdf::<Sha1>::new(Some(salt), &secret).expand(&info, &mut r),
          CryptoHash::Sha256 => hkdf::Hkdf::<Sha256>::new(Some(salt), &secret).expand(&info, &mut r),
          CryptoHash::Sha384 => hkdf::Hkdf::<Sha384>::new(Some(salt), &secret).expand(&info, &mut r),
          CryptoHash::Sha512 => hkdf::Hkdf::<Sha512>::new(Some(salt), &secret).expand(&info, &mut r),
          _ => return Err(CryptoError::UnsupportedAlgorithm),
        };
        expanded.map_err(|_| CryptoError::HKDFLengthTooLarge)?;
        Ok(r)
      }
      _ => Err(CryptoError::UnsupportedAlgorithm),
    }
  }
}

/// PBKDF2 (RFC 8018), checking every so many iterations whether the
/// isolate ran out of time: the iteration count is the guest's, up to
/// 2^32 - 1, and native code only stops when it returns to JavaScript.
fn pbkdf2<M: Mac + hmac::digest::KeyInit + Clone>(
  password: &[u8],
  salt: &[u8],
  iterations: u32,
  out: &mut [u8],
) -> Result<(), CryptoError> {
  let prf = <M as Mac>::new_from_slice(password).map_err(|_| CryptoError::InvalidHmacKey)?;
  let mut done: u64 = 0;
  for (i, chunk) in out.chunks_mut(<M as hmac::digest::OutputSizeUser>::output_size()).enumerate() {
    let mut u = prf.clone();
    u.update(salt);
    u.update(&(i as u32 + 1).to_be_bytes());
    let mut u = u.finalize().into_bytes();
    let mut t = u.clone();
    done += 1;
    if done.is_multiple_of(4096) && crate::vm::out_of_time() {
      return Err(CryptoError::Interrupted);
    }
    for _ in 1..iterations {
      let mut next = prf.clone();
      next.update(&u);
      u = next.finalize().into_bytes();
      for (t, u) in t.iter_mut().zip(u.iter()) {
        *t ^= u;
      }
      done += 1;
      if done.is_multiple_of(4096) && crate::vm::out_of_time() {
        return Err(CryptoError::Interrupted);
      }
    }
    chunk.copy_from_slice(&t[..chunk.len()]);
  }
  Ok(())
}

fn read_rsa_public_key(key_data: KeyData) -> Result<RsaPublicKey, CryptoError> {
  let public_key = match key_data.r#type {
    KeyType::Private => {
      RsaPrivateKey::from_pkcs1_der(&key_data.data)?.to_public_key()
    }
    KeyType::Public => RsaPublicKey::from_pkcs1_der(&key_data.data)?,
    KeyType::Secret => return Err(CryptoError::InvalidKeyFormat),
  };
  Ok(public_key)
}

pub fn op_crypto_random_uuid() -> Result<String, CryptoError> {
  let mut bytes = [0u8; 16];
  IsolaneRng
    .try_fill_bytes(&mut bytes)
    .map_err(|_| JsErrorBox::generic("no randomness available"))?;
  Ok(fast_uuid_v4(&mut bytes))
}

pub fn op_crypto_subtle_digest(
  algorithm: CryptoHash,
  data: &[u8],
) -> Result<Vec<u8>, CryptoError> {
  Ok(match algorithm {
    CryptoHash::Sha1 => Sha1::digest(data).to_vec(),
    CryptoHash::Sha256 => Sha256::digest(data).to_vec(),
    CryptoHash::Sha384 => Sha384::digest(data).to_vec(),
    CryptoHash::Sha512 => Sha512::digest(data).to_vec(),
    CryptoHash::Sha3_256 => sha3::Sha3_256::digest(data).to_vec(),
    CryptoHash::Sha3_384 => sha3::Sha3_384::digest(data).to_vec(),
    CryptoHash::Sha3_512 => sha3::Sha3_512::digest(data).to_vec(),
  })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WrapUnwrapKeyArg {
  key: V8RawKeyData,
  algorithm: Algorithm,
}

pub fn op_crypto_wrap_key(
  args: WrapUnwrapKeyArg,
  data: &[u8],
) -> Result<Vec<u8>, CryptoError> {
  let algorithm = args.algorithm;

  match algorithm {
    Algorithm::AesKw => {
      let key = args.key.as_secret_key()?;

      if !data.len().is_multiple_of(8) {
        return Err(CryptoError::DataInvalidSize);
      }

      let wrapped_key = match key.len() {
        16 => KekAes128::new(key.into()).wrap_vec(data),
        24 => KekAes192::new(key.into()).wrap_vec(data),
        32 => KekAes256::new(key.into()).wrap_vec(data),
        _ => return Err(CryptoError::InvalidKeyLength),
      }
      .map_err(|_| CryptoError::EncryptionError)?;

      Ok(wrapped_key)
    }
    _ => Err(CryptoError::UnsupportedAlgorithm),
  }
}

pub fn op_crypto_unwrap_key(
  args: WrapUnwrapKeyArg,
  data: &[u8],
) -> Result<Vec<u8>, CryptoError> {
  let algorithm = args.algorithm;
  match algorithm {
    Algorithm::AesKw => {
      let key = args.key.as_secret_key()?;

      if !data.len().is_multiple_of(8) {
        return Err(CryptoError::DataInvalidSize);
      }

      let unwrapped_key = match key.len() {
        16 => KekAes128::new(key.into()).unwrap_vec(data),
        24 => KekAes192::new(key.into()).unwrap_vec(data),
        32 => KekAes256::new(key.into()).unwrap_vec(data),
        _ => return Err(CryptoError::InvalidKeyLength),
      }
      .map_err(|_| CryptoError::DecryptionError)?;

      Ok(unwrapped_key)
    }
    _ => Err(CryptoError::UnsupportedAlgorithm),
  }
}

const HEX_CHARS: &[u8; 16] = b"0123456789abcdef";

fn fast_uuid_v4(bytes: &mut [u8; 16]) -> String {
  // Set UUID version to 4 and variant to 1.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let buf = [
    HEX_CHARS[(bytes[0] >> 4) as usize],
    HEX_CHARS[(bytes[0] & 0x0f) as usize],
    HEX_CHARS[(bytes[1] >> 4) as usize],
    HEX_CHARS[(bytes[1] & 0x0f) as usize],
    HEX_CHARS[(bytes[2] >> 4) as usize],
    HEX_CHARS[(bytes[2] & 0x0f) as usize],
    HEX_CHARS[(bytes[3] >> 4) as usize],
    HEX_CHARS[(bytes[3] & 0x0f) as usize],
    b'-',
    HEX_CHARS[(bytes[4] >> 4) as usize],
    HEX_CHARS[(bytes[4] & 0x0f) as usize],
    HEX_CHARS[(bytes[5] >> 4) as usize],
    HEX_CHARS[(bytes[5] & 0x0f) as usize],
    b'-',
    HEX_CHARS[(bytes[6] >> 4) as usize],
    HEX_CHARS[(bytes[6] & 0x0f) as usize],
    HEX_CHARS[(bytes[7] >> 4) as usize],
    HEX_CHARS[(bytes[7] & 0x0f) as usize],
    b'-',
    HEX_CHARS[(bytes[8] >> 4) as usize],
    HEX_CHARS[(bytes[8] & 0x0f) as usize],
    HEX_CHARS[(bytes[9] >> 4) as usize],
    HEX_CHARS[(bytes[9] & 0x0f) as usize],
    b'-',
    HEX_CHARS[(bytes[10] >> 4) as usize],
    HEX_CHARS[(bytes[10] & 0x0f) as usize],
    HEX_CHARS[(bytes[11] >> 4) as usize],
    HEX_CHARS[(bytes[11] & 0x0f) as usize],
    HEX_CHARS[(bytes[12] >> 4) as usize],
    HEX_CHARS[(bytes[12] & 0x0f) as usize],
    HEX_CHARS[(bytes[13] >> 4) as usize],
    HEX_CHARS[(bytes[13] & 0x0f) as usize],
    HEX_CHARS[(bytes[14] >> 4) as usize],
    HEX_CHARS[(bytes[14] & 0x0f) as usize],
    HEX_CHARS[(bytes[15] >> 4) as usize],
    HEX_CHARS[(bytes[15] & 0x0f) as usize],
  ];

  // Hex digits and dashes only (Deno uses from_utf8_unchecked).
  String::from_utf8_lossy(&buf).into_owned()
}
