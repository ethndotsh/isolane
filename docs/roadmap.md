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

## Order of work

Agreed October 2026:

1. **Web conformance pass** (done but for the ada decision): close the WPT gaps, using Deno wherever it is ahead.
2. **The rest of the web platform**:
   - `crypto.subtle`;
   - the web snapshot built into the binary and a pool of pre-created web isolates, so `web` can default to on;
   - fair CPU accounting for timers;
   - test262;
   - delete the old prelude.
3. **Errors and stack traces** (section 4).
4. **Research deployments before building them.** The pieces are wanted:
   - warm isolates;
   - ES modules;
   - TypeScript and JSX through oxc;
   - multi-file programs with `oxc_resolver`;
   - code and wasm caches;
   - shims.
   The API shape is open: `tenant.deploy()` reads oddly, so find a better surface first.
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
| 1 | primordials, webidl, URL/URLSearchParams (`url` crate), TextEncoder/Decoder (`encoding_rs`), atob/btoa, Event/EventTarget/CustomEvent/ErrorEvent, AbortController/AbortSignal, DOMException/QuotaExceededError, structuredClone (V8 ValueSerializer, with transfer), MessageChannel/MessagePort, performance (frozen-clock semantics), queueMicrotask, reportError, `self`, `navigator.userAgent`, `crypto.getRandomValues`/`randomUUID` — behind `webPlatform: true` | done (WPT 97.3%, below) |
| 2 | Timers + an event loop in the VM thread (`setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `AbortSignal.timeout`), Streams (ReadableStream incl. byte streams/BYOB, WritableStream, TransformStream, queuing strategies), Blob/File/FileReader, `URL.createObjectURL`, TextEncoderStream/TextDecoderStream, CompressionStream/DecompressionStream (gzip, deflate, deflate-raw via `flate2`'s pure-Rust backend; brotli via the pure-Rust `brotli` crate), structuredClone of Blob/File | done (WPT 97.2% over the phase 1 + 2 subset, below) |
| 3 | Spec `fetch`/`Request`/`Response`/`Headers`/`FormData`: Deno's 20–23 (vendored) plus our own `fetch()` (`runtime/fetch.js`, adapted from Deno's 26_fetch.js) over the network broker; response bodies stream (byte streams pulled from the broker), ReadableStream request bodies stream to it (others are sent whole); Subresource Integrity; redirect modes (follow/manual/error; the broker follows, re-checking each hop); abort cancels the broker's request; `data:` and `blob:` URLs; `fetch` without a network policy rejects with a TypeError | done (WPT below) |
| — | Streamed request bodies (upload a `ReadableStream` as it's produced; today it's read to the end first, within `maxRequestBytes`). WPT bug `request-streaming` (2 subtests) | planned |
| — | A base URL option (Deno's `--location`): `web: { baseUrl }`, see API v2 | done |
| — | Header values Node's HTTP client refuses (control bytes 0x01–0x08, 0x0B–0x1F, 0x7F, which Fetch allows) fail the fetch; would need our own HTTP/1.1 client in the supervisor | idea |
| — | Browser-only Fetch rules are not applied (forbidden request/response headers like `Set-Cookie`, method overrides, `only-if-cached`): server runtimes (Deno, workerd) don't either | by design |
| — | WPT fetch tests needing WPT's Python handlers (`.py`): WPT's server (wptserve) serves the WPT gate (see "WPT gate" below) | done |
| 4 | `crypto.subtle` (Deno's ext/crypto Rust, MIT) | planned |
| — | V8 startup snapshot of the web platform: each worker builds one (every vendored script loaded and compiled, globals as plain values) and creates web VMs from it, then configures each (base URL, timers, time origin). Built when the first web VM wants it, or in the background from start when the supervisor expects web VMs (`--prepare-web`: the first isolate is web, or the defaults turn web on for spares). Fixed WPT bug `lazy-globals`. Measured (macOS dev build, release): fresh web isolate +1.30 → +0.55 ms over web off; first use of Response 4.9 → 0.13 ms, of streams 3.4 → 0.21 ms, all common APIs together 4.9 → 0.32 ms; memory per live web isolate 4.59 → 2.46 MB; the serverless example's warm request 9.6 → 3.4 ms. Costs: ~30 ms to build once per worker that runs web VMs (a new web tenant's first result waits for it unless a spare built it), and ~13 MB more idle RSS in such a worker | done |
| — | Web snapshot, next: embed it in the binary at build time (zero build time per worker, and pages shared by every worker through the page cache); needs a two-pass build, and a native or emulated run for the arm64 cross-compile | planned |
| — | Web snapshot, next: a small pool of pre-created web isolates per worker, to hide the remaining ~0.55 ms of deserialization (isolates take their heap limit at creation, so the pool is per limit) | idea |
| — | ES modules for guest code (`export default { fetch }` handlers) | planned |
| — | **TypeScript guest code** (`lang: 'ts'`, `.ts` deployments): type stripping, not checking, done in the worker with `oxc` (pure Rust), so untrusted source is parsed only inside the locked-down worker. Erasable syntax only (like TypeScript's `erasableSyntaxOnly`: no enum/namespace/parameter properties, which get a clear error; a `transform` mode later). Types are blanked to whitespace, so line:column in guest stack traces match the TypeScript source with no source maps. Pairs with generated `.d.ts` for host APIs so developers can type-check against the exact host API at deploy time | planned (after API v2 and WPT) |
| — | **Multi-file programs**: deployments upload an in-memory file tree (`files: { path: source }`, `entry`); the worker resolves imports with `oxc_resolver` over a virtual filesystem (package.json exports/imports and conditions — `workerd`/`worker`/`browser`/`import`/`default` — tsconfig paths, extension probing), compiles each module with V8's native ES module API (resolve → strip/transform with oxc → compile → link), with dynamic `import()`, `import.meta.url` as the virtual path, and JSON modules. All parsing, resolving, and transforming of untrusted input stays in the locked-down worker, and resolution can't leave the uploaded tree. New limits: `modules`, `moduleBytes`. Packages work if uploaded; `node:*` only with the Node compat layer | planned |
| — | **JSX/TSX** via oxc's transformer: classic (`React.createElement` or a custom factory) and automatic (`jsxImportSource`, resolved in the uploaded tree), so SSR with Hono JSX, Preact render-to-string, or React's server renderer works; the serverless example becomes a `.tsx` app rendering HTML | planned |
| — | V8 code cache for deployments: compile each module eagerly once per worker, keep `create_code_cache()` bytes keyed by content hash, and later isolates use `ConsumeCodeCache` (celld calls the equivalent the largest share of its cold-wake latency) | planned (with deployments) |
| — | Per-tenant cache of compiled WebAssembly modules (`CompiledWasmModule`) keyed by content hash, so new isolates rehydrate instead of recompiling | planned (with deployments) |
| — | Optional deploy-time bundling with Rolldown (Rust, on oxc) for large dependency trees, plus V8 code cache per deployment | idea |
| — | TypeScript **transform mode** (`ts: { mode: 'transform' }`) via `oxc_transformer`: enums and const enums (inlined within a file), namespaces (partial: no cross-block merging, no exported `var`/`let`), legacy decorators + metadata, JSX/TSX; per-file (`isolatedModules`) semantics. Positions shift, so the worker maps guest stack traces back through the source map before reporting `err.guest.stack`. Strip mode stays the default. Verify parameter properties and standard decorators before documenting them | planned |
| — | **Type checking** at deploy time (`deploy(code, { check: true })`, cached by content hash), never per run: TypeScript's checker running *inside an isolane isolate* (tsc is plain JS; a large heap budget, nothing else enabled), so a checker bug or DoS on hostile input stays sandboxed. Checked against generated `.d.ts` for exactly the host functions (from their schemas) plus the WinterTC globals; failures are `ERR_TYPE_CHECK` with file:line:col diagnostics. Evaluate the native TypeScript 7 compiler (tsgo) as a separate sandboxed process once its embedding API settles | planned |
| — | WPT subset with tracked pass rates: now the WPT gate (`test/wpt/run.mjs`, see "WPT gate" below), which replaced `soak/wpt.mjs` and its 95% floor | done |
| — | Turn `web` on by default: **not yet**. With the snapshot, a web isolate costs ~0.55 ms more than a plain one (isolate 0.29 → 0.59 ms, context 0.12 → 0.37 ms; all V8 deserialization, `configure` is 0.01 ms), over the 0.3 ms bar set for flipping the default; first use costs nothing. Revisit with an embedded snapshot or an isolate pool | deferred |
| — | Fair CPU for idle timers: a stateful isolate's `setInterval` runs between evals (each batch budgeted like an eval, but unbounded in count); per-tenant CPU accounting should cover it | planned |
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
reason in one of four categories (by-design, browser-only, environment,
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
| `onPolicyDenial` event (audit log of refused fetch/connect/fs calls per tenant) | done (API v2 hooks) |
| Resolve the worker binary automatically (per-platform optional package) instead of `ISOLANE_WORKER` | planned (with packaging) |
| Standard Schema (Zod, Valibot, ArkType, ...) for host functions (`hostFunction({ args, result, fn })`: guest arguments validated before `fn` runs, results validated before they reach the guest, parameter types inferred) and for eval results (`run`/`eval` `{ result }`, typed; `ERR_INVALID_RESULT`) | done |
| Standard Schema everywhere else a user defines a shape: deployment entrypoint inputs/outputs and `env`, `globals`, host-function errors, `sockets`/`fetch` message bodies where useful; generate guest-side `.d.ts` from host-function schemas (via JSON Schema) so guest code type-checks against its host API | planned |
| `vm.call(name, ...args)` for stateful isolates (call an exported/global function with schema-checked args) | idea |
| **Deployments with user-defined entrypoints** (Workers-style, customizable): `tenant.deploy(code, { entrypoints: ['fetch', 'scheduled', 'onMessage', ...] })` evaluates the module once (its "cold start": top-level code, user-defined init), then `deployment.invoke(name, ...args)` calls an exported handler in a warm isolate. Host-defined handler names and argument shapes (`fetch(request, env, ctx)` is just one preset); warm-isolate pool per deployment with `minWarm`/`maxIsolates`/`idleMs`; `isolation: 'per-invoke' \| 'reuse'` (reuse keeps module state between invocations, like Workers); cold-start hooks (`onColdStart`); V8 code cache per deployment so re-creating an isolate skips parsing | planned |

### Web conformance pass (done, except the URL parser decision)

Decided (October 2026): close the known WPT gaps before expanding features, using Deno wherever it has the better implementation. First compare against Deno's own WPT expectations, then: `data:` URLs via the `data-url` crate; Deno's MessageChannel (and structuredClone transfer); Deno's compression semantics; newer Deno fixes or our own for the vendored-code edge cases (structured clone, body, Request attributes, streams, events, SRI); evaluate `ada-url` for URL parsing; stream request bodies through the broker; confirm the encoding edge case is upstream.

Result: see "After the Deno-gaps pass" under the WPT gate below (99.0% of applicable subtests; bugs 177 → 125, 112 of them the URL parser, where adopting ada is a decision to make).

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

Landed in October 2026; the review's "Status" section lists the
differences.

| Item | Status |
|---|---|
| One layered config (`defaults` → `tenants(name)` → call), grouped by meaning, no shorthands; `ERR_INVALID_CONFIG` names the field (and the new name for an old one) | done |
| Uniform naming (units as suffixes, capabilities named for guest APIs, one word per idea; full rename table in the review) | done |
| Host functions: one definition form (`hostFunction({ args, returns, handler, sync })`), namespaces (frozen in the guest), a call context (`tenant`, `isolate`, `signal`, `log`) | done |
| One hook system: `before*`/`after*` interceptors and `on*` events at every level, plus `runtime.on()`; host calls, evals, logs, limits, policy denials, security events, worker lifecycle | done |
| `onWorker` `recycle` events (once workers are recycled) | planned |
| Hooks over the brokers (`fetch`/`connect`/`fs` as host calls under `beforeHostCall`), beyond `onPolicyDenial` | idea |
| `Tenant` handle owns tenant operations (`run`, `isolate()`, `usage`, `resetUsage`, `release`, `stop`); `close()` everywhere; internals behind `runtime.diagnostics` | done |
| One `ERR_LIMIT` code with `err.limit` for every limit | done |
| Split `index.ts` (config, host, hooks, worker pool, runtime) and `vm.rs` (watchdog, mailbox, host calls, console, context, eval); one per-isolate state record; one config-resolution pipeline | done |
| Protocol: version field checked at `ready`; `create` grouped like the public config; host calls name functions by index | done |
| `web: { baseUrl }`: relative URLs in `fetch` and `new Request` resolve against it, and a read-only `location` exists (Deno's `getLocationHref`). WPT runs with each test's URL as the base (96.4%, from 95.9%) | done |
| `shims`: the embedder's JS in the isolate, `setup` once and `before`/`after` each eval, each its own script (exact guest line numbers), compiled by isolane (works with `eval` off), layered like the config, `ERR_SHIM` for their failures; the serverless example invokes `handle()` with one | done |
| Delete the minimal fetch/base64/UTF-8 prelude once the web platform is always on | planned |
| Split the end-to-end tests by area | done |

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
| Startup snapshot of the web platform (see WinterTC above for the numbers) | done |
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
| V8 build speed: decided (October 2026) to accept the free 4-core public-repo runners. Code-only pushes take ~5 min (cached V8); V8 patch bumps (~30–40 min) run unattended from the daily workflow; compiler-flag changes are full rebuilds (~1 h). Revisit with a self-hosted 16+ core runner or an org's larger runners if bumps start blocking anyone | done |
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
