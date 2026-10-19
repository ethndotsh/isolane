// test262 as a regression gate. Runs a pinned test262 (ECMAScript's own
// conformance suite) in isolates with isolane's defaults for everything but
// `eval` (test262 evals constantly), compares every test with
// test/test262/expectations.json, and fails on any difference:
//   - a test that doesn't pass and isn't listed (a regression),
//   - a listed test that now passes (update the file),
//   - a worker crash that isn't listed,
//   - a listed test that no longer exists or no longer runs (stale),
//   - an entry or skip rule without a classified reason.
// Its job is catching what isolane changes about the engine: the removed
// globals (SharedArrayBuffer, Atomics), V8 flags (no Temporal, no code
// generation unless allowed), the frozen clock, and the patches.
//
//   node test/test262/run.mjs [--test262 <checkout>] [--filter <substr>]
//                             [--concurrency N] [--update] [--report out.json]
//                             [--summary out.md] [--verbose]
//
// Without --test262, the checkout is sparse-cloned at TEST262_COMMIT into a
// cache. --update rewrites the expectations from this run, keeping existing
// reasons and marking new failures "unclassified" for a person to classify.
//
// Each test runs once per mode it allows (non-strict and strict, or just
// the one its flags name), each in a fresh isolate. Skip rules (by feature
// or flag) cover what isolane leaves out on purpose, and every stage-3
// proposal in test262's features.txt: those tests don't run, and count in
// their reason's category.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime } from '../../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// The commit V8's DEPS pins for test/test262/data, so V8's own
// test262.status (its known failures) applies as is. Move it with V8.
export const TEST262_COMMIT = '9e61c12835c5e4a3bdba93850427e6742c4f64c4';

// Directories under test/. Not staging/ (tests not yet reviewed into the
// suite proper).
const DIRS = ['built-ins', 'language', 'annexB', 'intl402'];

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
const concurrency = Number(opt('--concurrency') ?? Math.min(8, availableParallelism()));
const filter = opt('--filter');
const reportPath = opt('--report');
const summaryPath = opt('--summary');
const expectationsPath = opt('--expectations') ?? join(here, 'expectations.json');
let root = opt('--test262');
if (argv.length) {
  console.error(`unknown arguments: ${argv.join(' ')}`);
  process.exit(2);
}

// ---- the test262 checkout ----

