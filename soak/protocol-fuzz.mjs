// Fuzz the supervisor's side of the worker protocol: fake workers (standing
// in for a compromised worker) send ready, then a random mix of valid,
// malformed, and hostile frames. Invariants: every eval settles (resolves,
// or rejects with a IsolaneError); the supervisor never throws outside a
// promise; a worker that breaks the protocol is killed; the pool keeps
// serving other tenants.
//   node soak/protocol-fuzz.mjs [iterations] [seed]
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime, IsolaneError } from '../dist/index.js';

const iterations = Number(process.argv[2] ?? 2000);
let seed = Number(process.argv[3] ?? Date.now() % 1e9);
const firstSeed = seed;

const failures = [];
process.on('uncaughtException', (e) => failures.push({ kind: 'uncaughtException', error: String(e?.stack ?? e) }));
process.on('unhandledRejection', (e) => failures.push({ kind: 'unhandledRejection', error: String(e?.stack ?? e) }));

// The fake worker gets its plan as JSON and executes it after the first
// eval arrives: a list of steps, each raw bytes (base64) or a JSON message
// with `$req`/`$vm` placeholders for the eval's ids.
const dir = mkdtempSync(join(tmpdir(), 'isolane-fuzz-'));
function fakeWorker(plan, i) {
  const path = join(dir, `w${i}`);
  writeFileSync(
    path,
    `#!${process.execPath}
const plan = ${JSON.stringify(plan)};
const out = (b) => process.stdout.write(b);
const frame = (b) => { const h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]); };
const fill = (v, ids) => JSON.parse(JSON.stringify(v), (k, x) => x === '$req' ? ids.req : x === '$vm' ? ids.vm : x);
out(frame(Buffer.from(JSON.stringify(plan.ready))));
let buf = Buffer.alloc(0), done = false;
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
    const msg = JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)));
    buf = buf.subarray(4 + buf.readUInt32LE(0));
    if (msg.t !== 'eval' || done) continue;
    done = true;
    for (const s of plan.steps) {
      if (s.raw) out(Buffer.from(s.raw, 'base64'));
      else if (s.binmsg) {
        // A binary frame: tag, JSON length (maybe wrong), JSON, bytes.
        const json = Buffer.from(JSON.stringify(fill(s.binmsg, msg)));
        const head = Buffer.alloc(5);
        head[0] = s.tag;
        head.writeUInt32LE(s.jsonLen ?? json.length, 1);
        out(frame(Buffer.concat([head, json, Buffer.from(s.bytes, 'base64')])));
      } else out(frame(Buffer.from(JSON.stringify(fill(s.msg, msg)))));
    }
    if (plan.exit) process.exit(plan.exit);
  }
});
setInterval(() => {}, 1000);
`,
  );
  chmodSync(path, 0o755);
  return path;
}

// ---- generator ----
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rand() * a.length)];
const weird = () =>
  pick([null, true, -1, 0, 1.5, 2 ** 53, -(2 ** 63), NaN, '', 'x'.repeat(1 + Math.floor(rand() * 5000)), [], {}, { __proto__: { a: 1 } }, '$req', '$vm', '\u0000', '\ud800', [[[[[]]]]]]);
