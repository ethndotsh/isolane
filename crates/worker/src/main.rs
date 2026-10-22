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

mod bytes;
mod clock;
mod frame;
mod js;
mod limits;
mod lockdown;
mod proto;
mod spares;
mod vm;
mod web;

use std::collections::HashMap;
use std::io::BufReader;
use std::process::ExitCode;
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;

use frame::{read_frame, Writer};
use proto::{fail, limit, ErrorCode, Failure, In, Out};
use vm::{Job, Output, VmConfig, VmMsg};

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
    // now: under a memory limit too small for V8 the worker then fails at
    // startup, here, instead of later in a guest's eval. The isolate is kept
    // for the life of the process: it holds V8's process-wide heaps (the
    // shared read-only heap and shared space) up, so they're never torn
    // down and rebuilt while one VM's isolate is created as another's is
    // disposed, which crashed V8 deserializing a snapshot.
    std::mem::forget(v8::Isolate::new(Default::default()));
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

fn serve(
    lock_down: bool,
    memory_limit: Option<u64>,
    web_background: bool,
    spare_isolates: usize,
) -> ExitCode {
    let lockdown = match start(lock_down, memory_limit, web_background) {
        Ok(report) => report,
        Err(exit) => return exit.into(),
    };
    let out = Arc::new(Writer::new(std::io::stdout()));
    out.send(&Out::Ready {
        protocol: proto::PROTOCOL_VERSION,
        v8: v8::V8::get_version(),
        sandbox_secure: sandbox_secure(),
        lockdown,
    });
    let mut worker = Worker {
        out,
        vms: HashMap::new(),
        failed: HashMap::new(),
        trees: HashMap::new(),
        spares: spares::Spares::new(spare_isolates),
    };
    let mut stdin = BufReader::new(std::io::stdin().lock());
    match worker.run(&mut stdin) {
        Ok(()) => ExitCode::SUCCESS,
        Err(exit) => exit.into(),
    }
}

/// Set the process up for guests: time zone, lockdown, V8, the memory
/// limit. Reports which lockdown layers are in place.
fn start(
    lock_down: bool,
    memory_limit: Option<u64>,
    web_background: bool,
) -> Result<lockdown::Report, Exit> {
    // Every guest sees UTC: the host's time zone (Date#getTimezoneOffset,
    // Intl's default zone) would say where the machine is. Set while the
    // process is still single-threaded, before ICU first reads it.
    std::env::set_var("TZ", "UTC");
    lockdown::close_inherited_fds().map_err(|e| fatal(Exit::Startup, e))?;
    let mut status = memory_limit.and_then(|_| std::fs::File::open("/proc/self/status").ok());
    let none = lockdown::Level::None;
    // Lockdown order matters: Landlock before V8 starts threads, seccomp
    // (on all threads) after V8 has initialized. A layer the host lacks
    // reports None; a layer that is available but fails to apply is fatal.
    let landlock = if lock_down {
        lockdown::before_v8()
    } else {
        Ok(none)
    };
    let landlock = landlock.map_err(|e| fatal(Exit::Lockdown, e))?;
    init_v8();
    // The web platform's snapshot is embedded in release builds. Without
    // one (or with another build's), it's built when the first web VM wants
    // it, or, with --prepare-web (the supervisor expects web VMs), right
    // away in the background: the worker reports ready without waiting,
    // and a web VM that comes sooner waits for the rest. Either way it's
    // memory operations only, the same under the lockdown below.
    if web_background {
        let _ = std::thread::Builder::new()
            .name("web-snapshot".into())
            .spawn(|| {
                web::snapshot();
            });
    }
    // The limit is for guests, on top of what V8 has already mapped writable
    // (on x64 mostly its JIT code range: ~550 MiB of address space, little
    // of it in use).
    if let Some(bytes) = memory_limit {
        let baseline = status.as_mut().and_then(read_vm_data).unwrap_or(0) * 1024;
        lockdown::memory_limit(baseline + bytes).map_err(|e| fatal(Exit::Lockdown, e))?;
    }
    drop(status);
    if !sandbox_secure() && !cfg!(feature = "dev-prebuilt") {
        return Err(fatal(
            Exit::InsecureSandbox,
            "the V8 sandbox is not securely configured; refusing to run guest code",
        ));
    }
    let seccomp = if lock_down {
        lockdown::after_v8()
    } else {
        Ok(none)
    };
    let seccomp = seccomp.map_err(|e| fatal(Exit::Lockdown, e))?;
    Ok(lockdown::Report { landlock, seccomp })
}

