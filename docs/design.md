# isolane: design and threat model

Status: this describes what's built (Linux x64 and arm64, tested in CI with
the V8 sandbox and full lockdown), except where it says planned. It isn't cleared
for untrusted code yet: see the release gate in `SECURITY.md`.

## Goal

An npm package that runs untrusted JavaScript from many tenants on V8, with
Cloudflare Workers' safety posture as the bar: no single bug (in V8, in our
code, or in the kernel interface) is enough for a tenant to reach another
tenant, the host application, or the machine.

`npm install isolane` must be the whole setup: no root, no daemons, no
container runtime. The client API (`Runtime`, `Tenant`, `Isolate`,
`IsolaneError`) descends from clockwork's `LanePool` (`run`, `createVm`,
`hostFunctions`, `LaneError` codes).

## Decisions so far

- **Tenants are authenticated, paying customers.** That gives
  accountability, but a customer can still be malicious or have a
  compromised account, so we still assume an attacker with a working V8
  exploit. What it buys: a small, known tenant population, which makes a
  **process per tenant** affordable as the default. That is stronger than
  Cloudflare's model, where many tenants share a process.
- **No gVisor or microVM layer.** The OS process lockdown is the outer wall,
  so it has to be strict and verifiable on every supported host.
- **Deployment target is open,** so the package must work on common Linux
  hosts, containers, and Kubernetes, and report what protection the host
  actually provides (see "Where the lockdown works").

## Non-goals

- **Running guest code in the application's process.** Spectre-class
  attacks can read anything in the same address space, so an in-process
  addon cannot meet the goal.
- **The quickjs-wasi handle API.** Handles across a process boundary would
  be one IPC round trip per property access. The surface is code in, JSON
  out, plus host functions.
- **Live snapshots.** V8 can only snapshot at startup and the snapshot is
  tied to the exact V8 build.
- **Node APIs** beyond what the application exposes as host functions (a
  later milestone). The web platform guests get is WinterTC's.
- **Windows hosts for untrusted code,** at least initially. Chrome-grade
  Windows sandboxing (restricted tokens, job objects, AppContainer) is a
  separate project. Windows can run in development mode only.

## Threat model

**Attacker:** a paying customer submitting arbitrary JavaScript, possibly
holding a working V8 exploit (memory corruption inside the isolate), and able
to attempt Spectre-style side channels.

| Attacker goal | Primary defense | Backstop |
|---|---|---|
| Read/modify another tenant's data or code | Process per tenant (default) | Isolate per VM; V8 sandbox |
| Read the host app's secrets (DB credentials, tokens) | Guest never runs in the app process | Workers inherit no env vars or fds; IPC carries only framed JSON |
| Escape to the machine (files, network, other processes) | seccomp allowlist in every worker | Landlock (no filesystem, no TCP); namespaces and cgroups where the host allows them (planned) |
| Side-channel reads (Spectre) | Separate processes per tenant; frozen clocks; no shared memory or threads | Quarantine on crashes |
| Denial of service | Per-isolate heap limit; CPU and wall-clock budgets via `TerminateExecution` | Per-worker memory cap (`RLIMIT_DATA`); worker count caps; cgroups where available (planned) |
| Persist after compromise | Workers recycled after `workerLifetimeMs` (1 hour) or `workerEvals` (100,000) | Crash = quarantine the tenant + replace the worker |

**Trusted:** the isolane library running in the application's Node process,
and the kernel (minimized by seccomp). **Untrusted:** everything inside a
worker after the first line of guest code runs. Once it has executed guest
code, the worker is treated as potentially compromised.

**Accepted risks** (recorded so a review can sign them off):

- RSA in `crypto.subtle` isn't constant-time (the `rsa` crate,
  RUSTSEC-2023-0071, the Marvin attack): a guest that can time many
  private-key operations with one key could learn it. The constant-time
  alternative parses guest-supplied keys in C outside the V8 sandbox.
- Native work that V8 can't interrupt (RSA key generation, up to 4,096
  bits; URLPattern parsing, bounded by size) runs on the isolate's thread,
  so it can overrun the time limit by its bounded cost.
