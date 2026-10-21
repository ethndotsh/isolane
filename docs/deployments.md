# isolane: deployments research

Status: research, October 2026, with the warm setup decided (section 5).
`isolate.call`, the invoke primitive, is built; programs are not. This
document surveys how other platforms load and run tenant code, works out
what that means for isolane's architecture, proposes an API to replace the
`tenant.deploy()` sketch in the roadmap, and lays out a build order. It is
step 4 of the order of work in `docs/roadmap.md`.

## 1. The problem

isolane today offers two ways to run guest code. `tenant.run(code)` makes a
fresh isolate, evaluates one script, and frees the isolate.
`tenant.isolate()` returns a stateful isolate whose globals survive between
`eval` calls. Both take a single classic script as a string.

A platform built on isolane, such as `examples/serverless`, wants more than
that:

- code made of ES modules, possibly many files, possibly TypeScript or JSX;
- handlers the host calls by name (`fetch`, `scheduled`, or names the host
  defines), with arguments and results that are richer than JSON;
- the module's top-level code evaluated once and reused across calls (a
  warm isolate), with control over when it is reused and when it is thrown
  away;
- compile caches, so that a new isolate for already-seen code skips parsing
  and compiling.

The serverless example worked around the gap with an `after` shim that
built a `Request`, called the app's global `handle`, and returned the
`Response` as plain data, in a fresh isolate per request, so the app's code
was parsed and compiled again every time. With `isolate.call` it now keeps
one warm isolate per deploy (`examples/serverless/src/warm.ts`).

## 2. Survey

### Cloudflare Workers and workerd

