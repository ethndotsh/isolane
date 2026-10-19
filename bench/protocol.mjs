// Where protocol time goes: eval and host-call round trips, by payload
// size, plus how much of it is JSON work. Run against a built worker:
//   ISOLANE_WORKER=... node bench/protocol.mjs
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime, hostFunction } from '../dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'isolane-bench-'));
writeFileSync(join(root, 'big.bin'), Buffer.alloc(1 << 20, 7));

const rt = new Runtime({ strict: process.env.ISOLANE_STRICT !== '0' });
const vm = rt.tenant('bench').isolate({
  host: { echo: (x) => x, nop: () => undefined, syncNop: hostFunction({ sync: true, handler: () => undefined }) },
});
await vm.eval('1');

async function time(label, n, f) {
  for (let i = 0; i < Math.min(200, n); i++) await f();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) await f();
  const us = Number(process.hrtime.bigint() - t0) / 1e3 / n;
  console.log(`${label.padEnd(44)} ${us.toFixed(1).padStart(9)} µs`);
  return us;
}

await time('eval round trip ("1")', 5000, () => vm.eval('1'));
await time('one async host call (nop) in an eval', 5000, () => vm.eval('nop()'));
await time('100 async host calls in one eval, per call', 50, () => vm.eval('(async () => { for (let i = 0; i < 100; i++) await nop(); })()')).then(() => {});
const per = await time('100 sync host calls in one eval (total)', 50, () => vm.eval('for (let i = 0; i < 100; i++) syncNop()'));
console.log(`${'  → per sync call'.padEnd(44)} ${(per / 100).toFixed(1).padStart(9)} µs`);
await time('100 async host calls, concurrent (total)', 50, () => vm.eval('Promise.all(Array.from({ length: 100 }, () => nop()))'));

for (const size of [1 << 10, 64 << 10, 1 << 20]) {
  const s = 'x'.repeat(size);
  await vm.eval(`globalThis.s${size} = 'x'.repeat(${size})`);
  await time(`echo ${size >> 10} KiB string through a host call`, size > 100000 ? 200 : 2000, () => vm.eval(`echo(s${size}).then((r) => r.length)`));
  const json = JSON.stringify(s);
  await time(`  JSON stringify+parse of it in Node only`, 2000, async () => JSON.parse(JSON.stringify(json)));
}

// Bytes: a 1 MiB Uint8Array through a host call, and a 1 MiB file read.
await vm.eval('globalThis.u8 = new Uint8Array(1 << 20).fill(3)');
await time('echo 1 MiB Uint8Array through a host call', 200, () => vm.eval('echo(u8).then((r) => r.length ?? Object.keys(r).length)'));
const fsVm = rt.tenant('bench').isolate({ fs: { root } });
await fsVm.eval('1');
await time('fs.readFile of a 1 MiB file', 200, () => fsVm.eval('fs.readFile("/big.bin").then((b) => b.length)'));
fsVm.close();
vm.close();
rt.close();
