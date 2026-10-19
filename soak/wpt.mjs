// Run a pinned subset of web-platform-tests (.any.js) in isolates with the
// web platform on, and report pass rates per directory as JSON.
//   node soak/wpt.mjs [wpt-checkout] [--concurrency N] [--filter substr] [--verbose]
//                     [--min-pass-rate PERCENT]   (exit 1 below it)
// Without a checkout path, sparse-clones WPT at WPT_COMMIT into a cache dir.
//
// Each test file gets a fresh isolate: testharness.js, its META scripts, the
// test, then done(). Code generation is on (idlharness.js uses eval).
// WPT files are served by a static HTTP server on localhost, and isolates
// fetch them with the platform's own fetch() under a network policy that
// allows it. WPT's Python handlers (.py) don't run here: tests that need
// them fail. Harness-only scaffolding: a `location`, and fetch() resolving
// relative URLs against it (the platform has no base URL; `new Request` with
// a relative URL throws, as in a worker without one). Files that only run
// in a window (META global=window) are skipped.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';
import { Runtime } from '../dist/index.js';

const WPT_COMMIT = 'c47791d69da614474168c0f6c1ad9a1dbd0cf0d3';
// More specific paths first: a file counts under the first that matches.
const DIRS = [
  'url',
  'encoding/streams',
  'encoding',
  'dom/events',
  'dom/abort',
  'html/webappapis/structured-clone',
  'html/webappapis/atob',
  'html/webappapis/microtask-queuing',
  'hr-time',
  'html/webappapis/timers',
  'streams',
  'FileAPI/blob',
  'FileAPI/file',
  'FileAPI/reading-data-section',
  'FileAPI/url',
  'compression',
  'WebCryptoAPI/getRandomValues.any.js',
  'WebCryptoAPI/randomUUID.https.any.js',
  'fetch/api/headers',
  'fetch/api/request',
  'fetch/api/response',
  'fetch/api/body',
  'xhr/formdata',
];

// Shared files the tests load (harness, IDL, data).
const SUPPORT = ['/resources', '/common', '/interfaces', '/fetch/data-urls/resources', '/FileAPI/support', '/fetch/api/resources'];
// Paths the WPT server serves under another name.
const ALIASES = { '/resources/WebIDLParser.js': '/resources/webidl2/lib/webidl2.js' };

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const verbose = args.includes('--verbose') && args.splice(args.indexOf('--verbose'), 1);
const concurrency = Number(flag('--concurrency') ?? 4);
const filter = flag('--filter');
const minPassRate = Number(flag('--min-pass-rate') ?? 0);
let root = args[0];

if (!root) {
  root = join(tmpdir(), `isolane-wpt-${WPT_COMMIT.slice(0, 12)}`);
  if (!existsSync(join(root, 'resources/testharness.js'))) {
    execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', 'https://github.com/web-platform-tests/wpt.git', root]);
    execFileSync('git', ['-C', root, 'sparse-checkout', 'set', '--no-cone', ...SUPPORT, ...DIRS.map((d) => `/${d}`)]);
    execFileSync('git', ['-C', root, 'checkout', '-q', WPT_COMMIT]);
  } else {
    // A cached checkout from before a directory was added.
    const missing = [...SUPPORT.map((d) => d.slice(1)), ...DIRS].filter((d) => !existsSync(join(root, d)));
    if (missing.length) execFileSync('git', ['-C', root, 'sparse-checkout', 'add', ...missing.map((d) => `/${d}`)]);
  }
}

const files = [];
const seen = new Set();
for (const d of DIRS) {
  const p = join(root, d);
  if (!existsSync(p)) continue;
  (function walk(f) {
    if (statSync(f).isDirectory()) for (const n of readdirSync(f).sort()) walk(join(f, n));
    else if (f.endsWith('.any.js') && !seen.has(f)) {
      seen.add(f);
      files.push(f);
    }
  })(p);
}
const selected = files.filter((f) => !filter || f.includes(filter));

const harness = readFileSync(join(root, 'resources/testharness.js'), 'utf8');

// The WPT checkout over HTTP (static files only).
const TYPES = { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.txt': 'text/plain', '.png': 'image/png' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const full = join(root, path);
  if (!full.startsWith(root) || path.endsWith('.py') || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404).end();
    return;
  }
  const ext = path.slice(path.lastIndexOf('.'));
  res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' }).end(readFileSync(full));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://localhost:${server.address().port}`;

/** META comments at the top of a test file. */
function meta(source) {
  const out = { scripts: [], globals: null, timeout: 'normal' };
  for (const line of source.split('\n')) {
    const m = /^\/\/ META: (\w+)=(.*)$/.exec(line.trim());
    if (!m) {
      if (line.trim() && !line.trim().startsWith('//')) break;
      continue;
    }
    if (m[1] === 'script') out.scripts.push(m[2].trim());
    if (m[1] === 'global') out.globals = m[2].split(',').map((s) => s.trim());
    if (m[1] === 'timeout') out.timeout = m[2].trim();
  }
  return out;
}

const runsHere = (globals) =>
  !globals || globals.some((g) => ['worker', 'dedicatedworker', 'shadowrealm', 'jsshell', 'default', 'any'].includes(g));

