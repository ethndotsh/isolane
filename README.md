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
- **Nothing ambient.** Guest code starts with ECMAScript, the web
  platform's APIs (no network until you allow some), and a clock that
  doesn't move while it runs. Everything else is opt-in, per isolate, and
  network and file access go through policies checked in your process.

See [docs/design.md](docs/design.md) for the threat model.

## Why isolane

The two common ways to run untrusted JavaScript from Node are
[isolated-vm](https://github.com/laverdet/isolated-vm) (V8 isolates inside
your Node process) and [quickjs-wasi](https://github.com/vercel-labs/quickjs-wasi)
(the QuickJS interpreter compiled to WebAssembly). isolane makes different
trade-offs:

| | isolane | isolated-vm | quickjs-wasi |
|---|---|---|---|
| Engine | V8 15.2, with its JIT | your Node's V8 (Node 22: 12.4, Node 26: 14.6) | QuickJS-NG, interpreted |
| Guest code runs | in a locked-down process per tenant | inside your Node process | inside your Node process, in Wasm memory |
| V8 memory sandbox | on | off (Node isn't built with it) | n/a (Wasm's bounds checks) |
| OS lockdown | seccomp and Landlock (Linux) | none | none |
| V8 security fixes | isolane patch releases, from CI | when you upgrade Node | n/a |
| Memory limit | enforced, ArrayBuffers and Wasm included | "a guideline": an attacker can use 2–3× | enforced (Wasm memory) |
| Web APIs | WinterTC: `fetch`, streams, `crypto.subtle`, `URL`, sockets, ... | none | a few (`URL`, `TextEncoder`, `crypto.subtle`) |
| Network and files | brokered, under policies checked in your process | build your own | build your own |

**Against isolated-vm:**
- **Your process stays out of reach.** In isolated-vm, a V8 bug or a leaked
  `Reference` reaches your Node process; its README calls leaked handles
  "usually trivial" to use "as a springboard back into the nodejs isolate"
  and recommends a separate process. isolane is that separate process, with
  V8's memory sandbox and seccomp around it.
- **Current V8, patched on its own schedule.** isolated-vm runs whatever V8
  your Node ships and gets V8 fixes only when you upgrade Node. isolane
  carries its own V8, and CI turns V8 security releases into patch releases.
- **Pointer compression.** Node is built without it, so pointers in an
  isolated-vm heap take twice the space they do in isolane's.
- **What a sandbox needs, built in:** CPU and wall-time limits, a limit on
  every resource, policy-checked `fetch` and sockets, typed errors with the
  guest's stack trace, and hooks.
- **No native addon:** no rebuild per Node release, no
  `--no-node-snapshot`, and odd-numbered Node releases work. isolated-vm is
  also in maintenance mode.

**Against quickjs-wasi:**
- **A JIT, not an interpreter.** On `fib(26)` (Apple M4 Pro), isolane takes
  0.69 ms and quickjs-wasi 10.5 ms, about 15× slower. Compute-heavy guest
  code (parsers, templating, crypto written in JS) feels it most.
- **The JavaScript of Chrome, Node, Deno, and Workers:** V8's language
  support, `Intl`, and WebAssembly, plus the WinterTC web platform, so code
  written for server runtimes runs unchanged.
- **A process boundary.** Wasm memory is a strong sandbox, but it runs in
  your process on your process's Wasm engine; a bug there is a bug in your
  process.

**Pick something else when:**
- You want many cheap sandboxes in your own process. isolane's floor is a
  worker process per tenant (about 15 MB) and an IPC round trip per call.
- You need live snapshots of a running VM (quickjs-wasi), or objects shared
  by reference with the host (isolated-vm).
- You need Windows, or macOS in production: isolane's lockdown is
  Linux-only.

## What guest code can use

| Option | Default | Gives the guest |
|---|---|---|
| `host` | none | Your functions, optionally in namespaces (`db.getUser`) |
| `globals` | none | JSON data as globals |
| `web` | on | The web platform: `URL`, `fetch`, streams, timers, `crypto.subtle`, ... ([WinterTC](https://wintertc.org) Minimum Common API). `false` leaves plain ECMAScript |
| `fetch` | off | HTTP(S) to the hosts you list |
| `connect` | off | TCP/TLS sockets (Workers' `connect()`) to the `host:port`s you list |
| `fs` | off | Files under one directory, read-only unless you allow writes |
| `eval` | off | `eval` and `new Function` |
| `wasm` | off | WebAssembly |
| `time` | `'frozen'` | A clock that only moves at I/O, the real clock, or a fixed time |
| `random` | OS | Seeded randomness, for reproducible runs |

`web` passes 99.6% of the applicable web-platform-tests, and the engine 98.8% of the applicable test262 runs; see the [guide](docs/guide.md#web-platform-conformance).

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
  defaults: { limits: { timeoutMs: 10_000 } },
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
guest's `name`, `message`, and `stack`, parsed `frames` in named scripts,
`cause` chains, and a SyntaxError's location; a failed host call's points
at the guest line that made it. Errors nothing handled (in timers,
unhandled rejections) arrive as `onGuestError` events.

```js
try {
  await acme.run(code);
} catch (err) {
  if (err.kind === 'guest') console.log(err.guest.stack, err.guest.frames[0]); // { function, file, line, column }
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
