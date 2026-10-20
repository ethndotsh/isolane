// isolane against the other ways to run JavaScript apart in Node: memory
// for many live sandboxes, cold start, and per-call latency, with the same
// workload in each. Meaningful on the Linux release worker (V8 sandbox and
// pointer compression); the dev worker gives smoke-test numbers only.
//
//   npm install --prefix bench          # isolated-vm (optional; skipped if absent)
//   ISOLANE_WORKER=... node bench/compare.mjs [--json out.json] [--summary out.md]
//     [--only isolane,node-vm,...] [--levels 1,10,100,1000] [--samples 30]
//
// Each contender runs in its own child process (fresh heap, nothing shared),
// started with --expose-gc. Memory is the child plus every process it
// started (isolane's workers), RSS and, on Linux, PSS (shared pages split
// between the processes that map them), after a GC and a settle.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const LEVELS = opt('levels', '1,10,100,1000').split(',').map(Number);
const SAMPLES = Number(opt('samples', 30));
const strict = process.env.ISOLANE_STRICT !== '0';

// The same in every sandbox: an object graph (~40 KB of heap) and a function.
const WORKLOAD = `globalThis.data = Array.from({ length: 256 }, (_, i) => ({ id: i, name: 'item-' + i, tags: ['a', 'b', 'c'], nested: { x: i, y: [i, i + 1] } }));
globalThis.f = (x) => data.length + x;`;
const HOST_CALLS = 1000;
const asyncLoop = (fn) => `(async () => { for (let i = 0; i < ${HOST_CALLS}; i++) await ${fn}(); return 1; })()`;
const syncLoop = (fn) => `(() => { for (let i = 0; i < ${HOST_CALLS}; i++) ${fn}(); return 1; })()`;

