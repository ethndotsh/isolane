//! The web platform (WinterTC's Minimum Common Web Platform API, phases 1
//! to 4) for VMs created with `webPlatform`. The APIs themselves are Deno's
//! web-platform JS, vendored in runtime/deno/ (MIT). In place of deno_core,
//! this module provides the native layer that JS calls: Deno's ops (same
//! names and calling conventions) and a few helpers for runtime/core.js.
//!
//! Setup: run primordials (capturing pristine intrinsics), build the
//! `__bootstrap` object in runtime/core.js, then install the globals from
//! runtime/globals.js. Guest code never sees `__bootstrap`: vendored files
//! get it as a function parameter.
//!
//! That setup runs once per worker, into a V8 startup snapshot with every
//! API already loaded (`snapshot`); each web VM is created from it and then
//! configured with what's its own (`configure`). Without a snapshot (it
//! failed to build), each VM runs the setup itself, lazily (`install`).

mod base64;
mod snapshot;
pub use snapshot::{embedded_status as snapshot_status, external_references, make as make_snapshot, snapshot};
mod clone;
mod compression;
mod encoding;
mod fetch;
pub mod timers;
mod url;
mod urlpattern;

macro_rules! runtime_js {
    ($path:literal) => {
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../runtime/", $path))
    };
}

/// A global the web platform defines for the VM's prelude (the network
/// broker's handover, see runtime/globals.js); deleted after the prelude.
pub const FETCH_HOOK: &str = "__isolane_web_fetch";
/// The same for the socket broker (`connect()`, runtime/sockets.js).
pub const CONNECT_HOOK: &str = "__isolane_web_connect";
/// The same for the file broker (`fs`, runtime/fs.js).
pub const FS_HOOK: &str = "__isolane_web_fs";

const PRIMORDIALS: &str = runtime_js!("deno/libs/core/00_primordials.js");
const CORE: &str = runtime_js!("core.js");
const GLOBALS: &str = runtime_js!("globals.js");

/// Vendored scripts, by the specifier Deno's JS loads them with.
const EXT: &[(&str, &str)] = &[
    ("ext:deno_webidl/00_webidl.js", runtime_js!("deno/ext/webidl/00_webidl.js")),
    ("ext:deno_web/00_infra.js", runtime_js!("deno/ext/web/00_infra.js")),
    ("ext:deno_web/00_url.js", runtime_js!("deno/ext/web/00_url.js")),
    ("ext:deno_web/01_dom_exception.js", runtime_js!("deno/ext/web/01_dom_exception.js")),
    ("ext:deno_web/01_mimesniff.js", runtime_js!("deno/ext/web/01_mimesniff.js")),
    ("ext:deno_web/01_urlpattern.js", runtime_js!("deno/ext/web/01_urlpattern.js")),
    ("ext:deno_web/02_event.js", runtime_js!("deno/ext/web/02_event.js")),
    ("ext:deno_web/02_structured_clone.js", runtime_js!("deno/ext/web/02_structured_clone.js")),
    ("ext:deno_web/02_timers.js", runtime_js!("deno/ext/web/02_timers.js")),
    ("ext:deno_web/03_abort_signal.js", runtime_js!("deno/ext/web/03_abort_signal.js")),
    ("ext:deno_web/04_global_interfaces.js", runtime_js!("deno/ext/web/04_global_interfaces.js")),
    ("ext:deno_web/05_base64.js", runtime_js!("deno/ext/web/05_base64.js")),
    ("ext:deno_web/06_streams.js", runtime_js!("deno/ext/web/06_streams.js")),
    ("ext:deno_web/08_text_encoding.js", runtime_js!("deno/ext/web/08_text_encoding.js")),
    ("ext:deno_web/09_file.js", runtime_js!("deno/ext/web/09_file.js")),
    ("ext:deno_web/10_filereader.js", runtime_js!("deno/ext/web/10_filereader.js")),
    ("ext:deno_web/13_message_port.js", runtime_js!("deno/ext/web/13_message_port.js")),
    ("ext:deno_web/14_compression.js", runtime_js!("deno/ext/web/14_compression.js")),
    ("ext:deno_web/15_performance.js", runtime_js!("deno/ext/web/15_performance.js")),
    ("ext:deno_fetch/20_headers.js", runtime_js!("deno/ext/fetch/20_headers.js")),
    ("ext:deno_fetch/21_formdata.js", runtime_js!("deno/ext/fetch/21_formdata.js")),
    ("ext:deno_fetch/22_body.js", runtime_js!("deno/ext/fetch/22_body.js")),
    ("ext:deno_fetch/23_request.js", runtime_js!("deno/ext/fetch/23_request.js")),
    ("ext:deno_fetch/23_response.js", runtime_js!("deno/ext/fetch/23_response.js")),
    // WebCrypto: Deno's JS, owned by isolane since Deno moved it to Rust.
    ("ext:deno_crypto/00_crypto.js", runtime_js!("crypto.js")),
    // isolane's fetch() over the network broker (in place of 26_fetch.js).
    ("ext:isolane/fetch.js", runtime_js!("fetch.js")),
    // connect(), the Sockets API over the socket broker.
    ("ext:isolane/sockets.js", runtime_js!("sockets.js")),
    // The `fs` object over the file broker.
    ("ext:isolane/fs.js", runtime_js!("fs.js")),
];

