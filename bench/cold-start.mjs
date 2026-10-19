// Time to the first result for brand-new tenants (each needs a worker).
//   ISOLANE_WORKER=... node bench/cold-start.mjs [spares]
import { Runtime } from '../dist/index.js';

const spares = Number(process.argv[2] ?? 0);
const rt = new Runtime({ spares, strict: process.env.ISOLANE_STRICT !== '0' });
if (spares) await new Promise((r) => setTimeout(r, 1500)); // let the spares start
const times = [];
for (let i = 0; i < 20; i++) {
  const t0 = performance.now();
  await rt.run('1', { tenant: `cold-${i}` });
  times.push(performance.now() - t0);
  await new Promise((r) => setTimeout(r, 100)); // give the pool time to refill
}
times.sort((a, b) => a - b);
console.log(`spares=${spares}: p50 ${times[10].toFixed(1)} ms, p90 ${times[18].toFixed(1)} ms, min ${times[0].toFixed(1)} ms`);
rt.close();
