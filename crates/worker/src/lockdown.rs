//! Process lockdown, applied by the worker to itself before it reads any
//! guest code (Chrome-renderer style).
//!
//! Linux:
//! 1. Landlock, while the process is still single-threaded: no filesystem
//!    access and no TCP bind/connect. Landlock restricts only the calling
//!    thread and its future children, hence before V8 starts its threads.
//! 2. V8 initializes (the caller does this between the two steps).
//! 3. seccomp-bpf on every thread (TSYNC): a syscall allowlist; anything
//!    else kills the process, except filesystem calls (open, stat,
//!    readlink, access), which fail with EACCES as under Landlock.

use serde::Serialize;

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
// Only Linux has these layers, so elsewhere every level is `None`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub enum Level {
    /// Every restriction this layer offers is in force.
    Full,
    /// The kernel supports only part of it (e.g. an older Landlock ABI).
    Partial,
    /// Not available on this host.
    None,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub landlock: Level,
    pub seccomp: Level,
}

#[cfg(target_os = "linux")]
mod linux {
    use super::Level;
    use std::collections::BTreeMap;

    use landlock::{
        Access, AccessFs, AccessNet, CompatLevel, Compatible, Ruleset, RulesetAttr, RulesetStatus,
        ABI,
    };
    use seccompiler::{
        BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
        SeccompRule,
    };

    /// Deny all filesystem access and TCP bind/connect. Already-open fds
    /// (the supervisor pipes) keep working.
    pub fn landlock() -> Result<Level, String> {
        let abi = ABI::V5;
        let status = Ruleset::default()
            .set_compatibility(CompatLevel::BestEffort)
            .handle_access(AccessFs::from_all(abi))
            .and_then(|r| r.handle_access(AccessNet::from_all(abi)))
            .and_then(|r| r.create())
            .and_then(|r| r.restrict_self())
            .map_err(|e| format!("landlock: {e}"))?;
        Ok(match status.ruleset {
            RulesetStatus::FullyEnforced => Level::Full,
            RulesetStatus::PartiallyEnforced => Level::Partial,
            RulesetStatus::NotEnforced => Level::None,
        })
    }

    /// Syscalls a serving worker needs after V8 has initialized: pipe I/O,
    /// memory management (V8's heap, JIT, and sandbox), threads (one per VM
    /// plus its watchdog), and time.
    ///
    /// `mmap`/`mprotect` stay unrestricted, PROT_EXEC included: V8's JIT
    /// maps and flips code pages at run time, so the filter can't tell its
    /// pages from an attacker's. A `--jitless` quarantine worker (planned)
    /// is the way to drop PROT_EXEC for tenants that don't need the JIT.
    const ALLOWED: &[i64] = &[
        libc::SYS_read,
        libc::SYS_write,
        libc::SYS_close,
        libc::SYS_mmap,
        libc::SYS_munmap,
        libc::SYS_mprotect,
        libc::SYS_mremap,
        libc::SYS_madvise,
        libc::SYS_brk,
        libc::SYS_futex,
        libc::SYS_sched_yield,
        libc::SYS_sched_getaffinity,
        libc::SYS_sched_getparam,
        libc::SYS_sched_getscheduler,
        libc::SYS_clock_gettime,
        libc::SYS_clock_nanosleep,
        libc::SYS_nanosleep,
        libc::SYS_gettid,
        libc::SYS_getpid,
        libc::SYS_rt_sigreturn,
        libc::SYS_rt_sigprocmask,
        libc::SYS_rt_sigaction,
        libc::SYS_sigaltstack,
        libc::SYS_set_robust_list,
        libc::SYS_rseq,
        libc::SYS_getrandom,
        libc::SYS_membarrier,
        libc::SYS_pkey_mprotect,
        libc::SYS_prctl, // only the options in PRCTL_ALLOWED; see seccomp()
        // V8's one-time kernel-version check before remapping its builtins
        // into the code range (arm64, isolates with heaps of 2 GiB or more);
        // it CHECKs that uname succeeds. Accepted: a compromised worker
        // learns the kernel release and the host name.
        libc::SYS_uname,
        libc::SYS_exit,
        libc::SYS_exit_group,
    ];

    /// The `prctl` options a serving worker uses, from the CI syscall audit:
    /// thread names (Rust's std and V8 name every thread) and V8 naming its
    /// anonymous mappings (`v8-sandbox`, `v8-pointer-table`). Any other
    /// option fails with EPERM, and those in PRCTL_KILLED kill the worker.
    pub const PRCTL_ALLOWED: &[(libc::c_int, Option<libc::c_int>)] = &[
        (libc::PR_SET_NAME, None),
        (libc::PR_SET_VMA, Some(libc::PR_SET_VMA_ANON_NAME)),
    ];

    /// `prctl` options that only an attacker would use: making the process
    /// dumpable (so same-user processes could read its memory or ptrace it),
    /// naming a ptracer, or rewriting the memory map's metadata.
    const PRCTL_KILLED: &[libc::c_int] =
        &[libc::PR_SET_DUMPABLE, libc::PR_SET_PTRACER, libc::PR_SET_MM];