/// How the worker exits when it can't go on. The supervisor tells an
/// out-of-memory exit by its code (`OutOfMemory`, which it also defines);
/// the others it reports as a crash, with the line the worker printed.
#[derive(Clone, Copy)]
pub enum Exit {
    /// Couldn't set the process up (closing inherited descriptors).
    Startup = 1,
    /// Bad command-line arguments.
    Usage = 2,
    /// The V8 sandbox isn't securely configured.
    InsecureSandbox = 3,
    /// A corrupt frame or a message that breaks the protocol.
    Protocol = 4,
    /// A lockdown layer (or the memory limit) is available but failed.
    Lockdown = 5,
    /// V8 ran out of memory under the worker's memory limit (`vm::out_of_memory`).
    OutOfMemory = 6,
}

impl From<Exit> for ExitCode {
    fn from(exit: Exit) -> ExitCode {
        ExitCode::from(exit as u8)
    }
}

/// Print why the worker is exiting; returns how.
fn fatal(exit: Exit, why: impl std::fmt::Display) -> Exit {
    eprintln!("isolane-worker: {why}");
    exit
}

fn bad_frame(e: std::io::Error) -> Exit {
    fatal(Exit::Protocol, format_args!("bad frame: {e}"))
}

fn bad_message(why: impl std::fmt::Display) -> Exit {
    fatal(Exit::Protocol, format_args!("bad message: {why}"))
}

/// The worker's isolates, as the supervisor's messages create and drive them.
struct Worker {
    out: Output,
    vms: HashMap<u64, (Sender<VmMsg>, vm::Stopper)>,
    /// Isolates whose evals fail with this, from their create on.
    failed: HashMap<u64, Failure>,
    /// Programs' files as loads sent them, by tree id, until `forget`.
    trees: HashMap<String, Arc<vm::Tree>>,
    /// Isolates made ahead of their VMs (see `vm::Spare`): made once a web
    /// VM has been created, for VMs of its shape.
    spares: spares::Spares<vm::Shape, vm::Spare>,
}

impl Worker {
    /// Handle messages until the supervisor goes away (EOF), or breaks the
    /// protocol.
    fn run(&mut self, stdin: &mut impl std::io::Read) -> Result<(), Exit> {
        while let Some(frame) = read_frame(stdin).map_err(bad_frame)? {
            let (json, attached) = frame::split(&frame).map_err(bad_frame)?;
            let msg: In = match serde_json::from_slice(json) {
                Ok(m) => m,
                Err(e) => {
                    // A well-formed create whose config doesn't fit (a limit
                    // out of range): that isolate's evals fail, the worker
                    // carries on.
                    let Some(vm) = create_id(json) else {
                        return Err(bad_message(e));
                    };
                    self.failed.insert(
                        vm,
                        fail(
                            ErrorCode::Internal,
                            format!("the isolate's config is invalid: {e}"),
                        ),
                    );
                    continue;
                }
            };
            if !attached.is_empty()
                && !matches!(
                    msg,
                    In::HostReply { .. } | In::Call { .. } | In::Load { .. }
                )
            {
                return Err(bad_message("bytes attached to a message that takes none"));
            }
            self.handle(msg, attached)?;
        }
        Ok(())
    }

