# isolane

isolane runs untrusted, multi-tenant JavaScript from Node.js. Each tenant's
code runs in its own sandboxed V8 worker process, and guest code gets only
the capabilities you grant it.

> **Status:** early development; not yet suitable for untrusted code. The
> release gate (external review, fuzzing, threat-model sign-off) is tracked
> in [SECURITY.md](SECURITY.md). No version has been published to npm.

The examples use `using` (TypeScript 5.2 or later, or Node.js 24); with
plain JavaScript on Node.js 22, call `runtime.close()` instead.

```js
import { Runtime } from 'isolane';

using runtime = new Runtime();
const acme = runtime.tenant('acme');

await acme.run('1 + 2'); // 3

// Inputs are passed as data, never interpolated into code.
await acme.run('order.items.length', { globals: { order } });

// Guest code can call the functions you provide, and nothing else.
await acme.run('db.getUser(42).then((u) => u.plan)', {
  host: { db: { getUser: async (id) => users.find(id) } },
});

// A program is an ES module loaded once into a pool of warm instances.
// program.fetch calls its Workers-style fetch handler with a Request;
// program.call invokes any of its exports with data.
await using app = await acme.load(`
  export default {
    async fetch(request, env) {
      const id = Number(new URL(request.url).searchParams.get('id'));
      return Response.json(await env.db.getUser(id));
    },
  };
`, { host: { db: { getUser: async (id) => users.find(id) } } });
const response = await app.fetch('https://acme.example/users?id=42');
```

