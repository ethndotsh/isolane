//! The web platform's startup snapshot: a context with the whole platform
//! bootstrapped and every API loaded, serialized once per worker and
//! deserialized for each web VM, instead of compiling ~20k lines of JS per
//! VM. It's built from the worker's own embedded JS only, never guest code,
//! and holds nothing per VM: base URL, timers, time origin, randomness, and
//! clock state are set after each VM starts (see `configure`).
//!
//! Release builds embed it: scripts/build-worker.sh builds the worker, has
//! it write the snapshot (`--make-web-snapshot`), and builds it again with
//! the file in ISOLANE_WEB_SNAPSHOT. Same source and V8 both times, so the
//! snapshot fits the binary it's embedded in; a header records what it was
//! made from, and a worker that finds a different build there (an old file
//! in the variable) ignores it and builds its own at startup, as it does
//! with nothing embedded.

use std::borrow::Cow;
use std::sync::OnceLock;

/// The external references: function pointers, fixed for the life of the
/// process, so safe to share between VM threads.
struct References(&'static [v8::ExternalReference]);
// SAFETY: the entries are pointers to `extern "C"` functions (and a null
// terminator) in this binary: immutable for the life of the process, so
// sending or sharing them between threads can't race.
unsafe impl Send for References {}
// SAFETY: as above.
unsafe impl Sync for References {}

static REFERENCES: OnceLock<References> = OnceLock::new();
static SNAPSHOT: OnceLock<Option<&'static [u8]>> = OnceLock::new();

/// Every native callback the snapshot's objects hold, for V8 to match up
/// when it serializes and deserializes them.
pub fn external_references() -> &'static [v8::ExternalReference] {
    REFERENCES
        .get_or_init(|| {
            let mut refs: Vec<v8::ExternalReference> =
                super::all_natives().map(|function| v8::ExternalReference { function }).collect();
            refs.push(v8::ExternalReference { pointer: std::ptr::null_mut() });
            References(Box::leak(refs.into_boxed_slice()))
        })
        .0
}

/// The snapshot: the embedded one if it fits this build, else built on
/// first use (a concurrent caller waits for it). None if it couldn't be
/// built (web VMs then set the platform up lazily).
pub fn snapshot() -> Option<&'static [u8]> {
    *SNAPSHOT.get_or_init(|| {
        if let Some(blob) = embedded() {
            return Some(blob);
        }
        match build() {
            Ok(blob) => Some(Box::leak(blob.into_boxed_slice())),
            Err(e) => {
                eprintln!("isolane-worker: no web platform snapshot ({e}); web VMs will set it up themselves");
                None
            }
        }
    })
}

/// Where this build's snapshot comes from, for --self-check: "embedded",
/// "mismatch" (embedded, from another build), or "none".
pub fn embedded_status() -> &'static str {
    match EMBEDDED {
        None => "none",
        Some(file) if unwrap(file).is_ok() => "embedded",
        Some(_) => "mismatch",
    }
}

#[cfg(isolane_embedded_snapshot)]
static EMBEDDED: Option<&[u8]> = Some(include_bytes!(env!("ISOLANE_WEB_SNAPSHOT_PATH")));
#[cfg(not(isolane_embedded_snapshot))]
static EMBEDDED: Option<&[u8]> = None;

fn embedded() -> Option<&'static [u8]> {
    match unwrap(EMBEDDED?) {
        Ok(blob) => Some(blob),
        Err(e) => {
            eprintln!("isolane-worker: ignoring the embedded web platform snapshot ({e}); building one");
            None
        }
    }
}

const MAGIC: &str = "isolane-web-snapshot 1";

/// What a snapshot depends on besides V8's own data: V8 (its version, flags,
/// and build), the JS it ran (runtime/), and the native callbacks, which
/// V8 refers to by their index in `external_references`.
fn fingerprint() -> String {
    let mut natives = Fnv::new();
    for (name, _) in super::native_fns().into_iter().chain(super::op_fns()) {
        natives.write(name.as_bytes());
    }
    let build = if cfg!(feature = "dev-prebuilt") { "prebuilt" } else { "sandbox" };
    format!(
        "v8 {} ({build}, {}-{}); flags {:016x}; js {}; natives {:016x}",
        v8::V8::get_version(),
        std::env::consts::ARCH,
        std::env::consts::OS,
        Fnv::of(crate::V8_FLAGS.as_bytes()),
        env!("ISOLANE_RUNTIME_HASH"),
        natives.0,
    )
}

/// The file: MAGIC, a newline, the fingerprint, a newline, V8's blob.
fn wrap(blob: &[u8]) -> Vec<u8> {
    let mut file = format!("{MAGIC}\n{}\n", fingerprint()).into_bytes();
    file.extend_from_slice(blob);
    file
}

/// V8's blob, if the file was made by a build like this one. (V8 would
/// abort on another V8's snapshot, and misbehave with other JS or natives.)
fn unwrap(file: &[u8]) -> Result<&[u8], String> {
    let mut parts = file.splitn(3, |&b| b == b'\n');
    let (magic, made, blob) = (parts.next(), parts.next(), parts.next());
    if magic != Some(MAGIC.as_bytes()) {
        return Err("not a snapshot file".into());
    }
    let (made, blob) = (String::from_utf8_lossy(made.unwrap_or_default()), blob.unwrap_or_default());
    let this = fingerprint();
    if made != this {
        return Err(format!("made by {made}; this is {this}"));
    }
    Ok(blob)
}

/// --make-web-snapshot: write the snapshot file for the next build to embed.
pub fn make(path: &str) -> Result<(), String> {
    let blob = build()?;
    std::fs::write(path, wrap(&blob)).map_err(|e| format!("{path}: {e}"))
}

/// FNV-1a, 64-bit (as in build.rs): fingerprints of our own sources.
struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
    fn of(bytes: &[u8]) -> u64 {
        let mut h = Fnv::new();
        h.write(bytes);
        h.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 = (self.0 ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3);
        }
        self.0 = (self.0 ^ 0xff).wrapping_mul(0x0100_0000_01b3);
    }
}

fn build() -> Result<Vec<u8>, String> {
    let mut isolate = v8::Isolate::snapshot_creator(Some(Cow::Borrowed(external_references())), None);
    {
        v8::scope!(let scope, &mut isolate);
        let context = v8::Context::new(scope, Default::default());
        let scope = &mut v8::ContextScope::new(scope, context);
        let global = context.global(scope);
        let handle = super::bootstrap(scope, global)?;
        super::call_method(scope, handle, "materialize", &[])?;
        scope.perform_microtask_checkpoint();
        let key = v8::String::new(scope, super::SNAPSHOT_HANDLE).unwrap();
        global.define_own_property(scope, key.into(), handle.into(), v8::PropertyAttribute::DONT_ENUM);
        scope.set_default_context(context);
    }
    let blob = isolate.create_blob(v8::FunctionCodeHandling::Keep).ok_or("V8 couldn't serialize it")?;
    // Hash tables in the snapshot must be rehashed with each VM's own hash
    // seed; a snapshot that can't be would share one seed across VMs.
    if !blob.can_be_rehashed() {
        return Err("it can't be rehashed".into());
    }
    Ok(blob.to_vec())
}
