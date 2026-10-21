// Programs (tenant.load): ES modules evaluated once per instance (setup,
// without I/O), handlers called by name, and the pool of warm instances.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { IsolaneError, Program } from '../dist/index.js';
import { base } from './http-server.mjs';
import { pool, code, limit } from './helpers.mjs';

const tenant = pool.tenant('programs');
const load = (source, options) => tenant.load(source, options);
const NET = { fetch: { hosts: ['localhost:*'], privateNetworks: true } };

test('a program calls its named exports and its default export\'s methods', async (t) => {
  const program = await load(`
    let calls = 0;
    export function count() { return ++calls; }
    export async function later(x) { await new Promise((r) => setTimeout(r, 5)); return { x }; }
    export const notAFunction = 1;
    export function bytes(n) { return new Uint8Array(n).fill(9); }
    class App { constructor() { this.tag = 'app'; } hello(who) { return 'hello ' + who + ' from ' + this.tag; } }
    export default { greet(who) { return this.prefix + who; }, prefix: 'hi ', count: () => 'shadowed by the named export' };
    globalThis.app = new App();
  `);
  t.after(() => program.close());
  assert.ok(program instanceof Program);
  assert.equal(program.tenant, 'programs');
  // Warm: module state persists between calls.
  assert.equal(await program.call('count'), 1);
  assert.equal(await program.call('count'), 2);
  assert.deepEqual(await program.call('later', ['y']), { x: 'y' });
  assert.equal(await program.call('greet', ['ada']), 'hi ada');
  assert.deepEqual([...(await program.call('bytes', [2]))], [9, 9]);
  for (const name of ['missing', 'notAFunction', 'toString', 'hasOwnProperty', 'prefix', 'hello']) {
    await assert.rejects(program.call(name), (err) => code('ERR_HANDLER_NOT_FOUND')(err) && err.kind === 'guest', name);
  }
  await assert.rejects(program.call('__isolane_web_fetch'), code('ERR_INVALID_CONFIG'));
  // A miss leaves the instance in service, state and all.
  assert.equal(await program.call('count'), 3);
});

test('a default export that is a class instance has its prototype methods called', async (t) => {
  const program = await load(`
    class App { constructor() { this.n = 0; } fetch(x) { return ++this.n + x; } }
    export default new App();
  `);
  t.after(() => program.close());
  assert.equal(await program.call('fetch', [10]), 11);
  assert.equal(await program.call('fetch', [10]), 12);
  await assert.rejects(program.call('constructor'), (err) => err instanceof IsolaneError && err.kind === 'guest');
});

test('isolane:env gives the program its env, with host functions mounted in it', async (t) => {
  const program = await load(
    `
    import { env } from 'isolane:env';
    const atSetup = env.greeting;
    export async function use(id) {
      return { atSetup, user: await env.db.get(id), sum: await env.add(2, 3), onGlobal: typeof globalThis.db + ' ' + typeof globalThis.add };
    }
  `,
    { env: { greeting: 'hello', nested: { a: [1, 2] } }, host: { db: { get: (id) => ({ id }) }, add: (a, b) => a + b } },
  );
  t.after(() => program.close());
  assert.deepEqual(await program.call('use', [7]), { atSetup: 'hello', user: { id: 7 }, sum: 5, onGlobal: 'undefined undefined' });

  // Without an env, isolane:env exports an empty object.
  const bare = await load(`import { env } from 'isolane:env'; export const keys = () => Object.keys(env);`);
  t.after(() => bare.close());
  assert.deepEqual(await bare.call('keys'), []);

  await assert.rejects(load('export {}', { env: [] }), code('ERR_INVALID_CONFIG'));
  await assert.rejects(load('export {}', { env: { x: 1n } }), code('ERR_INVALID_CONFIG'));
  await assert.rejects(load('export {}', { env: { db: 1 }, host: { db: { get: () => 1 } } }), (err) => code('ERR_INVALID_CONFIG')(err) && err.message.includes('env.db'));
});