    fn handle(&mut self, msg: In, attached: &[u8]) -> Result<(), Exit> {
        match msg {
            In::Create { vm, config } => self.create(vm, *config),
            In::Eval {
                vm,
                req,
                code,
                filename,
                last,
            } => {
                self.eval(
                    vm,
                    req,
                    VmMsg::Eval {
                        req,
                        job: Job::Code { code, filename },
                        last,
                    },
                );
            }
            In::Load {
                vm,
                req,
                main,
                tree: id,
                files,
                bin,
                options,
            } => {
                let bytes = split_attached(attached, bin)
                    .ok_or_else(|| bad_message("load bytes don't match the frame"))?;
                let files = match files {
                    Some(files) => {
                        let mut tree: std::collections::BTreeMap<String, vm::Source> = files
                            .into_iter()
                            .map(|(path, text)| (path, vm::Source::Text(text)))
                            .collect();
                        for (path, data) in bytes {
                            tree.insert(path, vm::Source::Bytes(data));
                        }
                        let tree = vm::Tree::new(tree).map(Arc::new);
                        if let Ok(tree) = &tree {
                            self.trees.insert(id, Arc::clone(tree));
                        }
                        tree
                    }
                    // The supervisor sends a tree's files before any load
                    // that names it alone, and forgets it only after.
                    None => Ok(self.trees.get(&id).cloned().ok_or_else(|| {
                        bad_message("a load names files the worker doesn't have")
                    })?),
                };
                self.eval(
                    vm,
                    req,
                    VmMsg::Eval {
                        req,
                        job: Job::Module {
                            main,
                            files,
                            options,
                        },
                        last: false,
                    },
                );
            }
            In::Call {
                vm,
                req,
                name,
                args,
                bin,
                kind,
                max_body,
            } => {
                let bytes = split_attached(attached, bin)
                    .ok_or_else(|| bad_message("call bytes don't match the frame"))?;
                self.eval(
                    vm,
                    req,
                    VmMsg::Eval {
                        req,
                        job: Job::Call {
                            name,
                            args,
                            bytes,
                            kind,
                            max_body: max_body.unwrap_or(0),
                        },
                        last: false,
                    },
                );
            }
            In::HostReply {
                vm,
                call,
                ok,
                value,
                error,
                error_name,
                error_code,
                bin,
            } => {
                let bytes = split_attached(attached, bin)
                    .ok_or_else(|| bad_message("host reply bytes don't match the frame"))?;
                if let Some((tx, _)) = self.vms.get(&vm) {
                    let reply = vm::Reply {
                        ok,
                        value,
                        error,
                        error_name,
                        error_code,
                        bytes,
                    };
                    let _ = tx.send(VmMsg::HostReply { call, reply });
                }
            }
            In::Abort { vm, req } => {
                if let Some((tx, stopper)) = self.vms.get(&vm) {
                    stopper.abort(req);
                    // A VM waiting for a timer or a reply notices now.
                    let _ = tx.send(VmMsg::Wake);
                }
            }
            In::Forget { tree } => {
                self.trees.remove(&tree);
            }
            In::Dispose { vm } => {
                self.failed.remove(&vm);
                if let Some((tx, stopper)) = self.vms.remove(&vm) {
                    let _ = tx.send(VmMsg::Dispose);
                    stopper.stop();
                }
            }
        }
        Ok(())
    }

    fn create(&mut self, vm: u64, config: VmConfig) {
        vm::init_shared_background(config.limits.worker_background_ms);
        let (tx, rx) = mpsc::channel();
        let shape = vm::Spare::shape(&config);
        let started = match shape.and_then(|shape| self.spares.take(shape)) {
            Some(spare) => match spare.take(vm, config, rx, self.out.clone()) {
                Ok(stopper) => Ok(stopper),
                Err(parts) => {
                    let (config, rx, out) = *parts;
                    vm::spawn(vm, config, rx, out)
                }
            },
            None => vm::spawn(vm, config, rx, self.out.clone()),
        };
        if let Some(shape) = shape {
            self.spares.refill(shape, vm::Spare::start);
        }
        match started {
            Ok(stopper) => {
                self.vms.insert(vm, (tx, stopper));
            }
            // Out of threads or memory: this VM's evals fail, the worker
            // carries on.
            Err(e) => {
                self.failed.insert(
                    vm,
                    limit(
                        "workerMemoryBytes",
                        format!("the isolate could not start: {e}"),
                    ),
                );
            }
        }
    }

