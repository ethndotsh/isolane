# isolane

Run untrusted, multi-tenant JavaScript from Node in sandboxed V8 worker
processes. The goal is Cloudflare Workers' safety posture, installable with
`npm install`. See [docs/design.md](docs/design.md) for the threat model and
architecture.

> **Status: early development. Not ready for untrusted code.** The design's
> security gate (phase 5: V8 patch pipeline, fuzzing, external review) is
> not met, and there are no published packages yet.

```js
import { Runtime } from 'isolane';

using runtime = new Runtime({
  defaults: { limits: { timeoutMs: 1000, heapBytes: 64 << 20 } },
  hooks: { onLog: (e) => console.log(`[${e.tenant}]`, e.message) },
});
const acme = runtime.tenant('acme');

await acme.run('1 + 2'); // 3

// Inputs go in as data, never spliced into code.
await acme.run('order.items.length', { globals: { order } });

// Host functions are async in the guest; nested objects are namespaces.
await acme.run('db.getUser(42).then((u) => u.plan)', {
  host: { db: { getUser: async (id) => users.find(id) } },
});

// Bytes cross as bytes: Uint8Array arguments arrive as Buffers, and
// Buffers (or any typed array) in a result arrive as Uint8Arrays.
await acme.run('thumbnail(new Uint8Array(image)).then((t) => t.length)', {
  globals: { image: [/* ... */] },
  host: { thumbnail: async (buf) => sharp(buf).resize(64).toBuffer() },
});

// Stateful isolates keep their globals between evals.
using vm = acme.isolate();
await vm.eval('globalThis.count = 0');
await vm.eval('++count'); // 1
```

### Configuration

One `IsolateConfig` shape (`host`, `globals`, `eval`, `wasm`, `web`,
`fetch`, `connect`, `fs`, `time`, `random`, `limits`, `hooks`, `shims`) is
set at three levels: the runtime's `defaults`, each tenant's
(`tenants(name)`, e.g. by plan), and each call (`tenant.run(code, config)`,
`tenant.isolate(config)`). Later levels win field by field; `host` and
`globals` merge by name, `limits` by field, and `hooks` and `shims`
accumulate. A malformed config throws `ERR_INVALID_CONFIG` naming the field
(`defaults.limits.timeoutMs must be ...`).

```js
const runtime = new Runtime({
  defaults: { web: true, limits: { timeoutMs: 10_000 } },
  tenants: (name) => (isPro(name) ? { limits: { isolates: 200, workerMemoryBytes: 4 << 30 } } : undefined),
  limits: { tenants: 500 },
});
await runtime.tenant('acme').run(code, { limits: { timeoutMs: 500, timers: 100 } });
```

A tenant handle has `run`, `isolate()`, `usage()`, `resetUsage()`,
`release()` (lifts a quarantine), and `stop()` (its worker and isolates).
Isolates, tenants' workers, and the runtime all `close()` (or `using`).

### Host functions

A bare function is async in the guest, with unchecked arguments. For
validation, sync calls, or a typed handler, use `hostFunction`. Arguments
come from untrusted guest code, so they can be checked with any [Standard
Schema](https://standardschema.dev) library (Zod, Valibot, ArkType, ...)
before the handler runs; parameter types are inferred from the schemas.
The handler gets the call context last (and as `this`): `tenant`,
`isolate`, `signal` (aborts when nobody is waiting any more: the eval hit
its time limit, or the isolate closed), and `log`.

```ts
import { hostFunction } from 'isolane';
import { z } from 'zod';

const getUser = hostFunction({
  args: [z.number().int().positive()],
  returns: User,                                  // checked too: a bad value never reaches the guest
  handler: (id, ctx) => repo(ctx.tenant).users.get(id, { signal: ctx.signal }), // id: number
});
const order = await acme.run('placeOrder()', { host: { getUser }, returns: Order }); // typed as Order
```

Bad arguments reach the guest as a `TypeError` (`code: 'ERR_INVALID_ARGUMENTS'`)
listing the issues; a value that fails `returns` fails the call (or the
run) with `ERR_INVALID_RETURN` (`err.issues`).

### Hooks

Interceptors can refuse or change what happens; events only observe. Every
level's hooks run: interceptors in onion order (`before*` outermost first,
`after*` innermost first), events at every level. `runtime.on(event, fn)`
gets the same events and returns an unsubscribe function.

