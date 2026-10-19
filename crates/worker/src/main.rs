//! isolane worker: runs one tenant's JavaScript in V8 isolates, driven by the
//! supervisor over length-prefixed JSON frames on stdin/stdout.
//!
//! `--self-check` prints whether this build's V8 sandbox is enabled and
//! securely configured, and exits non-zero if not. `--no-lockdown` skips the
//! process lockdown, for syscall tracing only; the worker then reports no
//! lockdown and a strict supervisor refuses it.

// Every unsafe block says why it's sound (`// SAFETY:`), and unsafe
// functions don't make their bodies implicitly unsafe.
#![deny(unsafe_op_in_unsafe_fn)]
#![warn(clippy::undocumented_unsafe_blocks)]

mod clock;
mod frame;
mod limits;
mod lockdown;
mod proto;
mod vm;
mod web;

use std::collections::HashMap;
use std::io::BufReader;
use std::process::ExitCode;
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;

use frame::{read_frame, Writer};
use proto::{fail, limit, ErrorCode, In, Out};
use vm::{VmConfig, VmMsg};

unsafe extern "C" {
    // rusty_v8's binding for v8::internal::SandboxIsEnabled().
    fn v8__V8__IsSandboxEnabled() -> bool;

    // v8::V8::IsSandboxConfiguredSecurely(), which rusty_v8 doesn't bind.
    // False means V8 couldn't reserve the sandbox's address space and fell
    // back to a sandbox without its security properties. Linked by its
    // Itanium-mangled name: a static member taking no arguments, so the
    // symbol involves no standard-library types.
    #[cfg(not(feature = "dev-prebuilt"))]
    #[link_name = "_ZN2v82V827IsSandboxConfiguredSecurelyEv"]
    fn v8_is_sandbox_configured_securely() -> bool;

    // v8::V8::SetFatalMemoryErrorCallback(), also not bound by rusty_v8.
    // Process-wide: V8 calls it for out-of-memory failures that belong to
    // no isolate (the sandbox's ArrayBuffer allocator), where an isolate's
    // OOM handler never runs and V8 would otherwise abort with a trap.
    #[link_name = "_ZN2v82V827SetFatalMemoryErrorCallbackEPFvPKcRKNS_10OOMDetailsEE"]
    fn v8_set_fatal_memory_error_callback(
        callback: unsafe extern "C" fn(*const std::ffi::c_char, &v8::OomDetails),
    );
}

/// V8 flags for untrusted code.
/// - no `eval`/`new Function` by default (each context opts in or not)
/// - no `SharedArrayBuffer` constructor (and the global is deleted)
/// - no Temporal: its clock is frozen like Date's (see `clock`), but it also
///   exposes the host time zone and hasn't been audited yet
const V8_FLAGS: &str = "--disallow-code-generation-from-strings \
    --enable-sharedarraybuffer-per-context \
    --no-harmony-temporal";

/// V8's seed for Math.random and its hash tables. Without an entropy
/// source, V8 on Linux reads /dev/urandom per isolate, which the lockdown
/// forbids, and then falls back to seeding from the clock. A VM created with
/// a random seed gets a deterministic stream instead (see `vm::seeded_entropy`).
#[cfg(target_os = "linux")]
fn entropy(buf: &mut [u8]) -> bool {
    if vm::seeded_entropy(buf) {
        return true;
    }
    let mut filled = 0;
    while filled < buf.len() {
        let rest = &mut buf[filled..];
        // SAFETY: getrandom writes at most rest.len() bytes into rest.
        let n = unsafe { libc::getrandom(rest.as_mut_ptr().cast(), rest.len(), 0) };
        if n < 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return false;
        }
        filled += n as usize;
    }
    true
}

/// Elsewhere V8 seeds from the OS itself (arc4random on macOS), so a seed
/// can only take effect through an entropy source.
#[cfg(not(target_os = "linux"))]
fn entropy(buf: &mut [u8]) -> bool {
    vm::seeded_entropy(buf)
}

fn init_v8() {
    v8::V8::set_entropy_source(entropy);
    v8::V8::set_flags_from_string(V8_FLAGS);
    // Background threads for GC and compilation. Each tenant has its own
    // process, so keep the pool small rather than one per core.
    #[cfg(not(feature = "dev-prebuilt"))]
    let platform = v8::Platform::new_with_clock(2, clock::platform_clock).make_shared();
    // The prebuilt V8 lacks the clock patch: guest clocks are real time.
    #[cfg(feature = "dev-prebuilt")]
    let platform = v8::new_default_platform(2, false).make_shared();
    vm::set_platform(platform.clone());
    v8::V8::initialize_platform(platform);
    v8::V8::initialize();
    // SAFETY: V8 is initialized, and the callback has the signature V8
    // declares (rusty_v8's OomDetails mirrors v8::OOMDetails).
    unsafe { v8_set_fatal_memory_error_callback(vm::out_of_memory) };
    // V8 reserves process-wide memory (the JIT's code range) when the first
    // isolate is created, before that isolate's OOM handler can be set. Do it
    // now, with a throwaway isolate: under a memory limit too small for V8 the
    // worker then fails at startup, here, instead of later in a guest's eval.
    drop(v8::Isolate::new(Default::default()));
}