/** Contenders: how to make a sandbox, call into it, and have it call out. */
const CONTENDERS = {
  async isolane(variant) {
    const { Runtime, hostFunction } = await import('../dist/index.js');
    const web = variant !== 'isolane-noweb';
    const perTenant = variant === 'isolane-tenants';
    const rt = new Runtime({
      strict,
      // Room for every level: 1,000 isolates in one worker, or 100 workers.
      defaults: { limits: { isolates: 2_000, workerMemoryBytes: 16 * 1024 ** 3 } },
      limits: { tenants: 2_000 },
    });
    const host = { ping: () => 1, pingSync: hostFunction({ handler: () => 1, sync: true }) };
    let n = 0;
    const warm = rt.tenant('warm');
    if (!perTenant) await warm.run('1', { web }); // the worker the isolates share
    return {
      max: perTenant ? 100 : Infinity,
      facts: isolaneFacts(),
      async create() {
        const iso = (perTenant ? rt.tenant(`t${n++}`) : warm).isolate({ web, host });
        await iso.eval(`${WORKLOAD}; 1`);
        return iso;
      },
      call: (iso) => iso.eval('f(1)'),
      hostCalls: {
        async: (iso) => iso.eval(asyncLoop('ping')),
        sync: (iso) => iso.eval(syncLoop('pingSync')),
      },
      async dispose(iso) {
        iso.close();
        // A per-tenant sandbox owns its worker: stop it, so the next one is cold.
        if (perTenant) rt.tenant(`t${n - 1}`).stop();
      },
      close: () => rt.close(),
    };
  },

  async 'isolated-vm'() {
    const { default: ivm } = await import('isolated-vm');
    return {
      max: Infinity,
      facts: { ...nodeFacts(), isolatedVm: JSON.parse(readFileSync(new URL('./node_modules/isolated-vm/package.json', import.meta.url))).version },
      async create() {
        const isolate = new ivm.Isolate({ memoryLimit: 128 });
        const context = await isolate.createContext();
        await context.global.set('ping', new ivm.Callback(() => 1));
        await context.eval(WORKLOAD);
        return { isolate, context };
      },
      call: (s) => s.context.eval('f(1)'),
      hostCalls: { sync: (s) => s.context.eval(syncLoop('ping')) },
      dispose: (s) => s.isolate.dispose(),
      close() {},
    };
  },

  async 'node-vm'() {
    const vm = await import('node:vm');
    return {
      max: Infinity,
      facts: nodeFacts(),
      async create() {
        const context = vm.createContext({ ping: () => 1 });
        vm.runInContext(WORKLOAD, context);
        return context;
      },
      call: async (c) => vm.runInContext('f(1)', c),
      hostCalls: { sync: async (c) => vm.runInContext(syncLoop('ping'), c) },
      dispose() {},
      close() {},
    };
  },

  async worker_threads() {
    const { Worker } = await import('node:worker_threads');
    // The guest's `ping` posts to the parent and waits for its answer.
    const source = `
      const { parentPort } = require('node:worker_threads');
      let pong;
      globalThis.ping = () => new Promise((r) => { pong = r; parentPort.postMessage({ ping: true }); });
      parentPort.on('message', async (m) => {
        if (m.pong) return pong(1);
        parentPort.postMessage({ id: m.id, value: await (0, eval)(m.code) });
      });`;
    return {
      max: 100,
      facts: nodeFacts(),
      async create() {
        const worker = new Worker(source, { eval: true });
        const waiting = new Map();
        let id = 0;
        worker.on('message', (m) => (m.ping ? worker.postMessage({ pong: true }) : (waiting.get(m.id)(m.value), waiting.delete(m.id))));
        const run = (code) => new Promise((resolve) => (waiting.set(++id, resolve), worker.postMessage({ id, code })));
        await run(`${WORKLOAD}; 1`);
        return { worker, run };
      },
      call: (w) => w.run('f(1)'),
      hostCalls: { async: (w) => w.run(asyncLoop('ping')) },
      dispose: (w) => w.worker.terminate(),
      close() {},
    };
  },
};
CONTENDERS['isolane-noweb'] = CONTENDERS.isolane;
CONTENDERS['isolane-tenants'] = CONTENDERS.isolane;
const ORDER = ['isolane', 'isolane-noweb', 'isolane-tenants', 'isolated-vm', 'node-vm', 'worker_threads'];
const LABELS = {
  isolane: 'isolane (isolates in one tenant)',
  'isolane-noweb': 'isolane, web: false',
  'isolane-tenants': 'isolane (one tenant each)',
  'isolated-vm': 'isolated-vm',
  'node-vm': 'node:vm contexts',
  worker_threads: 'worker_threads',
};

function nodeFacts() {
  const v = process.config.variables;
  return { node: process.version, v8: process.versions.v8, pointerCompression: !!v.v8_enable_pointer_compression, sandbox: !!v.v8_enable_sandbox };
}

function isolaneFacts() {
  try {
    // Exits non-zero when the sandbox isn't secure (the dev build); the report is the same.
    const check = JSON.parse(spawnSync(process.env.ISOLANE_WORKER, ['--self-check'], { encoding: 'utf8' }).stdout);
    // The V8 sandbox needs pointer compression, so a sandboxed worker has it;
    // the dev build (rusty_v8's stock prebuilt) has neither.
    return { node: process.version, v8: check.v8, pointerCompression: check.sandboxEnabled, sandbox: check.sandboxEnabled, webSnapshot: check.webSnapshot };
  } catch {
    return { node: process.version };
  }
}

// ---- measuring ----

const gc = () => globalThis.gc?.();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

/** This process and everything it started: RSS and (Linux) PSS, in KiB. */
function treeMemory() {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number));
  const pids = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of rows) if (pids.has(ppid) && !pids.has(pid)) pids.add(pid), (grew = true);
  }
  let rss = 0;
  let pss = 0;
  for (const [pid, , kib] of rows) {
    if (!pids.has(pid)) continue;
    rss += kib;
    try {
      pss += Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))[1]);
    } catch {
      pss = NaN; // not Linux
    }
  }
  return { processes: pids.size, rssKiB: rss, pssKiB: pss };
}

async function sample(n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn();
    out.push(performance.now() - t);
  }
  return { p50: pct(out, 50), p95: pct(out, 95) };
}