    /// Filesystem calls fail with EACCES instead of killing the process, as
    /// Landlock would answer them: V8, ICU, and abseil probe files lazily
    /// (CPU info under /sys, /etc/localtime for the time zone) and fall back
    /// when that fails.
    #[cfg(target_arch = "x86_64")]
    const FILE_SYSCALLS: &[i64] = &[
        libc::SYS_open,
        libc::SYS_openat,
        libc::SYS_openat2,
        libc::SYS_readlink,
        libc::SYS_readlinkat,
        libc::SYS_stat,
        libc::SYS_lstat,
        libc::SYS_newfstatat,
        libc::SYS_statx,
        libc::SYS_access,
        libc::SYS_faccessat,
        libc::SYS_faccessat2,
    ];
    #[cfg(not(target_arch = "x86_64"))]
    const FILE_SYSCALLS: &[i64] = &[
        libc::SYS_openat,
        libc::SYS_openat2,
        libc::SYS_readlinkat,
        libc::SYS_newfstatat,
        libc::SYS_statx,
        libc::SYS_faccessat,
        libc::SYS_faccessat2,
    ];

    /// Install the allowlist on every thread. Stacked filters, because a
    /// single seccompiler filter has one match action:
    ///
    /// - `clone3` returns ENOSYS, so libc falls back to `clone`, whose flags
    ///   the allowlist can inspect (`clone3` passes them in memory).
    /// - filesystem calls return EACCES.
    /// - `prctl` options outside PRCTL_ALLOWED return EPERM, and the ones in
    ///   PRCTL_KILLED kill the process.
    /// - the allowlist kills the process on anything else, and allows
    ///   `clone` only for threads: CLONE_THREAD with the memory, files, and
    ///   signal handlers shared, and no new namespace (never a process).
    ///
    /// The kernel applies the most restrictive result across filters.
    pub fn seccomp() -> Result<Level, String> {
        let arch = std::env::consts::ARCH
            .try_into()
            .map_err(|e| format!("seccomp: {e:?}"))?;
        let err = |e: seccompiler::BackendError| format!("seccomp: {e}");

        let no_clone3 = SeccompFilter::new(
            BTreeMap::from([(libc::SYS_clone3, vec![])]),
            SeccompAction::Allow,
            SeccompAction::Errno(libc::ENOSYS as u32),
            arch,
        )
        .map_err(err)?;
        let no_files = SeccompFilter::new(
            FILE_SYSCALLS.iter().map(|&s| (s, vec![])).collect(),
            SeccompAction::Allow,
            SeccompAction::Errno(libc::EACCES as u32),
            arch,
        )
        .map_err(err)?;

        // Each rule is one way to be outside the allowed options (the
        // conditions in a rule all hold; any rule matching refuses).
        let arg = |n: u8, op: SeccompCmpOp, v: libc::c_int| {
            SeccompCondition::new(n, SeccompCmpArgLen::Dword, op, v as u64).map_err(err)
        };
        // PR_SET_NO_NEW_PRIVS passes too: installing each later filter calls
        // it (it can only ever add a restriction), and the allowlist, which
        // must be last since it refuses seccomp() itself, kills the rest.
        let mut outside = vec![SeccompRule::new(
            PRCTL_ALLOWED
                .iter()
                .map(|&(option, _)| option)
                .chain([libc::PR_SET_NO_NEW_PRIVS])
                .map(|option| arg(0, SeccompCmpOp::Ne, option))
                .collect::<Result<_, _>>()?,
        )
        .map_err(err)?];
        for &(option, sub) in PRCTL_ALLOWED {
            if let Some(sub) = sub {
                outside.push(
                    SeccompRule::new(vec![
                        arg(0, SeccompCmpOp::Eq, option)?,
                        arg(1, SeccompCmpOp::Ne, sub)?,
                    ])
                    .map_err(err)?,
                );
            }
        }
        let prctl_options = SeccompFilter::new(
            BTreeMap::from([(libc::SYS_prctl, outside)]),
            SeccompAction::Allow,
            SeccompAction::Errno(libc::EPERM as u32),
            arch,
        )
        .map_err(err)?;
        let prctl_killed = SeccompFilter::new(
            BTreeMap::from([(
                libc::SYS_prctl,
                PRCTL_KILLED
                    .iter()
                    .map(|&o| SeccompRule::new(vec![arg(0, SeccompCmpOp::Eq, o)?]).map_err(err))
                    .collect::<Result<_, _>>()?,
            )]),
            SeccompAction::Allow,
            SeccompAction::KillProcess,
            arch,
        )
        .map_err(err)?;

        // Syscalls refused by the filters above must pass this one, or its
        // kill (the most restrictive action) would win.
        let mut rules: BTreeMap<i64, Vec<SeccompRule>> = ALLOWED
            .iter()
            .chain(FILE_SYSCALLS)
            .map(|&s| (s, vec![]))
            .collect();
        rules.insert(libc::SYS_clone3, vec![]);
        // A thread as pthread_create makes one: sharing memory, files, the
        // filesystem context, and signal handlers, in no new namespace.
        let shared = (libc::CLONE_VM
            | libc::CLONE_FS
            | libc::CLONE_FILES
            | libc::CLONE_SIGHAND
            | libc::CLONE_THREAD) as u64;
        let thread_only = SeccompCondition::new(
            0,
            SeccompCmpArgLen::Qword,
            SeccompCmpOp::MaskedEq(shared),
            shared,
        )
        .map_err(err)?;
        let namespaces = (libc::CLONE_NEWNS
            | libc::CLONE_NEWCGROUP
            | libc::CLONE_NEWUTS
            | libc::CLONE_NEWIPC
            | libc::CLONE_NEWUSER
            | libc::CLONE_NEWPID
            | libc::CLONE_NEWNET
            | libc::CLONE_VFORK) as u64;
        let no_namespaces = SeccompCondition::new(
            0,
            SeccompCmpArgLen::Qword,
            SeccompCmpOp::MaskedEq(namespaces),
            0,
        )
        .map_err(err)?;
        rules.insert(
            libc::SYS_clone,
            vec![SeccompRule::new(vec![thread_only, no_namespaces]).map_err(err)?],
        );
        let allowlist = SeccompFilter::new(
            rules,
            SeccompAction::KillProcess,
            SeccompAction::Allow,
            arch,
        )
        .map_err(err)?;

        for filter in [no_clone3, no_files, prctl_options, prctl_killed, allowlist] {
            let prog: BpfProgram = filter.try_into().map_err(err)?;
            seccompiler::apply_filter_all_threads(&prog).map_err(|e| format!("seccomp: {e}"))?;
        }
        Ok(Level::Full)
    }
}