// ---- helpers shared by the ops ----

type Args<'a> = v8::FunctionCallbackArguments<'a>;
type Rv<'a> = v8::ReturnValue<'a, v8::Value>;

pub(crate) use crate::bytes::{copy_bytes, new_u8array, with_bytes, with_bytes_mut, with_u32s_mut};
pub(crate) use crate::js::{guest_string, throw_range, throw_type};

fn string_arg(scope: &mut v8::PinScope, args: &Args, i: i32) -> String {
    args.get(i).to_rust_string_lossy(scope)
}

/// One-byte strings (Latin-1, Deno's ByteString): each char's code unit,
/// or None if any is above 0xFF.
fn byte_string(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Option<Vec<u8>> {
    let s = value.to_string(scope)?;
    if !s.contains_only_onebyte() {
        let mut units = vec![0u16; s.length()];
        s.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
        return units.iter().map(|&u| u8::try_from(u).ok()).collect();
    }
    let mut out = vec![0u8; s.length()];
    s.write_one_byte_v2(scope, 0, &mut out, v8::WriteFlags::empty());
    Some(out)
}

fn set_bool(rv: &mut Rv, v: bool) {
    rv.set_bool(v);
}

// ---- the native object (runtime/core.js's `native`) ----

/// Compile a vendored script as `function (__bootstrap) { return <IIFE> }`.
/// Its leading comment lines become blank lines, keeping line numbers.
fn compile_ext(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let specifier = string_arg(scope, &args, 0);
    let Some((_, source)) = EXT.iter().find(|(s, _)| *s == specifier) else {
        throw_type(scope, &format!("isolane: no built-in script {specifier}"));
        return;
    };
    let mut wrapped = String::with_capacity(source.len() + 64);
    let mut lines = source.split_inclusive('\n');
    for line in lines.by_ref() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("//") {
            wrapped.push('\n');
            continue;
        }
        wrapped.push_str("(function (__bootstrap) { return ");
        wrapped.push_str(line);
        break;
    }
    for line in lines {
        wrapped.push_str(line);
    }
    wrapped.push_str("\n})");
    let Some(code) = v8::String::new(scope, &wrapped) else { return };
    let name = v8::String::new(scope, &specifier).unwrap();
    let origin = script_origin(scope, name);
    let Some(script) = v8::Script::compile(scope, code, Some(&origin)) else { return };
    if let Some(f) = script.run(scope) {
        rv.set(f);
    }
}

fn script_origin<'s>(scope: &mut v8::PinScope<'s, '_>, name: v8::Local<'s, v8::String>) -> v8::ScriptOrigin<'s> {
    v8::ScriptOrigin::new(scope, name.into(), 0, 0, false, 0, None, false, false, false, None)
}

fn is_array_buffer(_: &mut v8::PinScope, args: Args, mut rv: Rv) {
    set_bool(&mut rv, args.get(0).is_array_buffer());
}
fn is_any_array_buffer(_: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let v = args.get(0);
    set_bool(&mut rv, v.is_array_buffer() || v.is_shared_array_buffer());
}
fn is_shared_array_buffer(_: &mut v8::PinScope, args: Args, mut rv: Rv) {
    set_bool(&mut rv, args.get(0).is_shared_array_buffer());
}
fn is_data_view(_: &mut v8::PinScope, args: Args, mut rv: Rv) {
    set_bool(&mut rv, args.get(0).is_data_view());
}
fn is_typed_array(_: &mut v8::PinScope, args: Args, mut rv: Rv) {
    set_bool(&mut rv, args.get(0).is_typed_array());
}
fn is_array_buffer_view(_: &mut v8::PinScope, args: Args, mut rv: Rv) {
    set_bool(&mut rv, args.get(0).is_array_buffer_view());
}
fn is_proxy(_: &mut v8::PinScope, args: Args, mut rv: Rv) {
    set_bool(&mut rv, args.get(0).is_proxy());
}
fn is_string_object(_: &mut v8::PinScope, args: Args, mut rv: Rv) {
    set_bool(&mut rv, args.get(0).is_string_object());
}

