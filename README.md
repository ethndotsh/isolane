# isolane

Run untrusted, multi-tenant JavaScript from Node in sandboxed V8 worker
processes. The goal is Cloudflare Workers' safety posture, installable with
`npm install`. See [docs/design.md](docs/design.md) for the threat model and
architecture.

> **Status: early development. Not ready for untrusted code.** The design's
> security gate (phase 5: V8 patch pipeline, fuzzing, external review) is
> not met, and there are no published packages yet.

```js
import { LanePool } from 'isolane';

const pool = new LanePool({ strict: true });
await pool.run('1 + 2', { tenant: 'acme' }); // 3

const vm = pool.createVm({
  tenant: 'acme',
  timeoutMs: 1000,
  memoryLimitBytes: 64 << 20,
  hostFunctions: { getUser: async (id) => db.users.find(id) },
});
await vm.eval('getUser(42).then((u) => u.plan)');
vm.dispose();
```

Each tenant gets its own worker process. Inside it, each VM is its own V8
isolate, built with the V8 sandbox enabled. Workers lock themselves down
before running guest code: Landlock and seccomp on Linux. In strict mode the
pool refuses hosts where that lockdown can't be applied
(`pool.isolationReport()` shows what a host provides).

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