#[cfg(not(feature = "dev-prebuilt"))]
fn sandbox_secure() -> bool {
    // SAFETY: both are argument-less queries, valid once V8 is initialized.
    unsafe { v8__V8__IsSandboxEnabled() && v8_is_sandbox_configured_securely() }
}
#[cfg(feature = "dev-prebuilt")]
fn sandbox_secure() -> bool {
    false
}

/// Writable private memory (what RLIMIT_DATA counts), in KiB (Linux).
fn vm_data_kib() -> Option<u64> {
    parse_vm_data(&std::fs::read_to_string("/proc/self/status").ok()?)
}

fn parse_vm_data(status: &str) -> Option<u64> {
    let line = status.lines().find(|l| l.starts_with("VmData:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

/// VmData from an already-open /proc/self/status (opened before Landlock,
/// which then refuses opening it again).
fn read_vm_data(file: &mut std::fs::File) -> Option<u64> {
    use std::io::{Read, Seek};
    file.rewind().ok()?;
    let mut status = String::new();
    file.read_to_string(&mut status).ok()?;
    parse_vm_data(&status)
}

fn self_check() -> ExitCode {
    let before = vm_data_kib();
    init_v8();
    let after_init = vm_data_kib();
    // SAFETY: an argument-less query, after init_v8().
    let enabled = unsafe { v8__V8__IsSandboxEnabled() };
    let secure = sandbox_secure();
    let isolate = v8::Isolate::new(Default::default());
    let with_isolate = vm_data_kib();
    drop(isolate);
    let kib = |v: Option<u64>| v.map(|k| k.to_string()).unwrap_or_else(|| "null".into());
    println!(
        "{{\"v8\":\"{}\",\"sandboxEnabled\":{enabled},\"sandboxSecure\":{secure},\"webSnapshot\":\"{}\",\"vmDataKiB\":{{\"start\":{},\"afterInit\":{},\"withIsolate\":{}}}}}",
        v8::V8::get_version(),
        web::snapshot_status(),
        kib(before),
        kib(after_init),
        kib(with_isolate)
    );
    if enabled && secure {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// Build time (scripts/build-worker.sh): write the web platform's snapshot
/// for the next build of this same source to embed. Set up like `serve`
/// (time zone, V8 flags), so the snapshot is the one serve would build.
fn make_web_snapshot(path: &str) -> ExitCode {
    std::env::set_var("TZ", "UTC");
    init_v8();
    match web::make_snapshot(path) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("isolane-worker: couldn't make the web platform snapshot: {e}");
            ExitCode::FAILURE
        }
    }
}

fn serve(lock_down: bool, memory_limit: Option<u64>, web_background: bool) -> ExitCode {
    // Every guest sees UTC: the host's time zone (Date#getTimezoneOffset,
    // Intl's default zone) would say where the machine is. Set while the
    // process is still single-threaded, before ICU first reads it.
    std::env::set_var("TZ", "UTC");
    let mut status = memory_limit.and_then(|_| std::fs::File::open("/proc/self/status").ok());
    let none = lockdown::Level::None;
    // Lockdown order matters: Landlock before V8 starts threads, seccomp
    // (on all threads) after V8 has initialized. A layer the host lacks
    // reports None; a layer that is available but fails to apply is fatal.
    let landlock = if lock_down { lockdown::before_v8() } else { Ok(none) };
    let landlock = match landlock {
        Ok(level) => level,
        Err(e) => {
            eprintln!("isolane-worker: {e}");
            return ExitCode::from(5);
        }
    };
    init_v8();
    // The web platform's snapshot is embedded in release builds. Without
    // one (or with another build's), it's built when the first web VM wants
    // it, or, with --prepare-web (the supervisor expects web VMs), right
    // away in the background: the worker reports ready without waiting,
    // and a web VM that comes sooner waits for the rest. Either way it's
    // memory operations only, the same under the lockdown below.
    if web_background {
        let _ = std::thread::Builder::new().name("web-snapshot".into()).spawn(|| {
            web::snapshot();
        });
    }
    // The limit is for guests, on top of what V8 has already mapped writable
    // (on x64 mostly its JIT code range: ~550 MiB of address space, little
    // of it in use).
    if let Some(bytes) = memory_limit {
        let baseline = status.as_mut().and_then(read_vm_data).unwrap_or(0) * 1024;
        if let Err(e) = lockdown::memory_limit(baseline + bytes) {
            eprintln!("isolane-worker: {e}");
            return ExitCode::from(5);
        }
    }
    drop(status);
    if !sandbox_secure() && !cfg!(feature = "dev-prebuilt") {
        eprintln!("isolane-worker: the V8 sandbox is not securely configured; refusing to run guest code");
        return ExitCode::from(3);
    }
    let seccomp = if lock_down { lockdown::after_v8() } else { Ok(none) };
    let seccomp = match seccomp {
        Ok(level) => level,
        Err(e) => {
            eprintln!("isolane-worker: {e}");
            return ExitCode::from(5);
        }
    };

    let out = Arc::new(Writer::new(std::io::stdout()));
    out.send(&Out::Ready {
        protocol: proto::PROTOCOL_VERSION,
        v8: v8::V8::get_version(),
        sandbox_secure: sandbox_secure(),
        lockdown: lockdown::Report { landlock, seccomp },
    });

    let mut vms: HashMap<u64, Sender<VmMsg>> = HashMap::new();
    let mut failed: HashMap<u64, String> = HashMap::new();
    let mut stdin = BufReader::new(std::io::stdin().lock());
    loop {
        let frame = match read_frame(&mut stdin) {
            Ok(Some(f)) => f,
            // Supervisor gone (EOF) or a corrupt stream: either way, stop.
            Ok(None) => return ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("isolane-worker: bad frame: {e}");
                return ExitCode::from(4);
            }
        };
        let (json, attached) = match frame::split(&frame) {
            Ok(parts) => parts,
            Err(e) => {
                eprintln!("isolane-worker: bad frame: {e}");
                return ExitCode::from(4);
            }
        };
        let msg: In = match serde_json::from_slice(json) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("isolane-worker: bad message: {e}");
                return ExitCode::from(4);
            }
        };
        if !attached.is_empty() && !matches!(msg, In::HostReply { .. }) {
            eprintln!("isolane-worker: bad message: bytes attached to a message that takes none");
            return ExitCode::from(4);
        }
        match msg {
            In::Create { vm, limits, time, random, eval, wasm, web, base_url, functions, prelude, shims } => {
                let (tx, rx) = mpsc::channel();
                let config = VmConfig { limits, time, seed: random.seed, eval, wasm, web, base_url, functions, prelude, shims };
                match vm::spawn(vm, config, rx, out.clone()) {
                    Ok(()) => {
                        vms.insert(vm, tx);
                    }
                    // Out of threads or memory: this VM's evals fail, the
                    // worker carries on.
                    Err(e) => {
                        failed.insert(vm, format!("the isolate could not start: {e}"));
                    }
                }
            }
            In::Eval { vm, req, code, last } => {
                let refuse = |f: proto::Failure| {
                    out.send(&Out::Result {
                        req,
                        ok: false,
                        value: None,
                        code: Some(f.code),
                        message: Some(&f.message),
                        guest: None,
                        limit: f.limit,
                        shim: None,
                        usage: Default::default(),
                    })
                };
                if let Some(cause) = failed.get(&vm) {
                    refuse(limit("workerMemoryBytes", cause.clone()));
                    continue;
                }
                let sent = vms.get(&vm).map(|tx| tx.send(VmMsg::Eval { req, code, last }).is_ok());
                if sent != Some(true) {
                    refuse(fail(ErrorCode::IsolateClosed, "the isolate has been closed"));
                }
            }
            In::HostReply { vm, call, ok, value, error, error_name, error_code, bin } => {
                // The attached bytes, split as `bin` says, all of them.
                let mut bytes = Vec::with_capacity(bin.len());
                let mut rest = attached;
                for (path, len) in bin {
                    if len > rest.len() {
                        eprintln!("isolane-worker: bad message: host reply bytes overrun the frame");
                        return ExitCode::from(4);
                    }
                    let (b, r) = rest.split_at(len);
                    bytes.push((path, b.to_vec()));
                    rest = r;
                }
                if !rest.is_empty() {
                    eprintln!("isolane-worker: bad message: unclaimed bytes in a host reply");
                    return ExitCode::from(4);
                }
                if let Some(tx) = vms.get(&vm) {
                    let reply = vm::Reply { ok, value, error, error_name, error_code, bytes };
                    let _ = tx.send(VmMsg::HostReply { call, reply });
                }
            }
            In::Dispose { vm } => {
                failed.remove(&vm);
                if let Some(tx) = vms.remove(&vm) {
                    let _ = tx.send(VmMsg::Dispose);
                }
            }
        }
    }
}

