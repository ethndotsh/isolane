# isolane: design and threat model

Status: draft for review. Nothing here is built yet. (`isolane` is a working
name.)

## Goal

An npm package that runs untrusted JavaScript from many tenants on V8, with
Cloudflare Workers' safety posture as the bar: no single bug (in V8, in our
code, or in the kernel interface) is enough for a tenant to reach another
tenant, the host application, or the machine.

`npm install isolane` must be the whole setup: no root, no daemons, no
container runtime. The client API mirrors clockwork's `LanePool` (`run`,
`createVm`, `hostFunctions`, `LaneError` codes).

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
- **Node or Web APIs** beyond what the application exposes as host
  functions.
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
| Escape to the machine (files, network, other processes) | seccomp allowlist in every worker | Landlock (no filesystem); namespaces where the host allows them |
| Side-channel reads (Spectre) | Separate processes per tenant; frozen clocks; no shared memory or threads | Quarantine on crashes |
| Denial of service | Per-isolate heap limit; CPU and wall-clock budgets via `TerminateExecution` | Per-worker rlimits; cgroups where available; worker count caps |
| Persist after compromise | Workers recycled on a schedule | Crash = quarantine the tenant + replace the worker |

**Trusted:** the isolane library running in the application's Node process,
and the kernel (minimized by seccomp). **Untrusted:** everything inside a
worker after the first line of guest code runs. Once it has executed guest
code, the worker is treated as potentially compromised.

## Architecture

