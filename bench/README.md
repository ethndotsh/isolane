# Benchmarks

| Script | Measures |
|---|---|
| `compare.mjs` | isolane against isolated-vm, `node:vm` contexts, and `worker_threads`: memory for 1–1,000 live sandboxes, cold start, call and host-call latency |
| `cold-start.mjs` | a new tenant's time to first result, with and without spare workers |
| `web-cost.mjs` | what the web platform adds to isolate creation, first API use, and memory |
| `protocol.mjs` | supervisor ↔ worker round trips |
| `program-load.mjs` | a program's instance loads, first and later (what the worker's files, code cache, and spare isolates save), for a module of your own or zod bundled by esbuild |

## compare.mjs

Every contender gets the same workload: an object graph of 256 small objects
(about 40 KB of heap) and a function `f`. For each contender the script
measures three things.

- **Memory** for 1, 10, 100, and 1,000 live sandboxes (`--levels`).
  - It's the whole process tree: the contender's process plus isolane's
    workers. Both RSS and, on Linux, PSS are reported; PSS counts shared
    pages once, split across the processes mapping them.
  - Each reading is taken after a GC and a settle.
  - It also reports the memory per extra sandbox, the slope between the two
    largest levels.
- **Cold start**: a new sandbox to its first result. For isolane that's a new
  isolate in a running tenant's worker. The "one tenant each" variant
  measures a new worker process instead.
- **Latency**:
  - a call into a warm sandbox;
  - a host function called 1,000 times from inside the sandbox, sync or
    async, whichever each contender supports.

Each contender runs in its own `node --expose-gc` child process.

The numbers only mean something on the Linux release worker, which has the
V8 sandbox and pointer compression. The dev worker (`--features
dev-prebuilt`) has neither, so on it the script is a smoke test.

```sh
npm install --prefix bench   # isolated-vm (optional: skipped if absent)
ISOLANE_WORKER=... node bench/compare.mjs --summary out.md --json out.json
```

CI runs it after every green CI run on main, and on demand (`gh workflow run
Bench`), against that run's worker. The table appears in the job summary,
and the full numbers in the `bench` artifact. Numbers quoted in the README
should come from there.
