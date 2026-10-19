#!/usr/bin/env node
// web-platform-tests as a regression gate. Runs a pinned WPT subset
// (.any.js files) in isolates with the web platform on, compares every
// subtest with test/wpt/expectations.json, and fails on any difference:
//   - a subtest that doesn't pass and isn't listed (a regression),
//   - a listed subtest that now passes (update the file),
//   - a file whose harness status (ERROR, TIMEOUT) isn't the expected one,
//   - a worker crash,
//   - a listed subtest or file that no longer exists (stale),
//   - an entry without a classified reason.
//
//   node test/wpt/run.mjs [--wpt <checkout>] [--static] [--filter <substr>]
//                         [--concurrency N] [--update] [--report out.json]
//                         [--summary out.md] [--verbose]
//
// By default WPT's own server (wptserve, Python 3) serves the checkout, so
// tests that need its handlers (.py) and substitutions (.sub.js) run as
// they do in browsers' CI. --static serves plain files instead (quick local
// runs; tests that need the server fail, so the gate isn't checked).
// Without --wpt, the checkout is sparse-cloned at WPT_COMMIT into a cache.
// --update rewrites the expectations from this run, keeping existing
// reasons; new entries get the reason "unclassified", which the gate
// refuses until someone classifies them.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime } from '../../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const WPT_COMMIT = 'c47791d69da614474168c0f6c1ad9a1dbd0cf0d3';

// Directories (or single files) under test. More specific paths first: a
// file is reported under the first that matches.
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
  'fetch/api/basic',
  'fetch/api/abort',
  'fetch/api/redirect',
  'fetch/data-urls',
  'xhr/formdata',
];
// Shared files the tests load, and the server's own code.
const SUPPORT = ['/resources', '/common', '/interfaces', '/FileAPI/support', '/fetch/api/resources', '/fetch/connection-pool/resources', '/xhr/resources', '/tools'];
// Paths a plain file server needs mapped (wptserve knows them).
const STATIC_ALIASES = { '/resources/WebIDLParser.js': '/resources/webidl2/lib/webidl2.js' };

// ---- arguments ----

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv.splice(i, 2)[1];
};
const has = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv.splice(i, 1).length > 0;
};
const verbose = has('--verbose');
const update = has('--update');
const staticMode = has('--static');
const concurrency = Number(opt('--concurrency') ?? 4);
const filter = opt('--filter');
const reportPath = opt('--report');
const summaryPath = opt('--summary');
const expectationsPath = opt('--expectations') ?? join(here, 'expectations.json');
let root = opt('--wpt');
if (argv.length) {
  console.error(`unknown arguments: ${argv.join(' ')}`);
  process.exit(2);
}

// ---- the WPT checkout ----

function retry(what, f) {
  for (let attempt = 1; ; attempt++) {
    try {
      return f();
    } catch (e) {
      if (attempt === 5) throw e;
      console.error(`${what} failed (attempt ${attempt}); retrying in ${attempt * 20}s`);
      execFileSync('sleep', [String(attempt * 20)]);
    }
  }
}

const sparse = () => [...SUPPORT, ...DIRS.map((d) => `/${d}`)];
if (!root) {
  root = process.env.ISOLANE_WPT_DIR ?? join(tmpdir(), `isolane-wpt-${WPT_COMMIT.slice(0, 12)}`);
  if (!existsSync(join(root, 'resources/testharness.js'))) {
    retry('cloning WPT', () => {
      execFileSync('rm', ['-rf', root]);
      execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', 'https://github.com/web-platform-tests/wpt.git', root]);
    });
    execFileSync('git', ['-C', root, 'sparse-checkout', 'set', '--no-cone', ...sparse()]);
    retry('checking out WPT', () => execFileSync('git', ['-C', root, 'checkout', '-q', WPT_COMMIT]));
  } else {
    const missing = sparse().filter((d) => !existsSync(join(root, d)));
    if (missing.length) retry('extending the WPT checkout', () => execFileSync('git', ['-C', root, 'sparse-checkout', 'add', ...missing]));
  }
}