/// Cap the worker's writable private memory (RLIMIT_DATA): V8's heap,
/// ArrayBuffer and WebAssembly memory, JIT pages, thread stacks. The V8
/// sandbox's address-space reservation is inaccessible until used, so it
/// doesn't count; V8's JIT code range does (it is mapped writable up front),
/// which is why the caller adds its limit to the post-initialization
/// baseline. Past the cap, allocations fail: a guest ArrayBuffer throws
/// a RangeError, and V8 itself running out exits the worker (code 6).
/// Not enforced on macOS, which ignores RLIMIT_DATA.
pub fn memory_limit(bytes: u64) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let lim = libc::rlimit {
            rlim_cur: bytes,
            rlim_max: bytes,
        };
        // SAFETY: setrlimit reads a valid, initialized rlimit.
        if unsafe { libc::setrlimit(libc::RLIMIT_DATA, &lim) } != 0 {
            return Err(format!(
                "setrlimit(RLIMIT_DATA): {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = bytes;
    Ok(())
}

/// No core dumps (a crashed worker's memory holds tenant data) and no file
/// writes (defense in depth: seccomp and Landlock already refuse opening
/// files). RLIMIT_NPROC is per user, not per process, so it would also cap
/// other workers' threads; seccomp already forbids creating processes.
fn resource_limits() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    for (resource, name) in [
        (libc::RLIMIT_CORE, "RLIMIT_CORE"),
        (libc::RLIMIT_FSIZE, "RLIMIT_FSIZE"),
    ] {
        let zero = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: as above.
        if unsafe { libc::setrlimit(resource, &zero) } != 0 {
            return Err(format!(
                "setrlimit({name}): {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

/// Step 0 (first thing): close every file descriptor but stdin, stdout,
/// and stderr. The supervisor's own process may hold descriptors without
/// close-on-exec (a CI runner's pipes, say), which spawn() would pass on;
/// seccomp allows read and write, so the guest could use them. Linux only,
/// like the rest of lockdown.
pub fn close_inherited_fds() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: close_range takes plain integers and touches no memory.
        if unsafe { libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, 0u32) } == 0 {
            return Ok(());
        }
        // Kernels before 5.9: close what /proc lists. Collect first, since
        // the listing's own descriptor is among them.
        let fds: Vec<i32> = std::fs::read_dir("/proc/self/fd")
            .map_err(|e| format!("listing /proc/self/fd: {e}"))?
            .filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
            .filter(|&fd| fd > 2)
            .collect();
        for fd in fds {
            // SAFETY: closing a descriptor number touches no memory; nothing
            // in this process owns descriptors above 2 yet, and EBADF (the
            // listing's own, already closed) is harmless.
            unsafe { libc::close(fd) };
        }
    }
    Ok(())
}

/// Step 1 (before V8 starts any threads).
pub fn before_v8() -> Result<Level, String> {
    resource_limits()?;
    #[cfg(target_os = "linux")]
    return linux::landlock();
    #[cfg(not(target_os = "linux"))]
    return Ok(Level::None);
}

/// Step 3 (after V8 initialized, before reading guest code).
pub fn after_v8() -> Result<Level, String> {
    #[cfg(target_os = "linux")]
    return linux::seccomp();
    #[cfg(not(target_os = "linux"))]
    return Ok(Level::None);
}
