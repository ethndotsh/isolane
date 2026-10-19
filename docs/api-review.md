# API and implementation review (October 2026)

A review of isolane's public surface and the code behind it, after a month
of features landing one at a time. The core is sound; the surface grew by
accretion and has too many ways to say the same thing. This proposes a
target ("v2") to move to in one step: we're pre-1.0 with no users, so no
compatibility shims.

## What's wrong with the surface

### 1. Configuration has five overlapping mechanisms

To set a timeout today you can use `timeoutMs`, `limits.timeoutMs`,
`defaults.timeoutMs`, `defaults.limits.timeoutMs`, `tenantLimits(t).timeoutMs`,
or `runtime.tenant(name, { timeoutMs })`. Worker memory has
`workerMemoryLimitBytes` *and* `limits.workerMemoryBytes`. Shorthands
(`timeoutMs`, `memoryLimitBytes`, `cpuTimeLimitMs`) use different names
from the limits they abbreviate (`timeoutMs`, `heapBytes`, `cpuTimeMs`).

**Fix:** one config shape, `IsolateConfig`, layered three ways and nowhere
else: the runtime's `defaults`, a `tenants(name)` resolver (replacing
`tenantLimits` and `tenant(name, defaults)`; it returns any part of the
config, not just limits), and the call. Delete the shorthands.

### 2. Guest options are one flat bag

`allowCodeGeneration`, `allowWebAssembly`, `webPlatform`, `network`, `fs`,
`sockets`, `clock`, `randomSeed`, `globals`, `hostFunctions`, `onLog`, and
`limits` all sit side by side. Nothing says which are capabilities (attack
surface), which are determinism, which are wiring.

**Fix:** group by meaning:

```ts
{
  host: { ... },                    // functions the guest can call (see 3)
  globals: { ... },                 // data the guest starts with
  eval: false, wasm: false,         // attack-surface opt-ins, named for the guest API
  web: true,                        // WinterTC globals (default true once snapshotted)
  fetch, connect, fs,               // brokered I/O policies, named for the guest API
  time: 'frozen' | 'real' | { fixedMs },
  random: { seed },
  limits: { ... },
  hooks: { ... },                   // see 4
}
```

### 3. Host functions have three definition forms and no context

A bare function, `{ sync: true, fn }`, and `hostFunction({ args, result, sync, fn })`.
And a host function can't tell which tenant or isolate called it, so a
multi-tenant host has to build a closure per tenant just to know who's asking.

**Fix:** one form plus the bare-function shortcut, nestable into namespaces,
with a context:

```ts
host: {
  ping: () => 'pong',                         // shortcut: async, unchecked
  db: {                                       // namespace: guest calls db.getUser(1)
    getUser: hostFunction({
      args: [z.number().int()],               // Standard Schema
      returns: User,
      handler: (id, ctx) => repo(ctx.tenant).users.get(id),   // ctx: tenant, isolate, signal, log
    }),
  },
}
```

- `ctx` comes last; its position is fixed because the schema fixes the
  arity. Bare functions get it as `this`.
- `ctx.signal` aborts when the eval times out, or the isolate is
  disposed, so host work stops when nobody is waiting.
- Namespaces become frozen objects in the guest, not a dozen globals.

### 4. Observability is three one-off callbacks

`onLog`, `onSecurityEvent`, and polling `usage()`. There's no way to see a
host call, an eval, a limit being hit, or a policy refusing a fetch.

**Fix:** one hook system. *Interceptors* can change or refuse what happens
(middleware, outermost first); *events* only observe. Both can be set at
the runtime, in `tenants(name)`, and per call, and all levels fire.

```ts
hooks: {
  // interceptors
  beforeHostCall({ tenant, name, args }) { if (!allowed(tenant, name)) return deny('not on your plan') },
  afterHostCall({ name, result, error, durationMs }) { /* may replace result */ },
  beforeEval({ tenant, code }) {},
  afterEval({ tenant, result, error, usage }) {},
  // events
  onLog({ tenant, level, message }) {},
  onLimit({ tenant, limit, value }) {},             // any limit hit
  onPolicyDenial({ tenant, api: 'fetch' | 'connect' | 'fs', target }) {},
  onSecurityEvent({ tenant, kind, quarantinedUntil }) {},
  onWorker({ tenant, event: 'start' | 'exit' | 'recycle', pid }) {},
}
```

Plus `runtime.on(event, listener)` for the same events, so an
OpenTelemetry or metrics adapter is one function, not plumbing through
every call site. `usage()` stays, as the cheap summary.

### 5. Tenant operations live on the runtime

`runtime.usage(t)`, `runtime.resetUsage(t)`, and `runtime.releaseQuarantine(t)`
take a tenant name, next to a `Tenant` class that exists to hold one.

**Fix:** `runtime.tenant('acme')` returns the handle with all of it:
`.run`, `.isolate()` (was `createIsolate`), `.usage()`, `.resetUsage()`,
`.release()`, `.stop()`. `runtime.run(code, { tenant })` stays as the
one-liner.

### 6. Smaller things