// With V8's sources at hand (scripts/fetch-rusty-v8.sh), check the pin.
const v8Deps = join(here, '../../build/rusty_v8/v8/DEPS');
if (existsSync(v8Deps)) {
  const pinned = readFileSync(v8Deps, 'utf8').match(/test262\.git' \+ '@' \+ '([0-9a-f]{40})'/)?.[1];
  if (pinned && pinned !== TEST262_COMMIT) console.error(`warning: V8's DEPS pins test262 ${pinned}, the runner ${TEST262_COMMIT}; V8's known failures may not match`);
}

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

const sparse = () => ['/harness', '/features.txt', ...DIRS.map((d) => `/test/${d}`)];
if (!root) {
  root = process.env.ISOLANE_TEST262_DIR ?? join(tmpdir(), `isolane-test262-${TEST262_COMMIT.slice(0, 12)}`);
  if (!existsSync(join(root, 'harness/assert.js'))) {
    retry('cloning test262', () => {
      execFileSync('rm', ['-rf', root]);
      execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', 'https://github.com/tc39/test262.git', root]);
    });
    execFileSync('git', ['-C', root, 'sparse-checkout', 'set', '--no-cone', ...sparse()]);
    retry('checking out test262', () => execFileSync('git', ['-C', root, 'checkout', '-q', TEST262_COMMIT]));
  } else {
    const have = new Set(execFileSync('git', ['-C', root, 'sparse-checkout', 'list'], { encoding: 'utf8' }).split('\n'));
    const missing = sparse().filter((d) => !have.has(d));
    if (missing.length) retry('extending the test262 checkout', () => execFileSync('git', ['-C', root, 'sparse-checkout', 'add', ...missing]));
  }
}

// ---- tests ----

/** A YAML list, flow (`[a, b]`) or block (`- a` lines). */
function yamlList(yaml, key) {
  const m = yaml.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!m) return [];
  if (m[1].trim().startsWith('[')) {
    return m[1].replace(/^\s*\[|\]\s*(#.*)?$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  const out = [];
  for (const line of yaml.slice(m.index + m[0].length).split('\n').slice(1)) {
    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    if (item) out.push(item[1]);
    else if (line.trim()) break;
  }
  return out;
}

/** The test's frontmatter: includes, flags, features, and negative. */
function frontmatter(src) {
  const m = src.match(/\/\*---([\s\S]*?)---\*\//);
  const yaml = m ? m[1] : '';
  const neg = yaml.match(/^negative:\s*\n((?:[ \t]+.*\n?)+)/m);
  return {
    includes: yamlList(yaml, 'includes'),
    flags: yamlList(yaml, 'flags'),
    features: yamlList(yaml, 'features'),
    negative: neg ? { phase: neg[1].match(/phase:\s*(\S+)/)?.[1], type: neg[1].match(/type:\s*(\S+)/)?.[1] } : undefined,
  };
}

/** Stage-3 proposals: the features above "## Standard language features". */
function proposals() {
  const text = readFileSync(join(root, 'features.txt'), 'utf8');
  const section = text.slice(0, text.indexOf('## Standard language features'));
  return section.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

const files = [];
for (const d of DIRS) {
  const p = join(root, 'test', d);
  if (!existsSync(p)) {
    console.error(`test262 directory test/${d} is missing from ${root}; remove the checkout to re-fetch it`);
    process.exit(2);
  }
  const before = files.length;
  (function walk(f) {
    if (statSync(f).isDirectory()) for (const n of readdirSync(f).sort()) walk(join(f, n));
    else if (f.endsWith('.js') && !f.includes('_FIXTURE')) files.push(relative(join(root, 'test'), f).split('\\').join('/'));
  })(p);
  if (files.length === before) {
    console.error(`test262 directory test/${d} has no tests in ${root}; check the sparse checkout`);
    process.exit(2);
  }
}

// ---- expectations ----

const blank = { test262Commit: TEST262_COMMIT, reasons: {}, skip: { features: {}, flags: {} }, files: {} };
const expectations = existsSync(expectationsPath) ? JSON.parse(readFileSync(expectationsPath, 'utf8')) : blank;
const reasons = expectations.reasons ?? {};
// Null-prototype, since test262 has a feature named __proto__.
const skipFeatures = Object.assign(Object.create(null), Object.fromEntries(proposals().map((f) => [f, 'proposal'])), expectations.skip?.features);
const skipFlags = Object.assign(Object.create(null), expectations.skip?.flags);

// Development builds (rusty_v8's prebuilt V8: no V8 sandbox) differ from
// the real worker in a few tests, which skip.devBuild lists by path.
const crashes = [];
const runtime = new Runtime({
  strict: process.env.ISOLANE_STRICT === '1',
  quarantineMs: null,
  hooks: { onSecurityEvent: (e) => crashes.push(e) },
});
const devBuild = !(await runtime.isolationReport()).sandboxEnabled;
const skipPaths = Object.assign(Object.create(null), devBuild ? expectations.skip?.devBuild : undefined);
const CATEGORIES = ['by-design', 'draft', 'v8', 'environment', 'bug'];

const problems = [];
const problem = (kind, key, detail) => problems.push({ kind, key, detail });
if (expectations.test262Commit !== TEST262_COMMIT && !update) {
  problem('commit', expectationsPath, `expectations are for test262 ${expectations.test262Commit}, the runner pins ${TEST262_COMMIT}`);
}
for (const [id, r] of Object.entries(reasons)) {
  if (id === 'unclassified') continue;
  if (!CATEGORIES.includes(r.category) || !r.reason) problem('reason', id, `reason "${id}" needs a category (${CATEGORIES.join(', ')}) and a reason`);
}
for (const [what, rules] of [['feature', skipFeatures], ['flag', skipFlags], ['path', expectations.skip?.devBuild ?? {}]]) {
  for (const [name, why] of Object.entries(rules)) if (!reasons[why]) problem('reason', `${what} ${name}`, `skip rule names undefined reason "${why}"`);
}

/** Expected reason for a run: files[path] is a reason id, or { strict?, sloppy? }. */
const expectedWhy = (path, mode) => {
  const e = expectations.files?.[path];
  return typeof e === 'string' ? e : e?.[mode];
};

// One run per test and mode, unless a skip rule covers the test.
const runs = [];
const skipped = {}; // reason id → runs not run
for (const path of files) {
  if (filter && !path.includes(filter)) continue;
  const src = readFileSync(join(root, 'test', path), 'utf8');
  const meta = frontmatter(src);
  const modes = meta.flags.includes('raw') || meta.flags.includes('noStrict') ? ['sloppy'] : meta.flags.includes('onlyStrict') ? ['strict'] : ['sloppy', 'strict'];
  const rule = skipPaths[path] ?? meta.flags.map((f) => skipFlags[f]).find(Boolean) ?? meta.features.map((f) => skipFeatures[f]).find(Boolean);
  if (rule) {
    skipped[rule] = (skipped[rule] ?? 0) + modes.length;
    continue;
  }
  for (const mode of modes) runs.push({ path, mode, src, meta });
}

// ---- running ----

const harnessCache = new Map();
const harness = (name) => {
  if (!harnessCache.has(name)) harnessCache.set(name, readFileSync(join(root, 'harness', name), 'utf8'));
  return harnessCache.get(name);
};

// What test262's host hooks need, before the harness. `print` is how async
// tests report (doneprintHandle.js); `$262.detachArrayBuffer` detaches with
// ArrayBuffer.prototype.transfer, captured before a test can patch it.
// Not provided: createRealm, evalScript, gc, agent, IsHTMLDDA (see the
// skip rules and reasons).
const HOST = `var $262 = (() => {
  const transfer = ArrayBuffer.prototype.transfer;
  const detached = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached').get;
  const apply = Reflect.apply;
  let settle;
  const done = new Promise((resolve) => (settle = resolve));
  globalThis.print = (msg) => {
    msg = String(msg);
    if (msg.startsWith('Test262:Async')) settle(msg);
  };
  Object.defineProperty(globalThis, '__t262_async', { value: done });
  return { global: globalThis, detachArrayBuffer: (buffer) => {
    if (!apply(detached, buffer, [])) apply(transfer, buffer, []);
    return null;
  } };
})();
`;
// For a negative test that expects Test262Error at runtime: the thrown
// object has no own name, and isolane reports only names.
const NAME_T262_ERROR = `Test262Error.prototype.name = 'Test262Error';\n`;

function program(run) {
  const { meta, src, mode } = run;
  if (meta.flags.includes('raw')) return src;
  const parts = [mode === 'strict' ? '"use strict";\n' : '', HOST, harness('assert.js'), harness('sta.js')];
  if (meta.flags.includes('async')) parts.push(harness('doneprintHandle.js'));
  for (const inc of meta.includes) parts.push(harness(inc));
  if (meta.negative?.phase === 'runtime' && meta.negative.type === 'Test262Error') parts.push(NAME_T262_ERROR);
  parts.push(src);
  // Async tests finish when they print a result; the eval waits on it.
  parts.push(meta.flags.includes('async') ? '\n;__t262_async' : '\n;undefined');
  return parts.join('\n');
}

const options = { eval: true, limits: { timeoutMs: 20_000 } };

/** Run one test in one mode; returns { status: PASS|FAIL|TIMEOUT|CRASH, message }. */
async function runOne(run, lane) {
  const tenant = `test262-${lane}`;
  const crashesBefore = crashes.length;
  const neg = run.meta.negative;
  try {
    const value = await runtime.tenant(tenant).run(program(run), options);
    if (neg) return { status: 'FAIL', message: `expected ${neg.phase} ${neg.type}, but it completed` };
    if (run.meta.flags.includes('async') && value !== 'Test262:AsyncTestComplete') return { status: 'FAIL', message: String(value) };
    return { status: 'PASS' };
  } catch (e) {
    const crash = crashes.slice(crashesBefore).find((c) => c.tenant === tenant);
    if (crash) return { status: 'CRASH', message: `${crash.kind}: ${crash.detail ?? ''}`.slice(0, 300) };
    if (e.code === 'ERR_LIMIT' && e.limit === 'timeoutMs') return { status: 'TIMEOUT', message: e.message };
    const name = e.guest?.name;
    if (neg && e.code === 'ERR_GUEST_EXCEPTION' && name === neg.type) return { status: 'PASS' };
    const message = e.code === 'ERR_GUEST_EXCEPTION' ? `${name ?? 'thrown'}: ${e.guest?.message ?? ''}` : `${e.code ?? ''} ${e.message}`;
    return { status: 'FAIL', message: (neg ? `expected ${neg.phase} ${neg.type}, got ${message}` : message).slice(0, 300) };
  }
}

const started = Date.now();
const results = {}; // path → { mode → result }
let next = 0;
let finished = 0;
const progress = setInterval(() => console.error(`test262: ${finished} of ${runs.length}`), 30_000);
try {
  await Promise.all(
    Array.from({ length: concurrency }, async (_, lane) => {
      while (next < runs.length) {
        const run = runs[next++];
        (results[run.path] ??= {})[run.mode] = await runOne(run, lane);
        finished++;
      }
    }),
  );
} finally {
  clearInterval(progress);
  runtime.close();
}
const seconds = (Date.now() - started) / 1000;

// ---- checking ----

const tally = { runs: runs.length, pass: 0, expected: Object.fromEntries(CATEGORIES.map((c) => [c, 0])), unexpected: 0 };
const byReason = {};
for (const [why, n] of Object.entries(skipped)) {
  byReason[why] = (byReason[why] ?? 0) + n;
  const cat = reasons[why]?.category;
  if (cat in tally.expected) tally.expected[cat] += n;
}
for (const [path, modes] of Object.entries(results)) {
  for (const [mode, r] of Object.entries(modes)) {
    const id = `${path} (${mode})`;
    const why = expectedWhy(path, mode);
    if (r.status === 'PASS') {
      tally.pass++;
      if (why) problem('unexpected-pass', id, 'listed as failing but passes');
      continue;
    }
    if (!why) {
      tally.unexpected++;
      problem(r.status === 'CRASH' ? 'crash' : 'regression', id, `${r.status}${r.message ? `: ${r.message}` : ''}`);
      continue;
    }
    if (why === 'unclassified' || !reasons[why]) {
      problem('unclassified', id, `reason "${why}" is ${why === 'unclassified' ? 'not yet classified' : 'not defined'}`);
      continue;
    }
    tally.expected[reasons[why].category]++;
    byReason[why] = (byReason[why] ?? 0) + 1;
  }
}
if (!filter) {
  for (const [path, e] of Object.entries(expectations.files ?? {})) {
    if (skipPaths[path]) continue;
    for (const mode of typeof e === 'string' ? ['sloppy', 'strict'] : Object.keys(e)) {
      if (typeof e === 'string' && results[path] && !results[path][mode]) continue; // single-mode test
      if (!results[path]?.[mode]) problem('stale', `${path} (${mode})`, 'listed, but no longer run');
    }
  }
}

// ---- --update ----

if (update) {
  const out = { test262Commit: TEST262_COMMIT, reasons: { ...reasons }, skip: expectations.skip ?? blank.skip, files: {} };
  let unclassified = 0;
  const paths = filter ? [...new Set([...Object.keys(expectations.files ?? {}), ...Object.keys(results)])] : Object.keys(results);
  for (const path of paths.sort()) {
    const modes = results[path];
    if (!modes) {
      if (expectations.files?.[path]) out.files[path] = expectations.files[path]; // outside this --filter: keep
      continue;
    }
    const failing = Object.entries(modes).filter(([, r]) => r.status !== 'PASS');
    if (!failing.length) continue;
    const whys = Object.fromEntries(failing.map(([mode]) => [mode, expectedWhy(path, mode) ?? 'unclassified']));
    const ids = Object.values(whys);
    unclassified += ids.filter((w) => w === 'unclassified').length;
    out.files[path] = failing.length === Object.keys(modes).length && ids.every((w) => w === ids[0]) ? ids[0] : whys;
  }
  if (unclassified) out.reasons.unclassified = { category: 'unclassified', reason: 'New since the last update: read the test and classify it.' };
  else delete out.reasons.unclassified;
  writeFileSync(expectationsPath, JSON.stringify(out, null, 2) + '\n');
  console.error(`wrote ${expectationsPath} (${Object.keys(out.files).length} tests with expected failures, ${unclassified} unclassified)`);
}

// ---- report ----

const skippedRuns = Object.values(skipped).reduce((a, b) => a + b, 0);
const total = tally.runs + skippedRuns;
const excluded = tally.expected['by-design'] + tally.expected.draft;
const applicable = total - excluded;
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');
const report = {
  test262Commit: TEST262_COMMIT,
  devBuild,
  seconds,
  tests: files.length,
  runs: tally.runs,
  skippedRuns,
  pass: tally.pass,
  passRate: pct(tally.pass, total),
  applicable,
  applicablePassRate: pct(tally.pass, applicable),
  expectedByCategory: tally.expected,
  byReason,
  problems: problems.slice(0, 500),
  problemCount: problems.length,
  ...(verbose ? { results } : {}),
};
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

const lines = [
  `### test262 (${TEST262_COMMIT.slice(0, 12)}${devBuild ? ', development build' : ''})`,
  '',
  `${tally.pass} of ${total} test runs pass (${report.passRate}; each test runs in strict and non-strict mode unless its flags say otherwise); **${report.applicablePassRate} of the ${applicable} that apply** (excluding by-design and draft). ${skippedRuns} runs are skipped by rule and counted under their reason.`,
  '',
  '| Expected failures | Runs |',
  '|---|---|',
  ...CATEGORIES.map((c) => `| ${c} | ${tally.expected[c]} |`),
  '',
  '| Reason | Runs |',
  '|---|---|',
  ...Object.entries(byReason)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `| ${id} (${reasons[id]?.category ?? '?'}) | ${n} |`),
  '',
];
if (problems.length) {
  lines.push(`**${problems.length} problems**:`, '');
  for (const p of problems.slice(0, 100)) lines.push(`- ${p.kind}: \`${p.key}\`${p.detail ? `: ${p.detail}` : ''}`);
  lines.push('');
} else lines.push('No problems: every test matches its expectation.', '');
lines.push(`${seconds.toFixed(0)} s.`);
const summary = lines.join('\n') + '\n';
if (summaryPath) writeFileSync(summaryPath, summary, { flag: 'a' });
console.log(summary);

process.exit(update || !problems.length ? 0 : 1);
