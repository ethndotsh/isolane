// Run a pinned subset of web-platform-tests (.any.js) in isolates with the
// web platform on, and report pass rates per directory as JSON.
//   node soak/wpt.mjs [wpt-checkout] [--concurrency N] [--filter substr] [--verbose]
//                     [--min-pass-rate PERCENT]   (exit 1 below it)
// Without a checkout path, sparse-clones WPT at WPT_COMMIT into a cache dir.
//
// Each test file gets a fresh isolate: testharness.js, its META scripts, the
// test, then done(). Code generation is on (idlharness.js uses eval).
// Harness-only scaffolding (not part of the platform):
// setTimeout via a host call (phase 1 has no timers), fetch() that reads WPT
// files, and a `location` for subset tests. Files that only run in a window
// (META global=window) are skipped.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';
import { Runtime } from '../dist/index.js';

const WPT_COMMIT = 'c47791d69da614474168c0f6c1ad9a1dbd0cf0d3';
const DIRS = [
  'url',
  'encoding',
  'dom/events',
  'dom/abort',
  'html/webappapis/structured-clone',
  'html/webappapis/atob',
  'html/webappapis/microtask-queuing',
  'hr-time',
  'WebCryptoAPI/getRandomValues.any.js',
  'WebCryptoAPI/randomUUID.https.any.js',
];

// Shared files the tests load (harness, IDL, data).
const SUPPORT = ['/resources', '/common', '/interfaces', '/fetch/data-urls/resources'];
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
  }
}

const files = [];
for (const d of DIRS) {
  const p = join(root, d);
  if (!existsSync(p)) continue;
  (function walk(f) {
    if (statSync(f).isDirectory()) for (const n of readdirSync(f).sort()) walk(join(f, n));
    else if (f.endsWith('.any.js')) files.push(f);
  })(p);
}
const selected = files.filter((f) => !filter || f.includes(filter));

const harness = readFileSync(join(root, 'resources/testharness.js'), 'utf8');

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
  // Timers through the host (harness only; the platform gets real ones in phase 2).
  let __nextTimer = 1; const __cancelled = new Set();
  globalThis.setTimeout = (fn, ms = 0, ...a) => { const id = __nextTimer++; __wpt_sleep(Math.min(Number(ms) || 0, 30000)).then(() => { if (!__cancelled.has(id)) typeof fn === "function" && fn(...a); }); return id; };
  globalThis.clearTimeout = (id) => __cancelled.add(id);
  globalThis.setInterval = () => { throw new TypeError("setInterval unavailable in this harness"); };
  globalThis.fetch = async (url) => {
    const r = await __wpt_read(String(url));
    if (r === null) return { ok: false, status: 404, async json() { throw new TypeError("not found"); }, async text() { return ""; } };
    return { ok: true, status: 200, async json() { return JSON.parse(r); }, async text() { return r; } };
  };
`;

const results = {};
const failures = [];
const statusName = ['pass', 'fail', 'timeout', 'notrun', 'precondition'];
const runtime = new Runtime({ strict: process.env.ISOLANE_STRICT === '1', idleTimeoutMs: 5000 });

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
  const isolate = runtime.createIsolate({
    tenant: `wpt-${lane}`,
    webPlatform: true,
    allowCodeGeneration: true, // idlharness.js evals
    timeoutMs: m.timeout === 'long' ? 60000 : 20000,
    memoryLimitBytes: 256 << 20,
    globals: { __wpt_url: `https://wpt.example/${rel}`, __wpt_path: `/${rel}` },
    hostFunctions: {
      __wpt_sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      __wpt_read: (url) => {
        const path = url.replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0];
        const full = resolveWpt(path);
        if (!full.startsWith(root) || !existsSync(full)) return null;
        return readFileSync(full, 'utf8');
      },
    },
  });
  let step = 'setup';
  try {
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
    failures.push({ file: rel, step, error: `${e.code ?? ''} ${e.message}`.slice(0, 400) });
  } finally {
    isolate.dispose();
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

const total = { files: 0, skipped: 0, harnessErrors: 0, tests: 0, pass: 0, fail: 0, timeout: 0, notrun: 0, precondition: 0 };
for (const r of Object.values(results)) for (const k of Object.keys(total)) total[k] += r[k];
const rate = (r) => (r.tests ? `${((100 * r.pass) / r.tests).toFixed(1)}%` : 'n/a');
const report = {
  wptCommit: WPT_COMMIT,
  seconds: (Date.now() - started) / 1000,
  total: { ...total, passRate: rate(total) },
  byDirectory: Object.fromEntries(Object.entries(results).map(([d, r]) => [d, { ...r, passRate: rate(r) }])),
  failures: failures.slice(0, verbose ? 2000 : 100),
};
console.log(JSON.stringify(report, null, 2));
if (total.tests === 0 || (100 * total.pass) / total.tests < minPassRate) process.exit(1);
