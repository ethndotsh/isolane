// What the web platform costs: isolate creation with web off / on, the
// first use of an API in a fresh isolate, a new tenant's cold start, and
// memory per isolate. Each figure is the median over many fresh isolates.
//   ISOLANE_WORKER=... node bench/web-cost.mjs
import { execFileSync } from 'node:child_process';
import { Runtime } from '../dist/index.js';

const rt = new Runtime({ strict: process.env.ISOLANE_STRICT === '1' });
const tenant = rt.tenant('bench');
await tenant.run('1', { web: true }); // start the worker

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function time(code, config, n = 200) {
  for (let i = 0; i < 20; i++) await tenant.run(code, config);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await tenant.run(code, config);
    out.push(performance.now() - t);
  }
  return median(out);
}

const off = await time('1', { web: false });
const on = await time('1', { web: true });
const row = (label, ms, base = on) => console.log(`${label.padEnd(44)} ${ms.toFixed(3).padStart(8)} ms   (+${(ms - base).toFixed(3)})`);
row('fresh isolate, web off', off, off);
row('fresh isolate, web on', on, off);
row('  + first URL use', await time('new URL("https://a.example/b?c=1").searchParams.get("c")', { web: true }));
row('  + first Response use', await time('new Response("x").status', { web: true }));
row('  + first ReadableStream use', await time('new ReadableStream().locked', { web: true }));
row('  + TextEncoder', await time('new TextEncoder().encode("x").length', { web: true }));
row('  + structuredClone', await time('structuredClone({ a: [1] }).a.length', { web: true }));
row('  + all of the above', await time(
  'new URL("https://a/").href; new Response("x").status; new ReadableStream().locked; new TextEncoder().encode("x"); structuredClone(1)',
  { web: true },
));

// A new tenant's first result (a worker start), median of 10.
const cold = [];
for (let i = 0; i < 10; i++) {
  const t = performance.now();
  await rt.run('1', { tenant: `cold-${i}`, web: true });
  cold.push(performance.now() - t);
}
console.log(`${'new tenant, first result (worker start)'.padEnd(44)} ${median(cold).toFixed(1).padStart(8)} ms`);

// Memory: 100 live isolates that used the common APIs.
const rss = (pid) => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024;
const mem = rt.tenant('mem');
await mem.run('1');
const pid = rt.diagnostics.workerPid('mem');
const before = rss(pid);
const vms = [];
for (let i = 0; i < 100; i++) {
  const vm = mem.isolate({ web: true });
  await vm.eval('new URL("https://a/").href; new Response("x").status; new ReadableStream(); new TextEncoder(); 1');
  vms.push(vm);
}
const after = rss(pid);
console.log(`${'memory per live isolate (web, APIs used)'.padEnd(44)} ${((after - before) / 100).toFixed(2).padStart(8)} MB`);
vms.forEach((v) => v.close());
rt.close();