/// `core.encode`: a string to UTF-8 bytes (lone surrogates → U+FFFD).
fn encode(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let Some(s) = args.get(0).to_string(scope) else { return };
    let mut out = vec![0u8; s.utf8_length(scope)];
    let n = s.write_utf8_v2(scope, &mut out, v8::WriteFlags::kReplaceInvalidUtf8, None);
    out.truncate(n);
    rv.set(new_u8array(scope, &out).into());
}

/// `core.decode`: UTF-8 bytes to a string (invalid sequences → U+FFFD),
/// dropping one leading byte order mark, as deno_core's does (Blob.text()
/// relies on it: the Encoding Standard's UTF-8 decode strips the BOM).
fn decode(scope: &mut v8::PinScope, args: Args, mut rv: Rv) {
    let Some(text) = with_bytes(scope, args.get(0), |b| {
        String::from_utf8_lossy(b.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(b)).into_owned()
    }) else {
        throw_type(scope, "expected a buffer");
        return;
    };
    if let Some(s) = v8::String::new(scope, &text) {
        rv.set(s.into());
    }
}

/// Fill a buffer with random bytes: the VM's seeded stream if it has one,
/// else the OS.
pub(crate) fn fill_random(buf: &mut [u8]) -> bool {
    crate::vm::seeded_entropy(buf) || getrandom::getrandom(buf).is_ok()
}

