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
| `isolate(config?)` | A stateful isolate: `eval(code)` keeps globals between calls |
| `usage()` / `resetUsage()` | Evals, failures, CPU ms, host calls, log bytes, peak memory, security events |
| `release()` | Lift a quarantine early |
| `stop()` | Stop the tenant's worker and its isolates |

`runtime.run(code, { tenant, ... })` is the one-liner. Isolates, tenants'
workers, and the runtime all `close()`, and work with `using`.

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
  hosts: ['api.example.com', '*.example.org'], // or a function (url, method) => boolean
  methods: ['GET', 'POST'],
  privateNetworks: false,
  limits: { requests: 100, requestBytes: 10 << 20, responseBytes: 10 << 20, redirects: 5, timeoutMs: 30_000 },
}
```

Private, loopback, and link-local addresses (including cloud metadata at
169.254.169.254) are refused unless `privateNetworks: true`, checked on the
address actually connected to, and every redirect hop is re-checked.

### `connect`

```js
connect: { hosts: ['db.example.com:5432', '*.cache.example:*'], privateNetworks: false, ca: undefined, limits: { connections: 8, connectMs: 10_000, idleMs: 60_000 } }
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
handshake). The same address rules as `fetch` apply, to every connection.

Libraries written for Workers' `cloudflare:sockets` work: the tests run
postgres.js's Workers build against Postgres, bundled with `cloudflare:sockets`
aliased to the global `connect` (guest code can't import modules yet).

### `fs`

```js
fs: { root: '/srv/tenants/acme', write: false, limits: { fileBytes: 10 << 20 } }
```

The guest gets a promise-based `fs` (`readFile`, `writeFile`, `readdir`,
`stat`, `exists`, `mkdir`, `rm`) confined to `root`, read-only unless
`write: true`. Symlinks out of the root are refused, errors carry Node-style
codes (`ENOENT`, `EACCES`, `EROFS`), and they never reveal host paths.

### `eval`, `wasm`

`eval: true` allows `eval` and `new Function`. `wasm: true` keeps
`WebAssembly` (off by default: its compilers are a large share of V8's
attack surface).

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

## Hooks

Settable at the runtime, in `tenants(name)`, and per call; every level's
hooks run.

| Hook | Kind | |
|---|---|---|
| `beforeHostCall` / `afterHostCall` | interceptor | can `deny()` (`ERR_DENIED`) or replace the arguments / result |
| `beforeEval` / `afterEval` | interceptor | can `deny()` or replace the code / result |
| `onLog` | event | guest `console` output (up to `limits.logBytes` per eval) |
| `onLimit` | event | any limit hit |
| `onPolicyDenial` | event | a `fetch`, `connect`, or `fs` refusal |
| `onSecurityEvent` | event | a worker crash, protocol violation, or unresponsive worker |
| `onWorker` | event | a tenant's worker started or exited |

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
| `logBytes` / `logLineBytes` | 1 MiB / 16 KiB | isolate |
| `codeBytes` / `resultBytes` | 16 MiB each | isolate, per eval |
| `decompressedBytes` | 128 MiB | isolate, per decompression call |
| `isolates` | 100 | tenant |
| `concurrentEvals` | 1,000 | tenant |
| `workerMemoryBytes` | 2 GiB | tenant (Linux; covers ArrayBuffer and WebAssembly memory a heap limit doesn't) |
| `idleMs` | 30 s | tenant (an idle worker exits) |
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

Isolate limits can be set at every level; tenant limits at the runtime and
in `tenants(name)`; `tenants` on the runtime only. Hitting any limit fails
with `ERR_LIMIT`, with `err.limit` naming it, and emits `onLimit`. `fetch`,
`connect`, and `fs` policies carry their own limits.

## Errors

Every failure is an `IsolaneError` with `code`, `kind`, `retryable`, and
`tenant`.

| Kind | Codes |
|---|---|
| `guest` | `ERR_GUEST_EXCEPTION` (see `err.guest`: `name`, `message`, `stack`), `ERR_UNSETTLED`, `ERR_NOT_SERIALIZABLE`, `ERR_INVALID_RETURN` |
| `limit` | `ERR_LIMIT` (see `err.limit`), `ERR_ISOLATE_RETIRED` |
| `usage` | `ERR_INVALID_CONFIG`, `ERR_ISOLATE_CLOSED`, `ERR_RUNTIME_CLOSED`, `ERR_DENIED`, `ERR_SHIM` |
| `security` | `ERR_TENANT_QUARANTINED` |
| `infrastructure` | `ERR_WORKER_CRASHED`, `ERR_WORKER_UNRESPONSIVE`, `ERR_WORKER_INCOMPATIBLE`, `ERR_ISOLATION_UNAVAILABLE`, `ERR_INTERNAL` |

## Isolation and strict mode

Each tenant gets its own worker process; each isolate is its own V8 isolate,
built with the V8 sandbox. Workers lock themselves down before running guest
code: Landlock and seccomp on Linux. Strict mode (the default) refuses hosts
where that lockdown can't be applied; `runtime.isolationReport()` shows what
a host provides. Development setups opt out with `strict: false`.

After a security event (a crash, a protocol violation, an unresponsive
worker), the tenant is quarantined for `quarantineMs`; `tenant.release()`
lifts it.

## Known limits

- **Time still moves at I/O.** A frozen clock stops guest code from timing
  itself between I/O events, but each host call, fetch, or eval moves the
  clock to the real time, so a guest that makes many calls can still
  measure coarse durations.
- **An `fs` root must not be writable by anyone else.** Paths are confined
  by resolving symlinks before each operation; another process creating
  symlinks inside the root at the same moment could race that check.
- **A seeded isolate's hash seeds are predictable** to its own code (it can
  slow its own hash tables down, within its time limits).
- **On macOS**, the per-worker memory cap and CPU-time budgets aren't
  enforced, and there's no seccomp or Landlock: strict mode refuses it.
- **Web Crypto runs on the isolate's thread**, as guest CPU time. Long
  derivations stop at the isolate's limits (PBKDF2 checks as it goes), but
  RSA key generation can't be interrupted, so RSA keys are capped at 4,096
  bits. RSA is the `rsa` crate's, which isn't constant-time
  ([RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071)):
  a remote observer timing many RSA decryptions or signatures with one key
  could learn it.
- **`URLPattern` parsing runs natively**, outside the watchdog, so
  patterns over 64 KiB, with over 1,024 groups in one component, or with
  many regexp groups in a long component (their count times its length
  over 2^18) throw a `RangeError`; real patterns are far below these.
  Matching runs in V8 and stops at the isolate's limits.
- **Everything is UTC.** Guests can't see the host's time zone, and can't
  choose another one as the default (they can still format for any zone
  with `Intl`).