- Background work is budgeted per isolate (`backgroundMs`) and per tenant
  (`workerBackgroundMs`, all its isolates together). Both are enforced in
  the worker, so a worker that guest code has compromised escapes them;
  `usage().workerCpuMs` still sees what it used.
- Landlock at `partial` (kernels before 6.7) meets strict mode; seccomp is
  the first wall for files and sockets.
- seccomp allows `uname`: V8 checks the kernel version (and aborts if it
  can't) before remapping its builtins on arm64, for isolates with heaps of
  2 GiB or more. A compromised worker can read the kernel release and the
  host name.

## Architecture

```
 application process (Node)                         worker processes (prebuilt Rust + V8)
┌──────────────────────────────────────┐   pipe  ┌───────────────────────────────────────┐
│ isolane library                      │◀───────▶│ worker: tenant A                      │
│  - Runtime-shaped API               │         │  isolate per VM, watchdog thread      │
│  - supervisor: spawn, lock down,     │   pipe  │  seccomp + Landlock                   │
│    route by tenant, quotas,          │◀───────▶├───────────────────────────────────────┤
│    quarantine                        │         │ worker: tenant B                      │
│  - runs host functions (app secrets  │         │                                       │
│    stay here)                        │         │                                       │
└──────────────────────────────────────┘         └───────────────────────────────────────┘
```

- **The supervisor is part of the library,** running in the application's
  Node process. It never executes guest code. It treats everything a worker
  sends as hostile: length-prefixed frames with a hard size cap, JSON only,
  schema-checked before use.
- **Workers** are one static Rust binary using `rusty_v8`, shipped per
  platform. Being a separate binary avoids a second V8 inside Node. A worker
  locks itself down (Chrome-renderer style) after V8 initializes and before
  it reads any guest code.
- **Isolation unit:** by default one worker process per tenant, containing
  one isolate per stateful VM (`tenant.isolate()`) or per one-shot run. Isolates are
  never reused across VMs. Grouping tenants by plan into shared workers
  (Cloudflare's model) is planned, not built.
  **The tenant is the security boundary, not the isolate.** A tenant's
  isolates share its worker, so guest code that compromises the worker can
  reach every isolate's state and call every host function registered for
  any of them. To keep two isolates apart, give them separate tenants.
- **Lifecycle:** workers start on a tenant's first request and idle out
  after a configurable period. They're recycled after `workerLifetimeMs` or
  `workerEvals`: new isolates start on a fresh worker, and the old one
  exits once it has finished what it runs, retiring stateful isolates
  still open on it after a minute. So a worker that is compromised but
  keeps running lives at most about that long.

### Request flow

1. The app calls `runtime.tenant(name).run(code, { host, limits: { timeoutMs } })`.
2. The supervisor finds or spawns the tenant's worker and sends the code.
3. The worker creates an isolate, compiles, and runs.
4. A host-function call becomes a frame up to the library, which runs the
   application's function and sends the result back. Inside the guest the
   call returns a Promise, driven by a per-isolate event loop.
5. The completion value returns as JSON; failures use clockwork's
   `IsolaneError` codes.

## Defense layers

### L0: Guest API surface

- ECMAScript, the application's host functions, and (unless `web: false`)
  the web platform: WinterTC's Minimum Common API, Deno's JS over isolane's
  native code, created from a startup snapshot embedded in the worker. It
  does no I/O of its own: `fetch`, `connect`, and `fs` reach the network
  and files only through the policies' brokers.
- No code generation from strings: `eval` and `new Function` throw.
- No WebAssembly (the global is deleted and code generation is denied).
- No `SharedArrayBuffer`, `Atomics.wait`, or guest threads.
- **Frozen clocks:** the wall clock (`Date`, `Intl`'s default "now",
  `Temporal.Now`) advances only when an eval starts and when a host-function
  reply arrives, never while guest code runs. It is the platform's
  `CurrentClockTimeMillis` (a small rusty_v8 patch, `patches/`) reading a
  per-VM-thread frozen time. `performance.now()` follows the same clock.

### L1: V8 configuration

- **V8 sandbox on,** which `rusty_v8`'s prebuilts don't provide (none are
  built with `v8_enable_sandbox`). We build V8 from source in CI with the
  crate's `v8_enable_sandbox` feature, for every shipped platform. The worker
  checks at startup that the sandbox is active and refuses to run otherwise.
- Heap limits per isolate, with a near-heap-limit callback that terminates
  the isolate instead of crashing the worker.
- A watchdog thread enforces CPU and wall-clock budgets with
  `TerminateExecution`, which works inside JIT-compiled code.
- An explicit stack limit per thread.
- Not used yet: V8's `--memory-protection-keys` (write-protects JIT code
  on CPUs with PKU) is to be evaluated, and a `--jitless` worker for
  quarantined tenants is planned. Both are rows in `docs/roadmap.md`.

### L2: Worker process lockdown

Every worker starts with an empty environment (apart from `TZ=UTC`, so
`Date` doesn't reveal the host's time zone) and closes every inherited file
descriptor except standard input, output, and error. It then locks itself
down in this order (`crates/worker/src/lockdown.rs`):

1. rlimits (Linux): `RLIMIT_CORE` and `RLIMIT_FSIZE` are set to 0, so a
   crash writes no core dump holding tenant data and no file can be
   written. `RLIMIT_DATA` caps the worker's private writable memory at
   `limits.workerMemoryBytes` (macOS ignores it). No CPU-time or
   process-count rlimit is set: `RLIMIT_NPROC` is per user, so it would cap
   other workers' threads, and seccomp already forbids creating processes;
   CPU is bounded by the watchdog, recycling, and `usage().workerCpuMs`.
   `RLIMIT_AS` is unusable because the V8 sandbox reserves a very large
   virtual address range.
2. Landlock (Linux 5.13+, unprivileged), while the process is still
   single-threaded, since Landlock restricts only the calling thread and its
   future children: no filesystem access, and no TCP bind or connect on
   kernels whose Landlock ABI has network rules (6.7 and later). It is a
   second layer under seccomp.
3. V8 initializes.
4. seccomp-bpf on every thread (TSYNC), with no privileges needed
   (`PR_SET_NO_NEW_PRIVS` plus a filter). The allowlist: `read`, `write`,
   `close`; `mmap`, `munmap`, `mprotect`, `mremap`, `madvise`, `brk`,
   `pkey_mprotect` (V8's heap, JIT, and sandbox; `PROT_EXEC` stays allowed,
   since the JIT flips code pages at run time); `futex`, `membarrier`,
   `sched_yield`, `sched_getaffinity`, `sched_getparam`,
   `sched_getscheduler`, `set_robust_list`, `rseq`, `gettid`, `getpid`;
   `clock_gettime`, `clock_nanosleep`, `nanosleep`; `rt_sigreturn`,
   `rt_sigprocmask`, `rt_sigaction`, `sigaltstack`; `getrandom`; `uname`
   (an accepted risk, above); `exit` and `exit_group`. `clone` is allowed
   only for a thread: the memory, files, filesystem context, and signal
   handlers shared, and no new namespace. `clone3` fails with `ENOSYS`, so
   libc falls back to `clone`, whose flags the filter can inspect. File
   calls (`open`, `openat`, `openat2`, `stat` and its variants,
   `readlink`, `access`) fail with `EACCES`, as Landlock would answer them,
   because V8, ICU, and abseil probe files lazily and fall back. `prctl`
   allows only `PR_SET_NAME` and `PR_SET_VMA_ANON_NAME` (thread and
   mapping names); other options fail with `EPERM`, and `PR_SET_DUMPABLE`,
   `PR_SET_PTRACER`, and `PR_SET_MM` kill the process. Anything else
   (`socket`, `connect`, `execve`, `fork`, `ptrace`, a `clone` that creates
   a process or a namespace) kills the process.

Namespaces and cgroups are planned, not built. The intent is to use
unprivileged user, PID, network, mount, and IPC namespaces, and cgroup v2
limits, where the host allows them, opportunistically and never relied on
(`docs/roadmap.md`, "Opportunistic cgroups v2 and namespaces"). Today the
worker creates none, and the seccomp filter kills a `clone` that asks for
one, so they would have to be entered before the filter is applied.

macOS has no lockdown today: no seccomp, no Landlock, and no enforcement
of `RLIMIT_DATA` or CPU budgets, which is why strict mode refuses it. A
Seatbelt profile (`sandbox_init` with a deny-by-default profile, as Chrome
uses) is planned (`docs/roadmap.md`, "macOS: Seatbelt profile").

### Where the lockdown works

| Host | seccomp | Landlock | User namespaces |
|---|---|---|---|
| Linux 5.13+ bare metal or VM | yes | yes | usually |
| Ubuntu 24.04+ | yes | yes | blocked by AppArmor by default |
| Docker / Kubernetes (default seccomp profile) | yes (nested filters work) | check (depends on the runtime's profile) | blocked |
| macOS | no (Seatbelt planned) | n/a | n/a |
| Windows | development mode only | n/a | n/a |

seccomp is the baseline we require; Landlock is required where the kernel
has it. The user-namespace column describes what a host permits, for the
planned namespace layer; isolane uses none today. The table's "check"
entries are what P0/P3 verify.

### Strict mode

On by default (`strict: true`), whatever `NODE_ENV` says. The runtime
refuses to run guest code unless the worker reports a securely configured
V8 sandbox, seccomp fully applied, and Landlock in force at least partially
(`meetsStrict` in `ts/worker.ts`); a refusal is `ERR_ISOLATION_UNAVAILABLE`,
not a security event. `runtime.isolationReport()` starts a probe worker,
ignoring strict mode, and reports the V8 version, the sandbox, and which
lockdown layers took effect. `strict: false` turns the check off for local
development. A command-line report for a host before deploying,
`npx isolane doctor`, is planned, not built (`docs/roadmap.md`, "`isolane
doctor`").

### L3: Tenancy, recycling, quarantine

- Process per tenant by default (above).
- Workers are recycled after a maximum lifetime or eval count
  (`workerLifetimeMs`, `workerEvals`; see Lifecycle above).
- A worker crash (SIGSEGV, a V8 sandbox violation, or a seccomp kill), a
  protocol violation, or an unresponsive worker is treated as a possible
  exploit attempt. The worker is gone (killed if needed), the tenant is
  refused with `ERR_TENANT_QUARANTINED` for `quarantineMs`, and the event is
  surfaced through `onSecurityEvent` with the tenant and what happened, so
  the application can alert or suspend the account. Planned: a `--jitless`
  quarantine worker instead of refusing (it needs its own web snapshot,
  since the snapshot is checked against V8's flags, and can't offer
  WebAssembly), and a hash of the code that ran.
- What a worker reports about itself is advisory once it has run guest
  code: usage figures (CPU, memory, log bytes), the limit it says was hit,
  and its exit code come from a process that may be compromised. The
  supervisor checks the shapes, cuts log lines, counts host calls and their
  bytes itself, and kills a worker that breaks the protocol. The one usage
  figure it measures itself is `usage().workerCpuMs` (Linux): each worker
  process's CPU time, read from the kernel. Billing on anything else in
  `usage()` trusts the worker's word. The background budgets
  (`backgroundMs`, `workerBackgroundMs`) are enforced by the worker too,
  so a compromised worker escapes them; recycling and `workerCpuMs` are
  what still hold.

### L4: Shipping V8 fixes through npm

- Patch pipeline (built): `.github/workflows/v8-update.yml` runs daily.
  When upstream V8 has a newer patch release on the branch we build (where
  security backports land), it bumps `V8_TAG` on a branch, runs CI on it,
  and opens a pull request when CI passes. It opens an issue when the branch
  leaves Chrome's support window (Stable and Extended Stable), which needs a
  rusty_v8 upgrade by hand. Owning the V8 build lets us take an urgent fix
  without waiting for `rusty_v8`.
- Releases: `release.yml` publishes from a tag, from CI only, and every
  V8 patch bump is meant to be a patch release. No release has been made
  yet. The target of a published release within 72 hours of a V8 security
  fix is planned, not met (`docs/roadmap.md`).
- Applications have to take updates. We can't push fixes to an
  installed package. A staleness warning, comparing the installed worker's
  V8 version with the newest patch release (and an option for strict mode
  to refuse a stale worker), is planned, not built (`docs/roadmap.md`,
  "Staleness warning").
- Fuzzing: Fuzzilli against our exact embedder configuration is
  planned, not running (`docs/roadmap.md`). What runs today is the protocol
  fuzzer (hostile fake workers) and the V8 mjsunit corpus replayed under
  lockdown, weekly in the soak workflow.
- An external security review before the first release that is
  recommended for untrusted code.

## Packaging

- `isolane`: the TypeScript library (supervisor and client API).
- Prebuilt workers as optional dependencies, chosen at install time by
  platform, like esbuild: `@isolane/worker-linux-x64-gnu`,
  `-linux-arm64-gnu`, `-linux-x64-musl`, `-linux-arm64-musl`,
  `-darwin-arm64`, `-darwin-x64`. Each contains one static binary, roughly
  30–40 MB.
- No install scripts and no compilation on the user's machine.

## Phases and exit criteria

| Phase | Builds | Exit criteria |
|---|---|---|
| P0 V8 build | V8 from source with the sandbox, for darwin-arm64 (this machine) and linux-x64 (OrbStack) | A test binary asserts the sandbox is active on both |
| P1 Worker | Isolate per VM, run/eval, limits, `TerminateExecution`, frozen clocks, codegen off, Promise host calls | Port of clockwork's lane tests passes against a bare worker |
| P2 Library | Supervisor in TS, framed IPC, process per tenant, lifecycle, `Runtime` API | Same tests pass through `npm`-style usage in Node |
| P3 Lockdown | seccomp, Landlock, and strict mode (built); opportunistic namespaces, Seatbelt, and `isolane doctor` (planned) | Escape suite: a test-only "compromised worker" mode is refused `open` (EACCES) and killed on `socket`/`execve`/`ptrace`/`fork` every time, on each row of the host table |
| P4 Packaging | CI matrix building V8 for six targets, per-platform npm packages, staleness checks | `npm install isolane` works on a clean machine per target |
| P5 Security program | Patch pipeline (built), Fuzzilli (planned), external review (planned) | **Gate: not recommended for untrusted code before P5 is complete** |

## Risks

- **V8 source builds are heavy:** roughly 30 GB of disk and an hour or more
  per clean build per target. CI needs caching.
- **Linux arm64 is cross-compiled:** Chromium's clang and Rust toolchains
  exist for x64 Linux hosts only, so CI builds arm64 on x64, makes the web
  snapshot with that first build on a native arm64 runner, links it into a
  second x64 build, and tests the result on the arm64 runner.
- **seccomp allowlists are brittle across V8 versions:** a new V8 can start
  using a new syscall. The escape suite and per-release tests catch this.
- **The V8 sandbox is still being hardened.** The V8 team doesn't yet treat
  it as a full security boundary; process per tenant and L2 exist for that
  reason.
- **No machine-level wall:** without gVisor, a kernel bug reachable through
  the seccomp allowlist is the remaining path out. Keeping the allowlist
  minimal is what bounds that risk.
- **Residual gap with Cloudflare:** we can match the architecture, not their
  telemetry or response team. `onSecurityEvent` hands that responsibility to
  the application.

## Open decisions

1. **Host functions:** Promise-returning in the guest (recommended, assumed
   above) or blocking like clockwork lanes?
2. **Guest WebAssembly:** none (assumed above), or application-supplied
   modules only?
3. **Process per tenant as the default:** confirm. The alternative is
   grouping tenants by plan.
