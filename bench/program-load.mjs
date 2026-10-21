// What a program's instances cost to load: the first instance (which
// compiles every module), then later fresh instances of the same program
// (reuse: false, so each call loads one), as programLoad reports them.
// Medians over many instances.
//   ISOLANE_WORKER=... node bench/program-load.mjs [module.mjs] [spareIsolates]
// Without a module, it's zod bundled with esbuild (about 760 KB), the size
// of a typical app with a dependency or two.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Runtime } from '../dist/index.js';

const spareIsolates = Number(process.argv[3] ?? 0);
const source = process.argv[2] && process.argv[2] !== '-'
  ? readFileSync(process.argv[2], 'utf8')
  : execFileSync(new URL('../node_modules/.bin/esbuild', import.meta.url).pathname, ['--bundle', '--format=esm', '--platform=neutral', '--main-fields=module,main', '--log-level=warning'], {
      input: "export * as z from 'zod';",
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf8',
    });
const code = `${source}\nexport function __benchCheck(value) { return typeof value === 'string' ? value.length : -1; }`;

const loads = [];
const modules = [];
const rt = new Runtime({ strict: process.env.ISOLANE_STRICT === '1', spareIsolates, hooks: { onProgramLoad: (e) => { loads.push(e.durationMs); modules.push(e.modules); } } });
const tenant = rt.tenant('bench');
await tenant.run('1'); // start the worker

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const n = 50;
const program = await tenant.load(code, { filename: 'bundle.js', instances: { reuse: false, max: 1 } });
const first = loads[0];
for (let i = 0; i < n; i++) await program.call('__benchCheck', ['x']);
const later = loads.slice(2); // the first call's instance is the one load made
const t = performance.now();
for (let i = 0; i < n; i++) await program.call('__benchCheck', ['x']);
const perCall = (performance.now() - t) / n;
console.log(`module: ${(code.length / 1024).toFixed(0)} KB, spareIsolates ${spareIsolates}`);
console.log(`${'first instance load'.padEnd(36)} ${first.toFixed(2).padStart(8)} ms`);
console.log(`${'later instance load (median)'.padEnd(36)} ${median(later).toFixed(2).padStart(8)} ms`);
console.log(`code cache: first ${JSON.stringify(modules[0])}, later ${JSON.stringify(modules.at(-1))}`);
console.log(`${'fresh-instance call (mean)'.padEnd(36)} ${perCall.toFixed(2).padStart(8)} ms`);
await program.close();
rt.close();