A program's top-level code is its setup: it runs once per instance, under
its own CPU budget, and can't do I/O, which belongs in its handlers.
Instances keep module state between calls and serve one call at a time,
or several with `instances.concurrency`; the pool starts more as calls
need them, queues calls when all are full, and replaces an instance that a
limit stopped. A fetch handler's `ctx.waitUntil` keeps work running after
its response. A program can be many files, `{ main, files }`, with
packages under `node_modules`, TypeScript, JSX, and JSON; the worker
resolves its imports over those files and compiles them, and errors point
at the original sources. See [Programs](docs/guide.md#programs).

## Security model

- One worker process per tenant, with one V8 isolate per `isolate()`.
- V8 is built with its memory sandbox enabled. Before running guest code,
  each worker applies seccomp and Landlock (Linux), which prevent it from
  opening files or sockets, creating processes, or reading the environment.
- Guest code starts with ECMAScript, the web platform APIs, and a clock that
  advances only between I/O operations. Network and filesystem access are
  disabled by default; when enabled, every request is checked against a
  policy in the host process.

The threat model is described in [docs/design.md](docs/design.md).

## Comparison

[isolated-vm](https://github.com/laverdet/isolated-vm) runs V8 isolates
inside the Node.js process.
[quickjs-wasi](https://github.com/vercel-labs/quickjs-wasi) runs the QuickJS
interpreter compiled to WebAssembly, also inside the Node.js process.

| | isolane | isolated-vm | quickjs-wasi |
|---|---|---|---|
| Engine | V8 15.2 (JIT) | the host's V8 (12.4 in Node 22, 14.6 in Node 26) | QuickJS-NG (interpreter) |
| Process | separate, per tenant | host process | host process |
| V8 sandbox | enabled | not enabled in Node builds | not applicable |
| OS-level restrictions | seccomp, Landlock | none | none |
| V8 security updates | isolane releases | Node.js releases | not applicable |
| Memory limit | enforced, including ArrayBuffers and Wasm | approximate | enforced |
| Web APIs | WinterTC Minimum Common API | none | partial |
| Network and filesystem | policy-checked brokers | not provided | not provided |

Compared with isolated-vm:

- A V8 vulnerability, or a leaked `Reference`, gives guest code access to
  the host process. isolated-vm's documentation recommends running it in a
  separate process for this reason; isolane always does, and adds V8's
  sandbox and seccomp.
- isolated-vm uses the V8 version of the Node.js release it runs on, and
  receives V8 fixes only through Node.js upgrades. isolane ships its own V8
  build and publishes a patch release for each V8 security update.
- Node.js is built without pointer compression, so isolated-vm heaps use
  larger pointers than isolane's.
- isolated-vm's `memoryLimit` is documented as a guideline that hostile code
  can exceed by two to three times.
- isolane is not a native addon, so it does not need rebuilding for each
  Node.js release. isolated-vm is in maintenance mode.

Compared with quickjs-wasi:

- V8's JIT is substantially faster on compute-bound code. On `fib(26)` on an
  Apple M4 Pro, isolane takes 0.69 ms and quickjs-wasi 10.5 ms.
- Guest code runs on the same engine as Chrome, Node.js, Deno, and
  Cloudflare Workers, with `Intl`, WebAssembly, and the full WinterTC API
  set.
- WebAssembly bounds checks isolate quickjs-wasi's memory, but it still runs
  in the host process, on the host's WebAssembly engine.

Other tools fit better when you need many inexpensive in-process sandboxes
(isolane's minimum is one worker process per tenant, about 15 MB, and an
IPC round trip per call), snapshots of a running VM (quickjs-wasi), objects
shared by reference with the host (isolated-vm), or Windows support.

## Guest capabilities

| Option | Default | Provides |
|---|---|---|
| `host` | none | Host functions, optionally namespaced (`db.getUser`) |
| `globals` | none | JSON values as globals |
| `web` | on | The [WinterTC](https://wintertc.org) Minimum Common API: `fetch`, `URL`, streams, timers, `crypto.subtle`, ... `false` leaves plain ECMAScript |
| `fetch` | off | HTTP(S) requests to listed hosts |
| `connect` | off | TCP and TLS sockets (the Sockets API) to listed `host:port` pairs |
| `fs` | off | Files under one directory; read-only unless writes are enabled |
| `eval` | off | `eval` and `new Function` |
| `wasm` | off | WebAssembly |
| `time` | `'frozen'` | A frozen clock, the real clock, or a fixed time |
| `random` | OS | Seeded randomness for reproducible runs |

The web platform passes 99.6% of the applicable web-platform-tests, and the
engine 98.8% of the applicable test262 runs. See
[conformance](docs/guide.md#web-platform-conformance).

```js
await acme.run(
  `const r = await fetch('https://api.example.com/plans');
   await fs.writeFile('/plans.json', await r.text());`,
  {
    fetch: { hosts: ['api.example.com'], limits: { requests: 10 } },
    fs: { root: '/srv/tenants/acme', write: true },
  },
);
```

The worker never opens sockets or files itself. The host process performs
`fetch`, `connect`, and `fs` operations after checking them against the
policy. Private and cloud metadata addresses are refused unless explicitly
allowed, and the check applies to the address actually connected to.

## Host functions

Host functions can be plain functions. `hostFunction` adds argument and
return validation with any [Standard Schema](https://standardschema.dev)
library (Zod, Valibot, ArkType), infers types from the schemas, and passes a
call context.

```ts
import { hostFunction } from 'isolane';
import { z } from 'zod';

const getUser = hostFunction({
  args: [z.number().int().positive()],
  returns: User,
  handler: (id, ctx) => repo(ctx.tenant).users.get(id, { signal: ctx.signal }),
});

const order = await acme.run('placeOrder()', { host: { getUser }, returns: Order });
```

Invalid arguments reach the guest as a `TypeError`. `ctx.signal` is aborted
when the result is no longer needed, for example after a timeout.

## Configuration

Configuration is set at three levels, merged field by field: runtime
defaults, per-tenant settings, and per-call options.

```js
const runtime = new Runtime({
  defaults: { limits: { timeoutMs: 10_000 } },
  tenants: (name) => (isPro(name) ? { limits: { isolates: 200 } } : undefined),
});
await runtime.tenant('acme').run(code, { limits: { timeoutMs: 500 } });
```

Every resource has a limit with a default, such as 30 seconds per
evaluation, 128 MiB of heap, and 100 isolates per tenant. Exceeding most
limits fails the evaluation with `ERR_LIMIT`, and every limit reached emits
`onLimit`. An evaluation stopped part-way by a time or CPU limit, or by its
abort signal, retires its isolate, since its state may be inconsistent. The [guide](docs/guide.md#limits) lists every limit and its
effect.

## Hooks

Interceptors can allow, modify, or deny an operation; events are
notifications.

```js
import { deny } from 'isolane';

const runtime = new Runtime({
  hooks: {
    beforeHostCall: ({ tenant, name }) => (quota.exceeded(tenant, name) ? deny('over quota') : undefined),
    onLog: ({ tenant, message }) => console.log(`[${tenant}]`, message),
    onSecurityEvent: ({ tenant, kind }) => alert(tenant, kind),
  },
});
```

## Errors

Every failure is an `IsolaneError` with a `code` and a `kind` (`guest`,
`limit`, `usage`, `security`, or `infrastructure`). Guest exceptions include
the name, message, stack, parsed frames, `cause` chain, and, for syntax
errors, the source location. Uncaught errors outside an evaluation are
reported through `onGuestError`.

```js
try {
  await acme.run(code);
} catch (err) {
  if (err.kind === 'guest') console.log(err.guest.stack, err.guest.frames[0]);
  if (err.code === 'ERR_LIMIT') console.log('limit reached:', err.limit);
}
```

## Documentation

- [Guide](docs/guide.md): options, limits, hooks, error codes, shims,
  stateful isolates, usage accounting, and known limitations.
- [Design](docs/design.md): architecture and threat model.
- [Roadmap](docs/roadmap.md)
- [Serverless example](examples/serverless)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md): the Rust style the worker follows.

## Building from source

V8 is built from source, because no published rusty_v8 build enables the V8
sandbox. Building requires Linux x64 with libclang 21, or macOS with Xcode.
Linux arm64 workers are cross-compiled on x64; see
`.github/actions/build-worker` for the toolchain setup.

```sh
scripts/fetch-rusty-v8.sh   # rusty_v8 and V8 sources, into build/
scripts/build-v8.sh         # target/release/isolane-worker
npm install && npx tsc
ISOLANE_WORKER=$PWD/target/release/isolane-worker npm test
```

For development without building V8, link rusty_v8's prebuilt V8. It has no
V8 sandbox, so it requires `strict: false` and `ISOLANE_DEV_INSECURE=1`:

```sh
scripts/build-worker.sh fast --no-default-features --features dev-prebuilt
ISOLANE_DEV_INSECURE=1 ISOLANE_WORKER=$PWD/target/fast/isolane-worker npm test
```

## License

[MIT](LICENSE). Third-party components are listed in
[THIRD_PARTY.md](THIRD_PARTY.md).