    /// Queue an eval on its VM, or answer it with why the VM can't run it.
    fn eval(&mut self, vm: u64, req: u64, eval: VmMsg) {
        let failure = match self.failed.get(&vm) {
            Some(failure) => failure.clone(),
            None => match self.vms.get(&vm) {
                Some((tx, _)) if tx.send(eval).is_ok() => return,
                _ => fail(ErrorCode::IsolateClosed, "the isolate has been closed"),
            },
        };
        self.out.send(&Out::Result {
            vm,
            req,
            ok: false,
            value: None,
            bin: None,
            retired: None,
            code: Some(failure.code),
            message: Some(&failure.message),
            guest: None,
            limit: failure.limit,
            shim: None,
            usage: Default::default(),
        });
    }
}

/// A frame's attached bytes, split as `bin` says (each part's place and
/// length, in order). None unless the parts claim exactly all of them.
fn split_attached<P>(attached: &[u8], bin: Vec<(P, usize)>) -> Option<Vec<(P, Vec<u8>)>> {
    let mut parts: Vec<(P, Vec<u8>)> = Vec::with_capacity(bin.len());
    let mut rest = attached;
    for (place, len) in bin {
        if len > rest.len() {
            return None;
        }
        let (part, after) = rest.split_at(len);
        parts.push((place, part.to_vec()));
        rest = after;
    }
    rest.is_empty().then_some(parts)
}

/// The isolate id of a `create` message that didn't parse as one.
fn create_id(json: &[u8]) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_slice(json).ok()?;
    if value.get("t")?.as_str()? != "create" {
        return None;
    }
    value.get("vm")?.as_u64()
}

/// Lock down, then attempt a forbidden operation. Prints `LOCKED` once the
/// lockdown is in place; a probe that seccomp blocks never returns (the
/// process dies with SIGSYS), so `SURVIVED` means the lockdown failed.
#[cfg(all(feature = "escape-tests", target_os = "linux"))]
fn escape_test(probe: &str) -> ExitCode {
    use std::io::Write;

    let locked = |msg: &str| {
        println!("{msg}");
        let _ = std::io::stdout().flush();
    };
    if probe == "landlock-open" {
        // Landlock alone (no seccomp): opening a file must be refused.
        if let Err(e) = lockdown::before_v8() {
            eprintln!("{e}");
            return Exit::Lockdown.into();
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
        return Exit::Lockdown.into();
    }
    init_v8();
    if let Err(e) = lockdown::after_v8() {
        eprintln!("{e}");
        return Exit::Lockdown.into();
    }
    locked("LOCKED");
    let path = c"/etc/hostname";
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
                let bin = c"/bin/true";
                let argv = [bin.as_ptr(), std::ptr::null()];
                libc::execve(bin.as_ptr(), argv.as_ptr(), std::ptr::null()) as i64
            }
            "ptrace" => libc::ptrace(libc::PTRACE_TRACEME, 0, 0, 0),
            "fork" => libc::fork() as i64,
            // A thread in a new mount namespace, and one that doesn't share
            // its file table: both killed (the kernel would refuse the first
            // with EINVAL; the filter refuses it first).
            "clone-namespace" => {
                let flags = libc::CLONE_VM
                    | libc::CLONE_FS
                    | libc::CLONE_FILES
                    | libc::CLONE_SIGHAND
                    | libc::CLONE_THREAD
                    | libc::CLONE_NEWNS;
                libc::syscall(
                    libc::SYS_clone,
                    flags as libc::c_ulong,
                    std::ptr::null::<u8>(),
                    0usize,
                    0usize,
                    0usize,
                )
            }
            "clone-unshared" => {
                let flags = libc::CLONE_VM | libc::CLONE_SIGHAND | libc::CLONE_THREAD;
                libc::syscall(
                    libc::SYS_clone,
                    flags as libc::c_ulong,
                    std::ptr::null::<u8>(),
                    0usize,
                    0usize,
                    0usize,
                )
            }
            // Killed: dumpable would let same-user processes ptrace the
            // worker or read its memory through /proc.
            "prctl-dumpable" => libc::prctl(libc::PR_SET_DUMPABLE, 1, 0, 0, 0) as i64,
            "prctl-other" => {
                // An option outside the allowlist: EPERM. Allowed ones work.
                if libc::prctl(libc::PR_SET_NAME, c"probe".as_ptr(), 0, 0, 0) != 0 {
                    locked("NAME FAILED");
                    return ExitCode::FAILURE;
                }
                let r = libc::prctl(libc::PR_SET_KEEPCAPS, 1, 0, 0, 0);
                if r == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) {
                    locked("EPERM");
                    return ExitCode::SUCCESS;
                }
                r as i64
            }
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
                return Exit::Usage.into();
            }
        }
    };
    locked(&format!("SURVIVED {r}"));
    ExitCode::FAILURE
}