```js
import { deny } from 'isolane';

const runtime = new Runtime({
  hooks: {
    beforeHostCall: ({ tenant, name }) => (quota.exceeded(tenant, name) ? deny('over quota') : undefined),
    onLimit: ({ tenant, limit }) => metrics.count('limit', { tenant, limit }),
    onPolicyDenial: ({ tenant, api, target }) => audit.log(tenant, api, target),
    onSecurityEvent: ({ tenant, kind, quarantinedUntil }) => alert(tenant, kind, quarantinedUntil),
  },
});
const off = runtime.on('worker', (e) => console.log(e.tenant, e.event, e.reason));
```

`beforeHostCall`/`afterHostCall` and `beforeEval`/`afterEval` can `deny()`
(`ERR_DENIED`) or replace arguments, code, or results. Events: `onLog`,
`onLimit`, `onPolicyDenial`, `onSecurityEvent`, `onWorker`.

### Shims

Shims are the embedder's own JS, run inside the isolate around guest code:
trusted like host functions, and compiled by isolane, so they work with
`eval` off. `setup` runs once when the isolate is created (after the web
platform, host functions, and globals, so it can wrap or freeze them);
`before` runs before each eval's code; `after` runs once the guest's value
settles, as the body of an `async function (result)`, and a value other
than undefined replaces the result. Each is its own script, so guest line
numbers in stack traces are exact; shims are named `shim:<level>.<phase>.<n>`
there, or by their `filename`. A shim that throws fails the eval with
`ERR_SHIM` (`err.shim` says which), not `ERR_GUEST_EXCEPTION`. Levels
concatenate: `setup` and `before` run outermost first, `after` innermost
first.

```js
await acme.run(app.code, {
  globals: { request },
  shims: { after: { code: 'return { status: 200, body: await handle(request) }', filename: 'platform:invoke.js' } },
});
```

### What guest code can reach

By default, only ECMAScript. There is no network, no files, no `eval`, no
WebAssembly, no shared memory, and a clock that doesn't move while guest
code runs. Each isolate can opt in to more:

| Option | Default | |
|---|---|---|
| `web` | `false` | WinterTC's Minimum Common API, phases 1–3: `fetch`, `Request`, `Response`, `Headers`, `FormData` (with a `fetch` policy; response bodies stream), `URL`, `URLSearchParams`, `TextEncoder`/`TextDecoder` (and their streams), `atob`/`btoa`, `Event`/`EventTarget`, `AbortController`/`AbortSignal.timeout`, `DOMException`, `structuredClone`, `performance`, `queueMicrotask`, `reportError`, `crypto.getRandomValues`/`randomUUID`, timers (`setTimeout`, `setInterval`), streams (`ReadableStream`, `WritableStream`, `TransformStream`), `Blob`/`File`/`FileReader`, `CompressionStream`/`DecompressionStream`. Deno's web-platform JS (vendored, MIT) on native ops; 96.4% of the WPT subset passes (`soak/wpt.mjs`). `{ baseUrl: 'https://app.example/' }` resolves relative URLs (`fetch('/x')`, `new Request('/x')`) against it and adds a read-only `location`. Timers advance a frozen clock when they fire; a one-shot `run()` drops timers still pending when it returns. |
| `time` | `'frozen'` | `'frozen'` moves only when an eval starts and when a host call returns (no timers for side channels). `'real'`, or `{ fixedMs }` for reproducible runs. |
| `random` | OS randomness | `{ seed }` seeds `Math.random`, crypto's randomness, and V8's hash seeds, for reproducible runs. |
| `eval` | `false` | Allows `eval` and `new Function`. |
| `fetch` | none | `fetch` (the spec one with `web`, otherwise a minimal one), limited by a policy: `{ hosts: ['api.example.com', '*.example.org'] }` or a function; `methods`, and `limits` on size, time, redirects, and request count. Private and link-local addresses (cloud metadata) are refused unless `privateNetworks: true`, checked on the address actually connected to, and every redirect is re-checked. |
| `connect` | none | `connect('db.example.com:5432', { secureTransport: 'on' })` returning `{ read, write, close }`, limited by `host:port` patterns in `hosts`, the same address rules as `fetch`, and connection and idle limits. |
| `wasm` | `false` | Keeps `WebAssembly`. Off by default: its compilers are a large share of V8's attack surface. |
| `fs` | none | A promise-based `fs` (readFile, writeFile, readdir, stat, exists, mkdir, rm) confined to `{ root }`, read-only unless `write: true`. Symlinks out of the root are refused, and errors never reveal host paths. |

