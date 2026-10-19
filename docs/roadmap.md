# isolane roadmap

Everything planned or discussed, in one place. `docs/design.md` is the
architecture and threat model; this is the work list. Status: **done**,
**in progress**, **planned**, **idea** (worth doing, not committed).

## Vision

Run untrusted, multi-tenant JavaScript from Node with Cloudflare Workers'
safety posture, installable with `npm install`:

- **Safe by default.** V8 sandbox, a process per tenant, seccomp and
  Landlock, frozen clocks, and no ambient capabilities. Everything beyond
  plain ECMAScript is an explicit, per-VM policy.
- **Standard.** Guest code sees the WinterTC Minimum Common Web Platform API
  (`fetch`, `URL`, streams, `crypto`, ...), so code written for Workers,
  Deno, or Bun runs unchanged.
- **Ergonomic.** One small API, typed errors, inputs passed as data, and
  `using` for cleanup.
- **Kept patched.** V8 security fixes reach users within a day, by CI.
- **Proven.** Fuzzing, WPT and test262 in CI, soak tests, and an external
  review before anyone is told it's ready for untrusted code.

## 1. Security

| Item | Status | Notes |
|---|---|---|
| V8 sandbox, verified at startup (`IsSandboxConfiguredSecurely`) | done | |
| Process per tenant; empty env; `cwd: /` | done | |
| Landlock (no FS, no TCP) before V8 starts threads | done | |
| seccomp allowlist on all threads (TSYNC); `clone` only with `CLONE_THREAD`; `clone3` → ENOSYS; file opens → EACCES | done | verified on a real kernel in CI (escape probes, kernel audit log) |
| Strict mode (refuse hosts without full lockdown) | done | |
| Seed V8 from `getrandom` (no `/dev/urandom`, no clock-seeded fallback) | done | |
| Supervisor deadline: kill workers that stop answering | done | found by the protocol fuzzer |
| Frozen clock (Date, Intl, Temporal.Now) via platform patch | done | `patches/rusty_v8-clock-platform.patch` |
| Per-worker memory cap (RLIMIT_DATA) covering ArrayBuffer/Wasm | done (Linux) | macOS ignores RLIMIT_DATA |
| V8 patch pipeline: rebase rusty_v8's V8 onto upstream patch releases daily, CI, PR | done | needs repo setting "Allow GitHub Actions to create and approve pull requests" |
| Milestone rollover alert (branch leaves Stable/Extended Stable) → issue | done | then: bump rusty_v8 major by hand |
| Bump V8 to 15.2.124.45 (44 security backports behind) | in progress | first run of the pipeline |
| Protocol fuzzer (hostile fake workers) | done | weekly soak + on demand |
| V8 mjsunit corpus replay under lockdown (SIGSYS/crash finder) | done | weekly soak |
| Fuzzilli against our worker config (REPRL mode, sanitizer-coverage V8 build, V8 sandbox fuzzing profile / memory-corruption API) | planned | rented box ~$20–80/mo or weekly 6 h CI job; 1–2 days to set up |
| V8 "sandbox testing" mode: give guest arbitrary in-sandbox R/W, check it can't escape the worker | idea | |
| Temporal: re-enable after audit (it exposes the host time zone; temporal_rs `sys` paths) | planned | |
| Host time zone leaks via `Date` (`getTimezoneOffset`): pin workers to UTC | planned | |
| Quarantine tenants after security events; tenant trust levels (group or isolate by plan) | planned | |
| CPU-time budgets (per-eval CPU, not just wall clock; per-tenant accounting) | planned | |
| rlimits: NPROC, FSIZE, CORE; opportunistic cgroups v2 and namespaces | planned | |
| macOS: Seatbelt profile (sandbox_init) | planned | |
| `isolane doctor` (explain what this host provides and why) | planned | |
| External security review; written threat-model sign-off (P5 gate) | planned | the README says "not ready for untrusted code" until then |
| Known limits to document: fs root must not be writable by others (TOCTOU); time still advances at I/O (coarse timing); a seeded VM's hash seeds are predictable to itself | planned | |

## 2. Guest capabilities (per-VM policies)

| Item | Status |
|---|---|
| `clock`: frozen / realtime / fixed | done |
| `randomSeed` (reproducible `Math.random`) | done |
| `allowCodeGeneration` (`eval`, `new Function`) | done |
| `allowWebAssembly` (async compile works: foreground tasks pumped) | done |
| `network`: brokered `fetch` (allowlist or function, DNS-pinned private-address blocking, redirects re-checked, limits) | done |
| `sockets`: brokered `connect()` (host:port patterns, TLS, connection/idle limits) | done |
| `fs`: brokered, confined to `root`, read-only by default, no symlink escapes, no host paths in errors | done |
| `console` → `onLog` (per-eval byte budget) | done |
| `globals`: inputs as data | done |
| Sync host functions (`{ sync: true, fn }`; the isolate blocks on the reply under the deadline; other messages wait in a mailbox) | done |
| Host functions get call context (tenant, VM, abort signal) | planned |
| UDP sockets | idea |
| KV / cache / queue capabilities as policies (Workers-style bindings) | idea |