// ---- servers ----

const freePort = () =>
  new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// WPT's server, for plain HTTP on localhost only. Two Python shims (a
// sitecustomize, so they apply in the server processes it spawns too):
// - Pythons from 3.15 removed http.server.CGIHTTPRequestHandler, which only
//   its websocket server (unused here) subclasses.
// - With TLS off, wptserve drops its https ports, and then any .sub.js file
//   that substitutes them (common/get-host-info.sub.js) fails with a 500.
//   Keep them (unused port numbers); the launcher starts no https or wss
//   servers, so https URLs fail to connect, as in any non-TLS setup.
const SITECUSTOMIZE = `import os, sys
import http.server
if not hasattr(http.server, "CGIHTTPRequestHandler"):
    http.server.CGIHTTPRequestHandler = http.server.SimpleHTTPRequestHandler
root = os.environ.get("ISOLANE_WPT_ROOT")
if root:
    sys.path.insert(0, root)
    import tools.localpaths  # noqa: F401
    from wptserve import config as _config
    _orig = _config.ConfigBuilder._get_ports
    def _get_ports(self, data):
        ports = _orig(self, data)
        for scheme in ("https", "wss"):
            if scheme not in ports and scheme in data["ports"]:
                ports[scheme] = list(data["ports"][scheme])
        return ports
    _config.ConfigBuilder._get_ports = _get_ports
`;
const LAUNCH = `import sys
from tools.serve import serve
_start = serve.start_servers
def start_servers(logger, host, ports, *args, **kwargs):
    ports = {s: p for s, p in ports.items() if s not in ("https", "wss")}
    return _start(logger, host, ports, *args, **kwargs)
serve.start_servers = start_servers
sys.argv = ["serve", "--config", sys.argv[1], "--no-h2"]
sys.exit(serve.main())
`;

// wptserve's port numbers → stable names for subtest names, e.g.
// "http://localhost:{HTTP_PORT}/...".
const portNames = new Map();
const stableName = (name) => (portNames.size ? name.replace(/(localhost|127\.0\.0\.1):(\d+)/g, (m, host, port) => (portNames.has(port) ? `${host}:${portNames.get(port)}` : m)) : name);

async function startWptserve() {
  const [port, https1, https2, wss] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const dir = mkdtempSync(join(tmpdir(), 'isolane-wptserve-'));
  writeFileSync(join(dir, 'sitecustomize.py'), SITECUSTOMIZE);
  const off = [null];
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      browser_host: 'localhost',
      alternate_hosts: { alt: '127.0.0.1' },
      check_subdomains: false,
      ssl: { type: 'none' },
      ports: {
        http: [port, 'auto'],
        https: [https1, https2],
        wss: [wss],
        ws: off,
        h2: off,
        'webtransport-h3': off,
        'http-local': off,
        'http-public': off,
        'https-local': off,
        'https-public': off,
      },
      logging: { level: 'warning' },
    }),
  );
  const child = spawn(process.env.PYTHON ?? 'python3', ['-c', LAUNCH, join(dir, 'config.json')], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: dir, ISOLANE_WPT_ROOT: root },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // its own process group, so stop() takes its servers too
  });
  let log = '';
  const keep = (b) => (log = (log + b.toString()).slice(-4000));
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const origin = `http://localhost:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wptserve exited (${child.exitCode}):\n${log}`);
    const info = await fetch(`${origin}/common/get-host-info.sub.js`).then((r) => (r.ok ? r.text() : null), () => null);
    if (info) {
      // Subtest names embed these (randomly chosen) port numbers.
      for (const [, name, value] of info.matchAll(/var (HTTPS?_PORT2?) = '(\d+)'/g)) portNames.set(value, `{${name}}`);
      break;
    }
    if (Date.now() > deadline) throw new Error(`wptserve didn't start within 60 s:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    origin,
    stop: () => {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
    },
  };
}

// Plain files, for quick local runs.
async function startStatic() {
  const TYPES = { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.txt': 'text/plain', '.png': 'image/png' };
  const server = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    path = STATIC_ALIASES[path] ?? path;
    const full = join(root, path);
    if (!full.startsWith(root) || path.endsWith('.py') || !existsSync(full) || !statSync(full).isFile()) {
      res.writeHead(404).end();
      return;
    }
    const ext = path.slice(path.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' }).end(readFileSync(full));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://localhost:${server.address().port}`, stop: () => server.close() };
}

