// Copyright 2018-2026 the Deno authors. MIT license.
// Ported from Deno's ext/crypto/decrypt.rs (denoland/deno@eb4061f6f367) to
// isolane's ops: see mod.rs.

use aes::cipher::BlockDecryptMut;
use aes::cipher::KeyIvInit;
use aes::cipher::block_padding::Pkcs7;
use ctr::Ctr32BE;
use ctr::Ctr64BE;
use ctr::Ctr128BE;
use ctr::cipher::StreamCipher;
use rsa::pkcs1::DecodeRsaPrivateKey;
use serde::Deserialize;
use sha1::Sha1;
use sha2::Sha256;
use sha2::Sha384;
use sha2::Sha512;
use sha3::Sha3_256;
use sha3::Sha3_384;
use sha3::Sha3_512;

use super::shared::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecryptOptions {
  key: V8RawKeyData,
  #[serde(flatten)]
  algorithm: DecryptAlgorithm,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "algorithm")]
pub enum DecryptAlgorithm {
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
  #[serde(rename = "AES-CTR", rename_all = "camelCase")]
  AesCtr {
    #[serde(with = "serde_bytes")]
    counter: Vec<u8>,
    ctr_length: usize,
    key_length: usize,
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
}

#[derive(Debug, thiserror::Error, deno_error::JsError)]
pub enum DecryptError {
  #[class(inherit)]
  #[error(transparent)]
  General(
    #[from]
    #[inherit]
    SharedError,
  ),
  #[class(generic)]
  #[error(transparent)]
  Pkcs1(#[from] rsa::pkcs1::Error),
  #[class("DOMExceptionOperationError")]
  #[error("Decryption failed")]
  Failed,
  #[class(type)]
  #[error("invalid length")]
  InvalidLength,
  #[class(type)]
  #[error("invalid counter length. Currently supported 32/64/128 bits")]
  InvalidCounterLength,
  #[class(type)]
  #[error("tag length not equal to 128")]
  InvalidTagLength,
  #[class("DOMExceptionOperationError")]
  #[error("invalid key or iv")]
  InvalidKeyOrIv,
  #[class("DOMExceptionOperationError")]
  #[error("tried to decrypt too much data")]
  TooMuchData,
  #[class(type)]
  #[error("iv length not equal to 12 or 16")]
  InvalidIvLength,
  #[class("DOMExceptionOperationError")]
  #[error("{0}")]
  Rsa(rsa::Error),
}

pub fn op_crypto_decrypt(
  opts: DecryptOptions,
  data: &[u8],
) -> Result<Vec<u8>, DecryptError> {
  let key = opts.key;
  match opts.algorithm {
    DecryptAlgorithm::RsaOaep { hash, label } => {
      decrypt_rsa_oaep(key, hash, label, data)
    }
    DecryptAlgorithm::AesCbc { iv, length } => {
      decrypt_aes_cbc(key, length, iv, data)
    }
    DecryptAlgorithm::AesCtr {
      counter,
      ctr_length,
      key_length,
    } => decrypt_aes_ctr(key, key_length, &counter, ctr_length, data),
    DecryptAlgorithm::AesGcm {
      iv,
      additional_data,
      length,
      tag_length,
    } => decrypt_aes_gcm(key, length, tag_length, iv, additional_data, data),
    DecryptAlgorithm::AesOcb {
      iv,
      additional_data,
      length,
      tag_length,
    } => decrypt_aes_ocb(key, length, tag_length, iv, additional_data, data),
  }
}

fn decrypt_rsa_oaep(
  key: V8RawKeyData,
  hash: ShaHash,
  label: Vec<u8>,
  data: &[u8],
) -> Result<Vec<u8>, DecryptError> {
  let key = key.as_rsa_private_key()?;

  let private_key = rsa::RsaPrivateKey::from_pkcs1_der(key)?;
  let label = Some(String::from_utf8_lossy(&label).to_string());

  let padding = match hash {
    ShaHash::Sha1 => rsa::Oaep {
      digest: Box::<Sha1>::default(),
      mgf_digest: Box::<Sha1>::default(),
      label,
    },
    ShaHash::Sha256 => rsa::Oaep {
      digest: Box::<Sha256>::default(),
      mgf_digest: Box::<Sha256>::default(),
      label,
    },
    ShaHash::Sha384 => rsa::Oaep {
      digest: Box::<Sha384>::default(),
      mgf_digest: Box::<Sha384>::default(),
      label,
    },
    ShaHash::Sha512 => rsa::Oaep {
      digest: Box::<Sha512>::default(),
      mgf_digest: Box::<Sha512>::default(),
      label,
    },
    ShaHash::Sha3_256 => rsa::Oaep {
      digest: Box::<Sha3_256>::default(),
      mgf_digest: Box::<Sha3_256>::default(),
      label,
    },
    ShaHash::Sha3_384 => rsa::Oaep {
      digest: Box::<Sha3_384>::default(),
      mgf_digest: Box::<Sha3_384>::default(),
      label,
    },
    ShaHash::Sha3_512 => rsa::Oaep {
      digest: Box::<Sha3_512>::default(),
      mgf_digest: Box::<Sha3_512>::default(),
      label,
    },
  };

  private_key
    .decrypt(padding, data)
    .map_err(DecryptError::Rsa)
}

fn decrypt_aes_cbc(
  key: V8RawKeyData,
  length: usize,
  iv: Vec<u8>,
  data: &[u8],
) -> Result<Vec<u8>, DecryptError> {
  let key = key.as_secret_key()?;

  // 2.
  let plaintext = match length {
    128 => {
      // Section 10.3 Step 2 of RFC 2315 https://www.rfc-editor.org/rfc/rfc2315
      type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;
      let cipher = Aes128CbcDec::new_from_slices(key, &iv)
        .map_err(|_| DecryptError::InvalidKeyOrIv)?;

      cipher
        .decrypt_padded_vec_mut::<Pkcs7>(data)
        .map_err(|_| DecryptError::Failed)?
    }
    192 => {
      // Section 10.3 Step 2 of RFC 2315 https://www.rfc-editor.org/rfc/rfc2315
      type Aes192CbcDec = cbc::Decryptor<aes::Aes192>;
      let cipher = Aes192CbcDec::new_from_slices(key, &iv)
        .map_err(|_| DecryptError::InvalidKeyOrIv)?;

      cipher
        .decrypt_padded_vec_mut::<Pkcs7>(data)
        .map_err(|_| DecryptError::Failed)?
    }
    256 => {
      // Section 10.3 Step 2 of RFC 2315 https://www.rfc-editor.org/rfc/rfc2315
      type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
      let cipher = Aes256CbcDec::new_from_slices(key, &iv)
        .map_err(|_| DecryptError::InvalidKeyOrIv)?;

      cipher
        .decrypt_padded_vec_mut::<Pkcs7>(data)
        .map_err(|_| DecryptError::Failed)?
    }
    _ => unreachable!(),
  };

  // 6.
  Ok(plaintext)
}

fn decrypt_aes_ctr_gen<B>(
  key: &[u8],
  counter: &[u8],
  data: &[u8],
) -> Result<Vec<u8>, DecryptError>
where
  B: KeyIvInit + StreamCipher,
{
  // `new` panics on a key or counter of the wrong size; `new_from_slices`
  // checks.
  let mut cipher = B::new_from_slices(key, counter)
    .map_err(|_| DecryptError::InvalidKeyOrIv)?;

  let mut plaintext = data.to_vec();
  cipher
    .try_apply_keystream(&mut plaintext)
    .map_err(|_| DecryptError::TooMuchData)?;

  Ok(plaintext)
}

fn decrypt_aes_ctr(
  key: V8RawKeyData,
  key_length: usize,
  counter: &[u8],
  ctr_length: usize,
  data: &[u8],
) -> Result<Vec<u8>, DecryptError> {
  let key = key.as_secret_key()?;

  match ctr_length {
    32 => match key_length {
      128 => decrypt_aes_ctr_gen::<Ctr32BE<aes::Aes128>>(key, counter, data),
      192 => decrypt_aes_ctr_gen::<Ctr32BE<aes::Aes192>>(key, counter, data),
      256 => decrypt_aes_ctr_gen::<Ctr32BE<aes::Aes256>>(key, counter, data),
      _ => Err(DecryptError::InvalidLength),
    },
    64 => match key_length {
      128 => decrypt_aes_ctr_gen::<Ctr64BE<aes::Aes128>>(key, counter, data),
      192 => decrypt_aes_ctr_gen::<Ctr64BE<aes::Aes192>>(key, counter, data),
      256 => decrypt_aes_ctr_gen::<Ctr64BE<aes::Aes256>>(key, counter, data),
      _ => Err(DecryptError::InvalidLength),
    },
    128 => match key_length {
      128 => decrypt_aes_ctr_gen::<Ctr128BE<aes::Aes128>>(key, counter, data),
      192 => decrypt_aes_ctr_gen::<Ctr128BE<aes::Aes192>>(key, counter, data),
      256 => decrypt_aes_ctr_gen::<Ctr128BE<aes::Aes256>>(key, counter, data),
      _ => Err(DecryptError::InvalidLength),
    },
    _ => Err(DecryptError::InvalidCounterLength),
  }
}

fn decrypt_aes_gcm(
  key: V8RawKeyData,
  length: usize,
  tag_length: usize,
  iv: Vec<u8>,
  additional_data: Option<Vec<u8>>,
  data: &[u8],
) -> Result<Vec<u8>, DecryptError> {
  let key = key.as_secret_key()?;
  let additional_data = additional_data.unwrap_or_default();
  // isolane: any IV length and tag length (super::gcm), where Deno's
  // aes-gcm crate takes 96- or 128-bit IVs, and 128-bit tags only here.
  if ![128, 192, 256].contains(&length) {
    return Err(DecryptError::InvalidLength);
  }
  if iv.is_empty() {
    return Err(DecryptError::InvalidIvLength);
  }
  super::gcm::open(length, key, &iv, &additional_data, data, tag_length / 8)
    .ok_or(DecryptError::Failed)
}

fn decrypt_aes_ocb(
  key: V8RawKeyData,
  length: usize,
  tag_length: usize,
  iv: Vec<u8>,
  additional_data: Option<Vec<u8>>,
  data: &[u8],
) -> Result<Vec<u8>, DecryptError> {
  use aes_gcm::aead::generic_array::GenericArray;
  use ocb3::Ocb3;
  use ocb3::aead::AeadInPlace as Ocb3AeadInPlace;
  use ocb3::aead::KeyInit as Ocb3KeyInit;

  let key = key.as_secret_key()?;
  let additional_data = additional_data.unwrap_or_default();

  // The `ocb3` crate only supports 128 bits tag length.
  //
  // Note that encryption won't fail, it instead truncates the tag
  // to the specified tag length as specified in the spec.
  if tag_length != 128 {
    return Err(DecryptError::InvalidTagLength);
  }

  // As in encrypt_aes_ocb: `Ocb3` takes 12-byte nonces only.
  if iv.len() != 12 {
    return Err(DecryptError::InvalidIvLength);
  }

  let sep = data
    .len()
    .checked_sub(tag_length / 8)
    .ok_or(DecryptError::Failed)?;
  let tag_bytes = &data[sep..];

  // The actual ciphertext, called plaintext because it is reused in place.
  let mut plaintext = data[..sep].to_vec();

  let nonce = GenericArray::from_slice(&iv);
  let tag = GenericArray::from_slice(tag_bytes);

  match length {
    128 => {
      let cipher = Ocb3::<aes::Aes128>::new_from_slice(key)
        .map_err(|_| DecryptError::Failed)?;
      cipher
        .decrypt_in_place_detached(nonce, &additional_data, &mut plaintext, tag)
        .map_err(|_| DecryptError::Failed)?;
    }
    192 => {
      let cipher = Ocb3::<aes::Aes192>::new_from_slice(key)
        .map_err(|_| DecryptError::Failed)?;
      cipher
        .decrypt_in_place_detached(nonce, &additional_data, &mut plaintext, tag)
        .map_err(|_| DecryptError::Failed)?;
    }
    256 => {
      let cipher = Ocb3::<aes::Aes256>::new_from_slice(key)
        .map_err(|_| DecryptError::Failed)?;
      cipher
        .decrypt_in_place_detached(nonce, &additional_data, &mut plaintext, tag)
        .map_err(|_| DecryptError::Failed)?;
    }
    _ => return Err(DecryptError::InvalidLength),
  }

  Ok(plaintext)
}
