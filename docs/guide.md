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

By default guest code gets only ECMAScript: no network, no files, no `eval`,
no WebAssembly, no shared memory, and a frozen clock.

### `web`

`web: true` installs the web platform ([WinterTC](https://wintertc.org)'s
Minimum Common API), built on Deno's web-platform JavaScript (vendored, MIT)
over isolane's own native code:

- `fetch`, `Request`, `Response`, `Headers`, `FormData` (needs a `fetch`
  policy; response bodies stream)
- `URL`, `URLSearchParams`
- `TextEncoder`, `TextDecoder`, and their streams; `atob`, `btoa`
- `Event`, `EventTarget`, `AbortController`, `AbortSignal` (incl. `timeout`),
  `DOMException`
- `structuredClone`, `queueMicrotask`, `reportError`, `performance`
- `crypto.getRandomValues`, `crypto.randomUUID`
- timers: `setTimeout`, `setInterval`
- streams: `ReadableStream`, `WritableStream`, `TransformStream`
- `Blob`, `File`, `FileReader`, `CompressionStream`, `DecompressionStream`

`web: { baseUrl: 'https://app.example/' }` also resolves relative URLs
(`fetch('/x')`, `new Request('/x')`) against it and adds a read-only
`location`.

Timers advance a frozen clock when they fire. A one-shot `run()` drops
timers still pending when it returns; a stateful isolate keeps them.

Cost: web isolates are created from a startup snapshot that each worker
builds the first time it needs one (about 30 ms, once), so every API is
ready at no first-use cost, and a web isolate takes about 0.5 ms more to
create than a plain one. With `defaults.web` on, spare workers build the
snapshot before a tenant claims them.

### `time` and `random`

- `time: 'frozen'` (default): `Date`, `Intl`'s default "now", and
  `performance.now()` move only when an eval starts and when a host call
  returns, so guest code can't time itself. `'real'` is the real clock;
  `{ fixedMs }` is a fixed instant, for reproducible runs.
- `random: { seed }` seeds `Math.random`, `crypto`'s randomness, and V8's
  hash seeds, for reproducible runs. Default: OS randomness per isolate.

### `fetch`

```js
fetch: {
  hosts: ['api.example.com', '*.example.org'], // or a function (url, method) => boolean
  methods: ['GET', 'POST'],
  privateNetworks: false,
  limits: { requests: 100, requestBytes: 10 << 20, responseBytes: 10 << 20, redirects: 5, timeoutMs: 30_000 },
}
```

Without `web`, the guest gets a minimal `fetch`/`Response`/`Headers`.
Private, loopback, and link-local addresses (including cloud metadata at
169.254.169.254) are refused unless `privateNetworks: true`, checked on the
address actually connected to, and every redirect hop is re-checked.

### `connect`

```js
connect: { hosts: ['db.example.com:5432', '*.cache.example:*'], privateNetworks: false, limits: { connections: 8, connectMs: 10_000, idleMs: 60_000 } }
```

The guest calls `connect('db.example.com:5432', { secureTransport: 'on' })`
and gets `{ read, write, close }`. The same address rules as `fetch` apply.

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
timers, and fetch, about 18,400 subtests. **98.7% of the subtests that
apply pass** (95.6% of all of them).

Every subtest that doesn't pass is listed in `test/wpt/expectations.json`
with a reason, in one of four categories:

| Category | Subtests | What it means |
|---|---|---|
| by-design | 101 | isolane's choices: no SharedArrayBuffer, no WebAssembly unless allowed, a global that isn't a `WorkerGlobalScope`, tentative APIs |
| browser-only | 483 | rules for browsers that server runtimes (Deno, workerd) don't apply either: CORS and origins, forbidden headers, referrers, the HTTP cache, `XMLHttpRequest`, the Cache API |
| environment | 49 | the test setup or Node's HTTP client: no TLS or HTTP/2 in the test server, no WPT proxy, header bytes Node refuses |
| bug | 177 | real gaps, each a row in the roadmap: mostly the `url` crate lagging the newest URL spec (112), then structured clone, `MessageChannel`, `Request` attributes, and body and streams edge cases |

The applicable rate leaves out by-design and browser-only failures; bugs
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
| `logBytes` / `logLineBytes` | 1 MiB / 16 KiB | isolate |
| `codeBytes` / `resultBytes` | 16 MiB each | isolate, per eval |
| `decompressedBytes` | 128 MiB | isolate, per decompression call |
| `isolates` | 100 | tenant |
| `concurrentEvals` | 1,000 | tenant |
| `workerMemoryBytes` | 2 GiB | tenant (Linux; covers ArrayBuffer and WebAssembly memory a heap limit doesn't) |
| `idleMs` | 30 s | tenant (an idle worker exits) |
| `tenants` | 1,000 | runtime (evicts the least recently used idle tenant) |

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
- **Everything is UTC.** Guests can't see the host's time zone, and can't
  choose another one as the default (they can still format for any zone
  with `Intl`).