```js
await acme.run(`
  const r = await fetch('https://api.example.com/plans');
  await fs.writeFile('/plans.json', await r.text());
`, {
  fetch: { hosts: ['api.example.com'], limits: { requests: 10 } },
  fs: { root: '/srv/tenants/acme', write: true },
});
```

A policy refusal throws in the guest and emits `onPolicyDenial`. `console`
always exists; its output goes to `onLog` hooks, up to `limits.logBytes`
per eval. Each tenant's worker is capped at `limits.workerMemoryBytes`
(default 2 GiB; Linux), which covers ArrayBuffer and WebAssembly memory
that an isolate's heap limit doesn't.

Network, socket, and file access are brokered: the worker still can't open a socket
or a file. `fetch`, `connect`, and `fs` are host calls that this library checks against
the policy and performs on the guest's behalf.

### Isolation

Each tenant gets its own worker process. Inside it, each isolate is its own V8
isolate, built with the V8 sandbox enabled. Workers lock themselves down
before running guest code: Landlock and seccomp on Linux. Strict mode (the
default) refuses hosts where that lockdown can't be applied
(`runtime.isolationReport()` shows what a host provides); development
setups opt out with `strict: false`.

### Limits

Every resource has a cap, in `limits` at any level (tenant limits at the
runtime and tenant levels, `tenants` on the runtime only).

| Limit | Default | Scope |
|---|---|---|
| `timeoutMs` | 30 s | isolate (per eval) |
| `cpuMs` | none | isolate (per eval; Linux) |
| `heapBytes` | 128 MiB | isolate |
| `timers` | 10,000 | isolate (RangeError in the guest) |
| `logBytes` / `logLineBytes` | 1 MiB / 16 KiB | isolate |
| `codeBytes` / `resultBytes` | 16 MiB each | isolate (per eval) |
| `decompressedBytes` | 128 MiB | isolate (per decompression call) |
| `isolates` | 100 | tenant |
| `concurrentEvals` | 1,000 | tenant |
| `workerMemoryBytes` | 2 GiB | tenant (Linux; beyond V8's baseline) |
| `idleMs` | 30 s | tenant (an idle worker exits) |
| `tenants` | 1,000 | runtime (evicts the least recently used idle tenant) |

Hitting any of them fails with `ERR_LIMIT`, with `err.limit` naming it, and
emits `onLimit`. `fetch`, `connect`, and `fs` policies carry their own limits.

### Known limits

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

## Building

V8 is compiled from source, because no published rusty_v8 build has the V8
sandbox enabled.

```sh
scripts/fetch-rusty-v8.sh   # pinned rusty_v8 + V8 sources into build/
scripts/build-v8.sh         # worker binary at target/release/isolane-worker
npm install && npx tsc
ISOLANE_WORKER=$PWD/target/release/isolane-worker npm test
```

Requirements: Linux x64 with libclang 21 (apt.llvm.org), or macOS with full
Xcode. Linux arm64 must be cross-compiled from x64. The lockdown tests need a
native Linux kernel; they don't work under emulation such as Rosetta. CI
(`.github/workflows/ci.yml`) builds and tests on native Linux x64.