const values = () => pick([undefined, '1', 'null', '"s"', '{"a":[1,2]}', '{', '1e999', '"\\ud800"', JSON.stringify('x'.repeat(10000))]);
function message() {
  const t = pick(['result', 'result', 'hostCall', 'ready', 'bogus', weird()]);
  const m = { t };
  if (rand() < 0.9) m.req = rand() < 0.7 ? '$req' : weird();
  if (rand() < 0.5) m.vm = rand() < 0.7 ? '$vm' : weird();
  if (rand() < 0.7) m.ok = rand() < 0.8 ? rand() < 0.5 : weird();
  // `value` is JSON text (or absent); sometimes not valid JSON.
  if (rand() < 0.6) m.value = rand() < 0.7 ? values() : weird();
  if (rand() < 0.4) m.code = pick(['ERR_LIMIT', 'ERR_GUEST_EXCEPTION', 'ERR_SHIM', 'ERR_NOPE', weird()]);
  if (rand() < 0.2) m.shim = pick([{ phase: 'after', index: 0 }, { phase: 'before', index: 7 }, { phase: 'constructor', index: 0 }, weird()]);
  if (rand() < 0.2) m.limit = pick(['timeoutMs', 'heapBytes', 'nope', weird()]);
  if (rand() < 0.4) m.message = weird();
  if (t === 'hostCall') {
    m.call = rand() < 0.7 ? Math.floor(rand() * 5) : weird();
    m.fn = pick([0, 0, 1, -1, 1.5, '0', 2 ** 32, weird()]);
    m.args = rand() < 0.7 ? [weird(), 1] : weird();
  }
  if (rand() < 0.2) m[pick(['extra', '__proto__', 'constructor'])] = weird();
  return m;
}
function rawStep() {
  const kind = pick(['truncated', 'zero', 'huge', 'garbage', 'badjson', 'header-only']);
  const b = (s) => Buffer.from(s);
  const frame = (body) => { const h = Buffer.alloc(4); h.writeUInt32LE(body.length); return Buffer.concat([h, body]); };
  let bytes;
  if (kind === 'truncated') bytes = frame(b(JSON.stringify(message()))).subarray(0, 1 + Math.floor(rand() * 10));
  else if (kind === 'zero') bytes = frame(Buffer.alloc(0));
  else if (kind === 'huge') { bytes = Buffer.alloc(4); bytes.writeUInt32LE(Math.floor(rand() * 0xffffffff)); }
  else if (kind === 'garbage') bytes = Buffer.from(Array.from({ length: 1 + Math.floor(rand() * 64) }, () => Math.floor(rand() * 256)));
  else if (kind === 'badjson') bytes = frame(b(pick(['{', '[]', '"x"', 'null', '{"t":', '\xff\xfe', '{"t":"result","req":1}'.repeat(3)])));
  else bytes = Buffer.alloc(3);
  return { raw: bytes.toString('base64') };
}
// Byte attachments: well-formed host calls with bytes, and every way to get
// them wrong (lengths that don't add up, bad or repeated indices, a
// placeholder that isn't null, bytes on a message that takes none, a JSON
// length that overruns the frame).
function binStep() {
  const nArgs = Math.floor(rand() * 4);
  const args = Array.from({ length: nArgs }, () => (rand() < 0.6 ? null : weird()));
  const lens = [];
  const bin = [];
  for (let i = 0; i < nArgs; i++) {
    if (args[i] === null && rand() < 0.8) {
      const len = Math.floor(rand() * 64);
      bin.push([i, len]);
      lens.push(len);
    }
  }
  let total = lens.reduce((a, b) => a + b, 0);
  const corrupt = rand() < 0.5 ? pick(['extra-bytes', 'short-bytes', 'bad-index', 'dup-index', 'non-null', 'not-array', 'other-type', 'json-overrun', 'bad-tag', 'empty-bin']) : null;
  if (corrupt === 'extra-bytes') total += 1 + Math.floor(rand() * 8);
  if (corrupt === 'short-bytes' && total > 0) total -= 1;
  if (corrupt === 'bad-index' && bin.length) bin[0][0] = pick([nArgs, -1, 1.5, '0', 2 ** 40]);
  if (corrupt === 'dup-index' && bin.length) bin.push([...bin[0]]);
  if (corrupt === 'non-null' && bin.length) args[bin[0][0]] = weird() ?? 1;
  const binField = corrupt === 'not-array' ? weird() : corrupt === 'empty-bin' ? [] : bin;
  const t = corrupt === 'other-type' ? pick(['result', 'log', 'usage', 'ready']) : 'hostCall';
  const binmsg = { t, vm: '$vm', call: Math.floor(rand() * 5), fn: 0, args, bin: binField, req: '$req', ok: true, value: 'null' };
  const bytes = Buffer.from(Array.from({ length: total }, () => Math.floor(rand() * 256)));
  const step = { binmsg, tag: corrupt === 'bad-tag' ? pick([1, 2, 0x7a, 0xff]) : 0, bytes: bytes.toString('base64') };
  if (corrupt === 'json-overrun') step.jsonLen = 0xffffff;
  return step;
}

function plan() {
  const ready = rand() < 0.9
    ? { t: 'ready', protocol: rand() < 0.95 ? 2 : pick([1, 3, '2', weird()]), v8: 'fake', sandboxSecure: true, lockdown: { landlock: 'full', seccomp: 'full' } }
    : message();
  const steps = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => {
    const r = rand();
    return r < 0.55 ? { msg: message() } : r < 0.8 ? binStep() : rawStep();
  });
  return { ready, steps, exit: rand() < 0.1 ? pick([0, 1, 139]) : 0 };
}

// ---- run ----
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG')), ms))]);
const outcomes = {};
const started = Date.now();
try {
for (let i = 0; i < iterations; i++) {
  const caseSeed = seed;
  const p = plan();
  if (process.env.FUZZ_TRACE) process.stderr.write(`case ${i} seed ${caseSeed} ${JSON.stringify(p)}\n`);
  const events = [];
  const pool = new Runtime({
    workerPath: fakeWorker(p, i),
    hooks: { onSecurityEvent: (e) => events.push(e) },
    defaults: { limits: { idleMs: 1000 } },
  });
  const vm = pool.tenant('t').isolate({ limits: { timeoutMs: 2000 }, host: { echo: (x) => x } });
  let outcome;
  try {
    const v = await withTimeout(vm.eval('1'), 8000);
    outcome = `resolved`;
    void v;
  } catch (e) {
    if (e instanceof IsolaneError) outcome = e.code;
    else if (e?.message === 'HUNG') {
      // The supervisor must give up on a worker that never answers.
      outcome = 'hung';
      failures.push({ kind: 'eval never settled', seed: caseSeed, plan: p });
    } else {
      outcome = 'non-IsolaneError';
      failures.push({ kind: 'non-IsolaneError rejection', seed: caseSeed, plan: p, error: String(e?.stack ?? e) });
    }
  }
  if (events.some((e) => e.kind === 'protocol')) {
    const pid = pool.diagnostics.workerPid('t');
    if (pid !== undefined) failures.push({ kind: 'violating worker still registered', seed: caseSeed, plan: p });
  }
  outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  vm.close();
  pool.close();
}
} catch (e) {
  console.error('harness error:', e);
  process.exit(2);
}
const report = { iterations, seed: firstSeed, seconds: (Date.now() - started) / 1000, outcomes, failures: failures.slice(0, 20), failureCount: failures.length };
console.log(JSON.stringify(report, null, 2));
process.exit(failures.length ? 1 : 0);
