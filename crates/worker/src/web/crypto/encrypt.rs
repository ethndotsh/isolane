// Copyright 2018-2026 the Deno authors. MIT license.
//! Ported from Deno's ext/crypto/encrypt.rs (denoland/deno@eb4061f6f367) to
//! isolane's ops: see mod.rs.

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::BlockEncryptMut;
use aes::cipher::KeyIvInit;
use aes::cipher::StreamCipher;
use ctr::Ctr128BE;
use ctr::Ctr32BE;
use ctr::Ctr64BE;
use rsa::pkcs1::DecodeRsaPublicKey;
use serde::Deserialize;
use sha1::Sha1;
use sha2::Sha256;
use sha2::Sha384;
use sha2::Sha512;
use sha3::Sha3_256;
use sha3::Sha3_384;
use sha3::Sha3_512;

use super::shared::{ShaHash, SharedError, V8RawKeyData};
use super::IsolaneRng;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptOptions {
    key: V8RawKeyData,
    #[serde(flatten)]
    algorithm: EncryptAlgorithm,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "algorithm")]
pub enum EncryptAlgorithm {
    #[serde(rename = "RSA-OAEP")]
    RsaOaep {
        hash: ShaHash,
        #[serde(with = "serde_bytes")]
        label: Vec<u8>,
    },
    #[serde(rename = "AES-CBC", rename_all = "camelCase")]
    AesCbc {
        #[serde(with = "serde_bytes")]
        iv: Vec<u8>,
        length: usize,
    },
    #[serde(rename = "AES-GCM", rename_all = "camelCase")]
    AesGcm {
        #[serde(with = "serde_bytes")]
        iv: Vec<u8>,
        #[serde(with = "serde_bytes")]
        additional_data: Option<Vec<u8>>,
        length: usize,
        tag_length: usize,
    },
    #[serde(rename = "AES-OCB", rename_all = "camelCase")]
    AesOcb {
        #[serde(with = "serde_bytes")]
        iv: Vec<u8>,
        #[serde(with = "serde_bytes")]
        additional_data: Option<Vec<u8>>,
        length: usize,
        tag_length: usize,
    },
    #[serde(rename = "AES-CTR", rename_all = "camelCase")]
    AesCtr {
        #[serde(with = "serde_bytes")]
        counter: Vec<u8>,
        ctr_length: usize,
        key_length: usize,
    },
}

#[derive(Debug, thiserror::Error, deno_error::JsError)]
pub enum EncryptError {
    #[class(inherit)]
    #[error(transparent)]
    General(
        #[from]
        #[inherit]
        SharedError,
    ),
    #[class(type)]
    #[error("invalid length")]
    InvalidLength,
    #[class("DOMExceptionOperationError")]
    #[error("invalid key or iv")]
    InvalidKeyOrIv,
    #[class(type)]
    #[error("iv length not equal to 12 or 16")]
    InvalidIvLength,
    #[class(type)]
    #[error("invalid counter length. Currently supported 32/64/128 bits")]
    InvalidCounterLength,
    #[class("DOMExceptionOperationError")]
    #[error("tried to encrypt too much data")]
    TooMuchData,
    #[class("DOMExceptionOperationError")]
    #[error("Encryption failed")]
    Failed,
}

pub fn op_crypto_encrypt(opts: EncryptOptions, data: &[u8]) -> Result<Vec<u8>, EncryptError> {
    let key = opts.key;
    match opts.algorithm {
        EncryptAlgorithm::RsaOaep { hash, label } => encrypt_rsa_oaep(key, hash, label, data),
        EncryptAlgorithm::AesCbc { iv, length } => encrypt_aes_cbc(key, length, iv, data),
        EncryptAlgorithm::AesGcm {
            iv,
            additional_data,
            length,
            tag_length,
        } => encrypt_aes_gcm(key, length, tag_length, iv, additional_data, data),
        EncryptAlgorithm::AesOcb {
            iv,
            additional_data,
            length,
            tag_length,
        } => encrypt_aes_ocb(key, length, tag_length, iv, additional_data, data),
        EncryptAlgorithm::AesCtr {
            counter,
            ctr_length,
            key_length,
        } => encrypt_aes_ctr(key, key_length, &counter, ctr_length, data),
    }
}