A Worker is an ES module whose default export holds handlers:
`fetch(request, env, ctx)`, plus `scheduled`, `queue`, `email`, `tail`, and
others ([handlers](https://developers.cloudflare.com/workers/runtime-apis/handlers/)).
`env` carries bindings: configuration values and stubs for other services.
`ctx` is the execution context: `waitUntil(promise)` extends the request's
lifetime by up to 30 seconds after the response, `passThroughOnException()`
fails open to the origin, and `props` and `exports` carry per-caller
configuration and loopback bindings
([context](https://developers.cloudflare.com/workers/runtime-apis/context/)).
Named entrypoints are classes extending `WorkerEntrypoint` whose public
methods are callable over RPC from other Workers. Arguments are structured
clones, functions and `RpcTarget` instances are passed as stubs, and
streams, `Request`, and `Response` cross with flow control. Payloads are
capped at 32 MiB
([RPC](https://developers.cloudflare.com/workers/runtime-apis/rpc/)).

Isolates are reused but not guaranteed to persist. A single isolate serves
concurrent requests on one event loop, so global state is shared between
requests that happen to land on it, and Cloudflare advises against relying
on it. Isolates are evicted under resource pressure or at resource limits
([how Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/)).
The relevant limits: global-scope code must finish within 1 second of CPU
time at startup, a Worker may be 64 MiB uncompressed, an isolate has 128 MB
of memory, and the CPU time per request is configurable up to 5 minutes
([limits](https://developers.cloudflare.com/workers/platform/limits/)).

Code is versioned. A version is an uploaded, immutable snapshot of a
Worker's code. A deployment routes traffic across at most two versions, by
percentage, for gradual rollouts
([gradual deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/)).
Workers for Platforms adds dispatch namespaces of customer Workers, a
dispatch Worker that routes to them, and per-customer CPU and subrequest
limits
([Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)).

The closest analogue to isolane's library API is the Worker Loader, or
Dynamic Workers, binding
([API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/)).
A Worker that holds a loader binding can start other Workers from code it
supplies at run time:

```js
const worker = env.LOADER.get(id, async () => ({
  compatibilityDate: '2026-10-01',
  mainModule: 'index.js',
  modules: { 'index.js': source, 'data.json': { json: data } },
  env: { API_KEY: key },
  globalOutbound: null,
}));
const response = await worker.getEntrypoint().fetch(request);
```

`modules` maps names to sources, with explicit types for anything other
than JavaScript (`js`, `cjs`, `text`, `data`, `json`, `wasm`, `py`). `get`
caches by `id`, and the callback runs only when no cached copy exists, so
the same id must always describe identical code: a changed program needs a
new id, such as a content hash. `load(code)` never caches, for code that is
new every time. The stub is returned synchronously, and calls made before
loading finishes wait for it. `globalOutbound` routes the dynamic Worker's
`fetch` and `connect` through a service of the caller's choosing, or cuts
the network off with `null`.

### Deno, Deno Deploy, and Netlify Edge Functions

`deno serve` runs a module whose default export satisfies
`Deno.ServeDefaultExport`: `fetch(request, info)`, where `info` has
`remoteAddr` and a `completed` promise, and an optional `onListen`.
`--parallel` runs one worker per CPU
([deno serve](https://docs.deno.com/runtime/reference/cli/serve/)).
The Subhosting API, Deno's product for platforms that run their customers'
code, defines a deployment as an immutable object holding source, static
assets, environment variables, and database bindings. A project groups
deployments, and domains are remapped to a new deployment to roll forward
([Subhosting](https://docs.deno.com/subhosting/api/)).

Deno added V8 code caching for ES modules in April 2024 (PR #23081). The
code cache is stored in SQLite, keyed by module specifier, type, and a hash
of the source
([`cli/cache/code_cache.rs`](https://code.fosterhangdaan.com/foster/denoland-deno/src/commit/24fa5c784a7a4731ba8864e52977857959c580ed/cli/cache/code_cache.rs)).

Netlify Edge Functions run on Deno. Each is a default-exported function
`(request, context)` with a route in `export const config = { path }`. The
context carries `geo`, `ip`, `params`, `cookies`, `next()`, and
`waitUntil()`
([Netlify API](https://docs.netlify.com/build/edge-functions/api/)).

### Supabase Edge Runtime

Supabase's Edge Runtime is open source, built on Deno, and multi-tenant.
It is the closest existing system to what a platform builds on isolane
([repository](https://github.com/supabase/edge-runtime)). A trusted main
worker, with no limits and the full environment, receives every request and
starts user workers for tenant code:

```ts
const worker = await EdgeRuntime.userWorkers.create({
  servicePath,
  memoryLimitMb: 150,
  workerTimeoutMs: 5 * 60 * 1000,
  cpuTimeSoftLimitMs: 10000,
  cpuTimeHardLimitMs: 20000,
  envVars,
  forceCreate: false,
  noModuleCache: false,
});
return await worker.fetch(request, { signal });
```

([main worker example](https://github.com/supabase/edge-runtime/blob/main/examples/main/index.ts)).
User workers receive only the environment variables the main worker passes.
`forceCreate: false` reuses an existing worker for the same service path.
Code arrives as a service path on disk or as an eszip, Deno's serialized
module graph.

The runtime has three reuse policies
([PR #241](https://github.com/supabase/edge-runtime/pull/241)).
`oneshot` tears the isolate down after each request and is meant for
development. `per_worker`, now the default, keeps a worker alive across
many requests, so the JIT's work is kept, with the hard CPU limit still
applying to each request. `per_request` keeps workers but never runs two
requests in one isolate at once. Because a busy worker refuses new
requests under it, `per_request` needs a `request-wait-timeout`. A
`max-parallelism` setting caps the number of workers per service path.

### Vercel Fluid compute

Fluid compute lets one function instance serve many invocations at once,
which mainly helps I/O-bound work. It keeps background work alive with
`waitUntil` and caches V8 bytecode for Node 20 and later, in production
deployments only. The first request after a deploy fills the cache, and
later cold starts use it. An unhandled error lets the instance's other
in-flight requests finish before the process stops
([Fluid compute](https://vercel.com/docs/fluid-compute)).

### Fastly Compute

Fastly takes the opposite position. Each request gets its own WebAssembly
sandbox, created and destroyed in microseconds, and Fastly presents not
reusing instances as a security property
([launch post](https://www.fastly.com/blog/compute-edge-now-supports-javascript)).
JavaScript is compiled with its JS engine into a Wasm binary at build time
by `js-compute-runtime`. Bundling happens before that, with the `fastly`
export condition and `fastly:*` modules kept external
([JavaScript guide](https://www.fastly.com/documentation/guides/compute/javascript/)).
The handler is `addEventListener('fetch', ...)` with `event.respondWith`.

### Val Town, Bun, and plugin sandboxes

Val Town runs vals on Deno, and an HTTP val is a module that
default-exports `(request) => Response`
([example](https://flaviocopes.com/val-town.md); Val Town's own docs did
not load during this research). Bun starts a server for any file whose
default export has a `fetch` handler, passing that export to `Bun.serve`
([Bun HTTP server](https://bun.com/docs/runtime/http/server)). So
`export default { fetch }` is a cross-runtime convention, not one vendor's
API.

Shopify Functions compile JavaScript to WebAssembly with Javy and run it
under an instruction budget: 11 million instructions for carts of up to
200 lines, scaled for larger ones
([instruction counts](https://shopify.dev/docs/apps/build/functions/optimize-instruction-counts)).
JavaScript reaches that budget sooner than languages that compile to Wasm
directly
([JavaScript for Functions](https://shopify.dev/docs/apps/functions/language-support/javascript)).
Figma replaced its Realms-based plugin sandbox after escapes were found,
reportedly with QuickJS compiled to WebAssembly
([Figma](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/),
[update](https://madebyevan.com/figma/an-update-on-plugin-security/)).
Both give each invocation a clean, cheap interpreter instead of a warm JIT,
the trade isolane's comparison section describes for quickjs-wasi.

### isolated-vm

isolated-vm exposes V8's module API almost directly. `compileModule`
accepts `filename`, `cachedData`, and `produceCachedData`.
`module.instantiate(context, resolve)` asks a callback for each specifier
and referrer. `module.evaluate()` runs the module, and `module.namespace`
is a reference to its exports. Its README says the project is in
maintenance mode
([README](https://github.com/laverdet/isolated-vm)).
Embedders resolve and compile modules on the host side, so the host parses
untrusted source in its own process.

### What the survey shows

1. `export default { fetch(request, env, ctx) }` is the common shape across
   Workers, Deno, Bun, and Val Town. Netlify and Supabase use the same
   `Request` and `Response` with a function in place of the object. Other
   handlers (`scheduled`, `queue`) and named entrypoints vary by platform.
2. Code arrives either as a module tree with a main module (Workers
   uploads, the Worker Loader, Supabase's service paths and eszips, Deno
   Subhosting assets) or as one prebuilt bundle (Fastly, and Workers after
   Wrangler bundles). Platforms that accept trees accept bundles too, since
   a bundle is a one-file tree.
3. Loaded code is immutable and identified by content or version.
   Cloudflare's loader makes this explicit: same id, same code. Rollouts
   are routing between immutable versions, which is the host's job.
4. Reuse is a policy, not a fixed property. Fresh-per-call (Fastly,
   Supabase `oneshot`), warm with one request at a time (Supabase
   `per_request`), and warm with concurrency (Workers, Fluid, Supabase
   `per_worker`) all ship in production, chosen for safety, latency, or
   cost.
5. Code caching is now standard: Deno for modules, Vercel for Node
   bytecode, and Cloudflare at its scale.
6. Startup gets its own budget, separate from per-request CPU: Workers
   allows 1 second of global-scope CPU.

## 3. What isolane's architecture implies

The tenant is the security boundary. Each tenant has its own worker
process, and each VM is its own isolate on its own thread
(`docs/design.md`). That decides several questions.

Where untrusted code is parsed. All parsing, resolving, and transforming of
guest source must happen in the locked-down worker, never in the
supervisor. That rules out an isolated-vm-style host-side resolver callback
and points to `oxc_resolver` over an in-memory file tree inside the worker,
as the roadmap already says. The supervisor only sends bytes and their
hashes.

How caches are scoped. A code cache made by a worker could be corrupted if
that worker is compromised. Sharing it with another worker of the same
tenant is acceptable, since the tenant is already the boundary. Sharing it
with another tenant is not. V8 checks a code cache against its own version,
flags, and the source hash, and rejects one that doesn't match, but that
check is a guard against staleness, not against crafted input. So caches
are per tenant: kept in the worker by content hash, and, if the supervisor
keeps copies so they survive a worker recycle, sent back only to that
tenant's workers. The same applies to compiled WebAssembly modules.

What V8 offers. The rusty_v8 build in `build/rusty_v8` has what is needed:

- `script_compiler::compile_module2` with `CompileOptions::ConsumeCodeCache`
  and `EagerCompile`;
- `UnboundModuleScript::create_code_cache`;
- `Module::instantiate_module` with a resolve callback;
- `create_synthetic_module` for JSON, text, and bytes modules;
- the dynamic `import()` and `import.meta` host callbacks on the isolate.

Module records belong to one isolate, so every isolate compiles its own,
which is why the code cache matters. The embedded web snapshot is
unaffected, since modules are compiled after the context is deserialized.

How isolates are made. A fresh web isolate costs about 1.5 ms to first
result on the dev build, about 0.9 ms of it deserializing the snapshot
(roadmap, section 3). A per-call isolate would pay that plus compiling and
evaluating the program. Warm instances avoid both. The isolate pool already
on the roadmap as an idea becomes worth building once programs create
isolates on the request path.

How the clock behaves. Wall time advances only when an eval starts and
when a host reply arrives. A program needs the same rule at its new
boundaries: the clock advances when module evaluation starts and when each
call starts. Each call is an eval for the clock and for limits.

How limits apply. `cpuMs` and `wallMs` are per eval today. For a program
they apply per call, plus a separate startup budget for module evaluation,
like Workers' 1 second. `heapBytes` stays per isolate, so in a warm
instance it bounds the heap that calls share. `backgroundMs` and
`workerBackgroundMs` already cover work between evals, which is where
`ctx.waitUntil` work belongs. With more than one call in flight in an
isolate, per-call CPU can't be measured exactly. The watchdog measures the
thread, and interleaved continuations would have to be attributed to
calls. So concurrency inside an isolate is opt-in, and when it is on,
limits apply to the instance.

## 4. Naming

The roadmap sketch is `tenant.deploy(code, { entrypoints })` returning a
deployment with `invoke(name, ...args)`. The name is misleading.
Everywhere else, a deployment is a durable, versioned record that traffic
is routed to: Deno Subhosting's immutable deployments, Cloudflare's
deployments over versions. isolane does neither persistence nor routing. It
loads code into memory for a tenant and calls into it. Deployment is the
host platform's concept, and the serverless example has it. isolane's own
operation is loading.

isolane's API is a short set of verbs: `run`, `eval`, `isolate`, `usage`,
`stop`, `close`. The new surface should fit that set.

### Option A: `tenant.load()` returning a `Program`

```ts
const program = await tenant.load({
  main: 'src/index.ts',
  files: { 'src/index.ts': source, 'src/db.ts': db, 'package.json': pkg },
  instances: { reuse: true, min: 0, max: 4, idleMs: 30_000 },
  limits: { startupCpuMs: 1_000, cpuMs: 50 },
  env: { API_URL: 'https://api.example.com' },
  host: { db },
});

const response = await program.fetch(request);
await program.call('scheduled', [{ cron: '*/5 * * * *', scheduledTime: Date.now() }]);
program.usage();
await program.close();
```

`load` compiles and evaluates the program once, so syntax, resolution, and
top-level errors surface there. It resolves to a `Program`, an immutable
loaded program with a pool of instances. `fetch` is a preset for the common
`fetch(request, env, ctx)` handler. `call(name, args)` calls any
exported handler. A new version is another `load`, and the host swaps
references and closes the old program, which waits for in-flight calls.
The name follows Cloudflare's Worker Loader (`env.LOADER.load()`), the most
similar API in production.

### Option B: modules on isolates, no new object

```ts
const isolate = tenant.isolate({ module: { main: 'index.js', files } });
await isolate.ready;
const response = await isolate.fetch(request);
const total = await isolate.call('sum', 1, 2);
const result = await tenant.run({ main: 'index.js', files }, { call: ['sum', 1, 2] });
```

This adds nothing to the vocabulary and is the primitive any pool is built
on (the roadmap's `vm.call` idea). But it leaves pooling, warm reuse,
eviction, startup budgets, and cache sharing to every host. Those are the
parts that are hard to get right, and each platform would build them
differently.

### Option C: a named, mutable `tenant.app()`

```ts
const app = tenant.app('site', { main: 'index.js', files });
await app.fetch(request);
await app.update({ main: 'index.js', files: next });
```

This reads well in examples, and `update` hides the version swap. But it
makes isolane responsible for the overlap between versions: draining,
deciding which version a request reaches, and rollback on failure. That is
routing, which section 2 found is the host's job. A mutable name inside the
library also invites persistence questions isolane shouldn't answer.

### Recommendation

Adopt option A, built on option B. `tenant.load()` returns a `Program`
that owns warm instances and caches, and `Isolate` gains `call` and
`fetch` for hosts that want manual control. `deploy` stays a word for the
host platform. The pieces fit the existing vocabulary:

| Concept | Name |
|---|---|
| Load code for a tenant | `tenant.load(source, options)` → `Program` |
| One-off call, fresh isolate | `tenant.run(source, { call })` (classic scripts keep `run(code)`) |
| Call a handler | `program.call(name, args, options)`, `isolate.call(name, args, options)` |
| HTTP preset | `program.fetch(request)`, `isolate.fetch(request)` |
| Usage | `program.usage()` (a slice of `tenant.usage()`) |
| End | `program.close()` (drains), `[Symbol.asyncDispose]` |
| Events | the runtime's existing `eval`, `guestError`, and `limit` events, with a `program` field, plus `programLoad` |

The source is either a string, which is one ES module, or
`{ main, files }`. Files map paths to strings or bytes, and types come
from extensions (`.js`, `.mjs`, `.ts`, `.tsx`, `.jsx`, `.json`, `.wasm`)
or import attributes (`with { type: 'json' }`, `'text'`, `'bytes'`). A
prebuilt bundle is a one-file tree with an optional `.map` beside it.

## 5. Lifecycle

### Decisions (October 2026)

The warm setup was settled after the survey:

1. `tenant.load()` is warm by default. A program's instances are reused
   across calls; `instances: { reuse: false }` opts out. Fresh-per-call
   execution stays what `tenant.run()` is.
2. Setup does no I/O, as on Workers. A program's top-level code (its module
   evaluation, including top-level `await`) may not use `fetch`,
   `connect()`, `fs`, or host functions: each fails at once with a guest
   `Error` whose `code` is `ERR_SETUP_IO`, and the error says that I/O is
   allowed only inside handlers. The rule keeps cold starts bounded by CPU
   alone and makes a load's outcome independent of the network. Clients
   that connect lazily, as postgres.js does on its first query, still get a
   warm connection: it is opened by the first invoke and reused by later
   ones on the same instance.
3. A call stopped part-way, by `timeoutMs`, `cpuMs`, its signal, or running
   out of memory, retires its instance, because the program's state may be
   half-updated. A handler that throws keeps it. Stateful isolates follow
   the same rule (built: an eval stopped part-way retires its isolate, and
   its later evals fail with `ERR_ISOLATE_RETIRED`).
4. A call finishes when the handler's returned promise settles, not when
   the event loop is idle. Work the handler leaves running continues as
   background work under `backgroundMs` (built, as for evals).
   `ctx.waitUntil(promise)` marks work that `close()` and eviction wait
   for, and reports its rejection through `onGuestError`.
5. `env` is readable at module scope through
   `import { env } from 'isolane:env'`, as Workers offers
   `import { env } from 'cloudflare:workers'`, as well as being the second
   argument of `fetch`. It lands with ES modules.
6. `isolate.call` lands first (built), and the serverless example moves to
   it.

### Setup

Setup is everything an instance runs before it can serve: the web platform
from the snapshot, host functions and globals, the embedder's `setup`
shims, and then the program's own top-level code. It happens once per
instance, under its own budget: `startupCpuMs` (default 1,000) and the
isolate's `timeoutMs` for wall time. Its I/O ban (decision 2) is enforced in
the worker: the brokers and host functions check a per-isolate "in setup"
flag and refuse while it is set. If setup fails, `load` rejects with
`err.guest` pointing at the failing line when it is the first instance;
for a later instance, the call that needed it fails with the same error.
(Marking a program unhealthy after repeated failures, so later calls fail
fast, is left as an idea: with no I/O, a setup that has succeeded once
rarely fails later, and phase 1 retries the load for each call that needs
a new instance.)

As built, a refused setup operation throws an `Error` whose `code` is
`ERR_SETUP_IO` (inside `fetch`, the `TypeError` it rejects with has that
error as its `cause`). The guest may catch it and carry on. A load that
fails after a refusal rejects with `ERR_SETUP_IO`, of kind `guest`, rather
than `ERR_GUEST_EXCEPTION`, with `err.guest` as usual: the worker records
the refusal itself, so the code doesn't depend on what the guest threw.

Classic-script isolates have no such split: a stateful isolate's first
`eval` is both its setup and an ordinary eval, and may do I/O. The ban
applies to programs only.

### Invoke

An invoke is one call of a handler on an instance. It is a protocol
message of its own, `call { vm, req, name, args }`, not an eval: nothing
is compiled. For a program it goes through these steps:

1. Pick an instance: a free warm one, else a new one up to `max`, else
   queue for at most `queueMs`, else fail with `ERR_LIMIT`. At the default
   `concurrency` of 1, an instance runs one call at a time.
2. Start the call's budget: the clock advances, and `cpuMs`, `wallMs`,
   `hostCalls`, and `logBytes` count per call, as they do per eval.
3. Find the handler: a named export called `name`, then a method of the
   default export, with the default export as `this`. That covers
   `export default { fetch }`, Hono apps, and plain exported functions. A
   name that resolves to neither fails with `ERR_HANDLER_NOT_FOUND`.
4. Call it with the arguments as data, in the host-call wire format (JSON
   values, and bytes at the top level). `fetch` is a preset that builds a
   guest `Request` and calls `fetch(request, env, ctx)`.
5. Finish when the handler's returned promise settles (decision 4), and
   free the instance for the next call.
6. Return the result, checked by an optional `returns` schema, or for
   `fetch` a host `Response`. A handler that throws rejects with
   `ERR_GUEST_EXCEPTION` and `err.guest`.

`isolate.call(name, args, options)` is that message on a stateful isolate,
built ahead of programs. For a classic script, step 3 looks for an own
property of the global object that is a function (a function declaration,
or one assigned to `globalThis`); `let` and `const` bindings are not found,
and neither are inherited properties or isolane's own `__isolane_*`
functions. Steps 2 and 4 to 6 are as above, and the `before` and `after`
shims run around the call as around an eval. The signature takes the
arguments as an array, not as rest parameters, because a trailing options
object would otherwise be indistinguishable from a final argument; this
also mirrors `Function.prototype.apply` and keeps the options in the same
position as `eval(code, options)`. The `beforeCall` and `afterCall` hooks
and the `call` event observe calls.

### Instance health

An instance stays in service until one of these retires it: a call stopped
part-way (decision 3), `heapBytes`, `backgroundMs`, worker recycling, a
quarantine, or `idleMs` eviction. A retired instance is closed by the
worker as soon as the stopped call's result is sent, so calls queued
behind it fail with `ERR_ISOLATE_RETIRED`; for a program they are instead
routed to another instance. A handler's own exception, an unhandled
rejection reported through `onGuestError`, a schema mismatch, and a refused
host call all leave the instance in service.

### Loading

The supervisor hashes each file and the options that change compilation,
and sends the tree to the tenant's worker once per worker. The worker keeps
it by hash. The first instance resolves the graph with `oxc_resolver`,
strips or transforms types with oxc, compiles each module eagerly, and
saves its code cache. Then it instantiates the graph and evaluates the
main module under `startupCpuMs`. A failure here rejects `load` with
`err.guest` as for evals, with module paths as filenames. `load` resolves
once one instance is ready, or only after the compile check when `min` is
0 and `reuse` is off.

Phase 1 builds less of this. The supervisor sends the program's files (one
module so far) in a `load` message to each new instance, with no hashing
and no code cache; those come with phase 4. `load` always resolves once one
instance has loaded, also with `reuse: false`: that instance has served no
call yet, so it serves the first one, and every later call gets a fresh
instance.

### Instances

An instance is an isolate that has evaluated the program. The
`instances` options describe the policy:

- `reuse: true` (the default, decision 1): instances are kept warm and
  serve call after call, so module state persists, as on Workers. `min`
  instances are kept ready, `max` caps them, and `idleMs` evicts idle ones.
  Instances are retired as "Instance health" describes.
- `reuse: false`: each call gets a fresh instance, made from the code cache
  and evaluated anew. Module state never carries over. This is Fastly's and
  Supabase `oneshot`'s position, for a tenant whose end users must not
  share state.
- `concurrency` (only with `reuse`, default 1): calls that may run in one
  instance at once. A call goes to an idle instance, else to the least
  busy one with room, else to a new one up to `max`, else it queues, at
  most `queue` calls (default 1,000) for up to `queueMs` each, like
  Supabase's `request-wait-timeout`, then fails with `ERR_LIMIT`.

The supervisor routes calls. It already sees every eval, so it knows which
instances are busy without asking the worker.

Above 1 (built in phase 3), the worker runs an instance's calls together on
its event loop (`crates/worker/src/vm/calls.rs`), and sends each result as
soon as it settles; calls that arrive while others run join them. Each
call keeps its own wall clock: `timeoutMs` from its start. CPU can't be
told apart by call, so, as section 3 says, the other per-eval budgets
belong to the instance while its calls run: `cpuMs`, `hostCalls`, and
`logBytes` each grow by their amount for every call that joins, and once
a count limit is hit, every call that finishes before the instance goes
idle fails with it. A call stopped part-way stops all of them and retires
the instance (decision 3, applied to the instance): the calls that hit the
limit fail with it, and the rest with `ERR_ISOLATE_RETIRED`, marked not
`retryable` because they may have done part of their work. The pool's own
retry, for a call an instance refused before running it, only retries a
`retryable` one.

### Calls and their arguments

`call(name, args)` sends arguments in the host-call wire format: JSON
values with top-level bytes. When binary frames are extended to nested
values (planned, section 5 of the roadmap), arguments become structured
data. The handler is the named export, or a method of the default export
object. The default export wins only for names the module doesn't export.
The result is validated by an optional `returns` schema, as for `eval`.

`fetch(request)` builds a guest `Request` and returns a host `Response`.
Bodies are buffered, each at most `limits.bodyBytes` (default 16 MiB): the
request's crosses as the call's byte argument, and the response's as bytes
attached to the result, whose JSON is the head (status, status text,
headers). A `call` message says which kind of call it is (`kind: 'fetch'`)
and the most body bytes the worker may send back (`maxBody`), so streaming
can come later by replacing the bytes with a stream id, read through the
same byte-queue machinery as the `fetch` broker, in reverse. In the guest,
runtime/serve.js builds the `Request`, calls the handler with
`(request, env, ctx)`, lets the `after` shims see (and replace) its
`Response`, and then reads the body. `env` is the program's `env` value
with host functions mounted in it, so a binding is `env.db.query(...)`
instead of a global. `ctx.waitUntil(p)` keeps work running after the
response, under `backgroundMs`; its rejections are reported as unhandled
ones; the result says how many such promises are still running, and the
pool waits for them (a `drain` call, budgeted as an eval) before it closes
the instance. `ctx.props` and `passThroughOnException` are not offered:
there are no per-caller props yet, and there is no origin to pass
through to. `program.fetch` is for programs only: a classic script's
global `fetch` is the web platform's, so `isolate.fetch` would be
ambiguous.

### Caches and invalidation

The code cache and compiled wasm are keyed by content hash. V8 version and
flags are implied by the worker, which checks its own build as the web
snapshot header does. Nothing needs explicit invalidation: new content
means a new hash, and a new worker binary means V8 rejects the old cache
and makes a new one. The supervisor may keep the bytes per tenant, within
a `cacheBytes` budget, so recycled workers start warm. Caches are never
shared across tenants.

### Time and limits

Each call is an eval for the frozen clock and for `cpuMs`, `wallMs`,
`hostCalls`, and `logBytes`. New limits: `startupCpuMs` (default 1,000),
`modules` and `moduleBytes` for the tree, `instances` for live instances
per tenant, `queueMs`, and `bodyBytes`.

### The serverless example

The example's own deploy protocol stays its own. Today, with
`isolate.call`, a deploy creates one stateful isolate for the app, whose
`setup` shim installs a small adapter (`__platform_serve`) once, and
evaluates the app's code there; each HTTP request is
`isolate.call('__platform_serve', [incoming, body])`, which builds the
`Request`, calls `handle`, and returns the `Response` as data. A deploy
whose code fails to load is reported to the deployer and the running
version keeps serving; a redeploy swaps the app table entry and closes the
old isolate once its requests finish; a request stopped by a limit retires
the isolate, and the next request loads the app again. Warm requests take
about 1.5 to 2 ms on the dev build, against about 13 ms for the cold first
one.

Since phase 3, the app is `export default { fetch(request, env, ctx) }`,
a deploy calls `tenant.load(code)` and keeps the `Program` in the app
table, and each HTTP request becomes `program.fetch(request)`, its body
streamed from the socket into the request and bounded by `bodyBytes` (a
413 past 1 MiB). The adapter and its `Outcome` schema are gone. Each app
has up to two instances running eight requests each, since an app mostly
waits on its deployer, and it counts page views with `ctx.waitUntil`.
Redeploys of an unchanged file will reuse the cache by hash (phase 4).

## 6. Build plan

0. `isolate.call` on classic scripts, the retirement of isolates whose
   eval was stopped part-way, and the serverless example on one warm
   isolate per deploy. Done.
1. ES modules and `Program`, for single files. A single-file source is
   compiled as a module with `import.meta.url` set to its path.
   `tenant.load`, `program.call` and `program.close` land on `isolate.call`,
   with one warm instance (`reuse: true`, `max: 1`) and `reuse: false`.
   The setup I/O ban, `isolane:env`, the `startupCpuMs` limit, filenames in
   errors, and `programLoad` events come with it. The serverless example
   moves to `call('fetch', ...)` on buffered data. Done, with two parts of
   phase 3 brought forward: the pool (`min`, `max`, `idleMs`, `queueMs`,
   routed by the supervisor, with `max` defaulting to 4) and `env` with the
   host functions mounted in it. The serverless example calls an exported
   `handle` through a small adapter the platform appends to the module, so
   its line numbers are unchanged, until `program.fetch` replaces it.
2. Multi-file programs: in-worker resolution with `oxc_resolver` over the
   tree, JSON, text, and bytes modules through synthetic modules, dynamic
   `import()`, TypeScript type stripping, and the `modules` and
   `moduleBytes` limits. Done. `import()` runs in a microtask, so an
   import made while the graph evaluates can't evaluate a module ahead of
   its turn. Type stripping refuses syntax with runtime behaviour, as
   Node.js does, rather than compiling it, and the worker keeps what it
   transformed by content hash, so a program's later instances reuse it.
3. `fetch`: `program.fetch` with buffered bodies (`limits.bodyBytes`), and
   `ctx.waitUntil` (drained before an instance closes). The serverless
   example switches to `export default { fetch }`. `instances.concurrency`
   above 1 came forward from phase 6, and `instances.queue` bounds the
   number of queued calls. (The pools and `env` landed in phase 1.) Done.
4. Caches: per-worker code cache by content hash, a per-tenant compiled
   wasm cache, an optional supervisor-held copy with a `cacheBytes` budget,
   and the isolate pool.
5. Transforms and bundles: JSX and TypeScript transform mode through oxc,
   source maps for transformed code and supplied bundles, `isolane:`
   virtual modules backed by host functions, and the `modules` aliases for
   shims. Done, with `define`, `cloudflare:sockets`, and test262's module
   tests (run as programs with their fixtures). Host modules may use any
   specifier, not only `isolane:` ones, so a program can be given
   `node:events` or a package by name. The source maps apply to what the
   worker reports (`err.guest`, logged errors, syntax-error locations); the
   guest's own `error.stack` keeps V8's positions. Phases 2 and 5 left
   phase 4 a seam: `module::compile` is where a code cache is consumed and
   made.
6. Later: streaming bodies both ways, `ctx.props`, deploy-time
   type checking, RPC stubs for functions passed as arguments, and a V8
   snapshot taken after module evaluation. That last one is the V8
   counterpart of Wizer's pre-initialization: near-zero cold starts, but
   only for programs whose top level touches no host state, so it needs
   its own study.

Each phase leaves `run`, `eval`, and `isolate` unchanged, and each is
covered by the WPT, test262, and syscall-audit gates as today.
