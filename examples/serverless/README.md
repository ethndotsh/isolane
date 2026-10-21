# Serverless platform example

A small serverless platform on isolane, in TypeScript (Node ≥ 22.18 runs it
directly; no build step).

Deployers keep their backend. A deployer connects over a WebSocket,
deploys an app, and serves the app's host functions from its own process.
When the app calls `env.getUser(42)`, the platform forwards the call to the
deployer and returns the reply; if the app stops waiting (it timed out),
the deployer is told to cancel.

Apps are Workers-style fetch handlers. An app is an ES module whose default
export has `fetch(request, env, ctx)`: it gets a spec `Request`, returns a
`Response`, finds its deployer's host functions in `env`, and can keep work
running after the response with `ctx.waitUntil`. It has the web platform,
with relative URLs resolved against its own origin.

Every app is a tenant, kept warm. Each app runs in its own sandboxed worker
process. A deploy loads the app as a program (`tenant.load()`), and each
HTTP request goes to it with `program.fetch(request)`. Its instances
evaluate the module once and serve request after request, eight at a time
in each of up to two instances, since an app mostly waits on its deployer.
A deploy whose code fails to load is reported to the deployer and the
running version keeps serving; a request stopped by a limit retires its
instance, and the program loads a fresh one. Request and response bodies
are limited to 1 MiB (`limits.bodyBytes`); a larger request gets a 413.

The host API is defined once (`src/host-api.ts`): the deployer implements
it, and the app is type-checked against it. Messages from deployers are
untrusted, so the platform parses them with Zod schemas
(`src/protocol.ts`).

| File | |
|---|---|
| `src/platform.ts` | HTTP and WebSocket endpoints, the app registry, error-to-status mapping |
| `src/warm.ts` | A deployed app's program: loading it, and sending it each request (`program.fetch`) |
| `src/connection.ts` | One deployer's connection: remote host calls, timeouts, cancellation |
| `src/protocol.ts` | The wire protocol, as schemas |
| `src/host-api.ts` | The host API, shared by the deployer and the app |
| `src/deployer.ts` | The deployer: strips the app's types, deploys it, serves the host API |
| `app/index.ts`, `app/env.d.ts` | The app, and the host API as it sees it |

```sh
npm install
ISOLANE_WORKER=/path/to/isolane-worker npm run platform   # terminal 1
npm run deploy                                             # terminal 2 (npm run dev redeploys on save)
curl 'http://localhost:8787/hello/?id=1'                   # terminal 3 (?id=0 shows a 500)
npm run typecheck
```

With a development worker (no full lockdown), start the platform with
`ISOLANE_STRICT=0 ISOLANE_DEV_INSECURE=1`.

This is a demo, not a product: deployers aren't authenticated, apps live only
as long as their deployer's connection, and bodies are buffered whole.