## 3. WinterTC compatibility

Approach (decided): vendor Deno's web-platform JS (MIT, `runtime/deno/`,
pinned by `scripts/vendor-deno.sh`) and implement its native ops ourselves in
the worker, keeping our V8, lockdown, and clock. Not deno_core: it pins an
older, unsupported V8 and brings tokio and its op layer into the worker.

| Phase | Scope | Status |
|---|---|---|
| 1 | primordials, webidl, URL/URLSearchParams (`url` crate), TextEncoder/Decoder (`encoding_rs`), atob/btoa, Event/EventTarget/CustomEvent, AbortController/AbortSignal, DOMException, structuredClone (V8 ValueSerializer), performance (frozen-clock semantics), queueMicrotask, reportError, `self`, `navigator.userAgent`, `crypto.getRandomValues`/`randomUUID` | in progress (JS vendored) |
| 2 | Timers + an event loop in the VM thread (`setTimeout`, `setInterval`, `AbortSignal.timeout`), Streams (06_streams), Blob/File, TextEncoderStream/DecoderStream, CompressionStream (`flate2`) | planned |
| 3 | Spec `fetch`/`Request`/`Response`/`Headers`/`FormData` (Deno's 20–26) over our network broker; streaming bodies | planned |
| 4 | `crypto.subtle` (Deno's ext/crypto Rust, MIT) | planned |
| — | V8 startup snapshot of the runtime JS (avoid compiling ~15k lines per VM) | planned |
| — | ES modules for guest code (`export default { fetch }` handlers) | planned |
| — | WPT subset in CI with tracked pass rates; Deno's and workerd's expectation files as a baseline | planned |
| — | test262 run (catch regressions from removed globals and flags) | planned |
| — | List isolane on unjs/runtime-compat | idea |
| — | Node compatibility layer (workerd's `src/node` JS/TS, Apache-2.0: `node:buffer`, `node:events`, `node:util`, ...) | idea |

## 4. API and ergonomics

| Item | Status |
|---|---|
| Rename: `LanePool` → `Runtime`, `LaneVm` → `Isolate`, `LaneError` → `IsolaneError`; `runtime.tenant(name)` → `Tenant` | done |
| `tenant()` handles, pool-wide `defaults`, merged options | done |
| `using` on runtime and isolates | done |
| Error taxonomy: one `IsolaneError` with `code`, `kind` (guest / limit / usage / infrastructure), `retryable`, `tenant`, and `guest` (name, message, stack); spec-shaped errors inside the guest (every fetch failure a `TypeError`; fs errors with Node-style `code`; host-function errors keep their class and `code`) | done |
| Codes: `ERR_ISOLATE_RETIRED`, `ERR_ISOLATE_DISPOSED`, `ERR_WORKER_UNRESPONSIVE`, `ERR_ISOLATION_UNAVAILABLE`, `ERR_INVALID_OPTION`, `ERR_RUNTIME_CLOSED` added. Policy denials and host-function failures surface inside the guest (as above), not as host-side codes | done |
| `onPolicyDenied` event (audit log of refused fetch/connect/fs calls per tenant) | idea |
| Resolve the worker binary automatically (per-platform optional package) instead of `ISOLANE_WORKER` | planned (with packaging) |
| Typed host-function signatures; `vm.call(name, ...args)` for stateful VMs | idea |

## 5. Performance

Measured against isolated-vm (Linux x64 under Rosetta; re-measure natively):

| | isolane | isolated-vm |
|---|---|---|
| Cold start for a new tenant | 142 ms | 0.89 ms |
| New VM on a warm tenant | 1.55 ms | 0.96 ms |
| Eval round trip | 30 µs | ~3 µs |
| `fib(30)` | 11.8 ms | 40.1 ms |
| Host call | 33 µs | 0.77 µs |
| Memory per VM / per tenant | 1.65 MB / 27 MB | 1.19 MB / 0 |

| Item | Status |
|---|---|
| Measured (`bench/protocol.mjs`, native macOS, dev build): eval round trip 15.5 µs; a host call ~13 µs sequential (async or sync) but **1.6 µs each when 100 run concurrently**; 1 MiB through a host call 1.8 ms (JSON in Node ≈ 0.57 ms of it). Small calls are latency-bound (pipe hops, event-loop wakeups), not serialization-bound | done |
| Frame reassembly without repeated copies (1 MiB host call 1.81 → 1.52 ms) | done |
| Binary frames for byte payloads (fs/fetch/socket bodies, typed arrays) instead of base64 in JSON, plus native base64 in the guest (WinterTC phase 1) | planned |
| V8 ValueSerializer as the wire format: **deferred**. Our V8 writes format v16; Node 22 and 26 read only up to v15. And the supervisor would parse a compromised worker's output with V8's deserializer, which Chrome never exposes across a trust boundary (browser IPC uses Mojo); JSON.parse is a much smaller parser to trust. Revisit for the supervisor → worker direction only (trusted sender), where it would carry Map/Set/Date/BigInt/typed arrays into the guest | idea |
| Lower per-call latency: coalesce frame writes per event-loop turn on the supervisor; spin briefly before blocking in the worker | planned |
| Frame batching (fewer syscalls), fewer copies | planned |
| Prewarmed worker pool (hide cold start) | planned |
| Startup snapshot (also cuts per-VM setup once the WinterTC runtime is in) | planned |
| Native benchmarks (not Rosetta) in CI, tracked over time | planned |
| Shared-memory transport | idea (needs a native addon; conflicts with plain `npm install`) |

## 6. Operations

| Item | Status |
|---|---|
| Stress soak: VM floods, tenant floods, crash churn, VM/eval leaks, noisy neighbours, memory bombs | done (weekly; first results pending) |
| Per-tenant VM cap (and graceful refusal) | planned (sized from soak results) |
| Worker recycling: max lifetime / max requests | planned |
| Metrics hooks (per tenant: evals, CPU, memory, host calls, security events) | planned |

## 7. Packaging and platforms (P4)

| Item | Status |
|---|---|
| Linux x64 build in CI (from source, sandbox on), incremental rebuilds via source manifest | done |
| Linux arm64 (cross-compile from x64: Chromium's toolchains are x64-only) | planned |
| macOS arm64/x64 (needs full Xcode; macOS CI runners) | planned |
| Per-platform npm packages as optional dependencies; stripped binaries | planned |
| Staleness warning when the installed worker's V8 is behind the patch pipeline | planned |
| Dev build against prebuilt V8 (`--features dev-prebuilt`, `ISOLANE_DEV_INSECURE=1`) for local iteration | done |
| Speed up V8 builds with sccache (as rusty_v8's CI does) | idea |

### CI cost (GitHub-hosted runners, private repo, 2026 prices)

Linux 2-core $0.006/min, Linux arm64 2-core $0.005/min, macOS $0.062/min.

- Full V8 build, Linux x64: ~100 min ≈ $0.60. Incremental (unchanged
  sources): ~4 min per run.
- Daily V8 patch check: ~1 min/day. Each V8 patch bump: one incremental
  build (cost to be measured on the 15.2.124.1 → .45 bump). V8 15.2 had ~44
  patch releases in ~10 weeks.
- macOS builds would dominate (~10× per minute): build macOS only for
  security-labelled patches, or batch them weekly.
- Weekly soak: 4 parallel jobs, ~30 min each ≈ $0.75/week.
- Cache: ~0.9 GB per target, within the 10 GB per-repo limit for 6 targets.
- A public repository makes all of this free.

## 8. Examples

| Item | Status |
|---|---|
| Serverless platform (`examples/serverless`): deployers connect over a WebSocket, deploy guest code, and serve its host functions from their own process; each app is a tenant, each request a fresh isolate; console streams back. ~2.4 ms per warm request including two remote host calls (dev build, macOS) | done |
| Serverless example, next: `export default { fetch(request) }` handlers with spec Request/Response (after WinterTC phase 3); warm isolates; deployer auth; deploy persistence | planned |

## 9. What we're borrowing

- **Deno:** web-platform JS (vendored), primordials, the crypto Rust, the WPT
  runner and expectations, the permission syntax (`--allow-net=host:port`),
  rusty_v8's CI practices (sccache, prebuilt publishing). Deno doesn't take
  V8 patch releases promptly; our pipeline does.
- **workerd:** its web APIs are C++ tied to its runtime (not vendorable);
  take its Node compat JS/TS, its WPT setup, `.wd-test` cases, and its
  security write-ups (Spectre, process isolation).
- **isolated-vm:** the comparison baseline. It runs in Node's own V8, built
  without the V8 sandbox (that needs pointer compression, which Node leaves
  off), in-process with the application. Its README: "in maintenance mode";
  untrusted code "does not automatically make your application safe"; a
  rewrite on its experimental branch "is certainly not ready for serious
  applications".

## 10. Housekeeping

- clockwork (the QuickJS sibling project) has its upgrade to quickjs-ng
  6d46d07 / interface 3.6.2, version 0.4.0, uncommitted.
- Enable "Allow GitHub Actions to create and approve pull requests" for the
  V8 update workflow's PRs.
- README `using` examples need Node 24+ (or TypeScript's downlevel).