test('a program that fails to load rejects load with what went wrong, and where', async () => {
  const syntax = await load('export const x = ;').catch((err) => err);
  assert.equal(syntax.code, 'ERR_GUEST_EXCEPTION');
  assert.equal(syntax.guest.name, 'SyntaxError');
  assert.deepEqual({ file: syntax.guest.location.file, line: syntax.guest.location.line }, { file: 'main.js', line: 1 });

  const threw = await load('const a = 1;\nthrow new RangeError("boom");', { filename: 'src/app.js' }).catch((err) => err);
  assert.equal(threw.code, 'ERR_GUEST_EXCEPTION');
  assert.equal(threw.guest.name, 'RangeError');
  assert.match(threw.guest.stack, /src\/app\.js:2:7/);

  const rejected = await load('await Promise.reject(new TypeError("later"))').catch((err) => err);
  assert.equal(rejected.code, 'ERR_GUEST_EXCEPTION');
  assert.equal(rejected.guest.message, 'later');

  // A single-module program has no other files to import (multi-file programs: modules.test.mjs).
  const imported = await load('import x from "./other.js"; export default x;').catch((err) => err);
  assert.equal(imported.code, 'ERR_GUEST_EXCEPTION');
  assert.match(imported.message, /Cannot find module "\.\/other\.js"/);

  await assert.rejects(load({ main: 'a.js', files: {} }), (err) => code('ERR_INVALID_CONFIG')(err) && /source\.main/.test(err.message));
  await assert.rejects(load('export {}', { filename: 'isolane:env' }), code('ERR_INVALID_CONFIG'));
  await assert.rejects(load('export {}', { nope: 1 }), code('ERR_INVALID_CONFIG'));
});

test('import.meta.url is the module\'s path as a file: URL', async (t) => {
  const program = await load('const url = import.meta.url; export const where = () => url;', { filename: 'src/my app.js' });
  t.after(() => program.close());
  assert.equal(await program.call('where'), 'file:///src/my%20app.js');
});

test('dynamic import() loads built-in modules too', async (t) => {
  const program = await load('export async function f(name) { try { return Object.keys(await import(name)); } catch (e) { return e.name + ": " + e.message; } }');
  t.after(() => program.close());
  assert.deepEqual(await program.call('f', ['isolane:env']), ['env']);
  assert.match(await program.call('f', ['./other.js']), /^TypeError: Cannot find module/);
});

test('setup can\'t do I/O: fetch, connect, fs, and host functions fail with ERR_SETUP_IO', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'isolane-program-'));
  writeFileSync(join(root, 'a.txt'), 'file');
  const listener = createServer((s) => s.end('tcp'));
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => listener.close());
  const port = listener.address().port;
  const config = {
    ...NET,
    connect: { hosts: [`127.0.0.1:${port}`], privateNetworks: true },
    fs: { root },
    host: { lookup: (id) => ({ id }) },
  };
  const cases = [
    ['fetch()', `await fetch('${base}/json');`],
    ['connect()', `await connect('127.0.0.1:${port}').opened;`],
    ['fs', `await fs.readFile('a.txt');`],
    ['the host function lookup', `import { env } from 'isolane:env';\nawait env.lookup(1);`],
  ];
  for (const [what, setup] of cases) {
    const err = await load(`const before = 1;\n${setup}`, config).catch((e) => e);
    assert.equal(err.code, 'ERR_SETUP_IO', what);
    assert.equal(err.kind, 'guest');
    assert.ok(err.guest.message.includes(`${what} can't be used while the program sets up`) || err.guest.cause?.message?.includes(what), `${what}: ${err.guest.message}`);
  }
  // Refused, and caught: the load goes on; in calls, the same I/O works.
  const program = await load(
    `
    import { env } from 'isolane:env';
    let refused;
    try { await env.lookup(0); } catch (e) { refused = e.code; }
    await new Promise((r) => setTimeout(r, 5)); // timers are fine
    export async function io() {
      const json = await (await fetch('${base}/json')).json();
      const file = new TextDecoder().decode(await fs.readFile('a.txt'));
      const socket = connect('127.0.0.1:${port}');
      const { value } = await socket.readable.getReader().read();
      return { refused, json, file, tcp: new TextDecoder().decode(value), host: await env.lookup(1) };
    }
  `,
    config,
  );
  t.after(() => program.close());
  assert.deepEqual(await program.call('io'), { refused: 'ERR_SETUP_IO', json: { hi: 'wörld' }, file: 'file', tcp: 'tcp', host: { id: 1 } });
});

