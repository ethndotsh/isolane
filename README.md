# isolane

Run untrusted, multi-tenant JavaScript from Node, in sandboxed V8 worker
processes. The goal is Cloudflare Workers' safety posture, installable with
`npm install`.

> **Status: early development. Not ready for untrusted code yet.** The
> security gate (an external review, a fuzzing program, a written threat-model
> sign-off) hasn't been met, and there's no release on npm yet.

```js
import { Runtime } from 'isolane';

using runtime = new Runtime();
const acme = runtime.tenant('acme');

await acme.run('1 + 2'); // 3

// Inputs go in as data, never spliced into code.
await acme.run('order.items.length', { globals: { order } });

// The guest calls functions you provide; it gets nothing else.
await acme.run('db.getUser(42).then((u) => u.plan)', {
  host: { db: { getUser: async (id) => users.find(id) } },
});
```

## How it isolates

- **A process per tenant.** Each tenant's code runs in its own worker
  process; each `isolate()` is a separate V8 isolate inside it.
- **V8's sandbox, then the OS.** V8 is built with its memory sandbox on, and
  each worker locks itself down before running guest code: seccomp and
  Landlock on Linux. It can't open files or sockets, start processes, or see
  the environment.
- **Nothing ambient.** Guest code starts with plain ECMAScript and a clock
  that doesn't move while it runs. Everything else is opt-in, per isolate,
  and network and file access go through policies checked in your process.

See [docs/design.md](docs/design.md) for the threat model.

## What guest code can use

| Option | Default | Gives the guest |
|---|---|---|
| `host` | none | Your functions, optionally in namespaces (`db.getUser`) |
| `globals` | none | JSON data as globals |
| `web` | off | The web platform: `URL`, `fetch`, streams, timers, `crypto`, ... ([WinterTC](https://wintertc.org) Minimum Common API) |
| `fetch` | off | HTTP(S) to the hosts you list |
| `connect` | off | TCP/TLS sockets (Workers' `connect()`, with `web`) to the `host:port`s you list |
| `fs` | off | Files under one directory, read-only unless you allow writes |
| `eval` | off | `eval` and `new Function` |
| `wasm` | off | WebAssembly |
| `time` | `'frozen'` | A clock that only moves at I/O, the real clock, or a fixed time |
| `random` | OS | Seeded randomness, for reproducible runs |

`web` passes 99.0% of the applicable web-platform-tests; see the [guide](docs/guide.md#web-platform-conformance).

```js
await acme.run(
  `const r = await fetch('https://api.example.com/plans');
   await fs.writeFile('/plans.json', await r.text());`,
  {
    web: true,
    fetch: { hosts: ['api.example.com'], limits: { requests: 10 } },
    fs: { root: '/srv/tenants/acme', write: true },
  },
);
```

The worker still can't open a socket or a file: `fetch`, `connect`, and `fs`
are carried out by your process after checking the policy. Private and cloud
metadata addresses are refused unless you allow them, on the address
actually connected to.

## Host functions

A plain function works. `hostFunction` adds argument and return validation
with any [Standard Schema](https://standardschema.dev) library (Zod, Valibot,
ArkType, ...), with types inferred from the schemas, plus a call context.

```ts
import { hostFunction } from 'isolane';
import { z } from 'zod';

const getUser = hostFunction({
  args: [z.number().int().positive()], // checked before the handler runs
  returns: User,                       // checked before the guest sees it
  handler: (id, ctx) => repo(ctx.tenant).users.get(id, { signal: ctx.signal }),
});

const order = await acme.run('placeOrder()', { host: { getUser }, returns: Order }); // typed as Order
```

Bad arguments reach the guest as a `TypeError`. `ctx.signal` aborts when
nobody is waiting any more (the eval timed out, or the isolate closed).

## Configuration

One config shape, set at three levels: the runtime's `defaults`, each
tenant's (`tenants(name)`, for example by plan), and each call. Later levels
win, field by field.

```js
const runtime = new Runtime({
  defaults: { web: true, limits: { timeoutMs: 10_000 } },
  tenants: (name) => (isPro(name) ? { limits: { isolates: 200 } } : undefined),
});
await runtime.tenant('acme').run(code, { limits: { timeoutMs: 500 } });
```

Every resource has a limit with a safe default (30 s per eval, 128 MiB of
heap, 100 isolates per tenant, ...); hitting one fails with `ERR_LIMIT`.
[docs/guide.md](docs/guide.md) lists them all.

## Hooks

Interceptors can refuse or change what happens; events observe.

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
`limit`, `usage`, `security`, `infrastructure`). Guest exceptions carry the
guest's `name`, `message`, and `stack`.

```js
try {
  await acme.run(code);
} catch (err) {
  if (err.kind === 'guest') console.log(err.guest.stack);
  if (err.code === 'ERR_LIMIT') console.log('hit', err.limit);
}
```

## More

- [docs/guide.md](docs/guide.md): every option, limit, hook, and error code;
  shims; stateful isolates; usage accounting; known limits.
- [docs/design.md](docs/design.md): threat model and architecture.
- [docs/roadmap.md](docs/roadmap.md): what's done and what's next.
- [examples/serverless](examples/serverless): a small serverless platform.
- [SECURITY.md](SECURITY.md): reporting vulnerabilities.

## Building

V8 is compiled from source, because no published rusty_v8 build has the V8
sandbox enabled. Requirements: Linux x64 with libclang 21 (apt.llvm.org), or
macOS with full Xcode.

```sh
scripts/fetch-rusty-v8.sh   # pinned rusty_v8 + V8 sources into build/
scripts/build-v8.sh         # worker binary at target/release/isolane-worker
npm install && npx tsc
ISOLANE_WORKER=$PWD/target/release/isolane-worker npm test
```

Without building V8 (any platform, development only):

```sh
cargo build --profile fast -p isolane-worker --no-default-features --features dev-prebuilt
ISOLANE_DEV_INSECURE=1 ISOLANE_WORKER=$PWD/target/fast/isolane-worker npm test
```

That links rusty_v8's prebuilt V8, which has no V8 sandbox or clock patch,
so it needs `strict: false`. An edit rebuilds in about a second.
