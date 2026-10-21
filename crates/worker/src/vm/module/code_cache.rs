//! V8 code caches for a program's modules, kept per worker (a tenant's) and
//! keyed by a hash of what the module's code is made from, so a program's
//! later instances deserialize its bytecode instead of parsing and
//! compiling it again.
//!
//! A cache is made once the module has evaluated, so it holds the
//! functions setup ran as well as the top level. V8 checks a cache against
//! its own version, flags, and the source before using it, and a rejected
//! one is dropped and made again. The cache is bounded and dropped whole
//! when full, like the transform cache.
//!
//! Caches never leave the worker: a recycled worker makes its own again
//! (see docs/deployments.md, "Caches and invalidation", for why the
//! supervisor keeps no copies).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use sha2::{Digest, Sha256};

/// Most bytes of code cache the worker keeps.
const CACHE_BYTES: usize = 64 << 20;

/// A module's cache key: what its code is made from, hashed (its name, and
/// its file's hash and the transform's options, or the code itself).
pub(crate) type Key = [u8; 32];

pub(crate) fn key(parts: &[&[u8]]) -> Key {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part);
    }
    hash.finalize().into()
}

#[derive(Default)]
struct Cache {
    entries: HashMap<Key, Arc<Vec<u8>>>,
    bytes: usize,
}

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Cache::default()))
}

/// The cache for `key`, if the worker has one.
pub(crate) fn get(key: &Key) -> Option<Arc<Vec<u8>>> {
    cache().lock().ok()?.entries.get(key).cloned()
}

/// Keep `bytes` as the cache for `key`. Returns whether it was kept (not
/// too big for the cache).
pub(crate) fn put(key: Key, bytes: Arc<Vec<u8>>) -> bool {
    let Ok(mut cache) = cache().lock() else {
        return false;
    };
    let size = bytes.len();
    if size > CACHE_BYTES {
        return false;
    }
    if cache.bytes + size > CACHE_BYTES {
        *cache = Cache::default();
    }
    if let Some(old) = cache.entries.insert(key, bytes) {
        cache.bytes -= old.len();
    }
    cache.bytes += size;
    true
}

/// Forget the cache for `key` (V8 rejected it).
pub(crate) fn remove(key: &Key) {
    if let Ok(mut cache) = cache().lock() {
        if let Some(old) = cache.entries.remove(key) {
            cache.bytes -= old.len();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_tell_name_and_code_apart() {
        assert_ne!(key(&[b"a.js", b"bc"]), key(&[b"a.jsb", b"c"]));
        assert_eq!(key(&[b"a.js", b"1"]), key(&[b"a.js", b"1"]));
    }

    #[test]
    fn put_replaces_and_counts_bytes_once() {
        let k = key(&[b"put_replaces.js", b"1"]);
        assert!(put(k, Arc::new(vec![0; 10])));
        assert!(put(k, Arc::new(vec![0; 4])));
        assert_eq!(get(&k).map(|b| b.len()), Some(4));
        remove(&k);
        assert!(get(&k).is_none());
    }
}