/// Most `--spare-isolates` (each holds an isolate's memory while idle).
const MAX_SPARE_ISOLATES: usize = 8;

/// Most `--code-cache-bytes` and `--wasm-cache-bytes`.
const MAX_CACHE_BYTES: usize = 1 << 30;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(all(feature = "escape-tests", target_os = "linux"))]
    if args.first().map(String::as_str) == Some("--escape-test") {
        return escape_test(args.get(1).map(String::as_str).unwrap_or_default());
    }
    if let Some(path) = args
        .first()
        .and_then(|a| a.strip_prefix("--make-web-snapshot="))
    {
        return make_web_snapshot(path);
    }
    let mut mode = None;
    let mut memory_limit = None;
    let mut web_background = false;
    let mut spare_isolates = 0;
    let mut code_cache_bytes = vm::DEFAULT_CODE_CACHE_BYTES;
    let mut wasm_cache_bytes = vm::DEFAULT_WASM_CACHE_BYTES;
    for arg in &args {
        if arg == "--prepare-web" {
            web_background = true;
        } else if let Some(n) = arg.strip_prefix("--spare-isolates=") {
            match n.parse::<usize>() {
                Ok(n) if n <= MAX_SPARE_ISOLATES => spare_isolates = n,
                _ => {
                    eprintln!(
                        "isolane-worker: bad --spare-isolates {n} (0 to {MAX_SPARE_ISOLATES})"
                    );
                    return Exit::Usage.into();
                }
            }
        } else if let Some((flag, n)) = arg
            .split_once('=')
            .filter(|(flag, _)| matches!(*flag, "--code-cache-bytes" | "--wasm-cache-bytes"))
        {
            let Some(n) = n.parse::<usize>().ok().filter(|n| *n <= MAX_CACHE_BYTES) else {
                eprintln!("isolane-worker: bad {flag} {n} (0 to {MAX_CACHE_BYTES})");
                return Exit::Usage.into();
            };
            if flag == "--code-cache-bytes" {
                code_cache_bytes = n;
            } else {
                wasm_cache_bytes = n;
            }
        } else if let Some(n) = arg.strip_prefix("--memory-bytes=") {
            match n.parse::<u64>() {
                Ok(n) => memory_limit = Some(n),
                Err(_) => {
                    eprintln!("isolane-worker: bad --memory-bytes {n}");
                    return Exit::Usage.into();
                }
            }
        } else if mode.is_none() {
            mode = Some(arg.as_str());
        } else {
            mode = Some("");
        }
    }
    vm::set_cache_budgets(code_cache_bytes, wasm_cache_bytes);
    match mode {
        Some("--self-check") => self_check(),
        None | Some("--serve") => serve(
            /* lock_down */ true,
            memory_limit,
            web_background,
            spare_isolates,
        ),
        Some("--no-lockdown") => serve(
            /* lock_down */ false,
            memory_limit,
            web_background,
            spare_isolates,
        ),
        Some(other) => {
            eprintln!(
                "usage: isolane-worker [--serve | --self-check | --no-lockdown] [--memory-bytes=BYTES] [--prepare-web] [--spare-isolates=N] [--code-cache-bytes=BYTES] [--wasm-cache-bytes=BYTES] | --make-web-snapshot=FILE (got {other})"
            );
            Exit::Usage.into()
        }
    }
}