async function measure(name) {
  const c = await CONTENDERS[name](name);
  const result = { contender: name, facts: c.facts };

  // Cold start: a brand-new sandbox to its first result, then thrown away.
  await (async () => c.dispose(await c.create()))(); // warm the code paths
  result.coldStartMs = await sample(Math.min(SAMPLES, c.max), async () => c.dispose(await c.create()));

  // Latency, on one warm sandbox.
  const one = await c.create();
  for (let i = 0; i < 200; i++) await c.call(one);
  result.callMs = await sample(SAMPLES * 20, () => c.call(one));
  result.hostCallUs = {};
  for (const [kind, loop] of Object.entries(c.hostCalls)) {
    await loop(one);
    const t = await sample(5, () => loop(one));
    result.hostCallUs[kind] = { p50: (t.p50 * 1000) / HOST_CALLS, p95: (t.p95 * 1000) / HOST_CALLS };
  }
  await c.dispose(one);

  // Memory: sandboxes kept alive, level by level.
  gc();
  await settle(1000);
  const base = treeMemory();
  result.memory = { base, levels: [] };
  const live = [];
  for (const level of LEVELS.filter((l) => l <= c.max)) {
    while (live.length < level) live.push(await c.create());
    gc();
    await settle(1500);
    result.memory.levels.push({ sandboxes: level, ...treeMemory() });
  }
  const [a, b] = result.memory.levels.slice(-2);
  if (a && b) {
    result.memory.perSandboxKiB = {
      rss: (b.rssKiB - a.rssKiB) / (b.sandboxes - a.sandboxes),
      pss: (b.pssKiB - a.pssKiB) / (b.sandboxes - a.sandboxes),
      between: [a.sandboxes, b.sandboxes],
    };
  }
  for (const s of live) await c.dispose(s);
  c.close();
  return result;
}

// ---- child: one contender ----

if (args[0] === '--child') {
  const result = await measure(args[1]).catch((err) => ({ contender: args[1], error: String(err?.stack ?? err) }));
  process.stdout.write(`\n@@RESULT ${JSON.stringify(result)}\n`);
  process.exit(0);
}

// ---- parent: every contender, one child each ----

const only = opt('only')?.split(',');
const results = [];
for (const name of ORDER.filter((n) => !only || only.includes(n))) {
  if (name === 'isolated-vm') {
    try {
      await import('isolated-vm');
    } catch {
      results.push({ contender: name, skipped: 'not installed (npm install --prefix bench)' });
      continue;
    }
  }
  const flags = ['--expose-gc', ...(name === 'isolated-vm' ? ['--no-node-snapshot'] : [])];
  const t0 = performance.now();
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [...flags, fileURLToPath(import.meta.url), '--child', name, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
    child.on('exit', () => (clearTimeout(timer), resolve(text)));
  });
  const line = out.split('\n').find((l) => l.startsWith('@@RESULT '));
  const r = line ? JSON.parse(line.slice(9)) : { contender: name, error: 'no result (timed out or crashed)' };
  r.seconds = Math.round((performance.now() - t0) / 1000);
  results.push(r);
  console.error(`${name}: ${r.error ? 'error' : r.skipped ? 'skipped' : 'done'} in ${r.seconds} s`);
}

// ---- report ----