fn random_uuid(scope: &mut v8::PinScope, _args: Args, mut rv: Rv) {
    let mut b = [0u8; 16];
    if !fill_random(&mut b) {
        throw_type(scope, "no randomness available");
        return;
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: Vec<String> = b.iter().map(|x| format!("{x:02x}")).collect();
    let s = format!(
        "{}-{}-{}-{}-{}",
        hex[0..4].concat(),
        hex[4..6].concat(),
        hex[6..8].concat(),
        hex[8..10].concat(),
        hex[10..16].concat()
    );
    rv.set(v8::String::new(scope, &s).unwrap().into());
}

/// An error nothing handled (reportError with no listener, a timer or
/// microtask that threw): the guest's console, at error level, and a
/// `guestError` frame.
fn report_unhandled_exception(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    let e = v8::Local::new(scope, args.get(0));
    crate::vm::report_guest_error(scope, "exception", e);
}

/// native.setRejectionReporter(fn), once per context: globals.js's
/// `unhandledrejection` dispatch, called for each rejection with no handler.
fn set_rejection_reporter(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    if let Ok(f) = v8::Local::<v8::Function>::try_from(args.get(0)) {
        let reporter = crate::vm::RejectionReporter(v8::Global::new(scope, f));
        scope.set_slot(std::rc::Rc::new(reporter));
    }
}

/// native.log(level, message): Deno's core.print, to the guest's console.
fn log(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    let level = string_arg(scope, &args, 0);
    let level = if level == "error" { "error" } else { "log" };
    crate::vm::guest_log(scope, level, "", args.get(1));
}

// ---- ops (Deno's names and conventions) ----

fn op_now(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    expose_time(scope, args.get(0), crate::clock::performance_now());
}

fn op_time_origin(scope: &mut v8::PinScope, args: Args, _rv: Rv) {
    let ms = crate::clock::time_origin_ms();
    expose_time(scope, args.get(0), std::time::Duration::from_secs_f64(ms.max(0.0) / 1000.0));
}

/// Write [seconds, subsecond nanoseconds] as two native-endian u32s.
fn expose_time(scope: &mut v8::PinScope, buf: v8::Local<v8::Value>, d: std::time::Duration) {
    with_bytes_mut(scope, buf, |out| {
        if out.len() >= 8 {
            out[0..4].copy_from_slice(&(d.as_secs() as u32).to_ne_bytes());
            out[4..8].copy_from_slice(&d.subsec_nanos().to_ne_bytes());
        }
    });
}

/// The native functions, as (name, callback): one list both builds the JS
/// objects and registers every callback with V8 as an external reference
/// (which a snapshot needs to restore them).
macro_rules! natives {
    ($($name:literal => $f:path),* $(,)?) => {
        vec![$(($name, v8::MapFnTo::<v8::FunctionCallback>::map_fn_to($f))),*]
    };
}

type Natives = Vec<(&'static str, v8::FunctionCallback)>;

mod crypto;

fn native_fns() -> Natives {
    natives!(
        "compileExt" => compile_ext,
        "maxTimers" => max_timers,
        "isArrayBuffer" => is_array_buffer,
        "isAnyArrayBuffer" => is_any_array_buffer,
        "isSharedArrayBuffer" => is_shared_array_buffer,
        "isDataView" => is_data_view,
        "isTypedArray" => is_typed_array,
        "isArrayBufferView" => is_array_buffer_view,
        "isProxy" => is_proxy,
        "isStringObject" => is_string_object,
        "encode" => encode,
        "decode" => decode,
        "structuredClone" => clone::structured_clone,
        "serialize" => clone::serialize_op,
        "deserialize" => clone::deserialize_op,
        "markNotSerializable" => clone::mark_not_serializable,
        "setHostObject" => clone::set_host_object,
        "randomUUID" => random_uuid,
        "reportUnhandledException" => report_unhandled_exception,
        "setRejectionReporter" => set_rejection_reporter,
        "newDecoder" => encoding::new_decoder,
        "decoderDecode" => encoding::decoder_decode,
        "freeDecoder" => encoding::free_decoder,
        "compressionNew" => compression::compression_new,
        "compressionWrite" => compression::compression_write,
        "compressionFinish" => compression::compression_finish,
        "compressionCheck" => compression::compression_check,
        "compressionFree" => compression::compression_free,
        "timerNow" => timers::timer_now,
        "timerState" => timers::timer_state,
        "setTimerRunner" => timers::set_timer_runner,
        "dataUrl" => fetch::data_url,
        "digest" => fetch::digest,
        "log" => log,
    )
}

fn op_fns() -> Natives {
    let mut ops = natives!(
        "op_base64_decode" => base64::op_base64_decode,
        "op_base64_encode_from_buffer" => base64::op_base64_encode_from_buffer,
        "op_base64_atob" => base64::op_base64_atob,
        "op_base64_btoa" => base64::op_base64_btoa,
        "op_url_parse" => url::op_url_parse,
        "op_url_parse_with_base" => url::op_url_parse_with_base,
        "op_url_reparse" => url::op_url_reparse,
        "op_url_get_serialization" => url::op_url_get_serialization,
        "op_url_parse_search_params" => url::op_url_parse_search_params,
        "op_url_stringify_search_params" => url::op_url_stringify_search_params,
        "op_urlpattern_parse" => urlpattern::op_urlpattern_parse,
        "op_urlpattern_process_match_input" => urlpattern::op_urlpattern_process_match_input,
        "op_encoding_normalize_label" => encoding::op_encoding_normalize_label,
        "op_encoding_decode_utf8" => encoding::op_encoding_decode_utf8,
        "op_encoding_decode_utf8_ascii_only" => encoding::op_encoding_decode_utf8_ascii_only,
        "op_encoding_decode_single" => encoding::op_encoding_decode_single,
        "op_encoding_encode_into" => encoding::op_encoding_encode_into,
        "op_encoding_encode_into_fallback" => encoding::op_encoding_encode_into_fallback,
        "op_now" => op_now,
        "op_time_origin" => op_time_origin,
    );
    ops.extend(crypto::op_fns());
    ops
}

/// Every callback the web platform's objects hold.
fn all_natives() -> impl Iterator<Item = v8::FunctionCallback> {
    native_fns().into_iter().chain(op_fns()).map(|(_, f)| f)
}

fn object_of<'s>(scope: &mut v8::PinScope<'s, '_>, natives: Natives) -> v8::Local<'s, v8::Object> {
    let obj = v8::Object::new(scope);
    for (name, f) in natives {
        let key = v8::String::new(scope, name).unwrap();
        let func = v8::Function::builder_raw(f).build(scope).expect("build web native");
        obj.set(scope, key.into(), func.into());
    }
    obj
}

/// native.maxTimers(): the VM's limits.timers (read per call: the JS that
/// asks may be from a snapshot made for every VM).
fn max_timers(scope: &mut v8::PinScope, _args: Args, mut rv: Rv) {
    rv.set(v8::Integer::new_from_unsigned(scope, crate::limits::get().timers).into());
}

// ---- setup ----

fn run_script<'s>(scope: &mut v8::PinScope<'s, '_>, name: &str, source: &str) -> Option<v8::Local<'s, v8::Value>> {
    let code = v8::String::new(scope, source)?;
    let name = v8::String::new(scope, name).unwrap();
    let origin = script_origin(scope, name);
    v8::Script::compile(scope, code, Some(&origin))?.run(scope)
}

fn call<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    f: v8::Local<'s, v8::Value>,
    args: &[v8::Local<'s, v8::Value>],
) -> Option<v8::Local<'s, v8::Value>> {
    let f = v8::Local::<v8::Function>::try_from(f).ok()?;
    let recv = v8::undefined(scope).into();
    f.call(scope, recv, args)
}

/// Bootstrap the web platform in the current context: primordials,
/// core.js, globals.js. Returns globals.js's `{ configure, materialize }`.
fn bootstrap<'s>(scope: &mut v8::PinScope<'s, '_>, global: v8::Local<'s, v8::Object>) -> Result<v8::Local<'s, v8::Object>, String> {
    v8::tc_scope!(let tc, scope);
    let failed = |tc: &mut v8::PinnedRef<v8::TryCatch<v8::HandleScope>>, step: &str| {
        let msg = tc.exception().map(|e| e.to_rust_string_lossy(tc)).unwrap_or_else(|| "unknown error".into());
        format!("web platform setup failed ({step}): {msg}")
    };

    // Primordials leave themselves on globalThis.__bootstrap; take them and
    // remove the global.
    if run_script(tc, "ext:core/00_primordials.js", PRIMORDIALS).is_none() {
        return Err(failed(tc, "primordials"));
    }
    let key = v8::String::new(tc, "__bootstrap").unwrap();
    let primordials = global
        .get(tc, key.into())
        .and_then(|b| v8::Local::<v8::Object>::try_from(b).ok())
        .and_then(|b| {
            let k = v8::String::new(tc, "primordials").unwrap();
            b.get(tc, k.into())
        });
    global.delete(tc, key.into());
    let Some(primordials) = primordials else {
        return Err("web platform setup failed: no primordials".into());
    };

    let native = object_of(tc, native_fns()).into();
    let ops = object_of(tc, op_fns()).into();
    let Some(core) = run_script(tc, "isolane:core.js", CORE) else {
        return Err(failed(tc, "core.js"));
    };
    let Some(bootstrap) = call(tc, core, &[native, ops, primordials]) else {
        return Err(failed(tc, "core.js"));
    };
    let Some(globals) = run_script(tc, "isolane:globals.js", GLOBALS) else {
        return Err(failed(tc, "globals.js"));
    };
    let Some(handle) = call(tc, globals, &[bootstrap]).and_then(|h| v8::Local::<v8::Object>::try_from(h).ok()) else {
        return Err(failed(tc, "globals.js"));
    };
    Ok(handle)
}

