# isolane roadmap

Everything planned or discussed, in one place. `docs/design.md` is the
architecture and threat model; this is the work list. Status: **done**,
**in progress**, **planned**, **idea** (worth doing, not committed).

## Vision

Run untrusted, multi-tenant JavaScript from Node with Cloudflare Workers'
safety posture, installable with `npm install`:

- **Safe by default.** V8 sandbox, a process per tenant, seccomp and
  Landlock, frozen clocks, and no ambient capabilities. Everything beyond
  ECMAScript and the web platform's in-isolate APIs (no network, no files)
  is an explicit, per-VM policy.
- **Standard.** Guest code sees the WinterTC Minimum Common Web Platform API
  (`fetch`, `URL`, streams, `crypto`, ...), so code written for Workers,
  Deno, or Bun runs unchanged.
- **Ergonomic.** One small API, typed errors, inputs passed as data, and
  `using` for cleanup.
- **Kept patched.** V8 security fixes reach users within a day, by CI.
- **Proven.** Fuzzing, WPT and test262 in CI, soak tests, and an external
  review before anyone is told it's ready for untrusted code.

## Order of work

Agreed October 2026:

1. **Web conformance pass** (done but for the ada decision): close the WPT gaps, using Deno wherever it is ahead.
2. **The rest of the web platform**:
   - `crypto.subtle` (done; draft algorithms remain, section 3);
   - `URLPattern` (done: Deno's `01_urlpattern.js` on the `urlpattern` crate, with the Minimum Common API now complete);
   - ~~`connect()` as the Sockets API~~ done: see section 2, and the Postgres test authenticates with SCRAM-SHA-256 (postgres.js on `crypto.subtle`);
   - the web snapshot built into the binary (done), so `web` defaults to on (done); the pool of pre-created web isolates is `spareIsolates` (done, with programs phase 4; section 3);
   - fair CPU accounting for timers (done: `limits.backgroundMs`);
   - test262 (done: a CI gate, section 3);
   - delete the old prelude (done: `fetch`, `connect`, and `fs` need the web platform).
3. **Errors and stack traces** (section 4).
4. **Research deployments before building them.** The pieces are wanted:
   - warm isolates;
   - ES modules;
   - TypeScript and JSX through oxc;
   - multi-file programs with `oxc_resolver`;
   - code and wasm caches;
   - shims.
   The API shape is open: `tenant.deploy()` reads oddly, so find a better surface first.
   Researched (October 2026): `docs/deployments.md` surveys other platforms and recommends `tenant.load()` returning a `Program` (`call`, `fetch`, `close`), with `isolate.call` and `isolate.fetch` beneath it, plus a six-phase build plan. The warm setup was decided in October 2026 (`docs/deployments.md`, section 5): `tenant.load()` is warm by default (`instances: { reuse: false }` opts out); setup does no I/O (`ERR_SETUP_IO`, as on Workers); a call stopped part-way retires its instance, and stateful isolates follow the same rule (done); a call finishes when its handler's promise settles, with what it leaves running as background work and `ctx.waitUntil` for work `close()` waits for; `env` is readable at module scope through `isolane:env`; and `isolate.call` lands first (done, with the serverless example on one warm isolate per deploy). Phase 1 of programs is built: single-module `tenant.load()` with a warm pool (section 4 of this roadmap, and `docs/deployments.md`, section 6). Phases 2 and 5 are built too: multi-file programs resolved in the worker, TypeScript, JSX, `define`, source maps, the `modules` option (aliases and host modules), `cloudflare:sockets`, and test262's module tests. Next for modules (October 2026): tsconfig `paths`, a complete `import.meta`, `isolane:files` for reading the program's own files, and the guest's own `error.stack` source-mapped, all done; CommonJS and `.wasm` imports stay later.
5. **Soon after, in no fixed order**:
   - the security gates (Fuzzilli, Temporal audit, external review);
   - more limits and worker recycling;
   - a dedicated performance deep dive (latency, batching, transport, benchmarks);
   - packaging and CI (arm64, macOS, first npm release).
6. **Later milestones**: npm packages and Node compatibility.

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
| Bump V8 to 15.2.124.45 (44 security backports behind) | done | first run of the pipeline (68 min incremental on 2 cores) |
| Protocol fuzzer (hostile fake workers) | done | weekly soak + on demand |
| V8 mjsunit corpus replay under lockdown (SIGSYS/crash finder) | done | weekly soak |
| Fuzzilli against our worker config (REPRL mode, sanitizer-coverage V8 build, V8 sandbox fuzzing profile / memory-corruption API) | planned | rented box ~$20–80/mo or weekly 6 h CI job; 1–2 days to set up |
| V8 "sandbox testing" mode: give guest arbitrary in-sandbox R/W, check it can't escape the worker | idea | |
| Temporal: re-enable after audit (it exposes the host time zone; temporal_rs `sys` paths) | planned | |
| Host time zone leaks via `Date` (`getTimezoneOffset`): pin workers to UTC | done | the worker sets `TZ=UTC` before ICU reads it |
| Quarantine tenants after security events (`quarantineMs`, default 60 s; `releaseQuarantine`) | done | |
| Tenant trust levels (group or isolate by plan) | planned | |
| CPU-time budgets per eval (`cpuTimeLimitMs`, `ERR_CPU_LIMIT`; VM thread's CPU clock, Linux) | done | |
| Per-tenant usage (`runtime.usage(tenant)`: evals, failures, CPU ms, host calls, log bytes, peak memory, security events; `resetUsage`) | done | CPU on Linux only |
| rlimits: CORE=0 (no tenant data in core dumps), FSIZE=0 | done | NPROC is per user (would cap other workers' threads); seccomp already forbids process creation |
| Opportunistic cgroups v2 and namespaces | planned | |
| macOS: Seatbelt profile (sandbox_init) | planned | |
| `isolane doctor` (explain what this host provides and why) | planned | |
| Evaluate V8's `--memory-protection-keys` (write-protects JIT code on CPUs with PKU) for the worker | idea | from `docs/design.md` L1; not used today |
| `RLIMIT_CPU` on workers as a backstop to the watchdog | idea | from `docs/design.md` L2's original list; CPU is bounded today by the watchdog, recycling, and `workerCpuMs` |
| Publish a patch release within 72 hours of a V8 security fix (merge the V8 update PR, tag, `release.yml`) | planned | the target in `docs/design.md` L4; the daily bump and PR are built, no release yet |
| External security review; written threat-model sign-off (P5 gate) | planned | the README says "not ready for untrusted code" until then |
| Known limits documented (README) | done | |

### Security review, October 2026

An internal review found these, each confirmed with a proof of concept,
and each fix has a regression test.

| Finding | Severity | Fix | Status |
|---|---|---|---|
| A `CryptoKey`'s slots (type, extractable, algorithm, usages, handle) were symbol properties on the key, found with `Object.getOwnPropertySymbols`: a guest could export a non-extractable key, add usages, or copy a handle onto a forged key. `algorithm` and `usages` returned the internal objects | high | Slots in a module-private WeakMap, and only keys made by `constructKey` pass a check; the getters return copies (`runtime/crypto.js`). Audited: Deno's webidl brand is an own symbol everywhere, so other vendored objects can be forged, but each only holds the guest's own data (URLs, events, streams, bodies, ports within one isolate); sockets use JS private fields, and broker ids are per isolate | done |
| A 421-byte brotli stream expanded to 256 MiB with `decompressedBytes: 1 MiB` (gzip to 64 MiB per 64 KiB of input): the limit was checked after decoding | high | Every decoder checks the limit as it decodes, in bounded steps (brotli driven directly, 64 KiB at a time; gzip fed 512 bytes at a time); brotli is strict (RFC 7932 windows, no 1 GiB large window, so WPT's tentative large-window test is by-design). The worker grows by under 48 MiB on any bomb (tested). Fetch never decodes (`accept-encoding: identity`) | done |
| `deriveBits` allocated 256 MiB under a 128 MiB heap; an RSA-PSS `saltLength` of 256 MiB was allocated before failing; imported RSA keys had no size cap | high | PBKDF2 derives at most 1 MiB and HKDF at most 255 hash lengths, checked before allocating; a PSS salt must fit the key (sign fails, verify is false); imported RSA keys are capped at 4,096 bits like generated ones, and exponents at rsa's 2^33 - 1. Audited every op in `crates/worker/src/web/` for guest-sized allocations: the rest are proportional to buffers the guest already holds (encoding, base64, clone, URL, compression input, host-call bytes), and arrays from JS now grow as read instead of reserving their claimed length | done |
| `wasm: true` gave guests a SharedArrayBuffer through a shared `WebAssembly.Memory` (V8 can't turn shared memories off) | medium | A guard installed before guest code: the Memory constructor and instances refuse shared memories, and `instantiate` instantiates synchronously after compiling, so no promise (whose `then` lookup a guest can hook) holds an unchecked instance | done |
| `limits.timers: 2**32` passed validation, then the worker exited on the message and the tenant was quarantined | medium | Every limit is checked against what the worker holds (`timers` a u32, durations at most 2^31 - 1 ms, as setTimeout takes, `heapBytes` at most 4 GiB); a create the worker can't parse fails that isolate's evals (`ERR_INTERNAL`) instead of exiting; the worker clamps durations and the heap too | done |
| No limit on host calls: 100,000 calls that never settle in one eval added ~44 MiB to the supervisor and ran every host function | high | `limits.pendingHostCalls` (1,000 waiting at once), `limits.hostCalls` (10,000 per eval; isolane's brokers aside), and `limits.hostCallBytes` (64 MiB waiting at once): the worker refuses the call with a `RangeError` (`ERR_LIMIT`) before sending it, and the eval fails with `ERR_LIMIT` even if the guest catches it; the supervisor kills a worker that sends more than the limits allow | done |
| Console output ignored `logBytes`/`logLineBytes` on the web platform's paths (`reportError`, unhandled errors, Deno's console printing): a 20 MiB line went through with 1 KiB limits; an 80 MiB error made a frame over 64 MiB, which the supervisor took as a protocol violation and quarantined the tenant | high | One path for every console line, held to both limits; strings are copied out of V8 only as far as a limit allows (`write_utf8` into a bounded buffer), for console lines, guest exceptions (64 KiB each part), and `ERR_NOT_SERIALIZABLE` messages; results are measured before copying and never exceed a frame; the supervisor cuts any line a worker sends past the limit | done |
| `Isolate.close()` left in-flight evals hanging, and their supervisor deadlines later killed the worker as unresponsive, quarantining the tenant | medium | Closing rejects the isolate's running and queued evals at once with `ERR_ISOLATE_CLOSED`, clears their deadlines, and stops what the VM is running (through its watchdog, only while it runs guest code, so an idle isolate is never left with a termination pending) | done |
| Concurrent `connect()` opens passed `connect.limits.connections` (a slot was counted only once connected) | medium | A socket counts from when it starts opening, released if it fails | done |
| A hostname resolving only to private addresses was refused without `onPolicyDenial` | medium | The DNS-pinning lookup reports it (`fetch` and `connect`, every redirect hop); refusing to replace the `fs` root is reported too. Audited the brokers' other refusals: the rest are limits (`ERR_LIMIT`-style messages), not policy | done |
| The supervisor ignored backpressure on the worker's stdin: a worker that stops reading made it buffer without bound | medium | Past 64 MiB queued, a worker has 5 s to drain it, and past 1 GiB it's killed at once, as unresponsive | done |
| Audit: other ways guest behaviour alone could look like an attack (and quarantine the tenant) | — | Found and fixed: a host function's error echoing guest input past 64 MiB (cut to 64 KiB), `codeBytes`/`resultBytes` set past a frame (capped at the frame), an eval waiting behind its isolate's own background work past its deadline (the deadline moves while the worker reports progress, up to 10×), and a V8 crash when one isolate started from the web snapshot while another was being disposed (V8's shared heaps were torn down and rebuilt in between: the worker now keeps its first isolate for its whole life) | done |
| macOS can't meet strict mode | — | By design: no seccomp, Landlock, or memory cap there; strict mode refuses it, and the guide's known limits say so | by design |

A second pass (at `2b5536a`) checked the fixes above and the rest of the
first pass's findings:

| Finding | Severity | Fix | Status |
|---|---|---|---|
| `exportKey` read the public `extractable` getter, so an own `extractable` property on a real key shadowed it: a non-extractable AES key exported | high | Every internal read of a key's state uses its slots (`runtime/crypto.js`), including JWK `key_ops`; tests shadow `extractable`, `usages`, `type`, and `algorithm` and try export, decrypt, and wrap | done |
| Host calls abandoned by a timed-out eval kept their `pendingHostCalls`/`hostCallBytes` slots in the worker, so the isolate could never call host functions again | medium | An eval that fails with `ERR_LIMIT` or `ERR_ISOLATE_RETIRED` abandons every pending call of its isolate, in the worker (slots freed, late replies ignored) as in the supervisor (signals aborted); and no host call waits more than a second past the isolate's `timeoutMs`, even one an eval left behind when it returned (the guest's promise rejects with `ERR_LIMIT`, the signal aborts, the slot frees) | done |
| `console.log(Symbol())` threw, and a thrown Symbol lost its text (the size-capped string copy called ToString) | low | Values whose conversion throws (symbols, throwing `toString`/`Symbol.toPrimitive`, revoked proxies) get V8's side-effect-free description; termination still propagates | done |
| Background budget per isolate: a tenant's 100 isolates get 100 budgets (~1.67 cores between evals) | medium | `limits.workerBackgroundMs` (default 10 s per minute): one budget for all the tenant's isolates, in the worker; running it out pauses their background work rather than retiring anything; tested with 20 isolates | done |
| On Linux the background budget is CPU time, so a timer blocked in a slow sync host function held the thread uncharged | medium | Time blocked in sync host calls between evals is charged too | done |
| The supervisor trusts worker-reported usage, limit names, and exit codes; log frames weren't rate-limited | medium | Log lines past 4 × `logBytes` (at least 4 MiB) a second per isolate are dropped with one notice; a worker's unprompted clean exit (code 0) is a security event (only the supervisor ends workers); `docs/design.md` says usage figures are the worker's word. Since: `usage().workerCpuMs`, the worker processes' CPU time read by the supervisor from `/proc/<pid>/stat` (Linux), next to the worker-reported figures, which the guide and `docs/design.md` call advisory. Not done: exit code 6 (out of memory) still skips quarantine | mostly done |
| seccomp breadth: `clone` checked only CLONE_THREAD; the syscall audit wasn't a gate; no check of open fds | medium | `clone` must share memory, files, filesystem context, and signal handlers and create no namespace (escape tests `clone-namespace`, `clone-unshared`); the CI syscall audit fails on any syscall outside the filter's list; a lockdown test checks a serving worker holds only pipes and anonymous inodes. Since: `prctl` allows only `PR_SET_NAME` and `PR_SET_VMA`/`PR_SET_VMA_ANON_NAME` (the only options the CI audit sees: ~15,700 calls, all thread and mapping names), other options get EPERM, and `PR_SET_DUMPABLE`, `PR_SET_PTRACER`, and `PR_SET_MM` kill the worker (escape tests `prctl-dumpable`, `prctl-other`); the audit fails on any other option. Open: `mmap`/`mprotect` stay unrestricted, PROT_EXEC included, because V8's JIT needs them (a `--jitless` quarantine worker would drop it), and timing calls are allowed | partly done |
| Strict mode accepts Landlock `partial` | low | Kept, and documented in the guide: seccomp already refuses file opens and `socket()`, and requiring Landlock's newest ABI would refuse most LTS kernels | decided |
| A dev build (no V8 sandbox) without `ISOLANE_DEV_INSECURE` was a protocol violation (a security event and a quarantine), and `isolationReport()` couldn't probe it | low | Refused as a setup error with a message saying so, no security event; `isolationReport()` reports it | done |
| `docs/design.md` described worker recycling, a `--jitless` quarantine worker, a code hash in `onSecurityEvent`, and `tenantsPerWorker` as if built | medium | The design says what exists and marks the rest planned; recycling stays the row in section 6 | done (docs) |
| Broker totals: `fs` had no total or concurrency limit; closed sockets kept counting; `startTls` checked only the broker's queue | medium | `fs.limits.writtenBytes` (100 MiB per isolate, `EDQUOT`) and `fs.limits.operations` (16 at once, `EMFILE`); a socket whose connection closed stops counting once the guest has read what's left; `startTls` also refuses over Node's own buffer (bytes still in the kernel fail the handshake). Since (EXT-10): `fetch.limits.requests` defaults to 1,000, and `fetch.limits.transferBytes` and `connect.limits.transferBytes` (1 GiB each, request and response bodies or socket reads and writes, over the isolate's life) cap the bytes moved; the fs race is closed on Linux (C4, below) | done |
| Host errors and denial targets can leak secrets | low | `onPolicyDenial` reports URLs without `user:password@`; the guide says a handler's error `name`, `message`, and `code` reach the guest. Idea: let `afterHostCall` replace an error, as it can a result | partly done |
| The runtime's per-tenant maps (`usage`, quarantines) grow with every tenant name | low | Expired quarantines are dropped as new ones come; usage is kept until `resetUsage()`, as billing needs, and the guide says tenant names must come from the application, not requests | done |
| Supply chain: tags not commits for rusty_v8 and V8, floating action and npm versions, no advisory gate | low/medium | `fetch-rusty-v8.sh` checks `RUSTY_V8_COMMIT` and `V8_COMMIT` (the daily V8 bump updates both); actions pinned by commit, npm by version; CI's `audit` job runs `npm audit --omit=dev` and `cargo audit` (RUSTSEC-2023-0071, RSA timing, accepted in `.cargo/audit.toml` and `docs/design.md`; `paste` unmaintained is a warning). Open: `x448` is a prerelease crate | partly done |
| `place_bytes` followed inherited properties on host-reply byte paths | low | Only own properties are followed and set (`create_data_property`), so no path reaches a prototype or runs a setter | done |
| Crypto inputs: an RSA `publicExponent` became a big integer before its check (16 MiB peaked at ~84 MiB); key data was parsed before the modulus cap; error strings could panic | low | Exponents longer than 3 significant bytes are refused first; RSA and EC key data over 64 KiB is refused before parsing; crypto error messages are cut to 1 KiB and never panic. Open: RSA key generation (up to 4,096 bits) can't be interrupted (accepted in `docs/design.md`); moving long crypto off the VM thread is the row in section 3 | partly done |
| `globals` could replace built-ins (`Object`, `TextEncoder`) or fail setup on non-writable names | low | ECMAScript names are refused as `ERR_INVALID_CONFIG`, web platform names when the isolate starts; each global is defined, never assigned | done |
| The review's release gate | — | Now a checklist in `SECURITY.md`. Still open before untrusted production: the Linux fd and syscall gates passing in CI, the external review and Fuzzilli (P5). Since done: the tenant-wide background budget, worker recycling, supervisor-side CPU accounting (`workerCpuMs`) | open |

A third pass ranked what's left by worst case:

| Finding | Severity | Fix | Status |
|---|---|---|---|
| C1: IPv6 addresses that embed an IPv4 address passed the private-address check: 6to4 (`2002:7f00:1::` is 127.0.0.1, `2002:a9fe:a9fe::` is 169.254.169.254), Teredo (`2001::/32`), local-use NAT64 (`64:ff9b:1::/48`), IPv4-translated (`::ffff:0:0:0/96`). A host with routes for them would reach loopback or cloud metadata | critical (policy bypass) | All of them are non-public now, along with the rest of IANA's special-purpose IPv6 space (`2001::/23`, `3fff::/20`, `5f00::/16`, `fec0::/10`); tested | done |
| C7: `fetch` allowed any port on an allowed host | medium | A bare host allows only the scheme's default port (443 or 80); others are named as `host:port`, `[v6]:port`, or `host:*`. Only `http:`/`https:` are fetched, as before. **Breaking**: a policy that relied on other ports must name them | done |
| EXT-10: `connect` had no byte limit and `fetch.limits.requests` no default | medium | `fetch.limits.requests` defaults to 1,000 per isolate; new `fetch.limits.transferBytes` and `connect.limits.transferBytes` (1 GiB each over the isolate's life, both directions); tested | done |
| C2: macOS, `strict: false`, and dev builds without the V8 sandbox can't contain untrusted code | — | Accepted by design: strict mode refuses them. Ship macOS workers for development only | decided |
| C4 (EXT-02): a writable `fs.root` could race a symlink between the broker resolving a path and opening it | high (conditional) | On Linux every path is walked one component at a time from held directory descriptors, opening `/proc/self/fd/<dir>/<name>` with `O_NOFOLLOW` (an `openat` without a native addon); symlinks are read and re-walked from the root only while they stay inside, and recursive `rm` descends by descriptor. A race test flips a directory and a symlink to outside under concurrent writes and reads (`test/fs-confinement.test.mjs`; it fails on the old code). macOS, development only, still resolves then opens | done (Linux) |
| C5: a compromised worker can call any host function registered for any isolate of its tenant (they share one worker process) | — | Inherent while a tenant's isolates share a process: the supervisor can't tell which isolate a compromised worker is really calling for. The tenant is the security boundary, not the isolate (now said in `docs/design.md`); code that needs isolates as separate domains should give them separate tenants | decided |
| C6: a V8 sandbox or kernel zero-day | — | The release gate: Fuzzilli, the external review, and a run of the real Linux worker under them | planned (P5) |
| EXT-06: worker recycling and the `--jitless` quarantine worker were planned, not built, so a compromised but running worker lived until it idled out | medium | Recycling after `workerLifetimeMs` (1 hour) or `workerEvals` (100,000), with `onWorker` `recycle` events; the `--jitless` worker stays planned (it needs its own snapshot and no WebAssembly) | mostly done |
| EXT-07: `backgroundMs` was per isolate, so 100 isolates got 100 budgets | medium | `workerBackgroundMs`, one budget per tenant (default 10 s per minute) that pauses rather than retires | done |
| EXT-08: every `usage()` figure was worker-reported | medium | `usage().workerCpuMs`: the worker processes' CPU time from `/proc/<pid>/stat`, measured by the supervisor (Linux). Not enforced as a limit: `cpuMs`, `backgroundMs`, `workerBackgroundMs`, and recycling bound the CPU a worker spends; an application can act on `workerCpuMs` itself | done |

## 2. Guest capabilities (per-VM policies)

| Item | Status |
|---|---|
| `clock`: frozen / realtime / fixed | done |
| `randomSeed` (reproducible `Math.random`) | done |
| `allowCodeGeneration` (`eval`, `new Function`) | done |
| `allowWebAssembly` (async compile works: foreground tasks pumped) | done |
| `network`: brokered `fetch` (allowlist or function, DNS-pinned private-address blocking, redirects re-checked, limits) | done |
| `sockets`: brokered `connect()` (host:port patterns, TLS, connection/idle limits) | done |
| `connect()` is the Sockets API (Cloudflare's, also a WinterTC draft): a `Socket` with `readable` (a byte stream, read from the broker only when the guest reads) and `writable` streams, `opened`/`closed`, `close()`, `allowHalfOpen`, and `startTls()` for `secureTransport: 'starttls'`. The broker upgrades the same connection with node:tls (the policy checks are unchanged) and refuses to upgrade over unread bytes (STARTTLS injection). `connect.ca` for private CAs. Needs `web: true`. postgres.js's Workers build runs from a guest (bundled with esbuild; `test/postgres.test.mjs`, a Postgres service in CI) | done |
| Sockets API, next: the `cloudflare:sockets` module (`import { connect } from 'cloudflare:sockets'`) once ES modules land, so postgres.js and friends need no alias | planned (with ES modules) |
| Sockets API, next: a bytes limit per isolate, counted both ways in the broker | done (`connect.limits.transferBytes`, 1 GiB) |
| Sockets API: `socket.closed` settles when the peer hangs up or the connection fails, whether or not the guest reads (a `watch` operation on the socket broker; unread bytes stay readable). An open socket counts as I/O in flight, so it keeps a pending eval waiting | done |
| Sockets API: `SocketInfo.localAddress`, left out because it would show the guest the host's own address | idea |
| A Postgres TLS (`sslmode=require`, STARTTLS) end-to-end test, with a Postgres configured for SSL and `connect.ca` | planned |
| `fs`: brokered, confined to `root`, read-only by default, no symlink escapes, no host paths in errors | done |
| `console` → `onLog` (per-eval byte budget) | done |
| `globals`: inputs as data | done |
| Sync host functions (`{ sync: true, fn }`; the isolate blocks on the reply under the deadline; other messages wait in a mailbox) | done |
| Host functions get call context (tenant, VM, abort signal) | done |
| UDP sockets | idea |
| KV / cache / queue capabilities as policies (Workers-style bindings) | idea |
| Cloudflare Workers parity, beyond WinterTC (ignoring Node compat and npm). Done: the isolate-per-request model, frozen time, limits, policy-checked `fetch`. Coming with deployments: `export default { fetch, scheduled, queue }` handlers, `ctx.waitUntil`/`passThroughOnException`, Workers-shaped `env` bindings | planned (with deployments) |
| `WebSocket` client (through the broker, under the `fetch`/`connect` policy) | planned |
| Durable Objects-style stateful actors (see celld) | idea |
| Not planned: `WebSocketPair`, `crypto.DigestStream`, `crypto.subtle.timingSafeEqual`, `scheduler.wait` (Workers-only, for porting Workers as-is). Also not planned: the Cache API and `HTMLRewriter`. They're Cloudflare-specific, not WinterTC, and an application can provide either through host functions | decided |

## 3. WinterTC compatibility

Approach (decided): vendor Deno's web-platform JS (MIT, `runtime/deno/`,
pinned by `scripts/vendor-deno.sh`) and implement its native ops ourselves in
the worker, keeping our V8, lockdown, and clock. Not deno_core: it pins an
older, unsupported V8 and brings tokio and its op layer into the worker.

| Phase | Scope | Status |
|---|---|---|
| 1 | primordials, webidl, URL/URLSearchParams (`url` crate), TextEncoder/Decoder (`encoding_rs`), atob/btoa, Event/EventTarget/CustomEvent/ErrorEvent, AbortController/AbortSignal, DOMException/QuotaExceededError, structuredClone (V8 ValueSerializer, with transfer), MessageChannel/MessagePort, performance (frozen-clock semantics), queueMicrotask, reportError, `self`, `navigator.userAgent`, `crypto.getRandomValues`/`randomUUID` — behind `webPlatform: true` | done (WPT 97.3%, below) |
| 2 | Timers + an event loop in the VM thread (`setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `AbortSignal.timeout`), Streams (ReadableStream incl. byte streams/BYOB, WritableStream, TransformStream, queuing strategies), Blob/File/FileReader, `URL.createObjectURL`, TextEncoderStream/TextDecoderStream, CompressionStream/DecompressionStream (gzip, deflate, deflate-raw via `flate2`'s pure-Rust backend; brotli via the pure-Rust `brotli` crate), structuredClone of Blob/File | done (WPT 97.2% over the phase 1 + 2 subset, below) |
| 3 | Spec `fetch`/`Request`/`Response`/`Headers`/`FormData`: Deno's 20–23 (vendored) plus our own `fetch()` (`runtime/fetch.js`, adapted from Deno's 26_fetch.js) over the network broker; response bodies stream (byte streams pulled from the broker), ReadableStream request bodies stream to it (others are sent whole); Subresource Integrity; redirect modes (follow/manual/error; the broker follows, re-checking each hop); abort cancels the broker's request; `data:` and `blob:` URLs; `fetch` without a network policy rejects with a TypeError | done (WPT below) |
| — | Streamed request bodies (upload a `ReadableStream` as it's produced; today it's read to the end first, within `maxRequestBytes`). WPT bug `request-streaming` (2 subtests) | planned |
| — | A base URL option (Deno's `--location`): `web: { baseUrl }`, see API v2 | done |
| — | Header values Node's HTTP client refuses (control bytes 0x01–0x08, 0x0B–0x1F, 0x7F, which Fetch allows) fail the fetch; would need our own HTTP/1.1 client in the supervisor | idea |
| — | Browser-only Fetch rules are not applied (forbidden request/response headers like `Set-Cookie`, method overrides, `only-if-cached`): server runtimes (Deno, workerd) don't either | by design |
| — | WPT fetch tests needing WPT's Python handlers (`.py`): WPT's server (wptserve) serves the WPT gate (see "WPT gate" below) | done |
| 4 | `crypto.subtle`: Deno's ext/crypto JS and Rust ops (MIT) from denoland/deno@eb4061f6f367, the last commit before Deno moved SubtleCrypto into deno_core's cppgc objects (#34966, which only runs inside deno_core); the ops ported to isolane's native layer (`web/crypto/`, serde through a small V8 bridge in place of serde_v8). Pure-Rust RustCrypto everywhere Deno uses aws-lc-rs, so keys come from the isolate's `random` policy (seeded runs reproduce them) and nothing parses guest keys in C. AES-GCM over any IV and tag length (`gcm.rs`, from `aes` + `ghash`), PBKDF2 that stops at the isolate's limits, RSA keys capped at 4,096 bits (generation can't be interrupted), every op panic-free (the release build aborts on panic). A CryptoKey's material is reachable only through a V8 private (Deno exposes it through a registered symbol and `kKeyObject`), and guest code can't forge a key through structured clone. WPT's WebCryptoAPI is in the gate: all of the standard's algorithms pass (plus X448); the WPT-version fixes are `patches/deno-crypto-*.patch` | done |
| — | Web Crypto's draft algorithms: Modern Algorithms (ML-KEM, ML-DSA, SLH-DSA, ChaCha20-Poly1305, AES-OCB, KMAC, Argon2, SHA-3 HMAC, SHAKE/cSHAKE/TurboSHAKE/KangarooTwelve, `getPublicKey`, encapsulate/decapsulate, `SubtleCrypto.supports`) and Secure Curves' Ed448. WPT `webcrypto-drafts`, 7,238 subtests (category `draft` until they're standards). Deno has them in its cppgc rewrite, mostly on aws-lc-rs; port each as an op with a pure-Rust crate (`ml-kem`, `ml-dsa`, `chacha20poly1305`, `ed448-goldilocks` signing, `argon2`, `sha3`'s XOFs) | planned |
| — | RSA through aws-lc-rs: the `rsa` crate isn't constant-time (RUSTSEC-2023-0071, the Marvin attack), so timing many decryptions or signatures with one key can reveal it; aws-lc-rs's RSA is constant-time. Costs: a C library parsing guest-supplied DER outside the V8 sandbox, its own OS randomness (seeded runs wouldn't reproduce RSA keys or OAEP/PSS randomness), and a C toolchain in the worker build. Alternatively wait for the `rsa` crate's constant-time rewrite (on crypto-bigint) | decide |
| — | A Web Crypto op runs on the VM thread: move long ones (RSA key generation, big PBKDF2/digests) to a worker thread the watchdog can account for, so they can run without blocking the isolate's event loop and the 4,096-bit RSA cap can lift | idea |
| — | V8 startup snapshot of the web platform: each worker builds one (every vendored script loaded and compiled, globals as plain values) and creates web VMs from it, then configures each (base URL, timers, time origin). Built when the first web VM wants it, or in the background from start when the supervisor expects web VMs (`--prepare-web`: the first isolate is web, or the defaults turn web on for spares). Fixed WPT bug `lazy-globals`. Measured (macOS dev build, release): fresh web isolate +1.30 → +0.55 ms over web off; first use of Response 4.9 → 0.13 ms, of streams 3.4 → 0.21 ms, all common APIs together 4.9 → 0.32 ms; memory per live web isolate 4.59 → 2.46 MB; the serverless example's warm request 9.6 → 3.4 ms. Costs: ~30 ms to build once per worker that runs web VMs (a new web tenant's first result waits for it unless a spare built it), and ~13 MB more idle RSS in such a worker | done |
| — | Web snapshot embedded in the binary at build time (`scripts/build-worker.sh`: build, `isolane-worker --make-web-snapshot=FILE`, build again with `ISOLANE_WEB_SNAPSHOT=FILE`; `build-v8.sh` and so CI and releases use it). A header records what the snapshot was made from (V8 version and build, V8 flags, a hash of runtime/, the native callbacks' names); a worker that finds another build's snapshot ignores it and builds its own at startup, as does one built without it, and `--self-check` reports `webSnapshot: embedded \| mismatch \| none`. `--prepare-web` remains for workers without one. Measured (macOS dev build): a new tenant's first web result 48.7 → 15.6 ms (web off: 14–19 ms); idle worker RSS after its first web isolate 27 → 15 MB; binary +2.0 MB (the snapshot); a fresh web isolate is unchanged, about +0.9 ms over web off. Arm64 cross-compile: the first pass's binary can't run on the x64 host, so build arm64 on a native runner (GitHub's free `ubuntu-24.04-arm` for public repos), or run the first pass under qemu-user; failing both, ship without the snapshot (runtime fallback, ~30 ms once per worker) | done |
| — | A small pool of pre-created web isolates per worker, to hide the remaining deserialization: the runtime's `spareIsolates` (0 to 8, default 0). Each tenant's worker keeps that many web isolates and their contexts made from the snapshot, for VMs without a `random.seed`, of each of the four heap limits (shapes) its web VMs used most recently; the least recently used shape's spares go when a fifth comes, so a worker holds at most `spareIsolates` × 4 (decided: per shape, not a total shared by the shapes, which a tenant alternating between two heap limits would gain nothing from; `crates/worker/src/spares.rs`). Measured (macOS dev build): a fresh web run 1.5 → 0.25 ms once a spare is ready, a later program instance 3.3 → 2.4 ms; about 3 MB of idle memory per spare, so off by default | done |
| — | ES modules for guest code (`export default { fetch }` handlers) | planned |
| — | **TypeScript guest code** (`lang: 'ts'`, `.ts` deployments): type stripping, not checking, done in the worker with `oxc` (pure Rust), so untrusted source is parsed only inside the locked-down worker. Erasable syntax only (like TypeScript's `erasableSyntaxOnly`: no enum/namespace/parameter properties, which get a clear error; a `transform` mode later). Types are blanked to whitespace, so line:column in guest stack traces match the TypeScript source with no source maps. Pairs with generated `.d.ts` for host APIs so developers can type-check against the exact host API at deploy time | planned (after API v2 and WPT) |
| — | **Multi-file programs**: deployments upload an in-memory file tree (`files: { path: source }`, `entry`); the worker resolves imports with `oxc_resolver` over a virtual filesystem (package.json exports/imports and conditions — `workerd`/`worker`/`browser`/`import`/`default` — tsconfig paths, extension probing), compiles each module with V8's native ES module API (resolve → strip/transform with oxc → compile → link), with dynamic `import()`, `import.meta.url` as the virtual path, and JSON modules. All parsing, resolving, and transforming of untrusted input stays in the locked-down worker, and resolution can't leave the uploaded tree. New limits: `modules`, `moduleBytes`. Packages work if uploaded; `node:*` only with the Node compat layer | planned |
| — | **JSX/TSX** via oxc's transformer: classic (`React.createElement` or a custom factory) and automatic (`jsxImportSource`, resolved in the uploaded tree), so SSR with Hono JSX, Preact render-to-string, or React's server renderer works; the serverless example becomes a `.tsx` app rendering HTML | planned |
| — | V8 code cache for programs' modules: made per worker once the first instance has evaluated (after its load returns, so it holds what setup compiled), keyed by the module's path, its file's hash, and the transform options, consumed by later instances (`ConsumeCodeCache`; a rejected cache is made again). 64 MiB per worker. `programLoad` reports `modules: { compiled, cached, rejected }`. With programs' files sent once per worker, a later instance of a 747 KB program loads in 2.9 to 3.3 ms instead of 12.8 (`bench/program-load.mjs`) | done |
| — | Per-tenant cache of compiled WebAssembly modules: the wasm guard hands each module the guest compiles to the worker, which keeps the most recent 32 MiB of them, so V8's own sharing of compiled modules between a process's isolates outlasts the isolate that compiled one (1.1 MB module, hot, fresh instance: about 2 ms less) | done |
| — | Optional deploy-time bundling with Rolldown (Rust, on oxc) for large dependency trees, plus V8 code cache per deployment | idea |
| — | TypeScript **transform mode** (`ts: { mode: 'transform' }`) via `oxc_transformer`: enums and const enums (inlined within a file), namespaces (partial: no cross-block merging, no exported `var`/`let`), legacy decorators + metadata, JSX/TSX; per-file (`isolatedModules`) semantics. Positions shift, so the worker maps guest stack traces back through the source map before reporting `err.guest.stack`. Strip mode stays the default. Verify parameter properties and standard decorators before documenting them | planned |
| — | **Type checking** at deploy time (`deploy(code, { check: true })`, cached by content hash), never per run: TypeScript's checker running *inside an isolane isolate* (tsc is plain JS; a large heap budget, nothing else enabled), so a checker bug or DoS on hostile input stays sandboxed. Checked against generated `.d.ts` for exactly the host functions (from their schemas) plus the WinterTC globals; failures are `ERR_TYPE_CHECK` with file:line:col diagnostics. Evaluate the native TypeScript 7 compiler (tsgo) as a separate sandboxed process once its embedding API settles | planned |
| — | WPT subset with tracked pass rates: now the WPT gate (`test/wpt/run.mjs`, see "WPT gate" below), which replaced `soak/wpt.mjs` and its 95% floor | done |
| — | Turn `web` on by default: **not yet**. With the snapshot, a web isolate costs ~0.55 ms more than a plain one (isolate 0.29 → 0.59 ms, context 0.12 → 0.37 ms; all V8 deserialization, `configure` is 0.01 ms), over the 0.3 ms bar set for flipping the default; first use costs nothing. Revisit with an embedded snapshot or an isolate pool | deferred |
| — | Fair CPU for work between evals: timers, `MessagePort` tasks, and continuations of unawaited host calls share `limits.backgroundMs` (default 1 s per minute; CPU time on Linux, wall time elsewhere; each host-call continuation charged at least 0.25 ms); past it the isolate is retired, with `onLimit` and `ERR_LIMIT` on its next eval. Counted in `usage().cpuMs`; usage reports coalesced to one frame per 250 ms; timer batches run in 10 ms slices so evals aren't held behind a storm. Covers the security review's findings (a host-call loop after the eval, 10,000 `setInterval`s) | done |
| — | A tenant-wide budget for work between evals across its isolates: `limits.workerBackgroundMs` (default 10 s per minute), a token bucket shared by the worker's VM threads; running out pauses timers and continuations (deferring host replies) until it refills, evals still run, `onLimit` fires once per isolate per pause. Batches mid-flight when it empties may overdraw by a slice each, repaid before more runs | done |
| — | Next for background work: a `background` breakdown in `usage()`, and pausing rather than retiring as an option for `backgroundMs` too | planned |
| — | `structuredClone` `transfer`, transferable streams, `MessageChannel`/`MessagePort`: Deno's 13_message_port.js over in-isolate ports in runtime/core.js (each message a task), and V8 serializer transfer in web/clone.rs (a transferred buffer's backing store moves to a new ArrayBuffer). Fixed WPT bugs `message-channel` and `structured-clone-edge` | done |
| — | Error a `DecompressionStream`'s readable right after the output on trailing data (`op_compression_check`, patches/deno-compression-errors.patch). Fixed WPT bug `decompression-trailing` | done |
| — | Streams backed by native resources (Deno's `op_readable_stream_resource_*`, `internals.readableStreamForRid`): not needed; fetch bodies are byte streams pulled from the broker in JS | dropped |

Timer semantics (phase 2): timers live in the isolate's thread. Scheduling
uses the real monotonic clock; firing a timer is an I/O event, so a frozen
guest clock moves forward before each callback. Each callback is its own
task (a microtask checkpoint runs between callbacks). HTML's nesting clamp
applies (4 ms past nesting level 5); at most 10,000 live timers per isolate
(RangeError past that). A pending eval waits for ref'd timers within
`timeoutMs` (an unobserved `AbortSignal.timeout` doesn't keep it alive). A
one-shot `run()` sends its eval as the isolate's last, so timers left
pending never fire; a stateful isolate keeps its timers between evals and
runs them when due, each batch under the same time/CPU budget as an eval.
Timers don't fire while a sync host call waits.

WPT at phase 2 (same commit, dev build): 16,171 / 16,635 subtests (97.2%),
up from 87.3% on the same directories before phase 2: streams 2.3% →
98.2%, compression 0.9% → 90.0%, FileAPI/blob 0% → 98.2%, FileAPI/file 0% →
56.6%, FileAPI/reading-data-section 0% → 100%, html/webappapis/timers 22% →
100%, encoding/streams 0% → 100%, dom/abort 88.6% → 100%,
html/webappapis/structured-clone n/a → 71.5%, FileAPI/url n/a → 8.3%. No
worker crashes in either run (the runner now fails on any). Remaining
failures, by cause:

- Phase 3: `Response`/`Request`/`FormData`/`fetch` (the structured-clone
  Blob battery reads Blobs via `Response`; FileAPI/file's FormData uploads;
  FileAPI/url's fetch/XHR of blob URLs; compression tests reading through
  `Response`). Done since; see phase 3 below.
- By design: no SharedArrayBuffer and no WebAssembly unless allowed
  (streams' non-transferable-buffer and compression bad-chunk variants).
- Not supported: transfer lists (structuredClone `transfer`, transferable
  streams, `MessageChannel`), tentative "owning" streams.

WPT at phase 3 (same commit, dev build): 16,849 / 17,571 subtests (95.9%;
the total now includes the new fetch directories), no worker crashes. WPT
files are now served over HTTP from a local static server and loaded with
the platform's own `fetch()`. New directories (none of these classes
existed before): fetch/api/body 100%, xhr/formdata 100%, fetch/api/response
94.3%, fetch/api/headers 51.5%, fetch/api/request 37.1%. Phase 3 also moved
earlier directories: url 91.7% → 94.9%, html/webappapis/structured-clone
71.5% → 86.9%, FileAPI/url 8.3% → 50.0%, compression 90.0% → 92.8%.
Remaining fetch failures, by cause:

- No base URL (`new Request('')`, relative URLs): ~140 request subtests.
- WPT's Python handlers (.py) don't run in the soak: ~100 request, header,
  and response subtests (a 404 instead of the handler's response).
- Browser-only rules: forbidden headers and method overrides
  (`headers-forbidden-override`, 72), `Set-Cookie` filtering, the HTTP cache
  (`only-if-cached`).
- Node's HTTP client refusing control bytes in header values (26).
- In the vendored classes (as in Deno): BYOB readers on bodies made from
  strings and other non-stream sources, an `Object.prototype.then`
  injection test, credentials in a `Request` URL, an empty `FormData`'s
  multipart length.
- `DecompressionStream`: trailing data after the end of a gzip/zlib/brotli
  stream keeps the decoded output and errors at the next write or at close;
  browsers error the readable right away, which needs the stream's
  controller inside the op (Deno instead throws at once and loses the
  output).
- Small spec gaps in vendored streams code (Deno's too): synchronous write
  algorithm in one piping case, patched-global byobRequest, transformer
  cancel error.
- `URL.createObjectURL` returns `blob:null/<uuid>` (no origin).

WPT at phase 1 (pinned commit c47791d, dev build): 14,099 / 14,493 subtests
(97.3%). url 91.7%, encoding 98.3%, dom/events 92.7%, dom/abort 88.6%,
atob 100%, microtask-queuing 100%, hr-time 94.7%, getRandomValues 100%,
randomUUID 100%. Remaining failures, by cause:

- Out of phase 1: streams (TextDecoderStream, ReadableStream), Request/
  Response/XMLHttpRequest, Blob (the structured-clone battery), timers
  (AbortSignal.timeout).
- By design: no SharedArrayBuffer in guests (encodeInto/streaming-decode SAB
  variants).
- The `url` crate lags the newest URL spec edge cases (file URL hosts,
  opaque-path trailing spaces, `xn--` labels): track url crate releases.
- The global object isn't a `WorkerGlobalScope` (idlharness "unexpected
  global object"); decide which global interface to model.
- `Event.timeStamp` is always 0 (Deno's behaviour too); `structuredClone`'s
  `transfer` option isn't supported yet (since done).

### WPT gate

`test/wpt/run.mjs` runs the pinned WPT subset (commit c47791d: the old
soak runner's directories plus fetch/api/basic, fetch/api/abort,
fetch/api/redirect, and fetch/data-urls; 349 files) served by WPT's own
server, wptserve (Python 3, localhost, HTTP only), so `.py` handlers and `.sub.js` substitutions work.
Each test gets a fresh isolate with `web: { baseUrl }` set to the test's
URL and a `fetch` policy for localhost (`privateNetworks: true`). Every
subtest that doesn't pass is listed in `test/wpt/expectations.json` with a
reason in one of five categories (by-design, draft, browser-only, environment,
bug); the run fails on an unexpected failure or pass, a changed harness
status, a worker crash, a stale entry, or an unclassified one. It runs in
CI after the end-to-end tests (sandboxed worker, strict mode) and in the
weekly soak. `--static` (plain files, no Python) stays for quick local runs
and doesn't gate.

At the gate's introduction (dev build): 17,622 / 18,432 subtests pass
(95.6%), **98.7% of the 17,848 that apply** (all but by-design and
browser-only). Expected failures: by-design 101, browser-only 483,
environment 49, bug 177. Under wptserve, the fixes below took the run from
17,284 to 17,622 passing subtests:

- An empty binary attachment (an empty request body) crashed the worker:
  the frame went out as text with a `bin` field, a protocol violation.
- A fetch body read ahead nothing, so a network error mid-body never
  settled `reader.closed`; bodies now read ahead 64 KiB.
- An aborted body read threw a TypeError instead of the abort reason (the
  vendored code checks `core.BadResourcePrototype`, which was missing).
- `data:` URLs refused non-GET methods, kept the fragment, and returned a
  body for HEAD; `blob:` URLs didn't ignore the fragment, sent an invalid
  MIME type as `Content-Type`, and had no origin (`blob:null/...`; now the
  base URL's).
- The broker upper-cased custom methods and lower-cased header names (the
  guest's spelling is now sent), sent no `User-Agent`, mangled non-ASCII
  `Location` bytes, and let a NUL in a response header through (now a
  network error, as in Fetch).

After the Deno-gaps pass (compared against Deno's own WPT expectations at
the commit we vendor, which is Deno's main; nothing newer to take): 17,829 /
18,590 subtests (95.9%), **99.0% of the 18,003 that apply**; bug 177 → 125,
of which 112 are `url-crate`. Deno's own patches to its vendored files are
in `patches/deno-*.patch`, applied by `scripts/vendor-deno.sh`.

| Phase | Item | Status |
|---|---|---|
| — | WPT expectations file (every allowed failure listed with a reason: by-design / browser-only / environment / bug) and per-subtest gating in CI and the soak; `--update` rewrites it from a run, keeping reasons | done |
| — | Run WPT's own server (wptserve) for the gate so tests that need its Python handlers run | done |
| — | Optional `web: { baseUrl }` (like Deno's `--location`) so relative Request/fetch URLs resolve and `location` exists | done |
| — | `data:` URLs processed natively with the `data-url` crate, as Deno's fetch does (its MIME serialization keeps `a=""`). Fixed WPT bug `mime-empty-quoted-param` | done |
| — | `URLPattern` regexp groups with the `v` flag (the standard's set operations, `[[a-z]--a]`): the `urlpattern` crate (0.4.2, as Deno uses) still generates regexps for the `u` flag, which the `v` flag rejects (`/` unescaped in classes). Fix upstream in rust-urlpattern, then switch the flag in 01_urlpattern.js. WPT bug `urlpattern-v-flag` (8 subtests) | planned |
| — | `URLPattern.compareComponent()` and `generate()` (tentative in WPT; Deno lacks them too) | idea (once standardized) |
| — | URL parser: the `url` crate lags the URL standard (WPT bug `url-crate`, 112 subtests). Evaluated ada (Node's parser, `ada-url` 4.0.0): on WPT's own data it gets urltestdata 896/896 (url crate 831) and setters 277/278 (255; the miss is an href case outside the setter harness). It builds cleanly against V8's own libc++ (compile `ada.cpp` with `-nostdinc++` and rusty_v8's `third_party/libc++` headers and `__config_site`, `-fno-exceptions -fno-rtti -DNDEBUG`: every C++ symbol it needs resolves inside librusty_v8.a, so no second C++ runtime); the crate's default build would instead link the system libc++/libstdc++ next to V8's static libc++abi, duplicating `__cxa_*`. Not adopted: it's 1.1 MB of C++ parsing guest-controlled strings outside the V8 sandbox, where the `url` crate is safe Rust, a change to what the worker's safety rests on. Options: adopt ada behind that decision (vendor ada.cpp, a worker build.rs, map its components to Deno's url-crate offsets; cross builds need a target sysroot), or fix the gaps in rust-url upstream | decide |
| — | Compression conformance: deflate and deflate-raw decoders drive flate2's inflater directly, so truncated input and input after the end are TypeErrors (flate2's write decoders accept both). The "output larger than input" failures were the WPT checkout missing the media file the test compresses. Fixed WPT bug `compression-format` | done |
| — | Encoding conformance: after a fatal streaming error, keep only the byte the decoder looked at (EUC-JP's JIS0212 case). encoding_rs's fatal API doesn't say whether it did; ask upstream for that, or add per-encoding rules. WPT bug `encoding-edge` (1; same op in Deno) | planned (upstream) |
| — | Event attributes: `Event.timeStamp` (always 0; under the frozen clock `performance.now()` is often 0 too, so the `> 0` checks couldn't pass reliably) and `isTrusted` as an own [LegacyUnforgeable] property (Deno chose a prototype accessor for speed). WPT bug `event-attrs` (3) | deferred |
| — | Fetch `integrity` (Subresource Integrity): sha256/384/512 via the `sha2` crate, strongest algorithm wins, base64 or base64url. Fixed WPT bug `sri` | done |
| — | Request attributes: `destination`, `isReloadNavigation`, `isHistoryNavigation`, `duplex` and its validation (a ReadableStream body needs `duplex: 'half'`), no keepalive or no-cors stream bodies, refusing credentials in the URL (patches/deno-request-attributes.patch). Fixed WPT bug `request-attrs` | done |
| — | Stream ReadableStream request bodies to the broker (`write(id, chunk)`, chunked, backpressure, `limits.requestBytes` counted as sent; a redirect that would resend a streamed body is a network error). Fixed WPT bug `request-streaming` | done |
| — | Body conformance (vendored classes): bodies from strings and bytes are byte streams (BYOB works; patches/deno-body-byte-streams.patch). Left: `Object.prototype.then` injection through promises resolved with body bytes (`then-injection`, 5, needs a rework of Deno's body/stream results), and an empty `FormData` as text (`empty-formdata`, 2: contradicts other WPT tests) | partly done |
| — | Streams conformance (vendored): pipeTo writes in a microtask, not inside enqueue() (patches/deno-pipe-to-async-write.patch); enqueue after a detached BYOB buffer came with transfer. Left (`streams-edge`, 2): byobRequest seen by a patched `then`, and a transformer.cancel() that errors during a pending close (the writable is still erroring when the cancel settles) | partly done |
| — | Structured clone: keep a resizable `ArrayBuffer`'s `maxByteLength`, refuse out-of-bounds views (the global is now 13_message_port.js's, straight to V8's serializer), non-transferable platform objects in a transfer list are DataCloneErrors. Fixed WPT bug `structured-clone-edge` | done |
| — | Blob from a detached buffer is empty (patches/deno-blob-detached-buffers.patch) | done |
| — | A port never closed keeps its queue until the isolate ends (no GC of ports): free entangled pairs when both MessagePort objects are collected | idea |
| — | test262 gate (`test/test262/run.mjs`, CI and the weekly soak): `built-ins`, `language`, `annexB`, `intl402` at the test262 commit V8's DEPS pins (so V8's test262.status applies), non-strict and strict, a fresh isolate per run with `eval: true`. At its introduction (dev build): 80,419 of 100,405 runs pass, **98.8% of the 81,363 that apply**; expected: by-design 17,380 (Temporal, modules, shared memory), draft 1,662 (stage-3 proposals), v8 455 (V8's own known failures, joint iteration behind a flag), environment 489, bug 0. isolane's own changes (removed globals, flags, frozen clock) broke nothing. The run found: `$262.detachArrayBuffer` on an already detached buffer must not throw (fixed in the harness), and development builds (no V8 sandbox) lose the worker on a multi-PiB `new ArrayBuffer` (dev-only skip; the sandbox refuses the length first) | done |
| — | test262, next: module tests run as programs since programs phase 5 (with their fixtures and the harness as a setup shim; all pass); `import()` from classic scripts stays skipped (`no-script-import`, 1,134 runs); Temporal's 13,378 once it's audited and on; `$262.createRealm` (375) and `$262.evalScript` (36) if isolane ever gets a host hook for a second context or a second Script; move `TEST262_COMMIT` with each V8 bump (the runner warns when V8's DEPS disagrees) | planned |
| — | List isolane on unjs/runtime-compat | idea |
| — | Node compatibility layer | later (see "Later milestone: npm and Node compatibility") |

## 4. API and ergonomics

| Item | Status |
|---|---|
| Rename: `LanePool` → `Runtime`, `LaneVm` → `Isolate`, `LaneError` → `IsolaneError`; `runtime.tenant(name)` → `Tenant` | done |
| `tenant()` handles, pool-wide `defaults`, merged options | done |
| `using` on runtime and isolates | done |
| Error taxonomy: one `IsolaneError` with `code`, `kind` (guest / limit / usage / infrastructure), `retryable`, `tenant`, and `guest` (name, message, stack); spec-shaped errors inside the guest (every fetch failure a `TypeError`; fs errors with Node-style `code`; host-function errors keep their class and `code`) | done |
| Codes: `ERR_ISOLATE_RETIRED`, `ERR_ISOLATE_DISPOSED`, `ERR_WORKER_UNRESPONSIVE`, `ERR_ISOLATION_UNAVAILABLE`, `ERR_INVALID_OPTION`, `ERR_RUNTIME_CLOSED` added. Policy denials and host-function failures surface inside the guest (as above), not as host-side codes | done |
| `onPolicyDenial` event (audit log of refused fetch/connect/fs calls per tenant) | done (API v2 hooks) |
| Resolve the worker binary automatically (per-platform optional package) instead of `ISOLANE_WORKER` | done (`ts/worker-binary.ts`) |
| Standard Schema (Zod, Valibot, ArkType, ...) for host functions (`hostFunction({ args, result, fn })`: guest arguments validated before `fn` runs, results validated before they reach the guest, parameter types inferred) and for eval results (`run`/`eval` `{ result }`, typed; `ERR_INVALID_RESULT`) | done |
| Standard Schema everywhere else a user defines a shape: deployment entrypoint inputs/outputs and `env`, `globals`, host-function errors, `sockets`/`fetch` message bodies where useful; generate guest-side `.d.ts` from host-function schemas (via JSON Schema) so guest code type-checks against its host API | planned |
| `isolate.call(name, args, { returns, signal })` for stateful isolates: a `call` protocol message (protocol 6) that invokes a global function with arguments as data, nothing compiled, budgeted as an eval; top-level bytes both ways; `ERR_HANDLER_NOT_FOUND` (kind `guest`: the guest didn't define it); `beforeCall`/`afterCall` hooks and the `call` event | done |
| `ERR_ISOLATE_RETIRED` is always `retryable` (on a new isolate), not only after a recycle | done |
| Tell the host when an isolate is retired by its own background work (`backgroundMs`, a heap limit between evals) as it happens, through an event or `isolate.retired`, instead of on its next eval. Undecided: worth it only if a host would act on it before its next call (a warm pool that wants to replace the instance early) | idea |
| An eval or call stopped part-way (`timeoutMs`, `cpuMs`, its signal) retires its isolate; the worker reports it in the result and the supervisor frees the isolate at once | done |
| An eval whose signal aborted while it waited for the worker to start is stopped (the abort was missed before) | done |
| Programs, phase 1 (`tenant.load(source, options)` → `Program`): a single ES module compiled, instantiated, and evaluated in the worker (protocol 7, a `load` message); `isolane:env` (a synthetic module exporting the program's `env`, with its `host` functions mounted in it instead of on the global); `import.meta.url` (`file:///<path>`); `import()` refused; setup under `limits.startupCpuMs` (default 1 s) and `timeoutMs`, with no I/O (`fetch`, `connect()`, `fs`, and host functions throw `ERR_SETUP_IO` while the module evaluates; a load that fails after one rejects with `ERR_SETUP_IO`, kind `guest`); `program.call` resolving a named export, then a method of the default export; a warm pool in the supervisor (`instances: { reuse, min, max, idleMs, queueMs }`, defaults true, 0, 4, 30 s, 10 s; one call per instance; retired instances replaced and waiting calls given to the replacement; a call an instance refused unrun retried once elsewhere); `program.usage()`, `program.close()` (drains; `ERR_PROGRAM_CLOSED`), `await using`; the `programLoad` event (`onProgramLoad`) and a `program` field on its instances' events; the serverless example on programs | done |
| Programs, phase 2: multi-file programs (`tenant.load({ main, files })`, files as strings or bytes, bytes attached to the `load` frame; protocol 8); imports resolved in the worker with `oxc_resolver` over the tree only (an in-memory file system; conditions `workerd`, `worker`, `browser`, `import`, `default`; `browser`/`module`/`main` fields; extensionless and TypeScript's `.js`-names-`.ts` specifiers); JSON (by extension or `with { type: 'json' }`), text, and bytes modules as synthetic modules; dynamic `import()` in programs (in a microtask, so it can't evaluate a module ahead of the graph's order); TypeScript type stripping with oxc that refuses non-erasable syntax with a SyntaxError at its line; import attributes other than `type` are SyntaxErrors; `limits.modules` (1,000 files) and `limits.moduleBytes` (32 MiB, at most a frame); `import.meta.url` for every module; a per-worker transform cache by content hash (64 MiB) | done |
| Programs, phase 3: `program.fetch(input, init)` (a guest `Request` built from a host one, the handler's `Response` back, both bodies buffered under the new `limits.bodyBytes`, default 16 MiB; runtime/serve.js in the guest; protocol 9: a `kind` and `maxBody` on `call`, the body attached to the result), `fetch(request, env, ctx)` with `ctx.waitUntil` (run as background work, rejections reported as unhandled, drained before an instance closes); the call hooks see it as `fetch` with the `Request` and the `Response`; `instances.concurrency` (calls run together in an instance, `crates/worker/src/vm/calls.rs`: per-call wall clocks, the instance's shared `cpuMs`/`hostCalls`/`logBytes`, and a stop failing the other calls with a non-retryable `ERR_ISOLATE_RETIRED`); `instances.queue` (default 1,000) bounding queued calls; an abort wakes a waiting VM at once; the serverless example on `export default { fetch }` with `program.fetch`, eight requests per instance, and `ctx.waitUntil` | done |
| Streamed `program.fetch` bodies, both ways (a stream id in place of the bytes, over the fetch broker's byte-queue machinery in reverse) | planned |
| `ctx.props` for `program.fetch` (per-caller configuration, as Workers' service bindings pass it) | idea |
| Programs, phase 4: the code cache by content hash per worker, compiled wasm kept per worker, programs' files sent once per worker (protocol 10), spare isolates (`spareIsolates`). A supervisor-held copy of the caches (`cacheBytes`) was decided against: a crafted cache from a compromised worker would be deserialized outside the V8 sandbox by the next worker, so a compromise would outlive the recycle and quarantine, for one saved compile per program per worker lifetime (docs/deployments.md, "Caches and invalidation") | done |
| The worker's caches as runtime options: `caches: { fileBytes, codeBytes, wasmBytes }` (defaults 64, 64, and 32 MiB; 0 to 1 GiB; 0 keeps nothing), the code and wasm budgets passed to the worker as `--code-cache-bytes` and `--wasm-cache-bytes` (no protocol change). Runtime-wide, not per tenant: what a worker keeps counts against its `workerMemoryBytes`, which is the per-tenant control. The transform cache stays a fixed 64 MiB | done |
| With `instances.concurrency` above 1, a call stuck in a synchronous loop holds up the instance's other calls, which reach their own `timeoutMs` while waiting, so one stuck call can fail every call in the instance: decided to be defined behaviour, documented (the guide, `docs/deployments.md`, the option's doc comment) and tested; handlers that may compute for long use `concurrency` 1 | done |
| Programs, phase 5: JSX (automatic, from the program's own `jsx-runtime`, or classic with a factory) and TypeScript transform mode (`ts: { mode: 'transform' }`: enums, namespaces, parameter properties, and legacy decorators with `experimentalDecorators`, their helpers built into the worker as `isolane:runtime/helpers/*`); `define`; source maps for transformed modules and for supplied bundles (`//# sourceMappingURL=` as a `data:` URL or a path, or a `.map` beside the file), applied to stacks and syntax-error locations in the worker before they're reported; the `modules` option (aliases to files or other specifiers, and host modules: objects of host functions imported as `isolane:<name>` or any specifier); `cloudflare:sockets` (the Sockets API's `connect`, captured when the context is made); a bundling recipe (esbuild, Rolldown) in the guide; test262's module tests, run as programs with their fixtures (all pass; `import()` from classic scripts, 1,134 runs, is skipped as `no-script-import`) | done |
| Programs, modules next: `tsconfig.json` `compilerOptions.paths` and `baseUrl` in the worker's resolver (the nearest tsconfig above the importing file, none in `node_modules`, `extends` and references; the `tsconfig` load option names one file or, `false`, none; protocol 11); `import.meta` as Node.js has it (`url`, `filename`, `dirname`, `main`, `resolve()`), and `file:` URLs of the program's files as import specifiers; `isolane:files`, the program's own files read-only with `node:fs`'s names and shapes (`readFileSync`, `existsSync`, `readdirSync`, `statSync`, `promises.*`; paths or `file:` URLs; Node's error codes), readable during setup because the files are the worker's memory and reading them is not I/O, and aliasable as `node:fs`; the guest's own `error.stack` source-mapped as V8 makes it (a `PrepareStackTraceCallback`, as Deno's), with `Error.prepareStackTrace` still honoured (given unmapped call sites, as V8 gives them; one that throws falls back to the default form, since the callback can't propagate an exception), and the reported stack no longer mapped twice | done |
| Programs, modules later: CommonJS packages (a `require` shim, or bundling only); `.wasm` modules (`import` of a WebAssembly module, with `wasm: true`); composing a bundle's map with the transform's map structurally rather than at lookup; mapped call sites for a custom `Error.prepareStackTrace` (Deno wraps them); `node:fs` itself, over `isolane:files` for the program's files and the `fs` broker for the host's (with the Node compat layer); tsconfig `compilerOptions` other than `paths`/`baseUrl` (`experimentalDecorators`, `jsx`) feeding the transform | idea |
| A program whose loads keep failing could be marked unhealthy, so calls fail fast until it's loaded again (section 5 of `docs/deployments.md` proposed it; phase 1 retries the load for each call that needs a new instance, which suits setup that, with no I/O, rarely fails once it has succeeded) | idea |
| (Superseded by programs, `tenant.load()`, above.) **Deployments with user-defined entrypoints** (Workers-style, customizable): `tenant.deploy(code, { entrypoints: ['fetch', 'scheduled', 'onMessage', ...] })` evaluates the module once (its "cold start": top-level code, user-defined init), then `deployment.invoke(name, ...args)` calls an exported handler in a warm isolate. Host-defined handler names and argument shapes (`fetch(request, env, ctx)` is just one preset); warm-isolate pool per deployment with `minWarm`/`maxIsolates`/`idleMs`; `isolation: 'per-invoke' \| 'reuse'` (reuse keeps module state between invocations, like Workers); cold-start hooks (`onColdStart`); V8 code cache per deployment so re-creating an isolate skips parsing | planned |

### Web conformance pass (done, except the URL parser decision)

Decided (October 2026): close the known WPT gaps before expanding features, using Deno wherever it has the better implementation. First compare against Deno's own WPT expectations, then: `data:` URLs via the `data-url` crate; Deno's MessageChannel (and structuredClone transfer); Deno's compression semantics; newer Deno fixes or our own for the vendored-code edge cases (structured clone, body, Request attributes, streams, events, SRI); evaluate `ada-url` for URL parsing; stream request bodies through the broker; confirm the encoding edge case is upstream.

Result: see "After the Deno-gaps pass" under the WPT gate below (99.0% of applicable subtests; bugs 177 → 125, 112 of them the URL parser, where adopting ada is a decision to make).

### Errors and stack traces

Checked on the dev build (October 2026), before this work: a guest throw gave a correct stack but with `<anonymous>` as the file; a SyntaxError had no location at all; a host function that threw gave the guest an Error whose stack had **no guest frames** (it was created when the reply arrived, not at the call site); `cause` chains were dropped; unhandled rejections were silently ignored.

| Item | Status |
|---|---|
| Name every script (`ScriptOrigin`): a `filename` option per `run`/`eval` (default `<tenant>/eval-<n>.js`, n counting the isolate's evals), so frames read `at handler (src/index.js:12:5)`; the prelude and wasm guard are `isolane:prelude.js` and `isolane:wasm-guard.js`; `beforeEval`/`afterEval` see the filename | done |
| Module paths as filenames for multi-file deployments | planned (with deployments) |
| SyntaxError (and every compile error of the eval's code) location: line, column, and the source line (a window around the column for long lines) in `err.guest.location`, and Node's format in `err.guest.stack` (`file:line`, the line, a caret, the error) | done |
| Host-call attribution: an Error made at the call site (V8 captures the frames, formats them only on failure), so a failing host call's error reads `at db.getUser (<host>)` then the guest frames, for async and sync calls; the class, message, and `code` cross, never the host's stack (hooks get the host error) | done |
| Structured errors end to end: `cause` chains (8 deep), `AggregateError.errors` (16), own enumerable JSON `properties` (16, 4 KiB each), parsed `frames` (`{ function, file, line, column, async? }`) next to the stack; every text bounded (64 KiB, 8 KiB nested, 32 errors in all); read under TryCatch, so hostile getters and Proxy traps are skipped | done |
| Hide isolane's own runtime frames (`ext:`/`isolane:`) from `err.guest.stack`, `frames`, and `Uncaught` log lines; the guest's own `error.stack` keeps them (as Deno's does), and `Error.prepareStackTrace`/`captureStackTrace` are untouched | done |
| An option to keep isolane's frames in `err.guest` (a raw stack), if debugging the runtime from the host side ever needs it | idea |
| Errors from timers and tasks, and unhandled rejections (V8's promise-reject callback, reported once a task's microtasks have run, unless handled by then or by an `unhandledrejection` listener's `preventDefault()`): the guest's console (`Uncaught …`) and a structured `onGuestError` event (`runtime.on('guestError')`), within `limits.logBytes`; they don't fail the eval | done |
| `onerror` / `onunhandledrejection` handler attributes on the global object (Deno's `defineEventHandler`, non-enumerable like the other globals; `onerror` is HTML's special error handler, and returning true handles the error) | done |
| `ErrorEvent`'s `filename`, `lineno`, and `colno` for errors nothing handled are empty: `core.destructureError` (runtime/core.js) returns no frames | planned |
| Source-map support for transformed TypeScript/JSX and bundles: map frames back to original files before reporting (in the worker) | planned (with TS transform / bundling) |

### Bundles, npm, and shims

isolane is a library that platforms embed; deploy tooling (a CLI, a
dashboard) belongs to whoever builds on it, like `examples/serverless`. What
isolane provides is the library half: `deploy()` accepting a bundle or a
file tree.

| Item | Status |
|---|---|
| `deploy()` accepts a prebuilt bundle (single module + optional source map) as well as a file tree; documented recipe for bundling with Rolldown/esbuild using worker export conditions (`workerd`, `worker`, `browser`, `import`, `default`) | planned |
| Customizable shims: `modules: { 'node:fs': './my-fs.js', pg: './pg-shim.js' }` (aliases and overrides), host-provided virtual modules (`import { kv } from 'isolane:kv'` backed by host functions), and `define` for compile-time constants | planned |
| A CLI (`isolane deploy` / `isolane dev`, Wrangler-style) | dropped: not isolane's job as an embeddable library; platforms build their own |

### Later milestone: npm and Node compatibility

Deliberately late, so it can be done properly once the core is settled.

| Item | Status |
|---|---|
| npm packages: deployers install on their own machine (trusted; lifecycle scripts never run on the platform) and ship the result; or the platform fetches tarballs from the registry by lockfile, with no install scripts, ever | later |
| Node compatibility (`node:buffer`, `events`, `util`, `stream`, `crypto`, `path`, `url`, `assert`, `string_decoder`, `process`): unenv presets (the layer behind Wrangler's `nodejs_compat` and Nitro) and/or workerd's `src/node` (Apache-2.0), with `node:net`/`node:tls` on our `connect` broker and `node:fs` on our `fs` broker; native addons, `child_process`, and real threads stay unsupported, by design | later |
| Compatibility target: "anything that runs on Cloudflare Workers with nodejs_compat"; publish a tested-packages list | later |

### Elegance pass, October 2026 (done)

From the API-surface review (approved by the owner):

- **Renames:**
  - `limits.concurrentEvals` → `limits.pendingEvals`;
  - `limits.hostCallBytes` → `limits.pendingHostCallBytes`;
  - `fs.limits.operations` → `fs.limits.pendingOperations`;
  - `WorkerEvent.event` → `WorkerEvent.kind`;
  - export an `IsolationReport` type;
  - the worker's `--memory-limit=` flag → `--memory-bytes=`.

  Nothing is released, so there are no deprecation shims.
- **`ERR_DENIED`** is kind `usage`, not `security`.
- **New:** `run`/`eval(code, { signal })` cancels an eval, rejecting with `ERR_ABORTED` and aborting its host calls' `ctx.signal`.
- **Policy limits** (`fetch.limits.requests`, `connect.limits.connections`, the fs limits) also emit `onLimit` with the dotted name; `onPolicyDenial` stays for refused targets.
- **Also from the review:**
  - carry worker exit reasons instead of matching message text (a dev worker reported `ERR_WORKER_CRASHED`);
  - fix the doc mismatches (ERR_LIMIT's list, `Tenant.stop` vs `close`, `FetchPolicy.hosts` JSDoc);
  - lower the `pendingHostCallBytes` default and/or add a total per tenant;
  - one table of the error codes the guest sees.

Applied, with the implementation review's items:

| Item | Status |
|---|---|
| The renames, `ERR_DENIED` as `usage`, `signal`/`ERR_ABORTED` (a new `abort` message; protocol 4), `onLimit` for policy limits, exit reasons carried on the worker's ready failure | done |
| `pendingHostCallBytes` default 16 MiB | done |
| A total of `pendingHostCallBytes` per tenant (100 isolates can still hold 1.6 GiB of call arguments in the supervisor) | planned |
| The guide: guest-visible error codes, the three effects of a limit, the shared pointer-compression cage, dev-build memory figures, `using`; `engines` is Node.js 22 or later, as CI tests | done |
| Worker: one module for text capping and JS exceptions (`js.rs`, which never panics on guest-sized text), one for guest bytes (`bytes.rs`; host calls use the checked path), one watchdog guard for every run in the VM loop | done |
| Supervisor: the brokers in `ts/brokers/`, one host-pattern matcher, policy defaults in `DEFAULT_POLICY_LIMITS`, typed `WorkerCommand`s, `IsolateState.limits`, `admitLog` (which also counts `usage().logBytes` in bytes, not UTF-16 units) | done |
| Deno's WebCrypto JS owned as `runtime/crypto.js` (it has no upstream any more), replacing five patches | done |
| A test that checks the guide's limits table against `DEFAULT_LIMITS` | done |
| A shared gate module for the WPT and test262 runners (`test/gate.mjs`); one HTTP test server (`test/http-server.mjs`); fetch broker unit tests that call the broker directly, without the fake web `fetch` | done |
| `create` deserialized straight into `VmConfig`, named exit codes (`Exit`), `serve` split into startup and a message loop (main.rs) | done |
| One `ByteQueue` for the fetch and connect brokers (`ts/brokers/byte-queue.ts`); framing out of `worker.ts` (`ts/frame.ts`); the guest `fs` wrapper in `runtime/fs.js`, handed the broker like `fetch` and `connect()` (protocol 5) | done |

### API v2 (from `docs/api-review.md`)

Landed in October 2026; the review's "Status" section lists the
differences.

| Item | Status |
|---|---|
| One layered config (`defaults` → `tenants(name)` → call), grouped by meaning, no shorthands; `ERR_INVALID_CONFIG` names the field (and the new name for an old one) | done |
| Uniform naming (units as suffixes, capabilities named for guest APIs, one word per idea; full rename table in the review) | done |
| Host functions: one definition form (`hostFunction({ args, returns, handler, sync })`), namespaces (frozen in the guest), a call context (`tenant`, `isolate`, `signal`, `log`) | done |
| One hook system: `before*`/`after*` interceptors and `on*` events at every level, plus `runtime.on()`; host calls, evals, logs, limits, policy denials, security events, worker lifecycle | done |
| `onWorker` `recycle` events | done |
| Hooks over the brokers (`fetch`/`connect`/`fs` as host calls under `beforeHostCall`), beyond `onPolicyDenial` | idea |
| `Tenant` handle owns tenant operations (`run`, `isolate()`, `usage`, `resetUsage`, `release`, `stop`); `close()` everywhere; internals behind `runtime.diagnostics` | done |
| One `ERR_LIMIT` code with `err.limit` for every limit | done |
| Split `index.ts` (config, host, hooks, worker pool, runtime) and `vm.rs` (watchdog, mailbox, host calls, console, context, eval); one per-isolate state record; one config-resolution pipeline | done |
| Protocol: version field checked at `ready`; `create` grouped like the public config; host calls name functions by index | done |
| `web: { baseUrl }`: relative URLs in `fetch` and `new Request` resolve against it, and a read-only `location` exists (Deno's `getLocationHref`). WPT runs with each test's URL as the base (96.4%, from 95.9%) | done |
| `shims`: the embedder's JS in the isolate, `setup` once and `before`/`after` each eval, each its own script (exact guest line numbers), compiled by isolane (works with `eval` off), layered like the config, `ERR_SHIM` for their failures; the serverless example invokes `handle()` with one | done |
| Delete the minimal fetch/base64/UTF-8 prelude once the web platform is always on | done: `web` defaults to on, and `fetch`, `connect`, and `fs` need it (`ERR_INVALID_CONFIG` with `web: false`); the prelude only hands the raw broker functions to the web platform and builds `fs` on its `TextEncoder`/`TextDecoder` |
| Split the end-to-end tests by area | done |
| Found while writing the docs site (October 2026): a `globals` name that is a built-in web global (`URL`) is refused only when the isolate starts, as `ERR_ISOLATE_RETIRED` ("vm setup failed"); check it when the config resolves and fail with `ERR_INVALID_CONFIG` | planned |
| Found while writing the docs site: `console.log(new Error(...))` reaches `onLog` as `{}`, since objects are written as JSON; format errors as their stack, as Node and browsers do | planned |
| Found while writing the docs site: a `hostFunction` without `args` gets its context only as `this`, not as a last parameter; decide whether every handler gets `ctx` the same way | idea |
| Found while writing the docs site: `ERR_WORKER_CRASHED` is `retryable`, but with the default `quarantineMs` an immediate retry fails with `ERR_TENANT_QUARANTINED`; either give the error a retry delay or document a backoff in the error itself | idea |
| Found while writing the docs site: `usage().hostCalls` counts isolane's own `fetch`, `connect`, and `fs` calls, which the `hostCalls` limit does not; make the two count the same calls | idea |
| Found while writing the docs site: a `beforeEval` interceptor that throws fails the eval with the thrown value, not an `IsolaneError`; wrap it as `beforeHostCall` failures are | idea |
| Found while writing the docs site: the `TenantUsage.cpuMs` doc comment doesn't say it is Linux only (it reads 0 on macOS) | planned |

## 5. Performance

Measured against isolated-vm (Linux x64 under Rosetta; superseded by the CI comparison below, `bench/compare.mjs`):

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
| Binary frames: bytes cross as raw attachments after a frame's JSON (a 0x00 tag, the JSON's length, the JSON, the bytes). Guest → host: top-level byte arguments of a host call (`bin: [[arg index, length]]`, null placeholders, no in-band markers a guest could forge); host → guest: byte values anywhere in a host function's result (`bin: [[path, length]]`), arriving as Uint8Arrays. The supervisor's parser rejects any attachment that doesn't add up (fuzzed). fs/fetch/socket brokers and the prelude use bytes, no base64. 1 MiB Uint8Array through a host call 149.5 → 1.38 ms; 1 MiB `fs.readFile` 2.61 → 1.33 ms | done |
| Byte values nested inside host-call arguments (not top-level) still cross as JSON objects | planned |
| Oversized guest output fails the guest, not the worker: host-call arguments past 64 MiB throw a RangeError, results past it fail the eval (`ERR_NOT_SERIALIZABLE`), error messages and stacks are clipped to 64 KiB (each used to be a protocol violation, a security event, and a quarantine) | done |
| V8 ValueSerializer as the wire format: **deferred**. Our V8 writes format v16; Node 22 and 26 read only up to v15. And the supervisor would parse a compromised worker's output with V8's deserializer, which Chrome never exposes across a trust boundary (browser IPC uses Mojo); JSON.parse is a much smaller parser to trust. Revisit for the supervisor → worker direction only (trusted sender), where it would carry Map/Set/Date/BigInt/typed arrays into the guest | idea |
| Lower per-call latency: coalesce frame writes per event-loop turn on the supervisor; spin briefly before blocking in the worker | planned |
| Frame batching (fewer syscalls), fewer copies | planned |
| Prewarmed worker pool (`prewarm: n`; spares never run guest code before a tenant claims one): new-tenant p50 36 → 4.9 ms (`bench/cold-start.mjs`, native macOS dev build) | done |
| Startup snapshot of the web platform (see WinterTC above for the numbers) | done |
| Comparison benchmark in CI (`bench/compare.mjs`, `.github/workflows/bench.yml`, after every green CI run on main): isolane (web on, web off, one tenant per sandbox) against isolated-vm, `node:vm` contexts, and `worker_threads` on the release worker, with memory for 1–1,000 live sandboxes (RSS and PSS over the process tree), cold start, call and host-call latency. Numbers quoted in the README come from its job summary | done |
| Benchmarks tracked over time (store each run's `bench-report.json`, chart it, flag regressions) | planned |
| Shared-memory transport | idea (needs a native addon; conflicts with plain `npm install`) |

## 6. Operations

| Item | Status |
|---|---|
| Stress soak: VM floods, tenant floods, crash churn, VM/eval leaks, noisy neighbours, memory bombs | done (weekly; first results pending) |
| Unified, configurable limits (`limits` on the runtime, `tenantLimits(tenant)`, and per isolate): timeoutMs (now 30 s by default), cpuTimeMs, heapBytes (now 128 MiB by default), timers, logBytesPerEval, logMessageBytes, codeBytes, resultBytes, decompressedBytes, isolates (100), concurrentEvals, workerMemoryBytes, tenants (LRU eviction of idle tenants); `ERR_RESOURCE_LIMIT` with `err.limit`. Prompted by the first soak, where one tenant's worker crashed between 300 and 400 live isolates | done |
| More limits: pending host calls per isolate, host calls per eval, host-call payload bytes (after binary frames land), sockets/fetch totals per tenant. (Done since: the host-call limits, and worker lifetime and evals as `workerLifetimeMs` / `workerEvals`.) | planned |
| One watchdog thread per worker instead of per isolate (halves thread count: each isolate is 2 threads today) | planned |
| First soak results (Linux x64, 2-core runner): no leaks (3,000 isolate create/dispose cycles 19→21 MB; 20,000 evals in one isolate 20→24 MB, flat); crash churn leaks no fds or zombies; noisy neighbour raises another tenant's p99 from 0.9 to 4.5 ms (same worker: 6 ms); 20 isolates hitting a 64 MB heap limit at once all get ERR_MEMORY_LIMIT and the worker keeps serving; 150 tenants at once: all succeed, 16 MB RSS each, cold start p50 721 ms under that contention | done |
| Worker recycling: `limits.workerLifetimeMs` (default 1 hour) and `limits.workerEvals` (default 100,000), tenant limits. A recycled worker takes no new isolates (the next run starts a fresh worker), finishes what it runs, and exits once idle; stateful isolates still open on it get a minute (or `workerLifetimeMs`, if shorter), then are retired (`ERR_ISOLATE_RETIRED`, `retryable`). At most one drains per tenant | done |
| A `--jitless` worker for tenants on probation after a quarantine: it needs its own web snapshot (the embedded one is checked against V8's flags) and can't run WebAssembly, so `wasm: true` would need a clear refusal there | planned |
| Metrics: per-tenant totals via `runtime.usage()` | done |
| Metrics hooks: per-eval callback / OpenTelemetry export | planned |
| Kubernetes: run the Linux tests in a kind cluster in CI, in a pod under the `restricted` Pod Security Standard with `seccompProfile: RuntimeDefault`, so that strict mode (seccomp inside the container's filter, Landlock) is known to hold there; then a "Run on Kubernetes" guide (securityContext, memory requests sized from `workerMemoryBytes` × tenants, `isolationReport()` as a startup probe) | planned |
| A Kubernetes operator (CRDs for tenants and programs, scaling hosts on per-tenant load, rolling program versions). Deferred: isolane is a library with no server for an operator to manage, and the security gate, npm release, and container testing come first. Revisit if an `isolane serve` host is built | idea |

## 7. Packaging and platforms (P4)

| Item | Status |
|---|---|
| Linux x64 build in CI (from source, sandbox on), incremental rebuilds via source manifest | done |
| Linux arm64: cross-compiled on x64 (Chromium's clang and Rust toolchains exist for x64 Linux hosts only), linked with clang and lld against the Debian bullseye arm64 sysroot (glibc 2.31). The web snapshot is made by running the first build on a native `ubuntu-24.04-arm` runner and embedded by a second, relink-only x64 build (the first pass segfaulted under qemu-user). Every gate runs natively on arm64: self-check, lockdown and escape probes, end-to-end tests in strict mode, WPT, test262, and the syscall audit. A clean cross build of V8 takes about 95 minutes on 4 cores; with the cache, the arm64 chain takes about 8 minutes before its tests. Shipped by `release.yml` as `@isolane/worker-linux-arm64-gnu`. seccomp allows `uname` for V8's arm64 builtin remap (an accepted risk in `docs/design.md`) | done |
| macOS arm64/x64 (needs full Xcode; macOS CI runners) | planned |
| **npm layout** (the esbuild/SWC/Biome/Rolldown pattern, not Prisma's postinstall download, which breaks offline, in locked-down installs, and with `--ignore-scripts`): `isolane` (the JS library) lists one `optionalDependencies` package per platform, each with `os`/`cpu`/`libc` fields so npm installs only the matching one: `@isolane/worker-linux-x64-gnu`, `@isolane/worker-linux-arm64-gnu`, `@isolane/worker-darwin-arm64`, `@isolane/worker-darwin-x64` (macOS: development only — no lockdown, strict mode refuses it). Later, maybe: `linux-*-musl` (Alpine; rusty_v8 doesn't support musl, so a real porting job). No Windows (no lockdown story). The library resolves its platform package, with `ISOLANE_WORKER` as an override | done (linux-x64-gnu; other platforms with their build jobs) |
| Sizes (Linux x64, October 2026): 71 MB unstripped, **53 MB stripped, ~18.7 MB gzipped per platform package** (cf. Biome 66 MB, esbuild/SWC ~11 MB unpacked); a little smaller with `symbol_level=0` | done (measured) |
| Publishing from CI only, with npm trusted publishing (OIDC, no long-lived token) and provenance attestations; all packages versioned in lockstep; every V8 patch bump is a patch release | done (`release.yml`; awaits the first release) |
| npm org `isolane` created; unscoped `isolane` reserved with a 0.0.0 placeholder (October 2026) | done |
| First real release: the owner adds a short-lived npm token as a repo secret for the first publish of each `@isolane/worker-*` package and the real `isolane`, then configures each package's trusted publisher (repo `ethndotsh/isolane`, workflow `release.yml`) and deletes the token; every release after is tokenless | to do (owner, at first release) |
| Stripped binaries; the staleness warning reads the worker's V8 version against the newest patch release | planned |
| Staleness warning when the installed worker's V8 is behind the patch pipeline | planned |
| Strict mode option to refuse a stale worker | planned |
| Dev build against prebuilt V8 (`--features dev-prebuilt`, `ISOLANE_DEV_INSECURE=1`) for local iteration | done |
| Build speed, round 1: `fast` Cargo profile for local work (an edit rebuilds in 1.3 s vs 12.3 s with fat-LTO `release`); `release` gets `panic = "abort"` and stripped debug info; CI links with lld, caches the Cargo registry, sets `CARGO_INCREMENTAL=0`, frees disk in the background; V8 built with `symbol_level=0` (GN args in `scripts/v8.gn`, part of the cache key) | done |
| Measured: a V8 patch bump (15.2.124.1 → .45) is close to a full rebuild on a 2-core runner — patch releases touch widely included headers, so most objects really are stale | done |
| V8 build speed: decided (October 2026) to accept the free 4-core public-repo runners. Code-only pushes take ~5 min (cached V8); V8 patch bumps (~30–40 min) run unattended from the daily workflow; compiler-flag changes are full rebuilds (~1 h). Revisit with a self-hosted 16+ core runner or an org's larger runners if bumps start blocking anyone | done |
| Rust style: Google's Rust style guide, as far as it suits a stable, Cargo-built project (`CONTRIBUTING.md`). `rustfmt.toml` sets `max_width = 100` (the guide's nightly-only rustfmt settings are left out), the workspace lints enforce `SAFETY:` comments, `expect` over `unwrap`, and no glob imports, and CI fails on any Clippy warning and on unformatted code | done |
| A prebuilt CI image (toolchain, libclang 21, strace) to drop the ~1 min of apt and setup per run | idea |
| Build noise: rusty_v8 152's `isolate.rs` uses `AtomicUsize::fetch_update`, deprecated in Rust 1.97 (renamed `try_update`); goes away with a newer rusty_v8, or pin the CI toolchain. rusty_v8's "Not using sccache or ccache" note is informational (we cache V8 with the source manifest instead) | noted |
| sccache for Rust dependencies once oxc and friends land (not for V8: patch bumps change shared headers, so per-object caching mostly misses) | planned |
| Nightly-only Rust build speedups (parallel frontend `-Zthreads`, Cranelift for dev builds) if we ever move off stable | idea |

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
| Serverless example: one warm isolate per deploy, each request an `isolate.call`; load failures reported to the deployer while the running version keeps serving | done |
| Serverless example, next: deployer auth; deploy persistence (`export default { fetch }` handlers on `program.fetch`, with requests in parallel, are done) | planned |

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
- **celld** (Deno's self-hosted Durable Objects runtime, studied at 90b4301,
  October 2026): explicitly not a hostile-multi-tenant sandbox (no V8
  sandbox, all tenants in one process, no OS lockdown, CPU limits only when
  configured, a JS-level clock shim). Worth adopting: a per-process V8 code
  cache (eager compile once, then `ConsumeCodeCache`) for user code in
  deployments; a per-tenant cache of compiled WebAssembly modules keyed by
  content hash. Already equivalent in isolane: ops passed as parameters
  rather than globals, thread-CPU-clock budgets, pumping V8's foreground
  tasks each turn, near-heap-limit headroom. Not to copy: shared processes
  or heaps across tenants, isolates migrating between threads, the JS clock
  shim, unvalidated op arguments.


## 10. Housekeeping

- clockwork (the QuickJS sibling project) has its upgrade to quickjs-ng
  6d46d07 / interface 3.6.2, version 0.4.0, uncommitted.
- Enable "Allow GitHub Actions to create and approve pull requests" for the
  V8 update workflow's PRs.
- README `using` examples need Node 24+ (or TypeScript's downlevel).
- The documentation site (`site/`, Blume) builds and checks its links in
  CI (`docs.yml`) but is not published. Where it is hosted (GitHub Pages
  under `/isolane`, or a domain) is undecided; publishing needs
  `deployment.site` (and `basePath` for Pages) in `site/blume.config.ts`.
- `docs/guide.md` and the site's reference pages now cover the same
  ground. Once the site is published, the guide should shrink to a pointer
  so that there is one copy to keep current.