// ---- test files ----

/** META comments at the top of a test file. */
function meta(source) {
  const out = { scripts: [], globals: null, timeout: 'normal', variants: [] };
  for (const line of source.split('\n')) {
    const m = /^\/\/ META: (\w+)=(.*)$/.exec(line.trim());
    if (!m) {
      if (line.trim() && !line.trim().startsWith('//')) break;
      continue;
    }
    if (m[1] === 'script') out.scripts.push(m[2].trim());
    if (m[1] === 'global') out.globals = m[2].split(',').map((s) => s.trim());
    if (m[1] === 'timeout') out.timeout = m[2].trim();
    if (m[1] === 'variant') out.variants.push(m[2].trim());
  }
  return out;
}

// The scopes these files run in: workers (we have no document), plus the
// shell-like scopes.
const runsHere = (globals) => !globals || globals.some((g) => ['worker', 'dedicatedworker', 'shadowrealm', 'jsshell', 'default', 'any'].includes(g));

const files = [];
const seen = new Set();
for (const d of DIRS) {
  const p = join(root, d);
  // A directory that's missing (an old sparse checkout) or has no tests
  // would otherwise pass vacuously: nothing run, nothing failed.
  if (!existsSync(p)) {
    console.error(`WPT directory ${d} is missing from ${root}; remove the checkout to re-fetch it`);
    process.exit(2);
  }
  const before = files.length;
  (function walk(f) {
    if (statSync(f).isDirectory()) for (const n of readdirSync(f).sort()) walk(join(f, n));
    else if (f.endsWith('.any.js') && !seen.has(f)) {
      seen.add(f);
      files.push(relative(root, f).split('\\').join('/'));
    }
  })(p);
  if (files.length === before && !seen.has(p)) {
    console.error(`WPT directory ${d} has no .any.js tests in ${root}; check the sparse checkout`);
    process.exit(2);
  }
}
const dirOf = (rel) => DIRS.find((d) => rel.startsWith(d)) ?? posix.dirname(rel);

// One run per file and META variant: "path" or "path?variant".
const runs = [];
const skipped = [];
for (const rel of files) {
  const m = meta(readFileSync(join(root, rel), 'utf8'));
  if (!runsHere(m.globals)) {
    skipped.push(rel);
    continue;
  }
  for (const v of m.variants.length ? m.variants : ['']) {
    const key = rel + v;
    if (!filter || key.includes(filter)) runs.push({ key, rel, variant: v, meta: m });
  }
}

// ---- running ----

const SETUP = `
  // What WPT's generated .any.worker.html wrapper defines.
  globalThis.GLOBAL = { isWindow: () => false, isWorker: () => true, isShadowRealm: () => false };
`;
const HARNESS_SETUP = `setup({ explicit_timeout: true, explicit_done: true });
  globalThis.__wpt_done = new Promise((resolve) => add_completion_callback((tests, status) =>
    resolve({ status: status.status, message: status.message, tests: tests.map((t) => ({ name: t.name, status: t.status, message: t.message })) })));`;
const TEST_STATUS = ['PASS', 'FAIL', 'TIMEOUT', 'NOTRUN', 'PRECONDITION_FAILED'];
const HARNESS_STATUS = ['OK', 'ERROR', 'TIMEOUT', 'PRECONDITION_FAILED'];

