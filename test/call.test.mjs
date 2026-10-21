// isolate.call: invoking a function the isolate defined, with arguments as
// data, budgeted as an eval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime, deny } from '../dist/index.js';
import { z } from 'zod';
import { pool, T, code, limit, isolate, strict } from './helpers.mjs';

const devBuild = process.env.ISOLANE_DEV_INSECURE === '1';

test('a call passes arguments and returns results as data', async () => {
  const vm = isolate(T);
  await vm.eval(`
    function add(a, b) { return a + b }
    async function later(x) { await null; return { x, list: [x, null] } }
    function kinds(...args) { return args.map((a) => a === null ? 'null' : a instanceof Uint8Array ? 'bytes:' + a.length : typeof a) }
    function bytes(n) { return new Uint8Array(n).fill(7) }
    globalThis.double = (x) => x * 2;
    globalThis.notAFunction = 1;
    const lexical = () => 1;
  `);
  assert.equal(await vm.call('add', [1, 2]), 3);
  assert.equal(await vm.call('add', ['a', 'b']), 'ab');
  assert.deepEqual(await vm.call('later', ['y']), { x: 'y', list: ['y', null] });
  assert.equal(await vm.call('double', [21]), 42);
  // No arguments; undefined crosses as null, as in an array.
  assert.deepEqual(await vm.call('kinds'), []);
  assert.deepEqual(await vm.call('kinds', [undefined, 's', 1, { a: 1 }]), ['null', 'string', 'number', 'object']);
  // Top-level bytes cross as bytes, both ways.
  assert.deepEqual(await vm.call('kinds', [Buffer.from('abc'), new Uint8Array(0), new ArrayBuffer(4)]), ['bytes:3', 'bytes:0', 'bytes:4']);
  const out = await vm.call('bytes', [3]);
  assert.ok(out instanceof Uint8Array);
  assert.deepEqual([...out], [7, 7, 7]);
  assert.equal((await vm.call('bytes', [0])).length, 0);
  // Only functions the isolate defined as globals are callable.
  for (const name of ['missing', 'notAFunction', 'lexical', 'toString', 'hasOwnProperty']) {
    await assert.rejects(vm.call(name), (err) => code('ERR_HANDLER_NOT_FOUND')(err) && err.kind === 'guest' && err.message.includes(name), name);
  }
  // isolane's own are refused before they're sent.
  await assert.rejects(vm.call('__isolane_web_fetch'), code('ERR_INVALID_CONFIG'));
  await assert.rejects(vm.call(''), code('ERR_INVALID_CONFIG'));
  await assert.rejects(vm.call('add', 1), code('ERR_INVALID_CONFIG'));
  await assert.rejects(vm.call('add', [1n]), code('ERR_INVALID_CONFIG'));
  // Not found leaves the isolate usable.
  assert.equal(await vm.call('add', [2, 2]), 4);
  vm.close();
  await assert.rejects(vm.call('add', [1, 2]), code('ERR_ISOLATE_CLOSED'));
});

test('a call result is checked against its returns schema', async () => {
  const vm = isolate(T);
  await vm.eval('function user(id) { return { id, name: id === 1 ? "ada" : 42 } }');
  const User = z.object({ id: z.number(), name: z.string() });
  const ada = await vm.call('user', [1], { returns: User });
  assert.deepEqual(ada, { id: 1, name: 'ada' });
  await assert.rejects(vm.call('user', [2], { returns: User }), code('ERR_INVALID_RETURN'));
  await assert.rejects(vm.call('user', [1], { returns: {} }), code('ERR_INVALID_CONFIG'));
  vm.close();
});

test('a handler that throws fails the call and keeps the isolate', async () => {
  const vm = isolate(T);
  await vm.eval(`
    let count = 0;
    function bump() { return ++count }
    function fail(why) { throw new RangeError(why) }
    async function reject() { await null; throw new TypeError('later') }
  `);
  assert.equal(await vm.call('bump'), 1);
  await assert.rejects(vm.call('fail', ['ids start at 1']), (err) => {
    assert.equal(err.code, 'ERR_GUEST_EXCEPTION');
    assert.equal(err.guest.name, 'RangeError');
    assert.equal(err.guest.message, 'ids start at 1');
    assert.match(err.guest.stack, /at fail/);
    return true;
  });
  await assert.rejects(vm.call('reject'), (err) => err.code === 'ERR_GUEST_EXCEPTION' && err.guest.name === 'TypeError');
  // State carries over between calls.
  assert.equal(await vm.call('bump'), 2);
  vm.close();
});