/// Call `handle[method](...args)`.
fn call_method<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    handle: v8::Local<'s, v8::Object>,
    method: &str,
    args: &[v8::Local<'s, v8::Value>],
) -> Result<(), String> {
    v8::tc_scope!(let tc, scope);
    let key = v8::String::new(tc, method).unwrap();
    let ran = handle.get(tc, key.into()).and_then(|f| call(tc, f, args));
    if ran.is_none() {
        let msg = tc.exception().map(|e| e.to_rust_string_lossy(tc)).unwrap_or_else(|| "unknown error".into());
        return Err(format!("web platform setup failed ({method}): {msg}"));
    }
    Ok(())
}

/// The VM's own web settings: its base URL (and `location`), its timers,
/// its time origin.
fn configure_with<'s>(scope: &mut v8::PinScope<'s, '_>, handle: v8::Local<'s, v8::Object>, base_url: Option<&str>) -> Result<(), String> {
    let url = match base_url {
        // The supervisor checked it's an absolute http(s) URL.
        Some(url) => v8::String::new(scope, url).unwrap().into(),
        None => v8::undefined(scope).into(),
    };
    call_method(scope, handle, "configure", &[url])
}

/// Install the web platform in a fresh context (no snapshot), lazily: each
/// global loads its script on first use.
pub fn install<'s>(scope: &mut v8::PinScope<'s, '_>, global: v8::Local<'s, v8::Object>, base_url: Option<&str>) -> Result<(), String> {
    let handle = bootstrap(scope, global)?;
    configure_with(scope, handle, base_url)
}

/// Where the snapshot keeps globals.js's handle for each VM to configure
/// itself with; deleted before guest code runs.
const SNAPSHOT_HANDLE: &str = "__isolane_web_setup";

/// Configure a context created from the snapshot.
pub fn configure<'s>(scope: &mut v8::PinScope<'s, '_>, global: v8::Local<'s, v8::Object>, base_url: Option<&str>) -> Result<(), String> {
    let key = v8::String::new(scope, SNAPSHOT_HANDLE).unwrap();
    let handle = global.get(scope, key.into()).and_then(|h| v8::Local::<v8::Object>::try_from(h).ok());
    global.delete(scope, key.into());
    let Some(handle) = handle else {
        return Err("web platform setup failed: the snapshot has no setup handle".into());
    };
    configure_with(scope, handle, base_url)
}
