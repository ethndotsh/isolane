# isolane guide

The reference behind the README: every option, limit, hook, and error code.

- [Runtimes, tenants, isolates](#runtimes-tenants-isolates)
- [Configuration](#configuration)
- [Guest capabilities](#guest-capabilities)
- [Host functions](#host-functions)
- [Hooks](#hooks)
- [Shims](#shims)
- [Limits](#limits)
- [Errors](#errors)
- [Isolation and strict mode](#isolation-and-strict-mode)
- [Known limits](#known-limits)

## Runtimes, tenants, isolates

A `Runtime` runs each tenant in its own worker process. `runtime.tenant(name)`
returns the tenant's handle:

| Method | |
|---|---|
| `run(code, config?)` | Evaluate in a fresh isolate, then close it |
| `isolate(config?)` | A stateful isolate: `eval(code, options?)` keeps globals between calls |
| `usage()` / `resetUsage()` | Evals, failures, CPU ms, host calls, log bytes, peak memory, security events, and the worker's CPU ms as the kernel counts it (see [usage](#usage)) |
| `release()` | Lift a quarantine early |
| `stop()` | Stop the tenant's worker and its isolates |

`runtime.run(code, { tenant, ... })` is the one-liner. Isolates, tenants'
workers, and the runtime all `close()`, and work with `using`.

Besides the configuration, `run` and `eval` take two options for the one
call: `returns` (a Standard Schema the result must match; it types the
result) and `filename` (the code's name in stack traces, default
`<tenant>/eval-<n>.js`, where n counts the isolate's evals from 1).

Tenant names are yours to choose, not the guest's: the runtime keeps each
name's usage until `resetUsage()` (a few hundred bytes each), so a platform
that takes names from requests should check them against its own list.

```js
using vm = runtime.tenant('acme').isolate();
await vm.eval('globalThis.count = 0');
await vm.eval('++count'); // 1
```

Runtime-only options: `workerPath` (default: the installed
`@isolane/worker-*` package, or `$ISOLANE_WORKER`), `strict` (default
`true`), `spares` (workers kept started and ready for new tenants),
`quarantineMs` (default 60 s), `limits.tenants`, and `hooks`.

## Configuration

One `IsolateConfig` shape: `host`, `globals`, `eval`, `wasm`, `web`,
`fetch`, `connect`, `fs`, `time`, `random`, `limits`, `hooks`, `shims`. It's
set at three levels:

1. the runtime's `defaults`,
2. each tenant's: `tenants(name)` returns any part of the config (for
   example by plan),
3. each call: `tenant.run(code, config)`, `tenant.isolate(config)`.

Later levels win field by field. `host` and `globals` merge by name,
`limits` by field, and `hooks` and `shims` accumulate. A malformed config
throws `ERR_INVALID_CONFIG` naming the field (`defaults.limits.timeoutMs
must be ...`).

`globals` are JSON values the guest gets as new globals; a name the guest
already has (`Object`, `JSON`, `console`, or a web platform global like
`URL`) is refused rather than replaced (ECMAScript's names as
`ERR_INVALID_CONFIG`, the web platform's when the isolate starts).

## Guest capabilities

By default guest code gets ECMAScript and the web platform, but no
network, no files, no `eval`, no WebAssembly, no shared memory, and a
frozen clock.

### `web`

The web platform ([WinterTC](https://wintertc.org)'s Minimum Common API),
on by default, built on Deno's web-platform JavaScript (vendored, MIT) over
isolane's own native code. `web: false` leaves plain ECMAScript, and rules
out the `fetch`, `connect`, and `fs` policies (their guest APIs are the web
platform's):

- `fetch`, `Request`, `Response`, `Headers`, `FormData` (needs a `fetch`
  policy; response bodies stream, and so do `ReadableStream` request bodies,
  which need `duplex: 'half'`; `integrity` is checked, Subresource
  Integrity's sha256/384/512; `data:` and `blob:` URLs work without a
  policy)
- `URL`, `URLSearchParams`, `URLPattern`
- `TextEncoder`, `TextDecoder`, and their streams; `atob`, `btoa`
- `Event`, `EventTarget`, `AbortController`, `AbortSignal` (incl. `timeout`),
  `DOMException`
- `structuredClone` (with `transfer` for ArrayBuffers, ports, and
  streams), `MessageChannel`, `MessagePort`, `MessageEvent`,
  `queueMicrotask`, `reportError`, `performance`
- `crypto.getRandomValues`, `crypto.randomUUID`, and `crypto.subtle` (Web
  Crypto: SHA-1, SHA-2, and SHA-3 digests; HMAC; AES-GCM, -CBC, -CTR, and
  -KW; RSA-OAEP, RSA-PSS, and RSASSA-PKCS1-v1_5; ECDSA and ECDH on P-256,
  P-384, and P-521; Ed25519, X25519, and X448; PBKDF2 and HKDF). Keys and
  nonces come from the isolate's randomness, so `random.seed` reproduces
  them too.
- timers: `setTimeout`, `setInterval`
- streams: `ReadableStream`, `WritableStream`, `TransformStream`
- `Blob`, `File`, `FileReader`, `CompressionStream`, `DecompressionStream`

Ports and transfer stay inside the isolate (there's nothing else to post
to): each message is delivered as its own task, a transferred buffer is
detached where it was, and a port that's never closed keeps its queue until
the isolate ends.

`web: { baseUrl: 'https://app.example/' }` also resolves relative URLs
(`fetch('/x')`, `new Request('/x')`) against it and adds a read-only
`location`.

Timers advance a frozen clock when they fire. A one-shot `run()` drops
timers still pending when it returns; a stateful isolate keeps them, and
runs them between evals within `limits.backgroundMs` (see
[Limits](#limits)).

Cost: web isolates are created from a startup snapshot with every API
loaded, embedded in the worker binary at build time, so every API is ready
at no first-use cost, and a web isolate takes about 0.9 ms more to create
than a plain one (`web: false`). A worker built without the embedded
snapshot (a plain `cargo build`) makes its own the first time it needs one,
about 30 ms, once.

### `time` and `random`

- `time: 'frozen'` (default): `Date`, `Intl`'s default "now", and
  `performance.now()` move only when an eval starts and when a host call
  returns, so guest code can't time itself. `'real'` is the real clock;
  `{ fixedMs }` is a fixed instant, for reproducible runs.
- `random: { seed }` seeds `Math.random`, `crypto`'s randomness (keys
  `crypto.subtle` generates included), and V8's hash seeds, for
  reproducible runs. Default: OS randomness per isolate.

### `fetch`

```js
fetch: {
  hosts: ['api.example.com', '*.example.org', 'internal.example:8443'], // or a function (url, method) => boolean
  methods: ['GET', 'POST'],
  privateNetworks: false,
  limits: { requests: 1000, requestBytes: 10 << 20, responseBytes: 10 << 20, transferBytes: 1 << 30, redirects: 5, timeoutMs: 30_000 },
}
```

The values shown are the defaults, except `hosts` and `methods` (default
GET, HEAD, POST, PUT, PATCH, DELETE). `requests` and `transferBytes` count
over the isolate's life: fetches, and request and response body bytes
together.

Only `http:` and `https:` URLs are fetched. A bare host (`api.example.com`,
`*.example.org`) allows only the scheme's default port, 443 or 80; name
other ports as `host:port`, `[v6]:port`, or `host:*`.

Private, loopback, and link-local addresses (including cloud metadata at
169.254.169.254) are refused unless `privateNetworks: true`, checked on the
address actually connected to, and every redirect hop is re-checked. So are
IPv6 addresses that embed or translate to IPv4 ones (IPv4-mapped and
-translated, NAT64, 6to4, Teredo), since a host with a route for them would
reach the IPv4 address inside.

### `connect`

```js
connect: { hosts: ['db.example.com:5432', '*.cache.example:*'], privateNetworks: false, ca: undefined, limits: { connections: 8, connectMs: 10_000, idleMs: 60_000, transferBytes: 1 << 30 } }
```

`connect()` is the
[Sockets API](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
of Cloudflare Workers:

```js
const socket = connect('db.example.com:5432', { secureTransport: 'starttls' });
const writer = socket.writable.getWriter();
const reader = socket.readable.getReader();
await writer.write(sslRequest);
await reader.read(); // the server agrees
writer.releaseLock();
reader.releaseLock();
const secure = socket.startTls(); // the same connection, now TLS
```

- `connect(address, options)` takes `'host:port'`, `'[v6]:port'`, or
  `{ hostname, port }`, and returns a `Socket` at once. A malformed address
  throws; a refused or failed connection rejects `socket.opened` and
  `socket.closed`.
- `secureTransport`: `'off'` (default), `'on'` (TLS from the start), or
  `'starttls'` (plain until `startTls()`, which returns the upgraded socket;
  the old one is done). `allowHalfOpen: true` keeps the writable side open
  after the peer ends its side.
- `socket.readable` is a byte stream (BYOB readers work); `socket.writable`
  takes bytes. `opened` resolves with `{ remoteAddress }`. `close()` closes
  both directions and resolves with `closed`.

TLS checks the server's certificate against Node's default roots, or
against `ca` (PEM text, or a list) for a private CA such as a cloud
database's. `startTls()` checks it against the hostname you connected to,
or `expectedServerHostname`, and refuses to upgrade if the server sent bytes
the guest hasn't read (they could have been injected before the
handshake); bytes still in transit when the upgrade starts are read as TLS
records, so they fail the handshake instead. The same address rules as `fetch` apply, to every connection.
`transferBytes` caps the bytes read and written over the isolate's life,
all its sockets together; past it, the socket in use errors.

Libraries written for Workers' `cloudflare:sockets` work: the tests run
postgres.js's Workers build against Postgres, bundled with `cloudflare:sockets`
aliased to the global `connect` (guest code can't import modules yet).

### `fs`

```js
fs: { root: '/srv/tenants/acme', write: false, limits: { fileBytes: 10 << 20, writtenBytes: 100 << 20, operations: 16 } }
```

The guest gets a promise-based `fs` (`readFile`, `writeFile`, `readdir`,
`stat`, `exists`, `mkdir`, `rm`) confined to `root`, read-only unless
`write: true`. Symlinks are followed only while they stay inside the root
(at most 40 per path), and a symlink where a file is written or removed is
never written through. Errors carry Node-style codes (`ENOENT`, `EACCES`,
`EROFS`), and they never reveal host paths.

On Linux, paths are walked one directory at a time from descriptors held
open for the operation, never re-resolved by name, so a symlink created or
swapped in the root while an operation runs can't redirect it outside, even
if another process writes to the root. Files need to be readable to be
`stat`ed.
`fileBytes` caps each file read or written, `writtenBytes` what the isolate
writes over its life (`EDQUOT` past it; it doesn't track deletions, so it
isn't a disk quota: give each tenant its own volume or quota if disk space
matters), and `operations` how many run at once (`EMFILE` past it), each
holding a file handle in your process.

### `eval`, `wasm`

`eval: true` allows `eval` and `new Function`. `wasm: true` keeps
`WebAssembly` (off by default: its compilers are a large share of V8's
attack surface). Shared memories stay off either way: `new
WebAssembly.Memory({ shared: true })`, and instantiating a module that
exports one, throw a `TypeError`, as their buffers are SharedArrayBuffers.

### Brokering

The worker can't open a socket or a file. `fetch`, `connect`, and `fs` are
host calls that your process checks against the policy and carries out on
the guest's behalf. A refusal throws in the guest (a `TypeError` for
`fetch`) and emits `onPolicyDenial`.

## Web platform conformance

`web` is checked against a pinned subset of the
[web-platform-tests](https://web-platform-tests.org) (WPT): URL, encoding,
DOM events and abort, streams, compression, FileAPI, structured clone,
timers, fetch, Web Crypto, and URL Pattern, about 54,600 subtests. **99.6% of the
subtests that apply pass** (85.2% of all of them; most of the rest are
Web Crypto algorithms from drafts beyond the standard).

Every subtest that doesn't pass is listed in `test/wpt/expectations.json`
with a reason, in one of five categories:

| Category | Subtests | What it means |
|---|---|---|
| by-design | 97 | isolane's choices: no SharedArrayBuffer, no WebAssembly unless allowed, a global that isn't a `WorkerGlobalScope` |
| draft | 7,304 | APIs from drafts, not yet in a standard: tentative "owning" streams, `URLPattern.compareComponent()` and `generate()`, and Web Crypto algorithms from WICG drafts (Modern Algorithms such as ML-KEM, ML-DSA, and ChaCha20-Poly1305, and Ed448), which are on the roadmap |
| browser-only | 487 | rules for browsers that server runtimes (Deno, workerd) don't apply either: CORS and origins, forbidden headers, referrers, the HTTP cache, `XMLHttpRequest`, the Cache API, canvas, secure contexts |
| environment | 49 | the test setup or Node's HTTP client: no TLS or HTTP/2 in the test server, no WPT proxy, header bytes Node refuses |
| bug | 133 | real gaps, each a row in the roadmap: mostly the `url` crate lagging the newest URL spec (112), then `URLPattern` regexp groups with the `v` flag's set operations (8), a patched `Object.prototype.then` seeing body reads, `Event` attributes, and a few streams and encoding edge cases |

The applicable rate leaves out by-design, draft, and browser-only failures; bugs
and environment failures count against it.

The run is a gate, in CI after the end-to-end tests (the sandboxed worker,
strict mode): it fails on a subtest that newly fails or newly passes, a
changed harness status, a worker crash, or a listed entry that's stale or
has no classified reason.

```sh
node test/wpt/run.mjs              # clone WPT at the pinned commit, run, gate
node test/wpt/run.mjs --update     # rewrite the expectations, keeping reasons
node test/wpt/run.mjs --static     # no Python: plain files, report only
```

It needs Python 3: WPT's own server (wptserve, on localhost, HTTP only)
serves the tests, so its handlers and substitutions work. Each test runs in
a fresh isolate with `web: { baseUrl }` set to the test's URL and a `fetch`
policy for localhost. `--filter <substr>` runs some files, `--report` and
`--summary` write JSON and Markdown, and `ISOLANE_WPT_DIR` sets where the
checkout is cached. New entries from `--update` are "unclassified" until
someone gives them a reason.

## ECMAScript conformance (test262)

The engine, as isolane configures it (SharedArrayBuffer and Atomics
removed, Temporal off, the frozen clock, no code generation unless `eval`
allows it), is checked against [test262](https://github.com/tc39/test262):
`built-ins`, `language`, `annexB`, and `intl402`, about 50,000 tests, each
run in non-strict and strict mode unless its flags say otherwise, for about
100,400 runs. It's pinned to the commit V8's own sources pin, so V8's list
of its known failures applies as is. **98.8% of the runs that apply pass**
(80.1% of all of them; most of the rest are Temporal and module tests).

Every run that doesn't pass is listed in `test/test262/expectations.json`
with a reason, or covered by a skip rule there (by feature, by flag, or, for
development builds only, by path):

| Category | Runs | What it means |
|---|---|---|
| by-design | 17,380 | isolane's choices: no Temporal until it's audited (13,378), no ES modules yet (2,792; they come with deployments), no SharedArrayBuffer or Atomics (1,210) |
| draft | 1,662 | stage-3 proposals, from test262's own list |
| v8 | 455 | V8's own: failures V8's test262 status lists for d8 too (291), and joint iteration (`Iterator.zip`), which V8 15.2 ships only behind a flag (164) |
| environment | about 490 | host hooks isolane doesn't give a guest: `$262.createRealm` (a second realm), `$262.evalScript`, `$262.IsHTMLDDA`; and, in development builds only, 8 runs whose huge ArrayBuffer lengths kill a worker without the V8 sandbox |
| bug | 0 | |

The applicable rate leaves out by-design and draft. Each run is a fresh
isolate with `eval: true` (test262 evals throughout) and everything else at
its default; `$262.detachArrayBuffer` is `ArrayBuffer.prototype.transfer`.
Like the WPT run, it's a gate in CI (strict mode, the sandboxed worker): a
run that newly fails or newly passes, an unlisted worker crash, or a stale or
unclassified entry fails it.

```sh
node test/test262/run.mjs            # clone test262 at the pinned commit, run, gate
node test/test262/run.mjs --update   # rewrite the expectations, keeping reasons
```

`--filter <substr>` runs some tests, `--report` and `--summary` write JSON
and Markdown, and `ISOLANE_TEST262_DIR` sets where the checkout is cached.
It takes about 15 s on 8 cores.

## Host functions

A bare function is async in the guest, with unchecked arguments, and gets
the call context as `this`. Nested objects become namespaces (`db.getUser`).

`hostFunction({ args, returns, handler, sync })`:

- `args`: one [Standard Schema](https://standardschema.dev) per argument (or
  one for the whole argument list); checked before `handler` runs, and the
  handler gets the schemas' output (defaults and transforms apply).
- `returns`: checked before the guest sees the value.
- `handler(...args, ctx)`: `ctx` has `tenant`, `isolate`, `signal` (aborts
  when nobody is waiting any more: the eval timed out, hit its CPU limit,
  the isolate closed, or the worker exited), and `log`.
- `sync: true`: the guest gets the value directly instead of a Promise; its
  isolate waits for the reply (within its time limit).

Bad arguments reach the guest as a `TypeError` (`code:
'ERR_INVALID_ARGUMENTS'`) listing the issues. A value that fails `returns`
fails the call (or, for `run`/`eval` with `returns`, the run) with
`ERR_INVALID_RETURN` and `err.issues`.

Bytes cross as bytes: `Uint8Array` arguments arrive as `Buffer`s, and
`Buffer`s (or any typed array) in a result arrive as `Uint8Array`s.

**Errors reach the guest.** When a handler throws, the guest's promise
rejects with the error's `name`, `message`, and `code` (never its stack).
A driver's error can carry a connection string, a host path, or part of a
query, so catch errors inside handlers that wrap such libraries and throw
what the tenant may see. `onPolicyDenial` reports URLs without their
`user:password@`.

## Hooks

Settable at the runtime, in `tenants(name)`, and per call; every level's
hooks run.

| Hook | Kind | |
|---|---|---|
| `beforeHostCall` / `afterHostCall` | interceptor | can `deny()` (`ERR_DENIED`) or replace the arguments / result |
| `beforeEval` / `afterEval` | interceptor | can `deny()` or replace the code / result |
| `onLog` | event | guest `console` output (up to `limits.logBytes` per eval) |
| `onGuestError` | event | an exception in a timer or task, or a promise rejected with no handler (see [Errors](#errors)) |
| `onLimit` | event | any limit hit |
| `onPolicyDenial` | event | a `fetch`, `connect`, or `fs` refusal (including a name that resolves only to private addresses) |
| `onSecurityEvent` | event | a worker crash, protocol violation, or unresponsive worker |
| `onWorker` | event | a tenant's worker started, is being recycled (`workerLifetimeMs`, `workerEvals`), or exited |

Interceptors run in onion order: `before*` outermost level first, `after*`
innermost first. `runtime.on(event, fn)` gets the same events and returns an
unsubscribe function.

## Shims

Shims are your own JavaScript, run inside the isolate around guest code:
trusted like host functions, and compiled by isolane, so they work with
`eval` off.

- `setup` runs once when the isolate is created, after the web platform,
  host functions, and globals, so it can wrap or freeze them.
- `before` runs before each eval's code.
- `after` runs once the guest's value settles, as the body of an
  `async function (result)`; a value other than `undefined` replaces the
  result.

Each shim is its own script, so guest line numbers in stack traces stay
exact; shims appear there as `shim:<level>.<phase>.<n>` or by their
`filename`. A shim that throws fails the eval with `ERR_SHIM` (`err.shim`
says which). Levels concatenate: `setup` and `before` outermost first,
`after` innermost first.

```js
await acme.run(app.code, {
  globals: { request },
  shims: { after: { code: 'return { status: 200, body: await handle(request) }', filename: 'platform:invoke.js' } },
});
```

## Limits

| Limit | Default | Scope |
|---|---|---|
| `timeoutMs` | 30 s | isolate, per eval |
| `cpuMs` | none | isolate, per eval (Linux) |
| `heapBytes` | 128 MiB | isolate |
| `timers` | 10,000 | isolate (a `RangeError` in the guest) |
| `backgroundMs` | 1 s per minute | isolate, work between evals (retires the isolate) |
| `logBytes` / `logLineBytes` | 1 MiB / 16 KiB | isolate, per eval / per line (cut before it leaves V8) |
| `codeBytes` / `resultBytes` | 16 MiB each | isolate, per eval (at most a frame, 64 MiB) |
| `pendingHostCalls` | 1,000 | isolate: async host calls waiting for replies at once |
| `hostCalls` | 10,000 | isolate, per eval (isolane's own `fetch`, `connect`, and `fs` calls aside) |
| `hostCallBytes` | 64 MiB | isolate: bytes of host calls waiting for replies at once |
| `decompressedBytes` | 128 MiB | isolate, per decompression call (checked as it decodes) |
| `isolates` | 100 | tenant |
| `concurrentEvals` | 1,000 | tenant |
| `workerMemoryBytes` | 2 GiB | tenant (Linux; covers ArrayBuffer and WebAssembly memory a heap limit doesn't) |
| `idleMs` | 30 s | tenant (an idle worker exits) |
| `workerBackgroundMs` | 10 s per minute | tenant: `backgroundMs` for all its isolates together (pauses their background work) |
| `workerLifetimeMs` / `workerEvals` | 1 hour / 100,000 | tenant: recycle its worker after this long, or this many evals |
| `tenants` | 1,000 | runtime (evicts the least recently used idle tenant) |

**Work between evals.** After an eval returns, a stateful isolate can
keep working: timers and `MessagePort` tasks it left, and continuations
of host calls it didn't await (`fetch`, `for (;;) await f()`). Each batch
of it runs under `timeoutMs` and `cpuMs` like an eval, and all of it
shares `backgroundMs`: a budget per minute, as CPU time on Linux and wall
time elsewhere, that refills continuously and starts full. Each host-call
continuation is charged at least 0.25 ms, for the host's side of the
call. When it runs out, the isolate stops (its timers never fire again),
`onLimit` fires with `limit: 'backgroundMs'`, its next eval fails with
`ERR_LIMIT`, and later ones with `ERR_ISOLATE_RETIRED`. The work is
counted in the tenant's `usage().cpuMs` like an eval's. Timers run in
slices of 10 ms, so an isolate's own evals and host replies aren't held
up behind a timer storm, and each isolate has its own thread, so a storm
doesn't slow the tenant's other isolates beyond sharing the CPU.

The tenant's isolates also share `workerBackgroundMs`, the same kind of
budget for all of them together, so a hundred isolates don't get a hundred
budgets. Running it out retires nothing: every isolate's timers and
continuations wait until it has refilled, its evals still run, and
`onLimit` fires once per isolate with `limit: 'workerBackgroundMs'`.
Isolates in the middle of a batch when it runs out finish it (at most a
10 ms slice each), and what they overdraw is paid back before any
background work runs again.

**Recycling.** A tenant's worker is replaced after `workerLifetimeMs` or
`workerEvals`, so a worker that guest code had quietly compromised doesn't
live on. `onWorker` fires with `kind: 'recycle'`, new isolates (every
`run`) start on a fresh worker, and the old one finishes what it's
running and exits. Stateful isolates still open on it keep working for up
to a minute (or `workerLifetimeMs`, if that's shorter); then they're
retired: their evals fail with `ERR_ISOLATE_RETIRED`, `retryable`, and a
new isolate starts on the fresh worker. Code that keeps an isolate for
long should expect that, and recreate it.

**Host calls.** A call past `pendingHostCalls`, `hostCalls`, or
`hostCallBytes` throws a `RangeError` in the guest (`code: 'ERR_LIMIT'`,
`limit` naming it) before it reaches your process, and the eval it was
made in fails with `ERR_LIMIT` even if the guest catches it. The worker
enforces them; the supervisor checks it did, and a worker sending more
calls (or bytes) in flight than the limits allow is killed as a protocol
violation. A call stays pending until its function settles, for at most a
second past the isolate's `timeoutMs` (even when the eval that made it has
returned):
then the guest's promise rejects with a `RangeError` (`code: 'ERR_LIMIT'`),
`ctx.signal` aborts, and the slot is free again. An eval that fails with
`ERR_LIMIT` (or `ERR_ISOLATE_RETIRED`) abandons every pending call of its
isolate at once (their signals abort, and their promises never settle), so
a timed-out eval doesn't leave the isolate unable to call host functions.
isolane's own `fetch`, `connect`, and `fs` calls have their own timeouts
instead.

**Console output and errors** are cut to size inside the worker, before a
string is copied out of V8: each console line to `logLineBytes` (with
`…`), each eval's output to `logBytes` (then one notice, and nothing
more), and a guest exception's message and stack to 64 KiB each. A
host function's error message is cut to 64 KiB too, as it may echo guest
input.

Isolate limits can be set at every level; tenant limits at the runtime and
in `tenants(name)`; `tenants` on the runtime only. Each is an integer of at
least 1, and durations (`timeoutMs`, `cpuMs`, `backgroundMs`, `idleMs`, `workerBackgroundMs`, `workerLifetimeMs`, and the policies'
`*Ms` limits) are at most 2^31 - 1 ms, `timers` at most 2^32 - 1, and
`heapBytes` at most 4 GiB (V8's largest heap); anything else is
`ERR_INVALID_CONFIG`. Hitting any limit fails
with `ERR_LIMIT`, with `err.limit` naming it, and emits `onLimit`. `fetch`,
`connect`, and `fs` policies carry their own limits. `connect`'s
`connections` counts a socket from when it starts opening, so opens racing
each other can't pass it, until the guest closes it or the connection closes
and the guest has read what was left.

## Usage

`tenant.usage()` returns what a tenant has used since it started or since
`resetUsage()`: `evals`, `failures`, `cpuMs`, `hostCalls`, `logBytes`,
`peakMemoryBytes`, `securityEvents`, and on Linux `workerCpuMs`.

Every figure but `workerCpuMs` is reported by the worker. They're right
unless guest code has compromised its worker, which could then report
anything: fine for metrics and quotas, not for billing that has to hold
against a hostile tenant.

`workerCpuMs` is measured by the supervisor: the CPU time of the tenant's
worker processes, every thread, user and system, read from the kernel
(`/proc/<pid>/stat`, in 10 ms steps), so a worker can't understate it. It
includes the worker's own work besides guest code (V8's compiler and
garbage collector threads, startup), so it's a little over `cpuMs`. It's
read every 5 s, when `usage()` is called, and when a worker is stopped; a
worker that crashes loses at most its last 5 s. It's absent on other
platforms.

## Errors

Every failure is an `IsolaneError` with `code`, `kind`, `retryable`, and
`tenant`.

| Kind | Codes |
|---|---|
| `guest` | `ERR_GUEST_EXCEPTION` (see `err.guest`), `ERR_UNSETTLED`, `ERR_NOT_SERIALIZABLE`, `ERR_INVALID_RETURN` |
| `limit` | `ERR_LIMIT` (see `err.limit`), `ERR_ISOLATE_RETIRED` |
| `usage` | `ERR_INVALID_CONFIG`, `ERR_ISOLATE_CLOSED`, `ERR_RUNTIME_CLOSED`, `ERR_DENIED`, `ERR_SHIM` |
| `security` | `ERR_TENANT_QUARANTINED` |
| `infrastructure` | `ERR_WORKER_CRASHED`, `ERR_WORKER_UNRESPONSIVE`, `ERR_WORKER_INCOMPATIBLE`, `ERR_ISOLATION_UNAVAILABLE`, `ERR_INTERNAL` |

### What the guest threw

`err.guest` describes the thrown value:

| Field | |
|---|---|
| `name`, `message` | `error.name` and `error.message` (or the value as a string) |
| `stack` | `error.stack`, without isolane's own frames |
| `frames` | the stack parsed: `[{ function, file, line, column, async? }]`, innermost first |
| `location` | for code that didn't compile: `{ file, line, column, sourceLine }` |
| `cause` | `error.cause`, described the same way (8 deep at most) |
| `errors` | an AggregateError's errors (16 at most) |
| `properties` | the error's own enumerable properties whose values are JSON, like `code` (16 at most, 4 KiB each) |

```js
try {
  await acme.run(code, { filename: 'src/orders.js', host: { db } });
} catch (err) {
  err.guest;
  // {
  //   name: 'Error', message: 'order 7 not found',
  //   stack: 'Error: order 7 not found\n    at db.getOrder (<host>)\n    at load (src/orders.js:4:22)\n    at src/orders.js:9:1',
  //   frames: [
  //     { function: 'db.getOrder', file: '<host>', line: null, column: null },
  //     { function: 'load', file: 'src/orders.js', line: 4, column: 22 },
  //     { function: null, file: 'src/orders.js', line: 9, column: 1 },
  //   ],
  //   properties: { code: 'ENOTFOUND' },
  // }
}
```

- **Scripts are named.** Each eval's code is `filename` (default
  `<tenant>/eval-<n>.js`); shims are `shim:<level>.<phase>.<n>` or their
  own `filename`.
- **A SyntaxError says where.** Code that didn't compile has no stack
  frames, so `err.guest.location` has the place, and `stack` reads like
  Node's: `src/bad.js:2`, the line, a caret under the column, then the
  error. Long lines show a window around the column.
- **A failed host call points at the guest's line.** The guest gets an
  error of the host error's class (`TypeError`, ...) with its message and
  `code`, and a stack from where the guest made the call, under a frame
  for the function (`at db.getOrder (<host>)`), for sync and async
  functions alike. The host's own stack never reaches the guest:
  `afterHostCall` and the `hostCall` event get the host error itself.
- **isolane's own frames are left out** of `err.guest.stack` and `frames`:
  the web platform's scripts (`ext:...`, Deno's code) and isolane's
  (`isolane:...`). Guest code's own `error.stack` keeps them (as Deno's
  does), and `Error.prepareStackTrace` and `Error.captureStackTrace` work
  as in V8: a custom `prepareStackTrace` string is reported as is.
- **Everything is bounded**: each text 64 KiB (8 KiB inside causes and
  errors), 32 errors described in all. Reading the error runs guest code
  (getters, Proxy traps) under the eval's limits; one that throws is
  skipped.

### Errors nothing handled

An exception thrown by a timer or task callback, and a promise rejected
with no handler by the time its task's microtasks have run, don't fail an
eval (an eval fails only with its own result). They're reported instead,
as in a browser or Workers:

- with the web platform, an `unhandledrejection` event on the global
  object first (`event.preventDefault()` handles it), and an `error`
  event for exceptions (as `reportError` dispatches);
- then the guest's console (`onLog`): `Uncaught …` or
  `Uncaught (in promise) …`;
- and `onGuestError` (`runtime.on('guestError')`) with `{ tenant,
  isolate, kind: 'exception' | 'rejection', error }`, `error` shaped like
  `err.guest`.

Both count against the eval's console budget (`limits.logBytes`), and the
event's texts are cut at `limits.logLineBytes`; what doesn't fit is
dropped. This applies to work between evals too (a stateful isolate's
`setInterval`). A rejection that gets its handler in a later task is still
reported, as browsers do.

## Isolation and strict mode

Each tenant gets its own worker process; each isolate is its own V8 isolate,
built with the V8 sandbox. Workers lock themselves down before running guest
code: Landlock and seccomp on Linux. Strict mode (the default) refuses hosts
where that lockdown can't be applied; `runtime.isolationReport()` shows what
a host provides. Development setups opt out with `strict: false`.

Strict mode needs a secure V8 sandbox and full seccomp, and accepts
Landlock at `partial`: a kernel older than 6.7 enforces Landlock's
filesystem rules but not its TCP ones (or not its newest file rights). That
is a deliberate choice: seccomp already refuses every file open and
`socket()` call, so Landlock is the second wall, and requiring the newest
Landlock would refuse most LTS kernels. A worker built without the V8
sandbox (a development build) is refused as a setup error
(`ERR_WORKER_CRASHED`, saying so), never treated as a security event.

After a security event (a crash, a protocol violation, an unresponsive
worker), the tenant is quarantined for `quarantineMs`; `tenant.release()`
lifts it.

## Known limits

- **Time still moves at I/O.** A frozen clock stops guest code from timing
  itself between I/O events, but each host call, fetch, or eval moves the
  clock to the real time, so a guest that makes many calls can still
  measure coarse durations.
- **On macOS, an `fs` root must not be writable by anyone else.** Paths
  there are confined by resolving symlinks before each operation, so
  another process creating symlinks inside the root at the same moment
  could race that check. Linux walks paths from held descriptors instead.
- **A seeded isolate's hash seeds are predictable** to its own code (it can
  slow its own hash tables down, within its time limits).
- **macOS is for development only.** The per-worker memory cap and
  CPU-time budgets aren't enforced, and there's no seccomp or Landlock, so
  strict mode refuses it by design: run untrusted code on Linux.
- **Web Crypto runs on the isolate's thread**, as guest CPU time. Long
  derivations stop at the isolate's limits (PBKDF2 checks as it goes), but
  RSA key generation can't be interrupted, so RSA keys are capped at 4,096
  bits, generated or imported. Lengths a guest picks are checked before
  anything is allocated: PBKDF2 derives at most 1 MiB, HKDF at most 255
  hash lengths (as RFC 5869 has it), and an RSA-PSS salt must fit the key.
  RSA is the `rsa` crate's, which isn't constant-time
  ([RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071)):
  a remote observer timing many RSA decryptions or signatures with one key
  could learn it.
- **`URLPattern` parsing runs natively**, outside the watchdog, so
  patterns over 64 KiB, with over 1,024 groups in one component, or with
  many regexp groups in a long component (their count times its length
  over 2^18) throw a `RangeError`; real patterns are far below these.
  Matching runs in V8 and stops at the isolate's limits.
- **A guest can delay its own evals** with work it leaves running between
  them (timers, continuations), within `backgroundMs`. The supervisor
  extends an eval's deadline (`timeoutMs` plus as much again, at least
  1 s) while the worker reports that work finishing, up to ten times the
  deadline; past that the worker is treated as unresponsive.
- **Closing an isolate** rejects its evals at once (`ERR_ISOLATE_CLOSED`)
  and stops what it's running; host functions it called still run to
  completion (their `signal` aborts).
- **Everything is UTC.** Guests can't see the host's time zone, and can't
  choose another one as the default (they can still format for any zone
  with `Intl`).