test('setup runs under limits.timeoutMs, and limits.startupCpuMs on Linux', async () => {
  await assert.rejects(load('for (;;) {}', { limits: { timeoutMs: 100 } }), limit('timeoutMs'));
  if (process.platform === 'linux') {
    await assert.rejects(load('for (;;) {}', { limits: { startupCpuMs: 50, timeoutMs: 10_000 } }), limit('startupCpuMs'));
    // Calls are held to cpuMs, not startupCpuMs. (The clock is frozen while
    // a call runs, so the spin counts iterations: well over 50 ms of CPU.)
    const program = await load('export function spin(n) { let x = 0; for (let i = 0; i < n; i++) x = (x + i) | 0; return x === x ? 1 : 0; }', {
      limits: { startupCpuMs: 50, cpuMs: 5_000 },
    });
    assert.equal(await program.call('spin', [3e8]), 1);
    await program.close();
  }
  await assert.rejects(load('export {}', { limits: { startupCpuMs: 0 } }), code('ERR_INVALID_CONFIG'));
});

test('the frozen clock moves when setup starts and when each call starts', { skip: process.env.ISOLANE_DEV_INSECURE === '1' && 'the dev build has no clock patch' }, async (t) => {
  const program = await load('const loaded = Date.now(); export function times() { const a = Date.now(); for (let i = 0; i < 1e6; i++); return [loaded, a, Date.now()]; }');
  t.after(() => program.close());
  await sleep(20);
  const [loaded, first, same] = await program.call('times');
  assert.ok(first > loaded);
  assert.equal(same, first);
  await sleep(20);
  const [, second] = await program.call('times');
  assert.ok(second > first);
});

test('the pool runs calls in parallel up to instances.max, and queues the rest', async (t) => {
  const program = await load('export async function wait(ms) { await new Promise((r) => setTimeout(r, ms)); return 1; }', { instances: { max: 2, queueMs: 5_000 } });
  t.after(() => program.close());
  const started = performance.now();
  const calls = [program.call('wait', [200]), program.call('wait', [200]), program.call('wait', [200])];
  await sleep(50);
  assert.deepEqual({ instances: program.usage().instances, busy: program.usage().busy, queued: program.usage().queued }, { instances: 2, busy: 2, queued: 1 });
  assert.deepEqual(await Promise.all(calls), [1, 1, 1]);
  // Two ran at once, then the third.
  const took = performance.now() - started;
  assert.ok(took >= 380 && took < 1_500, `took ${took}ms`);
  assert.equal(program.usage().instances, 2);
});

test('a call waits at most instances.queueMs for an instance', async (t) => {
  const limits = [];
  const program = await load('export async function wait(ms) { await new Promise((r) => setTimeout(r, ms)); return ms; }', {
    instances: { max: 1, queueMs: 50 },
    hooks: { onLimit: (e) => limits.push(e) },
  });
  t.after(() => program.close());
  const slow = program.call('wait', [300]);
  await assert.rejects(program.call('wait', [1]), (err) => limit('instances.queueMs')(err) && err.kind === 'limit');
  assert.equal(await slow, 300);
  assert.equal(limits[0]?.program, program.id);
  // An aborted wait leaves the queue.
  const busy = program.call('wait', [200]);
  const ac = new AbortController();
  const waiting = program.call('wait', [1], { signal: ac.signal });
  ac.abort('enough');
  await assert.rejects(waiting, (err) => code('ERR_ABORTED')(err) && err.reason === 'enough');
  assert.equal(program.usage().queued, 0);
  await busy;
});

test('idle instances close after instances.idleMs, down to instances.min', async (t) => {
  const idle = await load('export const f = () => 1;', { instances: { idleMs: 50 } });
  t.after(() => idle.close());
  assert.equal(await idle.call('f'), 1);
  assert.equal(idle.usage().instances, 1);
  await sleep(200);
  assert.equal(idle.usage().instances, 0);
  // The next call loads a fresh one.
  assert.equal(await idle.call('f'), 1);
  assert.equal(idle.usage().loads, 2);

  const kept = await load('export const f = () => 1;', { instances: { min: 2, idleMs: 50 } });
  t.after(() => kept.close());
  await sleep(200);
  assert.equal(kept.usage().instances, 2);
  await assert.rejects(load('export {}', { instances: { min: 3, max: 2 } }), code('ERR_INVALID_CONFIG'));
  await assert.rejects(load('export {}', { instances: { size: 2 } }), code('ERR_INVALID_CONFIG'));
});