- `_workerPid` and `_evalLast` are public-but-internal; move them behind a
  symbol or a `diagnostics` object.
- `strict` defaults on from `NODE_ENV`, which surprises people. Make it
  `true` everywhere, and have dev setups opt out explicitly
  (`strict: false`); `isolationReport()` already says why.
- `SecurityEvent.exitCode/signal/detail` are worker internals; keep them
  in `detail`, and lead with `kind`, `tenant`, and `quarantinedUntil`.

## Naming

Names today were picked one feature at a time, so the same idea has
different spellings: `timeoutMs` vs `cpuTimeMs` vs `cpuTimeLimitMs`;
`memoryLimitBytes` vs `heapBytes` vs `workerMemoryLimitBytes`; `maxFileBytes`
vs `logBytesPerEval`; `allowCodeGeneration` vs `webPlatform` vs
`allowPrivateNetworks`; `dispose()` vs `close()`; `result` vs `fn`. The
rules below fix that, and every public name follows them.

### Rules

1. **Units are suffixes, always**: `Ms` for durations, `Bytes` for sizes.
   A plain plural noun is a count (`isolates`, `timers`, `requests`).
   Never `max`, `limit`, or `Limit` in a name: inside `limits`, every field
   is already a maximum.
2. **A capability is named for the guest API it enables**: `fetch`,
   `connect`, `fs`, `eval`, `wasm`, `web`. A capability is either `false`
   (default for anything that adds attack surface) or `true` or a policy
   object. So the config reads like the guest's global scope.
3. **Policies have the same shape**: `{ <targets>, <switches>, limits: { ... } }`,
   with the targets named for what they list (`hosts`, `root`).
4. **Hooks**: `before<Thing>` and `after<Thing>` can intercept; `on<Thing>`
   only observes. `<Thing>` is the same noun everywhere: `HostCall`, `Eval`,
   `Log`, `Limit`, `PolicyDenial`, `SecurityEvent`, `Worker`. Event names for
   `runtime.on()` are the same nouns, lowercased: `'hostCall'`, `'eval'`, ...
5. **Every closable thing has `close()`** and `[Symbol.dispose]`
   (`Runtime`, `Isolate`, and a deployment, later). There's no `dispose()`.
6. **Factories are nouns, actions are verbs**: `runtime.tenant('acme')`,
   `tenant.isolate()`, then `run`, `eval`, `close`, `release`.
7. **Error codes are `ERR_` + subject + condition**, and every limit shares
   one code: `ERR_LIMIT`, with `err.limit` naming the field
   (`'timeoutMs'`, `'heapBytes'`, `'isolates'`, ...). So `ERR_TIMEOUT`,
   `ERR_CPU_LIMIT`, `ERR_MEMORY_LIMIT`, and `ERR_RESOURCE_LIMIT` merge into
   one, and `err.kind === 'limit'` keeps working.
8. **One word per idea, everywhere**: `returns` for an expected-result
   schema (host functions, `run`, `eval`, deployments); `handler` for the
   function that does the work; `tenant` for the tenant's name.

### Renames

