//! AES-GCM (NIST SP 800-38D) over any IV length and any tag length
//! WebCrypto allows, from the AES block cipher and GHASH. Deno's ops use the
//! `aes-gcm` crate, which fixes both at compile time (Deno supports 96- and
//! 128-bit IVs, and only 128-bit tags when decrypting).

use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockEncrypt, KeyInit};
use ghash::universal_hash::UniversalHash;
use ghash::GHash;

type Block = GenericArray<u8, aes::cipher::consts::U16>;

/// AES-128, -192, or -256 by key length (in bits).
enum Aes {
    A128(aes::Aes128),
    A192(aes::Aes192),
    A256(aes::Aes256),
}

impl Aes {
    fn new(length: usize, key: &[u8]) -> Option<Aes> {
        Some(match length {
            128 => Aes::A128(aes::Aes128::new_from_slice(key).ok()?),
            192 => Aes::A192(aes::Aes192::new_from_slice(key).ok()?),
            256 => Aes::A256(aes::Aes256::new_from_slice(key).ok()?),
            _ => return None,
        })
    }

    fn encrypt(&self, block: &mut Block) {
        match self {
            Aes::A128(c) => c.encrypt_block(block),
            Aes::A192(c) => c.encrypt_block(block),
            Aes::A256(c) => c.encrypt_block(block),
        }
    }
}

fn lengths_block(a: usize, b: usize) -> Block {
    let mut block = Block::default();
    block[..8].copy_from_slice(&((a as u64) * 8).to_be_bytes());
    block[8..].copy_from_slice(&((b as u64) * 8).to_be_bytes());
    block
}

fn inc32(counter: &mut Block) {
    let n = u32::from_be_bytes([counter[12], counter[13], counter[14], counter[15]]).wrapping_add(1);
    counter[12..].copy_from_slice(&n.to_be_bytes());
}

struct Gcm {
    cipher: Aes,
    h: Block,
    j0: Block,
}

impl Gcm {
    fn new(length: usize, key: &[u8], iv: &[u8]) -> Option<Gcm> {
        if iv.is_empty() {
            return None;
        }
        let cipher = Aes::new(length, key)?;
        let mut h = Block::default();
        cipher.encrypt(&mut h);
        let j0 = if iv.len() == 12 {
            let mut j0 = Block::default();
            j0[..12].copy_from_slice(iv);
            j0[15] = 1;
            j0
        } else {
            let mut g = GHash::new(&h);
            g.update_padded(iv);
            g.update(&[lengths_block(0, iv.len())]);
            g.finalize()
        };
        Some(Gcm { cipher, h, j0 })
    }

    /// GCTR from inc32(J0): encryption and decryption alike.
    fn ctr(&self, data: &mut [u8]) {
        let mut counter = self.j0;
        for chunk in data.chunks_mut(16) {
            inc32(&mut counter);
            let mut keystream = counter;
            self.cipher.encrypt(&mut keystream);
            for (b, k) in chunk.iter_mut().zip(keystream.iter()) {
                *b ^= k;
            }
        }
    }

    fn tag(&self, aad: &[u8], ciphertext: &[u8]) -> Block {
        let mut g = GHash::new(&self.h);
        g.update_padded(aad);
        g.update_padded(ciphertext);
        g.update(&[lengths_block(aad.len(), ciphertext.len())]);
        let mut s = g.finalize();
        let mut e = self.j0;
        self.cipher.encrypt(&mut e);
        for (s, e) in s.iter_mut().zip(e.iter()) {
            *s ^= e;
        }
        s
    }
}

/// C || T, T being the first `tag_len` bytes (1 to 16) of the tag; None for
/// a bad key, IV, or tag length.
pub fn seal(length: usize, key: &[u8], iv: &[u8], aad: &[u8], plaintext: &[u8], tag_len: usize) -> Option<Vec<u8>> {
    if !(1..=16).contains(&tag_len) {
        return None;
    }
    let gcm = Gcm::new(length, key, iv)?;
    let mut out = plaintext.to_vec();
    gcm.ctr(&mut out);
    let tag = gcm.tag(aad, &out);
    out.extend_from_slice(&tag[..tag_len]);
    Some(out)
}

/// The plaintext of C || T, if T (the last `tag_len` bytes) checks out.
pub fn open(length: usize, key: &[u8], iv: &[u8], aad: &[u8], data: &[u8], tag_len: usize) -> Option<Vec<u8>> {
    if !(1..=16).contains(&tag_len) {
        return None;
    }
    let split = data.len().checked_sub(tag_len)?;
    let (ciphertext, tag) = data.split_at(split);
    let gcm = Gcm::new(length, key, iv)?;
    let expected = gcm.tag(aad, ciphertext);
    // Constant time, over the whole truncated tag.
    let diff = expected[..tag_len].iter().zip(tag).fold(0u8, |acc, (a, b)| acc | (a ^ b));
    if diff != 0 {
        return None;
    }
    let mut out = ciphertext.to_vec();
    gcm.ctr(&mut out);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    // The GCM spec's test case 4 (96-bit IV) and 6 (60-byte IV).
    #[test]
    fn known_answers() {
        let key = hex("feffe9928665731c6d6a8f9467308308");
        let p = hex("d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39");
        let a = hex("feedfacedeadbeeffeedfacedeadbeefabaddad2");
        let iv = hex("cafebabefacedbaddecaf888");
        let out = seal(128, &key, &iv, &a, &p, 16).unwrap();
        assert_eq!(&out[p.len()..], &hex("5bc94fbc3221a5db94fae95ae7121a47")[..]);
        assert_eq!(open(128, &key, &iv, &a, &out, 16).unwrap(), p);
        let iv = hex("9313225df88406e555909c5aff5269aa6a7a9538534f7da1e4c303d2a318a728c3c0c95156809539fcf0e2429a6b525416aedbf5a0de6a57a637b39b");
        let out = seal(128, &key, &iv, &a, &p, 16).unwrap();
        assert_eq!(&out[p.len()..], &hex("619cc5aefffe0bfa462af43c1699d050")[..]);
        assert_eq!(open(128, &key, &iv, &a, &out, 12).map(|_| ()), None);
        let short = seal(128, &key, &iv, &a, &p, 4).unwrap();
        assert_eq!(open(128, &key, &iv, &a, &short, 4).unwrap(), p);
    }
}