test('a call stopped part-way retires its instance, which is replaced, and queued calls go to the new one', async (t) => {
  const program = await load(
    `
    let calls = 0;
    export function count() { return ++calls; }
    export function spin() { for (;;); }
    export function boom() { throw new Error('handler threw'); }
  `,
    { limits: { timeoutMs: 100 }, instances: { max: 1, queueMs: 5_000 } },
  );
  t.after(() => program.close());
  assert.equal(await program.call('count'), 1);
  // A throw keeps the instance (and its state).
  await assert.rejects(program.call('boom'), (err) => code('ERR_GUEST_EXCEPTION')(err) && err.guest.message === 'handler threw');
  assert.equal(await program.call('count'), 2);
  // A timeout retires it; the call queued behind runs on its replacement.
  const [spun, next] = await Promise.allSettled([program.call('spin'), program.call('count')]);
  assert.ok(limit('timeoutMs')(spun.reason));
  assert.deepEqual(next, { status: 'fulfilled', value: 1 });
  assert.equal(program.usage().loads, 2);

  // An aborted call too.
  const ac = new AbortController();
  const running = program.call('spin', [], { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(running, code('ERR_ABORTED'));
  assert.equal(await program.call('count'), 1);
});

test('reuse: false gives every call a fresh instance', async (t) => {
  const program = await load('let calls = 0; export function count() { return ++calls; }', { instances: { reuse: false } });
  t.after(() => program.close());
  assert.equal(await program.call('count'), 1);
  assert.equal(await program.call('count'), 1);
  assert.equal(await program.call('count'), 1);
  // The first call used the instance load() made.
  assert.equal(program.usage().loads, 3);
});

test('close() waits for running calls, and refuses new and queued ones', async () => {
  const program = await load('export async function wait(ms) { await new Promise((r) => setTimeout(r, ms)); return ms; }', { instances: { max: 1 } });
  const running = program.call('wait', [150]);
  const queued = program.call('wait', [1]);
  await sleep(20);
  const closed = program.close();
  assert.equal(program.close(), closed);
  await assert.rejects(queued, (err) => code('ERR_PROGRAM_CLOSED')(err) && err.kind === 'usage');
  await assert.rejects(program.call('wait', [1]), code('ERR_PROGRAM_CLOSED'));
  assert.equal(await running, 150);
  await closed;
  assert.equal(program.usage().instances, 0);
  // Symbol.asyncDispose (what `await using` calls; Node 22 lacks the syntax) closes it too.
  const disposable = await load('export const f = () => 2;');
  assert.equal(await disposable.call('f'), 2);
  await disposable[Symbol.asyncDispose]();
  await assert.rejects(disposable.call('f'), code('ERR_PROGRAM_CLOSED'));
});

test('usage counts calls, failures, loads, and CPU', async (t) => {
  const program = await load('export const ok = () => 1; export function bad() { throw new Error("no"); }');
  t.after(() => program.close());
  await program.call('ok');
  await program.call('bad').catch(() => {});
  await program.call('missing').catch(() => {});
  const u = program.usage();
  assert.deepEqual({ calls: u.calls, failures: u.failures, loads: u.loads, loadFailures: u.loadFailures, instances: u.instances, busy: u.busy, queued: u.queued }, {
    calls: 3,
    failures: 2,
    loads: 1,
    loadFailures: 0,
    instances: 1,
    busy: 0,
    queued: 0,
  });
  assert.equal(typeof u.cpuMs, 'number');
  if (process.platform === 'linux') assert.ok(u.cpuMs > 0);
});

test('events name the program: programLoad, call, guestError, log', async (t) => {
  const seen = { programLoad: [], call: [], guestError: [], log: [] };
  const offs = Object.keys(seen).map((name) => pool.on(name, (e) => e.tenant === 'programs-events' && seen[name].push(e)));
  t.after(() => offs.forEach((off) => off()));
  const program = await pool.tenant('programs-events').load(
    'export function f() { console.log("hi"); Promise.reject(new Error("unhandled")); return 1; }',
    { filename: 'events.js' },
  );
  t.after(() => program.close());
  assert.equal(await program.call('f', []), 1);
  await sleep(20);
  assert.equal(seen.programLoad.length, 1);
  assert.deepEqual({ ...seen.programLoad[0], durationMs: 0, isolate: 0 }, { tenant: 'programs-events', program: program.id, isolate: 0, filename: 'events.js', durationMs: 0 });
  assert.equal(seen.call[0]?.program, program.id);
  assert.equal(seen.call[0]?.name, 'f');
  assert.equal(seen.guestError[0]?.program, program.id);
  assert.equal(seen.log[0]?.program, program.id);

  const failed = [];
  await assert.rejects(pool.tenant('programs-events').load('throw 1', { hooks: { onProgramLoad: (e) => failed.push(e) } }));
  assert.equal(failed[0]?.error?.code, 'ERR_GUEST_EXCEPTION');
});