fn encrypt_rsa_oaep(
    key: V8RawKeyData,
    hash: ShaHash,
    label: Vec<u8>,
    data: &[u8],
) -> Result<Vec<u8>, EncryptError> {
    let label = String::from_utf8_lossy(&label).to_string();

    let public_key = key.as_rsa_public_key()?;
    let public_key = rsa::RsaPublicKey::from_pkcs1_der(&public_key)
        .map_err(|_| SharedError::FailedDecodePublicKey)?;
    let mut rng = IsolaneRng;
    let padding = match hash {
        ShaHash::Sha1 => rsa::Oaep {
            digest: Box::<Sha1>::default(),
            mgf_digest: Box::<Sha1>::default(),
            label: Some(label),
        },
        ShaHash::Sha256 => rsa::Oaep {
            digest: Box::<Sha256>::default(),
            mgf_digest: Box::<Sha256>::default(),
            label: Some(label),
        },
        ShaHash::Sha384 => rsa::Oaep {
            digest: Box::<Sha384>::default(),
            mgf_digest: Box::<Sha384>::default(),
            label: Some(label),
        },
        ShaHash::Sha512 => rsa::Oaep {
            digest: Box::<Sha512>::default(),
            mgf_digest: Box::<Sha512>::default(),
            label: Some(label),
        },
        ShaHash::Sha3_256 => rsa::Oaep {
            digest: Box::<Sha3_256>::default(),
            mgf_digest: Box::<Sha3_256>::default(),
            label: Some(label),
        },
        ShaHash::Sha3_384 => rsa::Oaep {
            digest: Box::<Sha3_384>::default(),
            mgf_digest: Box::<Sha3_384>::default(),
            label: Some(label),
        },
        ShaHash::Sha3_512 => rsa::Oaep {
            digest: Box::<Sha3_512>::default(),
            mgf_digest: Box::<Sha3_512>::default(),
            label: Some(label),
        },
    };
    let encrypted = public_key
        .encrypt(&mut rng, padding, data)
        .map_err(|_| EncryptError::Failed)?;
    Ok(encrypted)
}

fn encrypt_aes_cbc(
    key: V8RawKeyData,
    length: usize,
    iv: Vec<u8>,
    data: &[u8],
) -> Result<Vec<u8>, EncryptError> {
    let key = key.as_secret_key()?;
    let ciphertext = match length {
        128 => {
            // Section 10.3 Step 2 of RFC 2315 https://www.rfc-editor.org/rfc/rfc2315
            type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

            let cipher = Aes128CbcEnc::new_from_slices(key, &iv)
                .map_err(|_| EncryptError::InvalidKeyOrIv)?;
            cipher.encrypt_padded_vec_mut::<Pkcs7>(data)
        }
        192 => {
            // Section 10.3 Step 2 of RFC 2315 https://www.rfc-editor.org/rfc/rfc2315
            type Aes192CbcEnc = cbc::Encryptor<aes::Aes192>;

            let cipher = Aes192CbcEnc::new_from_slices(key, &iv)
                .map_err(|_| EncryptError::InvalidKeyOrIv)?;
            cipher.encrypt_padded_vec_mut::<Pkcs7>(data)
        }
        256 => {
            // Section 10.3 Step 2 of RFC 2315 https://www.rfc-editor.org/rfc/rfc2315
            type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;

            let cipher = Aes256CbcEnc::new_from_slices(key, &iv)
                .map_err(|_| EncryptError::InvalidKeyOrIv)?;
            cipher.encrypt_padded_vec_mut::<Pkcs7>(data)
        }
        _ => return Err(EncryptError::InvalidLength),
    };
    Ok(ciphertext)
}

fn encrypt_aes_gcm(
    key: V8RawKeyData,
    length: usize,
    tag_length: usize,
    iv: Vec<u8>,
    additional_data: Option<Vec<u8>>,
    data: &[u8],
) -> Result<Vec<u8>, EncryptError> {
    let key = key.as_secret_key()?;
    let additional_data = additional_data.unwrap_or_default();
    // isolane: any IV length and tag length (super::gcm), where Deno's
    // aes-gcm crate takes 96- or 128-bit IVs only.
    if ![128, 192, 256].contains(&length) {
        return Err(EncryptError::InvalidLength);
    }
    if iv.is_empty() {
        return Err(EncryptError::InvalidIvLength);
    }
    super::gcm::seal(length, key, &iv, &additional_data, data, tag_length / 8)
        .ok_or(EncryptError::Failed)
}

