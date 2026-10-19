// Replay V8's own JavaScript test corpus (test/mjsunit, ~9000 files) through
// the real worker under the lockdown. Results don't matter (no mjsunit
// harness, no natives syntax, no d8 globals); crashes do. Each file runs in
// a fresh VM with a timeout and a heap cap. A worker that dies is recorded
// with the file and signal:
//   SIGSYS   a syscall the seccomp allowlist is missing
//   SIGSEGV  a crash, possibly a V8 sandbox violation
//   SIGTRAP/SIGILL  a V8 CHECK or fatal error (a safe crash, but a DoS)
//   node soak/corpus.mjs <v8 checkout> [concurrency] [shard/of]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { LanePool } from '../dist/index.js';

const v8dir = process.argv[2] ?? 'build/rusty_v8/v8';
const concurrency = Number(process.argv[3] ?? 4);
const [shard, shards] = (process.argv[4] ?? '0/1').split('/').map(Number);
const root = join(v8dir, 'test/mjsunit');

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.js') && !name.startsWith('mjsunit')) files.push(p);
  }
})(root);
const mine = files.filter((_, i) => i % shards === shard);

// Just enough of the mjsunit harness that files run past their first
// assertion. Assertions never throw: only reaching odd engine paths matters.
const prelude = `
for (const n of ['assertEquals','assertNotEquals','assertSame','assertNotSame','assertTrue','assertFalse',
  'assertNull','assertNotNull','assertInstanceof','assertArrayEquals','assertPropertiesEqual','assertMatches',
  'assertDoesNotThrow','assertEqualsDelta','assertContains','assertOptimized','assertUnoptimized','print',
  'printErr','gc','version','assertPromiseResult','assertUnreachable','assertThrowsAsync'])
  globalThis[n] = (...a) => { for (const x of a) if (typeof x === 'function' && n === 'assertDoesNotThrow') try { x(); } catch {} };
globalThis.assertThrows = (f) => { try { typeof f === 'function' && f(); } catch {} };
globalThis.__natives = new Proxy({}, { get: () => () => undefined });
`;

const pool = new LanePool({ strict: process.env.ISOLANE_STRICT === '1', onSecurityEvent: (e) => events.push(e) });
const events = [];
const outcomes = {};
const crashes = [];
let skipped = 0;
const started = Date.now();

async function runFile(path, tenant) {
  // %Natives() need --allow-natives-syntax to parse; make them no-ops.
  const src = readFileSync(path, 'utf8').replace(/%([A-Z][A-Za-z0-9]*)\(/g, '__natives.$1(');
  if (src.length > 4 << 20) {
    skipped++;
    return;
  }
  const before = events.length;
  try {
    await pool.run(prelude + src, { tenant, timeoutMs: 2000, memoryLimitBytes: 128 << 20 });
    outcomes.ok = (outcomes.ok ?? 0) + 1;
  } catch (e) {
    const c = e?.code ?? 'non-LaneError';
    outcomes[c] = (outcomes[c] ?? 0) + 1;
    if (c === 'ERR_WORKER_CRASHED') {
      const ev = events.slice(before).find((x) => x.tenant === tenant);
      crashes.push({ file: relative(root, path), signal: ev?.signal ?? null, exitCode: ev?.exitCode ?? null, kind: ev?.kind, detail: (ev?.detail ?? e.message).slice(-300) });
    }
  }
}

let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async (_, lane) => {
    while (next < mine.length) {
      const path = mine[next++];
      await runFile(path, `corpus-${lane}`);
      const done = next;
      if (done % 500 === 0) process.stderr.write(`${done}/${mine.length} files, ${crashes.length} crashes, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
    }
  }),
);
pool.close();

const bySignal = {};
for (const c of crashes) bySignal[c.signal ?? `exit ${c.exitCode}`] = (bySignal[c.signal ?? `exit ${c.exitCode}`] ?? 0) + 1;
const report = { files: mine.length, skipped, seconds: (Date.now() - started) / 1000, outcomes, crashesBySignal: bySignal, crashes };
console.log(JSON.stringify(report, null, 2));
// SIGSYS is an allowlist gap and fails the run; other crashes are reported.
process.exit(crashes.some((c) => c.signal === 'SIGSYS') ? 1 : 0);
