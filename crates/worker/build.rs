// Two things for the web platform's startup snapshot (src/web/snapshot.rs):
//
// - ISOLANE_WEB_SNAPSHOT: a snapshot made by this crate's own previous build
//   (`isolane-worker --make-web-snapshot`, see scripts/build-worker.sh), to
//   embed in the binary. Without it, the worker builds one at startup.
// - A hash of runtime/, the JS the snapshot is made from, so a worker can
//   tell an embedded snapshot made from other JS and ignore it.

use std::path::{Path, PathBuf};

fn main() {
    println!("cargo::rustc-check-cfg=cfg(isolane_embedded_snapshot)");
    println!("cargo:rerun-if-env-changed=ISOLANE_WEB_SNAPSHOT");
    if let Some(path) = std::env::var_os("ISOLANE_WEB_SNAPSHOT").filter(|p| !p.is_empty()) {
        let path = std::fs::canonicalize(&path).unwrap_or_else(|e| panic!("ISOLANE_WEB_SNAPSHOT={}: {e}", Path::new(&path).display()));
        println!("cargo:rerun-if-changed={}", path.display());
        println!("cargo:rustc-env=ISOLANE_WEB_SNAPSHOT_PATH={}", path.display());
        println!("cargo:rustc-cfg=isolane_embedded_snapshot");
    }

    let runtime = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../runtime");
    println!("cargo:rerun-if-changed={}", runtime.display());
    let mut files = Vec::new();
    collect(&runtime, &mut files);
    files.sort();
    let mut hash = Fnv::new();
    for file in &files {
        println!("cargo:rerun-if-changed={}", file.display());
        hash.write(file.strip_prefix(&runtime).unwrap().to_string_lossy().as_bytes());
        hash.write(&std::fs::read(file).unwrap());
    }
    println!("cargo:rustc-env=ISOLANE_RUNTIME_HASH={:016x}", hash.0);
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            println!("cargo:rerun-if-changed={}", path.display());
            collect(&path, out);
        } else {
            out.push(path);
        }
    }
}

/// FNV-1a, 64-bit: a fingerprint of our own sources, not a defense against
/// anyone (the same function is in src/web/snapshot.rs).
struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 = (self.0 ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3);
        }
        // Separate fields, so ("ab", "c") and ("a", "bc") differ.
        self.0 = (self.0 ^ 0xff).wrapping_mul(0x0100_0000_01b3);
    }
}