```
 application process (Node)                         worker processes (prebuilt Rust + V8)
┌──────────────────────────────────────┐   pipe  ┌───────────────────────────────────────┐
│ isolane library                      │◀───────▶│ worker: tenant A                      │
│  - LanePool-shaped API               │         │  isolate per VM, watchdog thread      │
│  - supervisor: spawn, lock down,     │   pipe  │  seccomp + Landlock (+ namespaces)    │
│    route by tenant, quotas, recycle, │◀───────▶├───────────────────────────────────────┤
│    quarantine                        │         │ worker: tenant B                      │
│  - runs host functions (app secrets  │   pipe  ├───────────────────────────────────────┤
│    stay here)                        │◀───────▶│ worker: quarantine (--jitless)        │
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
  one isolate per VM (`pool.createVm`) or per one-shot run. Isolates are
  never reused across VMs. A `tenantsPerWorker` option allows grouping
  tenants by plan when process count matters more; that is Cloudflare's
  model.
- **Lifecycle:** workers start on a tenant's first request, idle out after a
  configurable period, and are recycled after a maximum lifetime or request
  count.

### Request flow

1. The app calls `pool.run(code, { tenant, hostFunctions, timeoutMs })`.
2. The supervisor finds or spawns the tenant's worker and sends the code.
3. The worker creates an isolate, compiles, and runs.
4. A host-function call becomes a frame up to the library, which runs the
   application's function and sends the result back. Inside the guest the
   call returns a Promise, driven by a per-isolate event loop.
5. The completion value returns as JSON; failures use clockwork's
   `LaneError` codes.

## Defense layers

### L0: Guest API surface

- ECMAScript plus the application's host functions only.
- No code generation from strings: `eval` and `new Function` throw.
- No WebAssembly (the global is deleted and code generation is denied).
- No `SharedArrayBuffer`, `Atomics.wait`, or guest threads.
- **Frozen clocks:** the wall clock (`Date`, `Intl`'s default "now",
  `Temporal.Now`) advances only when an eval starts and when a host-function
  reply arrives, never while guest code runs. It is the platform's
  `CurrentClockTimeMillis` (a small rusty_v8 patch, `patches/`) reading a
  per-VM-thread frozen time. There is no `performance` global.

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
- To evaluate: `--memory-protection-keys` (write-protects JIT code on CPUs
  with PKU), and `--jitless` for the quarantine worker.

### L2: Worker process lockdown

Every worker starts with an empty environment and only its pipe fds open.
After V8 initializes, it applies:

- **seccomp-bpf allowlist** (Linux): roughly `read`/`write` on its pipes,
  `mmap`/`munmap`/`mprotect`/`madvise` (JIT), `futex`, `clock_gettime`,
  `sched_yield`, signal return, and `exit`. Everything else (`open`,
  `socket`, `connect`, `execve`, `ptrace`, namespace creation) kills the
  process. This needs no privileges: `PR_SET_NO_NEW_PRIVS` plus a filter.
- **Landlock** (Linux 5.13+, unprivileged): no filesystem access at all, as
  a second layer under seccomp.
- **Namespaces where the host allows unprivileged user namespaces:** PID,
  network, mount, IPC. Many hosts block them (see below), so they are
  opportunistic, never relied on.
- **rlimits** on CPU time, file size, and process count, plus cgroup v2
  limits when the application's cgroup is delegated. `RLIMIT_AS` is unusable
  because the V8 sandbox reserves a very large virtual address range.
- **macOS** (development and Mac hosts): the Seatbelt sandbox
  (`sandbox_init` with a deny-by-default profile), as Chrome does.

### Where the lockdown works

| Host | seccomp | Landlock | User namespaces |
|---|---|---|---|
| Linux 5.13+ bare metal or VM | yes | yes | usually |
| Ubuntu 24.04+ | yes | yes | blocked by AppArmor by default |
| Docker / Kubernetes (default seccomp profile) | yes (nested filters work) | check (depends on the runtime's profile) | blocked |
| macOS | Seatbelt instead | n/a | n/a |
| Windows | development mode only | n/a | n/a |

seccomp is the baseline we require; Landlock is required where the kernel
has it. The table's "check" entries are what P0/P3 verify.

### Strict mode

On by default when `NODE_ENV=production`. The pool refuses to start unless
the required layers are active on this host: V8 sandbox, seccomp, and
Landlock where the kernel supports it. `pool.isolationReport()` lists what
is active, and `npx isolane doctor` prints the same report for a host before
deploying. Development mode warns instead of refusing.

### L3: Tenancy, recycling, quarantine

- Process per tenant by default (above).
- Workers are recycled after a maximum lifetime or request count.
- A worker crash (SIGSEGV, a V8 sandbox violation, or a seccomp kill) is
  treated as a possible exploit attempt. The tenant moves to a quarantine
  worker (`--jitless`), and the event is surfaced to the application through
  an `onSecurityEvent` callback with the tenant id and code hash, so the
  application can alert or suspend the account.

### L4: Shipping V8 fixes through npm

- **Patch pipeline:** CI tracks Chrome stable security releases, rebuilds V8,
  runs the full test and escape suites, and publishes a new npm version
  **within 72 hours**. Owning the V8 build lets us cherry-pick an urgent fix
  without waiting for `rusty_v8`.
- **Applications have to take updates.** We can't push fixes to an installed
  package, so the worker embeds its V8 version and build date, and the pool
  warns once the installed worker is older than a configurable age (default
  30 days). Strict mode can be set to refuse a stale worker.
- **Fuzzing:** Fuzzilli runs continuously against our exact embedder
  configuration.
- **External security review** before the first release that is
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
| P2 Library | Supervisor in TS, framed IPC, process per tenant, lifecycle, `LanePool` API | Same tests pass through `npm`-style usage in Node |
| P3 Lockdown | seccomp, Landlock, opportunistic namespaces, Seatbelt, strict mode, `isolane doctor` | Escape suite: a test-only "compromised worker" mode is refused `open` (EACCES) and killed on `socket`/`execve`/`ptrace`/`fork` every time, on each row of the host table |
| P4 Packaging | CI matrix building V8 for six targets, per-platform npm packages, staleness checks | `npm install isolane` works on a clean machine per target |
| P5 Security program | Patch pipeline, Fuzzilli, external review | **Gate: not recommended for untrusted code before P5 is complete** |

## Risks

- **V8 source builds are heavy:** roughly 30 GB of disk and an hour or more
  per clean build per target. CI needs caching.
- **Linux arm64 is the hardest target:** Chromium's toolchain is built for
  x64 Linux hosts, so arm64 Linux likely needs cross-compiling from x64.
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