| Today | v2 |
|---|---|
| `LanePool` / `Runtime` options `defaults`, `tenantLimits`, `runtime.tenant(name, defaults)` | `defaults`, `tenants(name)` |
| `timeoutMs` / `cpuTimeLimitMs` / `memoryLimitBytes` (shorthands) | gone: `limits.timeoutMs` / `limits.cpuMs` / `limits.heapBytes` |
| `limits.cpuTimeMs` | `limits.cpuMs` |
| `workerMemoryLimitBytes` / `limits.workerMemoryBytes` | `limits.workerMemoryBytes` |
| `limits.logBytesPerEval` / `limits.logMessageBytes` | `limits.logBytes` (per eval) / `limits.logLineBytes` |
| `idleTimeoutMs`, `quarantineMs`, `prewarm` | `limits.idleMs` (tenant), `quarantineMs`, `spares` |
| `allowCodeGeneration` / `allowWebAssembly` / `webPlatform` | `eval` / `wasm` / `web` |
| `network: { allow, allowPrivateNetworks, methods, maxRequests, maxRequestBytes, maxResponseBytes, maxRedirects, timeoutMs }` | `fetch: { hosts, methods, privateNetworks, limits: { requests, requestBytes, responseBytes, redirects, timeoutMs } }` |
| `sockets: { allow, allowPrivateNetworks, maxConnections, connectTimeoutMs, idleTimeoutMs }` | `connect: { hosts, privateNetworks, limits: { connections, connectMs, idleMs } }` |
| `fs: { root, write, maxFileBytes }` | `fs: { root, write, limits: { fileBytes } }` |
| `clock: 'frozen' \| 'realtime' \| { fixedMs }` / `randomSeed` | `time: 'frozen' \| 'real' \| { fixedMs }` / `random: { seed }` |
| `hostFunctions: { f }`, `{ sync, fn }`, `hostFunction({ args, result, fn, sync })` | `host: { f }` or `host: { ns: { f: hostFunction({ args, returns, handler, sync }) } }` |
| `onLog`, `onSecurityEvent` (scattered) | `hooks: { onLog, onSecurityEvent, ... }` (one system) |
| `result` (run/eval schema) | `returns` |
| `createIsolate()` | `isolate()` |
| `Isolate.dispose()` | `Isolate.close()` |
| `runtime.usage(t)` / `resetUsage(t)` / `releaseQuarantine(t)` | `tenant.usage()` / `tenant.resetUsage()` / `tenant.release()` |
| `ERR_TIMEOUT`, `ERR_CPU_LIMIT`, `ERR_MEMORY_LIMIT`, `ERR_RESOURCE_LIMIT` | `ERR_LIMIT` + `err.limit` |
| `ERR_INVALID_OPTION` | `ERR_INVALID_CONFIG` (it's all config now) |
| `ERR_ISOLATE_DISPOSED` | `ERR_ISOLATE_CLOSED` (matches `close()`) |
| `ERR_INVALID_ARGUMENTS` / `ERR_INVALID_HOST_RESULT` (guest-side) | `ERR_INVALID_ARGUMENTS` / `ERR_INVALID_RETURN` |
| `ERR_INVALID_RESULT` | `ERR_INVALID_RETURN` (one word: `returns`) |
| `SecurityEvent.kind: 'worker-crash' \| 'protocol-violation' \| 'worker-unresponsive'` | `'crash' \| 'protocol' \| 'unresponsive'` (the subject is always the worker) |
| `_workerPid`, `_evalLast` | `runtime.diagnostics`, internal |
| Rust/protocol: `heap_bytes`, `cpu_time_limit_ms`, `allow_code_generation`, ... | the same names as the public config (`limits.heapBytes`, `eval`, ...), so a field means one thing end to end |

## What's wrong with the implementation

1. **`ts/index.ts` is one 1,000-line file**: option types, merging,
   validation, host-function wrapping, `SpareWorker`, `TenantWorker`,
   `Runtime`, `Tenant`, and `Isolate`. Split it into `config.ts` (types,
   layering, validation into one frozen resolved config), `host.ts`
   (definitions, namespaces, schema wrapping, dispatch, hooks), `worker-pool.ts`
   (spares, tenant workers, eviction), and `runtime.ts` (the public classes).
2. **Per-isolate state is seven parallel maps** in `TenantWorker`
   (`#hostFunctions`, `#disposers`, `#loggers`, `#timeouts`, `#codeBytes`,
   `#busyUntil`, ...). Use one `Map<id, IsolateState>`.
3. **Normalization is scattered**: `withLimits`, `mergeOptions`, `vmSetup`,
   `clockSpec`, `validateLimits`, `capabilities()` each validate a piece, in
   different orders. One `resolve(layers) → ResolvedConfig` pipeline, run
   once per isolate, validating everything with good errors, then
   everything downstream reads the resolved config.
4. **The `create` frame has grown 16 flat fields.** Group it like the
   public config (`limits`, `time`, `random`, `allow`, `web`, `functions:
   [{ name, path, sync }]`, `prelude`), and give the protocol a version
   field so a mismatched worker and supervisor fail at `ready`, not
   halfway through.
5. **`vm.rs` is ~1,100 lines**: watchdog, mailbox, bridge, host calls,
   console, eval loop, timers glue, and `vm_main`. Split it into
   `watchdog.rs`, `mailbox.rs`, `host_call.rs`, `console.rs`, and
   `eval.rs`.
6. **Two implementations of fetch/Headers/Response/base64/UTF-8.** The
   minimal prelude in `capabilities.ts` (~250 lines of JS in a template
   string) predates the web platform. Once the startup snapshot makes the
   web platform cheap, it should be always on, and the prelude should go:
   one fetch (Deno's, over our broker), one fs and one sockets wrapper on
   top of it.
7. **Tests are one 600-line file.** Split by area (`limits`, `host`,
   `policies`, `lifecycle`, `hostile-workers`), with shared helpers.

## Target, all together

```ts
import { Runtime, hostFunction } from 'isolane';

using runtime = new Runtime({
  defaults: { web: true, limits: { timeoutMs: 5_000 } },
  tenants: (name) => plans[planOf(name)],            // any part of the config, per tenant
  hooks: { onLog: (e) => logger.info(e), beforeHostCall: authorize },
  spares: 2,
});

const acme = runtime.tenant('acme');
const order = await acme.run(source, {
  globals: { input },
  host: {
    db: {
      getUser: hostFunction({ args: [z.number()], returns: User, handler: (id, ctx) => users(ctx.tenant).get(id) }),
    },
  },
  fetch: { hosts: ['api.stripe.com'] },
  returns: Order,
});
acme.usage(); // { evals, cpuMs, hostCalls, ... }
```

## Plan

Do it, renames included, as one refactor after WinterTC phase 3 and binary frames merge (they
touch the same host-call paths), in this order: config pipeline, host
functions + context + namespaces, hooks/events, `Tenant` handle, file
splits, protocol versioning and grouping. Tests move with each step. The
README and the serverless example are rewritten against the new surface.
