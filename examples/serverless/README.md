# Serverless platform example

A small serverless platform on isolane, in TypeScript (Node ≥ 22.18 runs it
directly; no build step).

- **Deployers keep their backend.** A deployer connects over a WebSocket,
  deploys an app, and serves the app's host functions from its own process.
  When the app calls `getUser(42)`, the platform forwards the call to the
  deployer and returns the reply; if the app stops waiting (it timed out),
  the deployer is told to cancel.
- **Apps are fetch handlers.** An app defines
  `async function handle(request: Request): Promise<Response>` and gets the
  web platform (`web`), with relative URLs resolved against its own origin.
- **Every app is a tenant, kept warm.** Each app runs in its own sandboxed
  worker process. A deploy evaluates the app's code once in a stateful
  isolate, and each request calls its `handle` there with `isolate.call`,
  so no code is compiled per request. A deploy whose code fails to load is
  reported to the deployer and the running version keeps serving; a
  request stopped by a limit retires the isolate, and the next request
  loads the app again.
- **Typed end to end.** The host API is defined once (`src/host-api.ts`):
  the deployer implements it, and the app is type-checked against it.
  Messages from deployers are untrusted, so the platform parses them with
  Zod schemas (`src/protocol.ts`), and the app's response is checked with
  `returns` before the platform uses it.

| File | |
|---|---|
| `src/platform.ts` | HTTP and WebSocket endpoints, the app registry, error-to-status mapping |
| `src/warm.ts` | A deployed app's warm isolate: loading it, and running each request (a real `Request` in, the app's `Response` out, through a `setup` shim) |
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
as long as their deployer's connection, and each app has one warm isolate,
so its requests run one at a time (`tenant.load()`, in the roadmap, will
keep a pool).