/// Lock down, then attempt a forbidden operation. Prints `LOCKED` once the
/// lockdown is in place; a probe that seccomp blocks never returns (the
/// process dies with SIGSYS), so `SURVIVED` means the lockdown failed.
#[cfg(all(feature = "escape-tests", target_os = "linux"))]
fn escape_test(probe: &str) -> ExitCode {
    use std::ffi::CString;
    use std::io::Write;

    let locked = |msg: &str| {
        println!("{msg}");
        let _ = std::io::stdout().flush();
    };
    if probe == "landlock-open" {
        // Landlock alone (no seccomp): opening a file must be refused.
        if let Err(e) = lockdown::before_v8() {
            eprintln!("{e}");
            return ExitCode::from(5);
        }
        locked("LOCKED");
        return match std::fs::File::open("/etc/hostname") {
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                locked("DENIED");
                ExitCode::SUCCESS
            }
            other => {
                locked(&format!("SURVIVED {other:?}"));
                ExitCode::FAILURE
            }
        };
    }
    if let Err(e) = lockdown::before_v8() {
        eprintln!("{e}");
        return ExitCode::from(5);
    }
    init_v8();
    if let Err(e) = lockdown::after_v8() {
        eprintln!("{e}");
        return ExitCode::from(5);
    }
    locked("LOCKED");
    let path = CString::new("/etc/hostname").unwrap();
    // SAFETY: test-only probes; each passes valid, NUL-terminated strings
    // and null-terminated argv. They are expected to be refused or killed.
    let r = unsafe {
        match probe {
            "open" => {
                // Refused with EACCES, as Landlock would (V8 and abseil
                // probe files and handle the failure).
                let r = libc::open(path.as_ptr(), libc::O_RDONLY);
                if r == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EACCES) {
                    locked("DENIED");
                    return ExitCode::SUCCESS;
                }
                r as i64
            }
            "socket" => libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) as i64,
            "execve" => {
                let bin = CString::new("/bin/true").unwrap();
                let argv = [bin.as_ptr(), std::ptr::null()];
                libc::execve(bin.as_ptr(), argv.as_ptr(), std::ptr::null()) as i64
            }
            "ptrace" => libc::ptrace(libc::PTRACE_TRACEME, 0, 0, 0),
            "fork" => libc::fork() as i64,
            "clone3" => {
                // Must fail with ENOSYS (libc then falls back to clone).
                let r = libc::syscall(libc::SYS_clone3, std::ptr::null::<u8>(), 0usize);
                let errno = std::io::Error::last_os_error().raw_os_error();
                if r == -1 && errno == Some(libc::ENOSYS) {
                    locked("ENOSYS");
                    return ExitCode::SUCCESS;
                }
                r
            }
            _ => {
                eprintln!("unknown probe {probe}");
                return ExitCode::from(2);
            }
        }
    };
    locked(&format!("SURVIVED {r}"));
    ExitCode::FAILURE
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(all(feature = "escape-tests", target_os = "linux"))]
    if args.first().map(String::as_str) == Some("--escape-test") {
        return escape_test(args.get(1).map(String::as_str).unwrap_or_default());
    }
    if let Some(path) = args.first().and_then(|a| a.strip_prefix("--make-web-snapshot=")) {
        return make_web_snapshot(path);
    }
    let mut mode = None;
    let mut memory_limit = None;
    let mut web_background = false;
    for arg in &args {
        if arg == "--prepare-web" {
            web_background = true;
        } else if let Some(n) = arg.strip_prefix("--memory-limit=") {
            match n.parse::<u64>() {
                Ok(n) => memory_limit = Some(n),
                Err(_) => {
                    eprintln!("isolane-worker: bad --memory-limit {n}");
                    return ExitCode::from(2);
                }
            }
        } else if mode.is_none() {
            mode = Some(arg.as_str());
        } else {
            mode = Some("");
        }
    }
    match mode {
        Some("--self-check") => self_check(),
        None | Some("--serve") => serve(true, memory_limit, web_background),
        Some("--no-lockdown") => serve(false, memory_limit, web_background),
        Some(other) => {
            eprintln!(
                "usage: isolane-worker [--serve | --self-check | --no-lockdown] [--memory-limit=BYTES] [--prepare-web] | --make-web-snapshot=FILE (got {other})"
            );
            ExitCode::from(2)
        }
    }
}
