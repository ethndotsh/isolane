//! The web platform's startup snapshot: a context with the whole platform
//! bootstrapped and every API loaded, serialized once per worker and
//! deserialized for each web VM, instead of compiling ~20k lines of JS per
//! VM. It's built from the worker's own embedded JS only, never guest code,
//! and holds nothing per VM: base URL, timers, time origin, randomness, and
//! clock state are set after each VM starts (see `configure`).

use std::borrow::Cow;
use std::sync::OnceLock;

/// The external references: function pointers, fixed for the life of the
/// process, so safe to share between VM threads.
struct References(&'static [v8::ExternalReference]);
unsafe impl Send for References {}
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

/// The snapshot, built on first use; a concurrent caller waits for it.
/// None if it couldn't be built (web VMs then set the platform up lazily).
pub fn snapshot() -> Option<&'static [u8]> {
    *SNAPSHOT.get_or_init(|| match build() {
        Ok(blob) => Some(blob),
        Err(e) => {
            eprintln!("isolane-worker: no web platform snapshot ({e}); web VMs will set it up themselves");
            None
        }
    })
}

fn build() -> Result<&'static [u8], String> {
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
    Ok(Box::leak(blob.to_vec().into_boxed_slice()))
}