const server = staticMode ? await startStatic() : await startWptserve();
const crashes = [];
const runtime = new Runtime({
  strict: process.env.ISOLANE_STRICT === '1',
  defaults: { limits: { idleMs: 5000 } },
  quarantineMs: null,
  hooks: { onSecurityEvent: (e) => crashes.push(e) },
});

/** Fetch a script the way the test page would (wptserve substitutes .sub.js). */
async function getScript(path, base) {
  const url = new URL(path, base);
  if (staticMode) {
    const p = STATIC_ALIASES[url.pathname] ?? url.pathname;
    const full = join(root, decodeURIComponent(p));
    if (!existsSync(full)) throw new Error(`missing script ${path}`);
    return readFileSync(full, 'utf8');
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`script ${path}: HTTP ${res.status}`);
  return res.text();
}

/** Run one file (variant); returns { status, message, subtests: { name: status } }. */
async function runOne(run, lane) {
  const testUrl = `${server.origin}/${run.rel}${run.variant}`;
  const tenant = `wpt-${lane}`;
  const crashesBefore = crashes.length;
  let isolate;
  let step = 'create';
  try {
    isolate = runtime.tenant(tenant).isolate({
      web: { baseUrl: testUrl },
      eval: true, // idlharness.js evals
      limits: { timeoutMs: run.meta.timeout === 'long' ? 60_000 : 20_000, heapBytes: 256 << 20 },
      // The methods these tests use (isolane's default allows the common ones).
      fetch: {
        hosts: ['localhost', '127.0.0.1'],
        privateNetworks: true,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CHICKEN', 'TACO', 'TESTING'],
        // Fetch's own redirect limit (isolane's default policy allows 5).
        limits: { requests: 10_000, redirects: 20 },
      },
    });
    // Scripts run for effect: drop their completion values (which may be
    // promises the eval would otherwise wait on).
    const script = (code) => isolate.eval(`${code}\n;undefined`);
    step = 'setup';
    await isolate.eval(SETUP);
    step = 'testharness.js';
    await script(await getScript('/resources/testharness.js', testUrl));
    step = 'harness setup';
    await script(HARNESS_SETUP);
    for (const s of run.meta.scripts) {
      step = s;
      await script(await getScript(s, testUrl));
    }
    step = 'test';
    await script(await getScript(`/${run.rel}`, testUrl));
    step = 'done';
    const outcome = await isolate.eval('done(); __wpt_done');
    const subtests = {};
    for (const t of outcome.tests) {
      const base = stableName(t.name);
      let name = base;
      for (let n = 2; Object.hasOwn(subtests, name); n++) name = `${base} [${n}]`;
      subtests[name] = { status: TEST_STATUS[t.status], message: t.message ?? undefined };
    }
    return { status: HARNESS_STATUS[outcome.status], message: outcome.message ?? undefined, subtests };
  } catch (e) {
    const crash = crashes.slice(crashesBefore).find((c) => c.tenant === tenant);
    if (crash) return { status: 'CRASH', message: `${crash.kind}: ${crash.detail ?? ''}`.slice(0, 300), subtests: {} };
    const status = e.code === 'ERR_LIMIT' && e.limit === 'timeoutMs' ? 'TIMEOUT' : 'ERROR';
    return { status, message: `${step}: ${e.code ?? ''} ${e.message}`.slice(0, 300), subtests: {} };
  } finally {
    isolate?.close();
  }
}

const started = Date.now();
const results = {};
let next = 0;
try {
  await Promise.all(
    Array.from({ length: concurrency }, async (_, lane) => {
      while (next < runs.length) {
        const run = runs[next++];
        results[run.key] = await runOne(run, lane);
      }
    }),
  );
} finally {
  runtime.close();
  server.stop();
}
const seconds = (Date.now() - started) / 1000;

// ---- expectations ----