const SETUP = `
  // What WPT's generated .any.worker.html wrapper defines.
  globalThis.GLOBAL = { isWindow: () => false, isWorker: () => true, isShadowRealm: () => false };
  globalThis.location = { search: "", hash: "", href: __wpt_url, pathname: __wpt_path, toString() { return this.href; } };
  // Before phase 2 (no platform timers), fall back to timers through the host.
  if (typeof setTimeout === "undefined") {
    let __nextTimer = 1; const __cancelled = new Set();
    globalThis.setTimeout = (fn, ms = 0, ...a) => { const id = __nextTimer++; __wpt_sleep(Math.min(Number(ms) || 0, 30000)).then(() => { if (!__cancelled.has(id)) typeof fn === "function" && fn(...a); }); return id; };
    globalThis.clearTimeout = (id) => __cancelled.add(id);
  }
  // fetch() with relative URLs, against the test's location.
  const __fetch = fetch;
  globalThis.fetch = function fetch(input, init) {
    return __fetch(typeof input === "string" ? new URL(input, __wpt_url).href : input, init);
  };
`;

const results = {};
const failures = [];
const workerCrashes = [];
const statusName = ['pass', 'fail', 'timeout', 'notrun', 'precondition'];
// A worker crash is a finding (recorded per file), not a reason to stop:
// no quarantine, and each lane's next file gets a fresh worker.
const crashes = [];
const runtime = new Runtime({
  strict: process.env.ISOLANE_STRICT === '1',
  idleTimeoutMs: 5000,
  quarantineMs: null,
  onSecurityEvent: (e) => crashes.push(e),
});

async function runFile(file, lane) {
  const rel = relative(root, file);
  const dir = DIRS.find((d) => rel.startsWith(d)) ?? posix.dirname(rel);
  const bucket = (results[dir] ??= { files: 0, skipped: 0, harnessErrors: 0, tests: 0, pass: 0, fail: 0, timeout: 0, notrun: 0, precondition: 0 });
  const source = readFileSync(file, 'utf8');
  const m = meta(source);
  if (!runsHere(m.globals)) {
    bucket.skipped++;
    return;
  }
  bucket.files++;
  const testDir = dirname(file);
  const resolveWpt = (p) => {
    p = ALIASES[p] ?? p;
    return p.startsWith('/') ? join(root, p) : join(testDir, p);
  };
  let isolate;
  let step = 'create';
  const crashesBefore = crashes.length;
  try {
  isolate = runtime.createIsolate({
    tenant: `wpt-${lane}`,
    webPlatform: true,
    allowCodeGeneration: true, // idlharness.js evals
    timeoutMs: m.timeout === 'long' ? 60000 : 20000,
    memoryLimitBytes: 256 << 20,
    globals: { __wpt_url: `${origin}/${rel}`, __wpt_path: `/${rel}` },
    network: { allow: ['localhost'], allowPrivateNetworks: true, maxRequests: 10_000 },
    hostFunctions: {
      __wpt_sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
  });
    step = 'setup';
    await isolate.eval(SETUP);
    step = 'testharness.js';
    // Scripts run for effect: drop their completion values (which may be
    // promises the eval would otherwise wait on).
    const script = (code) => isolate.eval(`${code}\n;undefined`);
    await script(harness);
    step = 'harness setup';
    await script(`setup({ explicit_timeout: true, explicit_done: true });
      globalThis.__wpt_done = new Promise((resolve) => add_completion_callback((tests, status) =>
        resolve({ status: status.status, message: status.message, tests: tests.map((t) => ({ name: t.name, status: t.status, message: t.message })) })));`);
    for (const s of m.scripts) {
      step = s;
      const p = resolveWpt(s);
      if (!existsSync(p)) throw new Error(`missing META script ${s}`);
      await script(readFileSync(p, 'utf8'));
    }
    step = 'test';
    await script(source);
    step = 'done';
    const outcome = await isolate.eval('done(); __wpt_done');
    if (outcome.status !== 0) {
      bucket.harnessErrors++;
      failures.push({ file: rel, harness: outcome.message });
    }
    for (const t of outcome.tests) {
      bucket.tests++;
      bucket[statusName[t.status]]++;
      if (t.status !== 0 && verbose) failures.push({ file: rel, test: t.name, status: statusName[t.status], message: t.message?.slice(0, 300) });
    }
  } catch (e) {
    bucket.harnessErrors++;
    const crash = crashes.slice(crashesBefore).find((c) => c.tenant === `wpt-${lane}`);
    if (crash) workerCrashes.push({ file: rel, step, kind: crash.kind, signal: crash.signal, exitCode: crash.exitCode, detail: crash.detail?.slice(0, 300) });
    failures.push({ file: rel, step, error: `${e.code ?? ''} ${e.message}`.slice(0, 400) });
  } finally {
    isolate?.dispose();
  }
}

const started = Date.now();
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async (_, lane) => {
    while (next < selected.length) await runFile(selected[next++], lane);
  }),
);
runtime.close();
server.close();

const total = { files: 0, skipped: 0, harnessErrors: 0, tests: 0, pass: 0, fail: 0, timeout: 0, notrun: 0, precondition: 0 };
for (const r of Object.values(results)) for (const k of Object.keys(total)) total[k] += r[k];
const rate = (r) => (r.tests ? `${((100 * r.pass) / r.tests).toFixed(1)}%` : 'n/a');
const report = {
  wptCommit: WPT_COMMIT,
  seconds: (Date.now() - started) / 1000,
  total: { ...total, passRate: rate(total) },
  byDirectory: Object.fromEntries(Object.entries(results).map(([d, r]) => [d, { ...r, passRate: rate(r) }])),
  workerCrashes,
  failures: failures.slice(0, verbose ? 2000 : 100),
};
console.log(JSON.stringify(report, null, 2));
// A crashed worker fails the run whatever the pass rate.
if (workerCrashes.length || total.tests === 0 || (100 * total.pass) / total.tests < minPassRate) process.exit(1);
