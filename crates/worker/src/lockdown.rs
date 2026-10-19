//! Process lockdown, applied by the worker to itself before it reads any
//! guest code (Chrome-renderer style).
//!
//! Linux:
//! 1. Landlock, while the process is still single-threaded: no filesystem
//!    access and no TCP bind/connect. Landlock restricts only the calling
//!    thread and its future children, hence before V8 starts its threads.
//! 2. V8 initializes (the caller does this between the two steps).
//! 3. seccomp-bpf on every thread (TSYNC): a syscall allowlist; anything
//!    else kills the process, except opening files, which fails with
//!    EACCES as under Landlock.

use serde::Serialize;

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
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

    use landlock::{Access, AccessFs, AccessNet, CompatLevel, Compatible, Ruleset, RulesetAttr, RulesetStatus, ABI};
    use seccompiler::{
        BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter, SeccompRule,
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
        libc::SYS_prctl,
        libc::SYS_exit,
        libc::SYS_exit_group,
    ];

    /// Opening files fails with EACCES instead of killing the process: V8 and
    /// abseil probe a few files lazily (CPU info under /sys) and fall back
    /// when that fails, as they must under Landlock anyway.
    #[cfg(target_arch = "x86_64")]
    const OPEN: &[i64] = &[libc::SYS_open, libc::SYS_openat, libc::SYS_openat2];
    #[cfg(not(target_arch = "x86_64"))]
    const OPEN: &[i64] = &[libc::SYS_openat, libc::SYS_openat2];

    /// Install the allowlist on every thread. Stacked filters, because a
    /// single seccompiler filter has one match action:
    /// - `clone3` returns ENOSYS, so libc falls back to `clone`, whose flags
    ///   the allowlist can inspect (`clone3` passes them in memory).
    /// - opening files returns EACCES.
    /// - the allowlist kills the process on anything else, and allows
    ///   `clone` only with CLONE_THREAD (threads, never new processes).
    /// The kernel applies the most restrictive result across filters.
    pub fn seccomp() -> Result<Level, String> {
        let arch = std::env::consts::ARCH.try_into().map_err(|e| format!("seccomp: {e:?}"))?;
        let err = |e: seccompiler::BackendError| format!("seccomp: {e}");

        let no_clone3 = SeccompFilter::new(
            BTreeMap::from([(libc::SYS_clone3, vec![])]),
            SeccompAction::Allow,
            SeccompAction::Errno(libc::ENOSYS as u32),
            arch,
        )
        .map_err(err)?;
        let no_open = SeccompFilter::new(
            OPEN.iter().map(|&s| (s, vec![])).collect(),
            SeccompAction::Allow,
            SeccompAction::Errno(libc::EACCES as u32),
            arch,
        )
        .map_err(err)?;

        // Syscalls refused by the filters above must pass this one, or its
        // kill (the most restrictive action) would win.
        let mut rules: BTreeMap<i64, Vec<SeccompRule>> =
            ALLOWED.iter().chain(OPEN).map(|&s| (s, vec![])).collect();
        rules.insert(libc::SYS_clone3, vec![]);
        let thread_only = SeccompCondition::new(
            0,
            SeccompCmpArgLen::Qword,
            SeccompCmpOp::MaskedEq(libc::CLONE_THREAD as u64),
            libc::CLONE_THREAD as u64,
        )
        .map_err(err)?;
        rules.insert(libc::SYS_clone, vec![SeccompRule::new(vec![thread_only]).map_err(err)?]);
        let allowlist = SeccompFilter::new(rules, SeccompAction::KillProcess, SeccompAction::Allow, arch).map_err(err)?;

        for filter in [no_clone3, no_open, allowlist] {
            let prog: BpfProgram = filter.try_into().map_err(err)?;
            seccompiler::apply_filter_all_threads(&prog).map_err(|e| format!("seccomp: {e}"))?;
        }
        Ok(Level::Full)
    }
}

/// Cap the worker's writable private memory (RLIMIT_DATA): V8's heap,
/// ArrayBuffer and WebAssembly memory, JIT pages, thread stacks. The V8
/// sandbox's address-space reservation is inaccessible until used, so it
/// doesn't count. Past the cap, allocations fail: a guest ArrayBuffer throws
/// a RangeError, and V8 itself running out exits the worker (code 6).
/// Not enforced on macOS, which ignores RLIMIT_DATA.
pub fn memory_limit(bytes: u64) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let lim = libc::rlimit { rlim_cur: bytes, rlim_max: bytes };
        if unsafe { libc::setrlimit(libc::RLIMIT_DATA, &lim) } != 0 {
            return Err(format!("setrlimit(RLIMIT_DATA): {}", std::io::Error::last_os_error()));
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
    for (resource, name) in [(libc::RLIMIT_CORE, "RLIMIT_CORE"), (libc::RLIMIT_FSIZE, "RLIMIT_FSIZE")] {
        let zero = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        if unsafe { libc::setrlimit(resource, &zero) } != 0 {
            return Err(format!("setrlimit({name}): {}", std::io::Error::last_os_error()));
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