const blank = { wptCommit: WPT_COMMIT, reasons: {}, files: {} };
const expectations = existsSync(expectationsPath) ? JSON.parse(readFileSync(expectationsPath, 'utf8')) : blank;
const reasons = expectations.reasons ?? {};
const CATEGORIES = ['by-design', 'browser-only', 'environment', 'bug'];

/** Expected non-pass subtests of a file entry: name → reason id. */
function expectedSubtests(entry) {
  const out = {};
  for (const [name, v] of Object.entries(entry?.subtests ?? {})) out[name] = typeof v === 'string' ? entry.why : v.why ?? entry.why;
  return out;
}

const problems = [];
const problem = (kind, key, detail) => problems.push({ kind, key, detail });
if (expectations.wptCommit !== WPT_COMMIT && !update) problem('commit', expectationsPath, `expectations are for WPT ${expectations.wptCommit}, the runner pins ${WPT_COMMIT}`);

for (const [id, r] of Object.entries(reasons)) {
  if (id === 'unclassified') continue;
  if (!CATEGORIES.includes(r.category) || !r.reason) problem('reason', id, `reason "${id}" needs a category (${CATEGORIES.join(', ')}) and a reason`);
}

// Tally: passes, and expected non-passes by category.
const tally = { subtests: 0, pass: 0, expected: Object.fromEntries(CATEGORIES.map((c) => [c, 0])), unexpected: 0, files: Object.keys(results).length, skippedFiles: skipped.length };
const byReason = {};
const checkWhy = (key, why) => {
  if (!why || why === 'unclassified' || !reasons[why]) {
    problem('unclassified', key, why ? `reason "${why}" is ${why === 'unclassified' ? 'not yet classified' : 'not defined'}` : 'no reason given');
    return undefined;
  }
  return reasons[why].category;
};

for (const [key, r] of Object.entries(results)) {
  const entry = expectations.files?.[key];
  const expectedStatus = entry?.status ?? 'OK';
  if (r.status === 'CRASH') problem('crash', key, r.message);
  else if (r.status !== expectedStatus) {
    problem(r.status === 'OK' ? 'unexpected-pass' : 'regression', key, `harness ${r.status}${r.message ? ` (${r.message})` : ''}, expected ${expectedStatus}`);
  } else if (r.status !== 'OK') {
    const cat = checkWhy(key, entry.why);
    if (cat) byReason[entry.why] = (byReason[entry.why] ?? 0) + 1;
  }
  const expected = expectedSubtests(entry);
  for (const [name, t] of Object.entries(r.subtests)) {
    tally.subtests++;
    const id = `${key} :: ${name}`;
    if (t.status === 'PASS') {
      tally.pass++;
      if (Object.hasOwn(expected, name)) problem('unexpected-pass', id, 'listed as failing but passes');
      continue;
    }
    if (!Object.hasOwn(expected, name)) {
      tally.unexpected++;
      problem('regression', id, `${t.status}${t.message ? `: ${String(t.message).slice(0, 200)}` : ''}`);
      continue;
    }
    const cat = checkWhy(id, expected[name]);
    if (cat) {
      tally.expected[cat]++;
      byReason[expected[name]] = (byReason[expected[name]] ?? 0) + 1;
    }
  }
  if (r.status === 'OK') for (const name of Object.keys(expected)) if (!Object.hasOwn(r.subtests, name)) problem('stale', `${key} :: ${name}`, 'listed, but no longer reported');
}
if (!filter) for (const key of Object.keys(expectations.files ?? {})) if (!Object.hasOwn(results, key)) problem('stale', key, 'listed, but no longer run');

// ---- --update ----