test('a call stopped part-way retires its isolate', async () => {
  const vm = isolate({ ...T, limits: { timeoutMs: 100 } });
  await vm.eval('function spin() { for (;;) {} } function ok() { return 1 }');
  await assert.rejects(vm.call('spin'), limit('timeoutMs'));
  await assert.rejects(vm.call('ok'), (err) => code('ERR_ISOLATE_RETIRED')(err) && err.retryable && err.kind === 'limit');
  await assert.rejects(vm.eval('1'), code('ERR_ISOLATE_RETIRED'));
  vm.close();

  const aborted = isolate(T);
  await aborted.eval('function spin() { for (;;) {} } function ok() { return 1 }');
  const ac = new AbortController();
  const running = aborted.call('spin', [], { signal: ac.signal });
  setTimeout(() => ac.abort('enough'), 50);
  await assert.rejects(running, (err) => code('ERR_ABORTED')(err) && err.reason === 'enough');
  await assert.rejects(aborted.call('ok'), code('ERR_ISOLATE_RETIRED'));
  aborted.close();

  // Already aborted: never sent, and the isolate stays usable.
  const fine = isolate(T);
  await fine.eval('function ok() { return 1 }');
  await assert.rejects(fine.call('ok', [], { signal: AbortSignal.abort() }), code('ERR_ABORTED'));
  assert.equal(await fine.call('ok'), 1);
  fine.close();
});

test('each call has its own budget: limits apply per call', async () => {
  let calls = 0;
  const vm = isolate({ ...T, host: { one: () => (calls++, 1) }, limits: { hostCalls: 3 } });
  await vm.eval(`
    async function three() { return (await Promise.all([one(), one(), one()])).length }
    async function four() { return (await Promise.all([one(), one(), one(), one()])).length }
  `);
  for (let i = 0; i < 3; i++) assert.equal(await vm.call('three'), 3);
  assert.equal(calls, 9);
  await assert.rejects(vm.call('four'), limit('hostCalls'));
  // CPU: each call may use up to cpuMs, however many came before.
  const cpu = isolate({ ...T, limits: { cpuMs: 300 } });
  await cpu.eval('function busy() { let x = 0; for (let i = 0; i < 2e7; i++) x += i; return x > 0 }');
  for (let i = 0; i < 5; i++) assert.equal(await cpu.call('busy'), true);
  cpu.close();
  vm.close();
});

test('the clock advances at each call and is frozen during it', { skip: devBuild && 'the dev build has no clock patch' }, async () => {
  const vm = isolate(T);
  await vm.eval('function now() { const a = Date.now(); let x = 0; for (let i = 0; i < 3e7; i++) x += i; return [a, Date.now()] }');
  const [a1, b1] = await vm.call('now');
  assert.equal(a1, b1, 'frozen during the call');
  await new Promise((r) => setTimeout(r, 20));
  const [a2] = await vm.call('now');
  assert.ok(a2 >= a1 + 15, `advanced between calls (${a1} → ${a2})`);
  vm.close();
});

test('a call settles with its handler; work it leaves runs in the background', async () => {
  const vm = isolate(T);
  await vm.eval(`
    globalThis.log = [];
    function kick() {
      setTimeout(() => log.push('timer'), 20);
      Promise.resolve().then(() => log.push('microtask'));
      return 'settled';
    }
    function seen() { return log }
  `);
  assert.equal(await vm.call('kick'), 'settled');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(await vm.call('seen'), ['microtask', 'timer']);
  vm.close();
});

test('beforeCall and afterCall intercept calls, and runtime.on("call") observes them', async (ctx) => {
  const rt = new Runtime({ strict });
  ctx.after(() => rt.close());
  const seen = [];
  rt.on('call', (e) => seen.push([e.name, e.args, e.result, e.error?.code]));
  const vm = rt.tenant('hooks').isolate({
    hooks: {
      beforeCall: (e) => (e.name === 'secret' ? deny('not on your plan') : { args: e.args.map((a) => a * 10) }),
      afterCall: (e) => (e.error ? undefined : { result: e.result + 1 }),
    },
  });
  await vm.eval('function id(x) { return x } function secret() { return "s" }');
  assert.equal(await vm.call('id', [4]), 41);
  await assert.rejects(vm.call('secret'), (err) => code('ERR_DENIED')(err) && err.reason === 'not on your plan');
  await assert.rejects(vm.call('missing'), code('ERR_HANDLER_NOT_FOUND'));
  assert.deepEqual(seen, [
    ['id', [40], 41, undefined],
    ['missing', [], undefined, 'ERR_HANDLER_NOT_FOUND'],
  ]);
});

test('calls count as evals in usage and share the tenant worker', async () => {
  const rt = new Runtime({ strict });
  const t = rt.tenant('calls');
  const vm = t.isolate();
  await vm.eval('function f() { return 1 }');
  for (let i = 0; i < 3; i++) await vm.call('f');
  assert.equal(t.usage().evals, 4);
  rt.close();
  assert.equal(await pool.run('1', T), 1);
});
