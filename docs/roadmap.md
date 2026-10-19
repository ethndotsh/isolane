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
| Host time zone leaks via `Date` (`getTimezoneOffset`): pin workers to UTC | done | the worker sets `TZ=UTC` before ICU reads it |
| Quarantine tenants after security events (`quarantineMs`, default 60 s; `releaseQuarantine`) | done | |
| Tenant trust levels (group or isolate by plan) | planned | |
| CPU-time budgets per eval (`cpuTimeLimitMs`, `ERR_CPU_LIMIT`; VM thread's CPU clock, Linux) | done | |
| Per-tenant usage (`runtime.usage(tenant)`: evals, failures, CPU ms, host calls, log bytes, peak memory, security events; `resetUsage`) | done | CPU on Linux only |
| rlimits: CORE=0 (no tenant data in core dumps), FSIZE=0 | done | NPROC is per user (would cap other workers' threads); seccomp already forbids process creation |
| Opportunistic cgroups v2 and namespaces | planned | |
| macOS: Seatbelt profile (sandbox_init) | planned | |
| `isolane doctor` (explain what this host provides and why) | planned | |
| External security review; written threat-model sign-off (P5 gate) | planned | the README says "not ready for untrusted code" until then |
| Known limits documented (README) | done | |

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
| 1 | primordials, webidl, URL/URLSearchParams (`url` crate), TextEncoder/Decoder (`encoding_rs`), atob/btoa, Event/EventTarget/CustomEvent/ErrorEvent, AbortController/AbortSignal, DOMException/QuotaExceededError, structuredClone (V8 ValueSerializer), performance (frozen-clock semantics), queueMicrotask, reportError, `self`, `navigator.userAgent`, `crypto.getRandomValues`/`randomUUID` — behind `webPlatform: true` | done (WPT 97.3%, below) |
| 2 | Timers + an event loop in the VM thread (`setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `AbortSignal.timeout`), Streams (ReadableStream incl. byte streams/BYOB, WritableStream, TransformStream, queuing strategies), Blob/File/FileReader, `URL.createObjectURL`, TextEncoderStream/TextDecoderStream, CompressionStream/DecompressionStream (gzip, deflate, deflate-raw via `flate2`'s pure-Rust backend; brotli via the pure-Rust `brotli` crate), structuredClone of Blob/File | done (WPT 97.2% over the phase 1 + 2 subset, below) |
| 3 | Spec `fetch`/`Request`/`Response`/`Headers`/`FormData`: Deno's 20–23 (vendored) plus our own `fetch()` (`runtime/fetch.js`, adapted from Deno's 26_fetch.js) over the network broker; response bodies stream (byte streams pulled from the broker), request bodies are buffered; redirect modes (follow/manual/error; the broker follows, re-checking each hop); abort cancels the broker's request; `data:` and `blob:` URLs; `fetch` without a network policy rejects with a TypeError | done (WPT below) |
| — | Streamed request bodies (upload a `ReadableStream` as it's produced; today it's read to the end first, within `maxRequestBytes`) | planned |
| — | A base URL option (Deno's `--location`): `new Request('/x')`, `Response.redirect('/x')` and relative `fetch` URLs throw today, as in a worker without one | idea |
| — | Header values Node's HTTP client refuses (control bytes 0x01–0x08, 0x0B–0x1F, 0x7F, which Fetch allows) fail the fetch; would need our own HTTP/1.1 client in the supervisor | idea |
| — | Browser-only Fetch rules are not applied (forbidden request/response headers like `Set-Cookie`, method overrides, `only-if-cached`): server runtimes (Deno, workerd) don't either | by design |
| — | WPT fetch tests needing WPT's Python handlers (`.py`): run WPT's server (wptserve) in the soak job to count them | planned |
| 4 | `crypto.subtle` (Deno's ext/crypto Rust, MIT) | planned |
| — | V8 startup snapshot of the runtime JS (avoid compiling ~15k lines per VM) | planned |
| — | ES modules for guest code (`export default { fetch }` handlers) | planned |
| — | **TypeScript guest code** (`lang: 'ts'`, `.ts` deployments): type stripping, not checking, done in the worker with `oxc` (pure Rust), so untrusted source is parsed only inside the locked-down worker. Erasable syntax only (like TypeScript's `erasableSyntaxOnly`: no enum/namespace/parameter properties, which get a clear error; a `transform` mode later). Types are blanked to whitespace, so line:column in guest stack traces match the TypeScript source with no source maps. Pairs with generated `.d.ts` for host APIs so developers can type-check against the exact host API at deploy time | planned (after API v2 and WPT) |
| — | **Multi-file programs**: deployments upload an in-memory file tree (`files: { path: source }`, `entry`); the worker resolves imports with `oxc_resolver` over a virtual filesystem (package.json exports/imports and conditions — `workerd`/`worker`/`browser`/`import`/`default` — tsconfig paths, extension probing), compiles each module with V8's native ES module API (resolve → strip/transform with oxc → compile → link), with dynamic `import()`, `import.meta.url` as the virtual path, and JSON modules. All parsing, resolving, and transforming of untrusted input stays in the locked-down worker, and resolution can't leave the uploaded tree. New limits: `modules`, `moduleBytes`. Packages work if uploaded; `node:*` only with the Node compat layer | planned |
| — | **JSX/TSX** via oxc's transformer: classic (`React.createElement` or a custom factory) and automatic (`jsxImportSource`, resolved in the uploaded tree), so SSR with Hono JSX, Preact render-to-string, or React's server renderer works; the serverless example becomes a `.tsx` app rendering HTML | planned |
| — | Optional deploy-time bundling with Rolldown (Rust, on oxc) for large dependency trees, plus V8 code cache per deployment | idea |
| — | TypeScript **transform mode** (`ts: { mode: 'transform' }`) via `oxc_transformer`: enums and const enums (inlined within a file), namespaces (partial: no cross-block merging, no exported `var`/`let`), legacy decorators + metadata, JSX/TSX; per-file (`isolatedModules`) semantics. Positions shift, so the worker maps guest stack traces back through the source map before reporting `err.guest.stack`. Strip mode stays the default. Verify parameter properties and standard decorators before documenting them | planned |
| — | **Type checking** at deploy time (`deploy(code, { check: true })`, cached by content hash), never per run: TypeScript's checker running *inside an isolane isolate* (tsc is plain JS; a large heap budget, nothing else enabled), so a checker bug or DoS on hostile input stays sandboxed. Checked against generated `.d.ts` for exactly the host functions (from their schemas) plus the WinterTC globals; failures are `ERR_TYPE_CHECK` with file:line:col diagnostics. Evaluate the native TypeScript 7 compiler (tsgo) as a separate sandboxed process once its embedding API settles | planned |
| — | WPT subset with tracked pass rates (`soak/wpt.mjs`, weekly soak job with a 95% floor, lowered from 97% when the fetch directories joined: their remaining failures are mostly the soak's environment, see below); Deno's and workerd's expectation files as a baseline | done (runner); expectations planned |
| — | Turn `webPlatform` on by default once the startup snapshot lands (today: +0.8 ms per isolate, +1–1.6 ms on first use of an API) | planned |
| — | Fair CPU for idle timers: a stateful isolate's `setInterval` runs between evals (each batch budgeted like an eval, but unbounded in count); per-tenant CPU accounting should cover it | planned |
| — | `structuredClone` `transfer`, transferable streams, `MessageChannel`/`MessagePort` | planned |
| — | Error a `DecompressionStream`'s readable immediately on trailing data (needs the transform controller in the op) | planned |
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
- Lazy globals show as accessors until first use (idlharness wants data
  properties); fixed by eager install from a snapshot.
- The global object isn't a `WorkerGlobalScope` (idlharness "unexpected
  global object"); decide which global interface to model.
- `Event.timeStamp` is always 0 (Deno's behaviour too); `structuredClone`'s
  `transfer` option isn't supported yet.
| — | WPT expectations file (every allowed failure listed with a reason: by-design / browser-only / environment / bug) and per-test gating in the soak: a new failure or an unexpected pass fails the job; track "unexplained failures" (goal 0) instead of the overall rate (95.9% at phase 3) | planned |
| — | Run WPT's own server (wptserve) in the WPT soak so tests that need its Python handlers run (~100 subtests) | planned |
| — | Optional `web: { baseUrl }` (like Deno's `--location`) so relative Request/fetch URLs resolve and `location` exists (~140 WPT subtests). Decided: opt-in | planned (shape lands with API v2) |
| — | Fix or upstream the `url` crate's lag on newest URL-spec edge cases (url 94.9%) | planned |
| — | test262 run (catch regressions from removed globals and flags) | planned |
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
| `onPolicyDenied` event (audit log of refused fetch/connect/fs calls per tenant) | idea |
| Resolve the worker binary automatically (per-platform optional package) instead of `ISOLANE_WORKER` | planned (with packaging) |
| Standard Schema (Zod, Valibot, ArkType, ...) for host functions (`hostFunction({ args, result, fn })`: guest arguments validated before `fn` runs, results validated before they reach the guest, parameter types inferred) and for eval results (`run`/`eval` `{ result }`, typed; `ERR_INVALID_RESULT`) | done |
| Standard Schema everywhere else a user defines a shape: deployment entrypoint inputs/outputs and `env`, `globals`, host-function errors, `sockets`/`fetch` message bodies where useful; generate guest-side `.d.ts` from host-function schemas (via JSON Schema) so guest code type-checks against its host API | planned |
| `vm.call(name, ...args)` for stateful isolates (call an exported/global function with schema-checked args) | idea |
| **Deployments with user-defined entrypoints** (Workers-style, customizable): `tenant.deploy(code, { entrypoints: ['fetch', 'scheduled', 'onMessage', ...] })` evaluates the module once (its "cold start": top-level code, user-defined init), then `deployment.invoke(name, ...args)` calls an exported handler in a warm isolate. Host-defined handler names and argument shapes (`fetch(request, env, ctx)` is just one preset); warm-isolate pool per deployment with `minWarm`/`maxIsolates`/`idleMs`; `isolation: 'per-invoke' \| 'reuse'` (reuse keeps module state between invocations, like Workers); cold-start hooks (`onColdStart`); V8 code cache per deployment so re-creating an isolate skips parsing | planned |

### Errors and stack traces

Checked on the dev build (October 2026): a guest throw gives a correct stack but with `<anonymous>` as the file; a SyntaxError has no location at all; a host function that throws gives the guest an Error whose stack has **no guest frames** (it's created when the reply arrives, not at the call site); `cause` chains are dropped.

| Item | Status |
|---|---|
| Name every script (`ScriptOrigin`): `filename` option per run/eval (default `tenant/eval-N.js`), module paths for multi-file deployments, so frames read `at handler (src/index.ts:12:5)` | planned |
| SyntaxError (and every compile error) location: line, column, and the source line with a caret, from V8's `Message`, in `err.guest.location` and the formatted stack | planned |
| Host-call attribution: capture the guest's stack at the call site and use it for the rejection or throw, so a failing host call points at the guest line that made it (`at load (src/db.ts:4:22)`), with the host function's name and Node-style `code` | planned |
| Structured errors end to end: `cause` chains (and `AggregateError.errors`), own enumerable props like `code`, parsed frames (`err.guest.frames: [{ function, file, line, column }]`) next to the raw stack; host-side errors in host functions surface to hooks (`afterHostCall`) with their full host stack, while the guest only ever sees the message, name, and code | planned |
| Source-map support for transformed TypeScript/JSX and bundles: map frames back to original files before reporting (in the worker) | planned (with TS transform / bundling) |
| Hide or mark isolane's own runtime frames (`ext:`/`isolane:` scripts) in guest stacks, like Deno marks `ext:` frames | planned |
| Errors from timers and unhandled rejections outside an eval: surface as structured `onGuestError` events (not only console output) | planned |

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

### API v2 (from `docs/api-review.md`)

| Item | Status |
|---|---|
| One layered config (`defaults` → `tenants(name)` → call), grouped by meaning, no shorthands | planned |
| Uniform naming (units as suffixes, capabilities named for guest APIs, one word per idea; full rename table in the review) | planned |
| Host functions: one definition form (`hostFunction({ args, returns, handler, sync })`), namespaces, a call context (`tenant`, isolate, `signal`, `log`) | planned |
| One hook system: `before*`/`after*` interceptors and `on*` events at every level, plus `runtime.on()`; host calls, evals, logs, limits, policy denials, security events, worker lifecycle | planned |
| `Tenant` handle owns tenant operations (`usage`, `resetUsage`, `release`, `isolate()`); `close()` everywhere | planned |
| One `ERR_LIMIT` code with `err.limit` for every limit | planned |
| Split `index.ts` (config, host, worker pool, runtime) and `vm.rs` (watchdog, mailbox, host calls, console, eval); one per-isolate state record; one config-resolution pipeline | planned |
| Protocol: version field checked at `ready`; `create` grouped like the public config | planned |
| Delete the minimal fetch/base64/UTF-8 prelude once the web platform is always on | planned |
| Split the end-to-end tests by area | planned |

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
| Binary frames: bytes cross as raw attachments after a frame's JSON (a 0x00 tag, the JSON's length, the JSON, the bytes). Guest → host: top-level byte arguments of a host call (`bin: [[arg index, length]]`, null placeholders, no in-band markers a guest could forge); host → guest: byte values anywhere in a host function's result (`bin: [[path, length]]`), arriving as Uint8Arrays. The supervisor's parser rejects any attachment that doesn't add up (fuzzed). fs/fetch/socket brokers and the prelude use bytes, no base64. 1 MiB Uint8Array through a host call 149.5 → 1.38 ms; 1 MiB `fs.readFile` 2.61 → 1.33 ms | done |
| Byte values nested inside host-call arguments (not top-level) still cross as JSON objects | planned |
| Oversized guest output fails the guest, not the worker: host-call arguments past 64 MiB throw a RangeError, results past it fail the eval (`ERR_NOT_SERIALIZABLE`), error messages and stacks are clipped to 64 KiB (each used to be a protocol violation, a security event, and a quarantine) | done |
| V8 ValueSerializer as the wire format: **deferred**. Our V8 writes format v16; Node 22 and 26 read only up to v15. And the supervisor would parse a compromised worker's output with V8's deserializer, which Chrome never exposes across a trust boundary (browser IPC uses Mojo); JSON.parse is a much smaller parser to trust. Revisit for the supervisor → worker direction only (trusted sender), where it would carry Map/Set/Date/BigInt/typed arrays into the guest | idea |
| Lower per-call latency: coalesce frame writes per event-loop turn on the supervisor; spin briefly before blocking in the worker | planned |
| Frame batching (fewer syscalls), fewer copies | planned |
| Prewarmed worker pool (`prewarm: n`; spares never run guest code before a tenant claims one): new-tenant p50 36 → 4.9 ms (`bench/cold-start.mjs`, native macOS dev build) | done |
| Startup snapshot (also cuts per-VM setup once the WinterTC runtime is in) | planned |
| Native benchmarks (not Rosetta) in CI, tracked over time | planned |
| Shared-memory transport | idea (needs a native addon; conflicts with plain `npm install`) |

## 6. Operations

| Item | Status |
|---|---|
| Stress soak: VM floods, tenant floods, crash churn, VM/eval leaks, noisy neighbours, memory bombs | done (weekly; first results pending) |
| Unified, configurable limits (`limits` on the runtime, `tenantLimits(tenant)`, and per isolate): timeoutMs (now 30 s by default), cpuTimeMs, heapBytes (now 128 MiB by default), timers, logBytesPerEval, logMessageBytes, codeBytes, resultBytes, decompressedBytes, isolates (100), concurrentEvals, workerMemoryBytes, tenants (LRU eviction of idle tenants); `ERR_RESOURCE_LIMIT` with `err.limit`. Prompted by the first soak, where one tenant's worker crashed between 300 and 400 live isolates | done |
| More limits: pending host calls per isolate, host calls per eval, host-call payload bytes (after binary frames land), sockets/fetch totals per tenant, worker lifetime / evals per worker (recycling) | planned |
| One watchdog thread per worker instead of per isolate (halves thread count: each isolate is 2 threads today) | planned |
| First soak results (Linux x64, 2-core runner): no leaks (3,000 isolate create/dispose cycles 19→21 MB; 20,000 evals in one isolate 20→24 MB, flat); crash churn leaks no fds or zombies; noisy neighbour raises another tenant's p99 from 0.9 to 4.5 ms (same worker: 6 ms); 20 isolates hitting a 64 MB heap limit at once all get ERR_MEMORY_LIMIT and the worker keeps serving; 150 tenants at once: all succeed, 16 MB RSS each, cold start p50 721 ms under that contention | done |
| Worker recycling: max lifetime / max requests | planned |
| Metrics: per-tenant totals via `runtime.usage()` | done |
| Metrics hooks: per-eval callback / OpenTelemetry export | planned |

## 7. Packaging and platforms (P4)

| Item | Status |
|---|---|
| Linux x64 build in CI (from source, sandbox on), incremental rebuilds via source manifest | done |
| Linux arm64 (cross-compile from x64: Chromium's toolchains are x64-only) | planned |
| macOS arm64/x64 (needs full Xcode; macOS CI runners) | planned |
| **npm layout** (the esbuild/SWC/Biome/Rolldown pattern, not Prisma's postinstall download, which breaks offline, in locked-down installs, and with `--ignore-scripts`): `isolane` (the JS library) lists one `optionalDependencies` package per platform, each with `os`/`cpu`/`libc` fields so npm installs only the matching one: `@isolane/worker-linux-x64-gnu`, `@isolane/worker-linux-arm64-gnu`, `@isolane/worker-darwin-arm64`, `@isolane/worker-darwin-x64` (macOS: development only — no lockdown, strict mode refuses it). Later, maybe: `linux-*-musl` (Alpine; rusty_v8 doesn't support musl, so a real porting job). No Windows (no lockdown story). The library resolves its platform package, with `ISOLANE_WORKER` as an override | planned |
| Sizes (Linux x64, October 2026): 71 MB unstripped, **53 MB stripped, ~18.7 MB gzipped per platform package** (cf. Biome 66 MB, esbuild/SWC ~11 MB unpacked); a little smaller with `symbol_level=0` | done (measured) |
| Publishing from CI only, with npm trusted publishing (OIDC, no long-lived token) and provenance attestations; all packages versioned in lockstep; every V8 patch bump is a patch release | planned |
| npm org `isolane` created; unscoped `isolane` reserved with a 0.0.0 placeholder (October 2026) | done |
| First real release: the owner adds a short-lived npm token as a repo secret for the first publish of each `@isolane/worker-*` package and the real `isolane`, then configures each package's trusted publisher (repo `ethndotsh/isolane`, workflow `release.yml`) and deletes the token; every release after is tokenless | to do (owner, at first release) |
| Stripped binaries; the staleness warning reads the worker's V8 version against the newest patch release | planned |
| Staleness warning when the installed worker's V8 is behind the patch pipeline | planned |
| Dev build against prebuilt V8 (`--features dev-prebuilt`, `ISOLANE_DEV_INSECURE=1`) for local iteration | done |
| Build speed, round 1: `fast` Cargo profile for local work (an edit rebuilds in 1.3 s vs 12.3 s with fat-LTO `release`); `release` gets `panic = "abort"` and stripped debug info; CI links with lld, caches the Cargo registry, sets `CARGO_INCREMENTAL=0`, frees disk in the background; V8 built with `symbol_level=0` (GN args in `scripts/v8.gn`, part of the cache key) | done |
| Measured: a V8 patch bump (15.2.124.1 → .45) is close to a full rebuild on a 2-core runner — patch releases touch widely included headers, so most objects really are stale | done |
| Bigger lever for V8 builds: more cores. GitHub prices runners per core, so an 8- or 16-core runner costs about the same per build and finishes 4–8× sooner (needs an org on the Team plan for larger runners), or make the repo public: standard runners are free with no minute cap, 4-core on Linux, but concurrency is still capped per account (reportedly 20 jobs on Free, 5 of them macOS; unconfirmed) and jobs still stop at 6 h. The account is on GitHub Pro: private repos keep 2-core runners with 3,000 included minutes/month, and larger runners still need an org on Team. At today's rate (V8 15.2 shipped ~4 patch releases a week, each ~2 h of 2-core build) that's ~2,000 min/month for bumps alone, near the included 3,000; overage is $0.006/min | decide |
| A prebuilt CI image (toolchain, libclang 21, strace) to drop the ~1 min of apt and setup per run | idea |
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