if (update) {
  const out = { wptCommit: WPT_COMMIT, reasons: { ...reasons }, files: {} };
  let unclassified = 0;
  const keys = filter ? [...new Set([...Object.keys(expectations.files ?? {}), ...Object.keys(results)])] : Object.keys(results);
  for (const key of keys.sort()) {
    const r = results[key];
    const old = expectations.files?.[key];
    if (!r) {
      out.files[key] = old; // outside this --filter: keep
      continue;
    }
    const oldSub = expectedSubtests(old);
    const failing = Object.entries(r.subtests).filter(([, t]) => t.status !== 'PASS');
    if (r.status === 'OK' && failing.length === 0) continue;
    const entry = {};
    if (r.status !== 'OK') entry.status = r.status;
    const whys = failing.map(([name]) => oldSub[name] ?? old?.why ?? 'unclassified');
    const fileWhy = r.status !== 'OK' ? old?.why ?? 'unclassified' : whys.every((w) => w === whys[0]) ? whys[0] : undefined;
    if (fileWhy) entry.why = fileWhy;
    if (failing.length) {
      entry.subtests = {};
      failing.forEach(([name, t], i) => {
        entry.subtests[name] = whys[i] === entry.why ? t.status : { status: t.status, why: whys[i] };
      });
    }
    for (const w of [entry.why, ...whys]) if (w === 'unclassified') unclassified++;
    out.files[key] = entry;
  }
  if (unclassified) out.reasons.unclassified = { category: 'unclassified', reason: 'New since the last update: read the test and classify it.' };
  else delete out.reasons.unclassified;
  writeFileSync(expectationsPath, JSON.stringify(out, null, 2) + '\n');
  console.error(`wrote ${expectationsPath} (${Object.keys(out.files).length} files with expected failures, ${unclassified} unclassified)`);
}

// ---- report ----

const excluded = tally.expected['by-design'] + tally.expected['browser-only'];
const applicable = tally.subtests - excluded;
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const bugs = Object.entries(reasons)
  .filter(([id, r]) => r.category === 'bug' && byReason[id])
  .map(([id, r]) => ({ id, subtests: byReason[id], reason: r.reason, tracking: r.tracking }));
const report = {
  wptCommit: WPT_COMMIT,
  server: staticMode ? 'static' : 'wptserve',
  seconds,
  files: tally.files,
  skippedFiles: tally.skippedFiles,
  subtests: tally.subtests,
  pass: tally.pass,
  passRate: pct(tally.pass, tally.subtests),
  applicable,
  applicablePassRate: pct(tally.pass, applicable),
  expectedByCategory: tally.expected,
  byReason,
  bugs,
  problems: problems.slice(0, 500),
  problemCount: problems.length,
  ...(verbose ? { results } : {}),
};
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

const lines = [
  `### web-platform-tests (WPT ${WPT_COMMIT.slice(0, 12)}, ${report.server})`,
  '',
  `${tally.pass} of ${tally.subtests} subtests pass (${report.passRate}); **${report.applicablePassRate} of the ${applicable} that apply** (excluding by-design and browser-only).`,
  '',
  '| Expected failures | Subtests |',
  '|---|---|',
  ...CATEGORIES.map((c) => `| ${c} | ${tally.expected[c]} |`),
  '',
];
if (bugs.length) {
  lines.push('Known bugs:', '');
  for (const b of bugs) lines.push(`- \`${b.id}\` (${b.subtests}): ${b.reason}${b.tracking ? ` (${b.tracking})` : ''}`);
  lines.push('');
}
if (problems.length) {
  lines.push(`**${problems.length} problems** (the gate fails):`, '');
  for (const p of problems.slice(0, 50)) lines.push(`- ${p.kind}: \`${p.key}\`${p.detail ? ` — ${p.detail}` : ''}`);
  if (problems.length > 50) lines.push(`- … and ${problems.length - 50} more (see the JSON report)`);
} else lines.push('No problems: every subtest matches its expectation.');
const markdown = lines.join('\n') + '\n';
if (summaryPath) writeFileSync(summaryPath, markdown);
console.log(markdown);

// --static can't run the tests that need wptserve, so it reports but
// doesn't gate; --update reports what it wrote.
const gate = !staticMode && !update;
process.exit(gate && problems.length ? 1 : 0);