const ms = (x) => (x === undefined ? '' : x < 1 ? x.toFixed(3) : x.toFixed(1));
const mib = (kib) => (Number.isFinite(kib) ? (kib / 1024).toFixed(1) : '–');
const kib = (k) => (Number.isFinite(k) ? `${Math.round(k)} KiB` : '–');
const ok = results.filter((r) => !r.error && !r.skipped);
const lines = [
  '### isolane vs. other ways to run JavaScript apart in Node',
  '',
  `Node ${process.version} on ${process.platform}-${process.arch}; isolane ${strict ? 'strict mode' : 'strict: false'}. Each contender ran in its own process.`,
  '',
  '| | V8 | Pointer compression | V8 sandbox |',
  '|---|---|---|---|',
  ...ok.map((r) => `| ${LABELS[r.contender]} | ${r.facts.v8 ?? '?'} | ${r.facts.pointerCompression ? 'on' : 'off'} | ${r.facts.sandbox ? 'on' : 'off'} |`),
  '',
  '**Memory** (MiB, the whole process tree, live sandboxes each holding the same ~40 KB object graph):',
  '',
  `| | base | ${LEVELS.map((l) => `${l} live`).join(' | ')} | per extra sandbox |`,
  `|---|---|${LEVELS.map(() => '---').join('|')}|---|`,
  ...ok.map((r) => {
    const m = r.memory;
    const cell = (l) => {
      const x = m.levels.find((v) => v.sandboxes === l);
      return x ? (Number.isFinite(x.pssKiB) ? `${mib(x.pssKiB)} PSS / ${mib(x.rssKiB)} RSS` : `${mib(x.rssKiB)} RSS`) : 'n/a';
    };
    const per = m.perSandboxKiB;
    const slope = per ? `${Number.isFinite(per.pss) ? `${kib(per.pss)} PSS, ` : ''}${kib(per.rss)} RSS (${per.between.join('→')})` : '';
    return `| ${LABELS[r.contender]} | ${mib(Number.isFinite(m.base.pssKiB) ? m.base.pssKiB : m.base.rssKiB)} | ${LEVELS.map(cell).join(' | ')} | ${slope} |`;
  }),
  '',
  '**Time** (ms; host calls in µs each, over 1,000 calls in one eval):',
  '',
  '| | cold start p50 / p95 | call p50 / p95 | async host call p50 | sync host call p50 |',
  '|---|---|---|---|---|',
  ...ok.map(
    (r) =>
      `| ${LABELS[r.contender]} | ${ms(r.coldStartMs.p50)} / ${ms(r.coldStartMs.p95)} | ${ms(r.callMs.p50)} / ${ms(r.callMs.p95)} | ${r.hostCallUs.async ? ms(r.hostCallUs.async.p50) : '–'} | ${r.hostCallUs.sync ? ms(r.hostCallUs.sync.p50) : '–'} |`,
  ),
  '',
  ...results.filter((r) => r.error || r.skipped).map((r) => `- ${LABELS[r.contender]}: ${r.skipped ?? `failed: ${r.error.split('\n')[0]}`}`),
  '',
  '<details><summary>Method</summary>',
  '',
  '- Workload in every sandbox: 256 small objects (~40 KB of heap) and a function `f`; "call" runs `f(1)` and returns its result to the host.',
  "- Cold start: a new sandbox to its first result. For isolane that's a new isolate in a running tenant's worker; for \"one tenant each\" it's a new tenant, so a new worker process.",
  '- Calls: isolane `isolate.eval`, isolated-vm `context.eval` (async), node:vm `runInContext` (synchronous, same thread), worker_threads a `postMessage` round trip.',
  '- Host calls: the sandbox calls a host function returning 1, 1,000 times in one eval. Async: isolane host functions, worker_threads `postMessage`. Sync: isolane `hostFunction({ sync: true })`, isolated-vm `Callback`, node:vm a plain function.',
  '- Memory: `ps` RSS and `/proc/<pid>/smaps_rollup` PSS, summed over the contender process and its children, after `gc()` (the contender process; isolane workers collect on their own) and a 1.5 s settle. "Per extra sandbox" is the slope between the two largest levels. worker_threads and isolane\'s one-tenant-each variant stop at 100.',
  '- Each contender runs in a fresh `node --expose-gc` child (isolated-vm adds `--no-node-snapshot`, which it requires).',
  ...(process.platform === 'darwin' ? ['- macOS: no PSS, and RSS leaves out compressed pages, so memory figures here are rough.'] : []),
  '',
  '</details>',
];
const summary = lines.join('\n') + '\n';
process.stdout.write(summary);
if (opt('summary')) writeFileSync(opt('summary'), summary, { flag: 'a' });
if (opt('json')) writeFileSync(opt('json'), JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, strict, levels: LEVELS, results }, null, 2) + '\n');
