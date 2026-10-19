//! isolane worker: runs one tenant's JavaScript in V8 isolates, driven by the
//! supervisor over length-prefixed JSON frames on stdin/stdout.
//!
//! `--self-check` prints whether this build's V8 sandbox is enabled and
//! securely configured, and exits non-zero if not. `--no-lockdown` skips the
//! process lockdown, for syscall tracing only; the worker then reports no
//! lockdown and a strict supervisor refuses it.

mod clock;
mod frame;
mod lockdown;
mod proto;
mod vm;

use std::collections::HashMap;
use std::io::BufReader;
use std::process::ExitCode;
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::time::Duration;

use frame::{read_frame, Writer};
use proto::{fail, ErrorCode, In, Out};
use vm::{VmConfig, VmMsg};

unsafe extern "C" {
    // rusty_v8's binding for v8::internal::SandboxIsEnabled().
    fn v8__V8__IsSandboxEnabled() -> bool;

    // v8::V8::IsSandboxConfiguredSecurely(), which rusty_v8 doesn't bind.
    // False means V8 couldn't reserve the sandbox's address space and fell
    // back to a sandbox without its security properties. Linked by its
    // Itanium-mangled name: a static member taking no arguments, so the
    // symbol involves no standard-library types.
    #[link_name = "_ZN2v82V827IsSandboxConfiguredSecurelyEv"]
    fn v8_is_sandbox_configured_securely() -> bool;
}

/// V8 flags for untrusted code.
/// - no `eval`/`new Function` (also refused per context)
/// - no `SharedArrayBuffer` constructor (and the global is deleted)
/// - no Temporal: its clock is frozen like Date's (see `clock`), but it also
///   exposes the host time zone and hasn't been audited yet
const V8_FLAGS: &str = "--disallow-code-generation-from-strings \
    --enable-sharedarraybuffer-per-context \
    --no-harmony-temporal";

/// V8's seed for Math.random and its hash tables. Without an entropy
/// source, V8 on Linux reads /dev/urandom per isolate, which the lockdown
/// forbids, and then falls back to seeding from the clock.
#[cfg(target_os = "linux")]
fn entropy(buf: &mut [u8]) -> bool {
    let mut filled = 0;
    while filled < buf.len() {
        let rest = &mut buf[filled..];
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

fn init_v8() {
    #[cfg(target_os = "linux")]
    v8::V8::set_entropy_source(entropy);
    v8::V8::set_flags_from_string(V8_FLAGS);
    // Background threads for GC and compilation. Each tenant has its own
    // process, so keep the pool small rather than one per core.
    let platform = v8::Platform::new_with_clock(2, clock::platform_clock).make_shared();
    v8::V8::initialize_platform(platform);
    v8::V8::initialize();
}

fn sandbox_secure() -> bool {
    unsafe { v8__V8__IsSandboxEnabled() && v8_is_sandbox_configured_securely() }
}

fn self_check() -> ExitCode {
    init_v8();
    let enabled = unsafe { v8__V8__IsSandboxEnabled() };
    let secure = unsafe { v8_is_sandbox_configured_securely() };
    println!(
        "{{\"v8\":\"{}\",\"sandboxEnabled\":{enabled},\"sandboxSecure\":{secure}}}",
        v8::V8::get_version()
    );
    if enabled && secure {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn serve(lock_down: bool) -> ExitCode {
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
    if !sandbox_secure() {
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
        v8: v8::V8::get_version(),
        sandbox_secure: true,
        lockdown: lockdown::Report { landlock, seccomp },
    });

    let mut vms: HashMap<u64, Sender<VmMsg>> = HashMap::new();
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
        let msg: In = match serde_json::from_slice(&frame) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("isolane-worker: bad message: {e}");
                return ExitCode::from(4);
            }
        };
        match msg {
            In::Create { vm, heap_bytes, timeout_ms, host_functions } => {
                let (tx, rx) = mpsc::channel();
                let config = VmConfig {
                    heap_bytes,
                    timeout: timeout_ms.map(Duration::from_millis),
                    host_functions,
                };
                vm::spawn(vm, config, rx, out.clone());
                vms.insert(vm, tx);
            }
            In::Eval { vm, req, code } => {
                let sent = vms.get(&vm).map(|tx| tx.send(VmMsg::Eval { req, code }).is_ok());
                if sent != Some(true) {
                    let f = fail(ErrorCode::VmDisposed, "vm has been disposed");
                    out.send(&Out::Result { req, ok: false, value: None, code: Some(f.code), message: Some(&f.message) });
                }
            }
            In::HostReply { vm, call, ok, value, error } => {
                if let Some(tx) = vms.get(&vm) {
                    let _ = tx.send(VmMsg::HostReply { call, ok, value, error });
                }
            }
            In::Dispose { vm } => {
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
    #[cfg(all(feature = "escape-tests", target_os = "linux"))]
    if std::env::args().nth(1).as_deref() == Some("--escape-test") {
        return escape_test(&std::env::args().nth(2).unwrap_or_default());
    }
    match std::env::args().nth(1).as_deref() {
        Some("--self-check") => self_check(),
        None | Some("--serve") => serve(true),
        Some("--no-lockdown") => serve(false),
        Some(other) => {
            eprintln!("usage: isolane-worker [--serve | --self-check | --no-lockdown] (got {other})");
            ExitCode::from(2)
        }
    }
}