fn encrypt_aes_ocb(
    key: V8RawKeyData,
    length: usize,
    tag_length: usize,
    iv: Vec<u8>,
    additional_data: Option<Vec<u8>>,
    data: &[u8],
) -> Result<Vec<u8>, EncryptError> {
    use aes_gcm::aead::generic_array::GenericArray;
    use ocb3::aead::AeadInPlace as Ocb3AeadInPlace;
    use ocb3::aead::KeyInit as Ocb3KeyInit;
    use ocb3::Ocb3;

    let key = key.as_secret_key()?;
    let additional_data = additional_data.unwrap_or_default();

    let mut ciphertext = data.to_vec();

    // OCB allows nonces of 1 to 15 bytes, but `Ocb3`'s default nonce size is
    // 12 bytes, and `from_slice` panics on any other length (which aborts the
    // worker; Deno, unwinding, would only fail the op).
    if iv.len() != 12 {
        return Err(EncryptError::InvalidIvLength);
    }

    let nonce = GenericArray::from_slice(&iv);

    let tag = match length {
        128 => {
            let cipher =
                Ocb3::<aes::Aes128>::new_from_slice(key).map_err(|_| EncryptError::Failed)?;
            cipher
                .encrypt_in_place_detached(nonce, &additional_data, &mut ciphertext)
                .map_err(|_| EncryptError::Failed)?
        }
        192 => {
            let cipher =
                Ocb3::<aes::Aes192>::new_from_slice(key).map_err(|_| EncryptError::Failed)?;
            cipher
                .encrypt_in_place_detached(nonce, &additional_data, &mut ciphertext)
                .map_err(|_| EncryptError::Failed)?
        }
        256 => {
            let cipher =
                Ocb3::<aes::Aes256>::new_from_slice(key).map_err(|_| EncryptError::Failed)?;
            cipher
                .encrypt_in_place_detached(nonce, &additional_data, &mut ciphertext)
                .map_err(|_| EncryptError::Failed)?
        }
        _ => return Err(EncryptError::InvalidLength),
    };

    // Truncate tag to the specified tag length
    // OCB tag is 16 bytes by default
    let tag = tag
        .get(..(tag_length / 8))
        .ok_or(EncryptError::InvalidLength)?;

    // C | T
    ciphertext.extend_from_slice(tag);

    Ok(ciphertext)
}

fn encrypt_aes_ctr_gen<B>(key: &[u8], counter: &[u8], data: &[u8]) -> Result<Vec<u8>, EncryptError>
where
    B: KeyIvInit + StreamCipher,
{
    // `new` panics on a key or counter of the wrong size; `new_from_slices`
    // checks.
    let mut cipher = B::new_from_slices(key, counter).map_err(|_| EncryptError::InvalidKeyOrIv)?;

    let mut ciphertext = data.to_vec();
    cipher
        .try_apply_keystream(&mut ciphertext)
        .map_err(|_| EncryptError::TooMuchData)?;

    Ok(ciphertext)
}

fn encrypt_aes_ctr(
    key: V8RawKeyData,
    key_length: usize,
    counter: &[u8],
    ctr_length: usize,
    data: &[u8],
) -> Result<Vec<u8>, EncryptError> {
    let key = key.as_secret_key()?;

    match ctr_length {
        32 => match key_length {
            128 => encrypt_aes_ctr_gen::<Ctr32BE<aes::Aes128>>(key, counter, data),
            192 => encrypt_aes_ctr_gen::<Ctr32BE<aes::Aes192>>(key, counter, data),
            256 => encrypt_aes_ctr_gen::<Ctr32BE<aes::Aes256>>(key, counter, data),
            _ => Err(EncryptError::InvalidLength),
        },
        64 => match key_length {
            128 => encrypt_aes_ctr_gen::<Ctr64BE<aes::Aes128>>(key, counter, data),
            192 => encrypt_aes_ctr_gen::<Ctr64BE<aes::Aes192>>(key, counter, data),
            256 => encrypt_aes_ctr_gen::<Ctr64BE<aes::Aes256>>(key, counter, data),
            _ => Err(EncryptError::InvalidLength),
        },
        128 => match key_length {
            128 => encrypt_aes_ctr_gen::<Ctr128BE<aes::Aes128>>(key, counter, data),
            192 => encrypt_aes_ctr_gen::<Ctr128BE<aes::Aes192>>(key, counter, data),
            256 => encrypt_aes_ctr_gen::<Ctr128BE<aes::Aes256>>(key, counter, data),
            _ => Err(EncryptError::InvalidLength),
        },
        _ => Err(EncryptError::InvalidCounterLength),
    }
}
