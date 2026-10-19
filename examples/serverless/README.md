# Serverless platform example

A toy serverless platform built on isolane, to show the shape of one:

- **Deployers keep their backend.** A deployer connects over a WebSocket,
  deploys guest code, and serves that code's host functions from their own
  process. When the guest calls `getUser(42)`, the platform forwards the
  call over the deployer's socket and returns the reply to the guest.
- **Every app is a tenant.** Each app runs in its own sandboxed worker
  process, and every HTTP request in a fresh isolate, with time and memory
  limits, a frozen clock, and no network unless the deploy asks for hosts.
- **Logs stream back.** The guest's `console` output goes to its deployer.
- **Scaling** is horizontal: platform nodes keep no state beyond the
  deployer connections, so more nodes behind a load balancer (with deployers
  connected to each, or a broker in between) handle more traffic.

```sh
cd examples/serverless && npm install
ISOLANE_WORKER=/path/to/isolane-worker node platform.mjs   # terminal 1
node deployer.mjs                                          # terminal 2
curl 'http://localhost:8787/hello/?id=1'                   # terminal 3
```

This is a demo, not a product: deployers aren't authenticated, apps live only
as long as their deployer's connection, and a request's guest code is
re-compiled every time (a real platform would keep warm isolates).
