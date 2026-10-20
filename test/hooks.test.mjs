// Hooks and events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime, deny } from '../dist/index.js';
import { pool, T, strict } from './helpers.mjs';

test('console output reaches onLog', async () => {
  const logs = [];
  const logged = new Runtime({ strict: process.env.ISOLANE_STRICT === '1', hooks: { onLog: ({ tenant, level, message }) => logs.push({ tenant, level, message }) } });
  await logged.run('console.log("hi", 1, { a: [2] }); console.error(new Error("bad").message); console.warn(undefined, null)', T);
  assert.deepEqual(logs, [
    { tenant: 'acme', level: 'log', message: 'hi 1 {"a":[2]}' },
    { tenant: 'acme', level: 'error', message: 'bad' },
    { tenant: 'acme', level: 'warn', message: 'undefined null' },
  ]);
  const mine = [];
  await logged.run('console.info("x".repeat(10))', { ...T, hooks: { onLog: (e) => mine.push(e.message) } });
  assert.deepEqual(mine, ['xxxxxxxxxx']);
  logs.length = 0;
  await logged.run('for (let i = 0; i < 1e5; i++) console.log("y".repeat(100))', T);
  assert.ok(logs.length < 12000, `${logs.length} lines got through the per-eval budget`);
  assert.match(logs.at(-1).message, /output limit reached/);
  logged.close();
});

test('beforeHostCall can deny or replace arguments; afterHostCall can replace results', async () => {
  const seen = [];
  const hooks = {
    beforeHostCall: ({ name, args }) => {
      seen.push(name);
      if (name === 'secret') return deny('not on your plan');
      if (name === 'double') return { args: args.map((a) => a * 2) };
    },
    afterHostCall: ({ name, result }) => (name === 'double' ? { result: result + 1 } : undefined),
  };
  const host = { secret: () => 'leak', double: (x) => x, plain: () => 'ok' };
  const out = await pool.run(
    'Promise.all([secret().catch((e) => [e.code, e.message]), double(5), plain()])',
    { ...T, host, hooks },
  );
  assert.deepEqual(out, [['ERR_DENIED', 'secret: denied: not on your plan'], 11, 'ok']);
  assert.deepEqual(seen.sort(), ['double', 'plain', 'secret']);
});

test('beforeEval can deny or replace code; afterEval can replace results', async () => {
  const hooks = {
    beforeEval: ({ code }) => (code.includes('forbidden') ? deny('no forbidden words') : { code: code.replace('ONE', '1') }),
    afterEval: ({ result }) => ({ result: { wrapped: result } }),
  };
  assert.deepEqual(await pool.run('ONE + 1', { ...T, hooks }), { wrapped: 2 });
  const err = await pool.run('"forbidden"', { ...T, hooks }).catch((e) => e);
  assert.deepEqual([err.code, err.kind, err.reason], ['ERR_DENIED', 'usage', 'no forbidden words']);
});

test('every level runs: runtime, defaults, tenants(name), the call, in onion order', async () => {
  const order = [];
  const level = (name) => ({
    beforeHostCall: () => void order.push(`before:${name}`),
    afterHostCall: () => void order.push(`after:${name}`),
  });
  const rt = new Runtime({
    strict,
    hooks: level('runtime'),
    defaults: { hooks: level('defaults'), host: { f: () => 1 } },
    tenants: () => ({ hooks: level('tenant') }),
  });
  await rt.run('f()', { tenant: 't', hooks: level('call') });
  assert.deepEqual(order, [
    'before:runtime', 'before:defaults', 'before:tenant', 'before:call',
    'after:call', 'after:tenant', 'after:defaults', 'after:runtime',
  ]);
  rt.close();
});

test('events: limits, policy denials, workers, and runtime.on', async () => {
  const events = [];
  const rt = new Runtime({
    strict,
    hooks: {
      onLimit: (e) => events.push(['limit', e.limit]),
      onPolicyDenial: (e) => events.push(['denial', e.api, e.target]),
      onWorker: (e) => events.push(['worker', e.kind]),
    },
  });
  const seen = [];
  const off = rt.on('eval', (e) => seen.push(['eval', e.code, e.error?.code ?? e.result]));
  rt.on('hostCall', (e) => seen.push(['hostCall', e.name, e.result]));
  const t = rt.tenant('ev');
  await t.run('1 + 1');
  await t.run('for (;;) {}', { limits: { timeoutMs: 50 } }).catch(() => {});
  await t.run('fetch("https://nope.example/").catch(() => 0)', { fetch: { hosts: ['api.example.com'] } });
  await t.run('ns.f()', { host: { ns: { f: () => 'x' } } });
  off();
  await t.run('2');
  t.stop();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(
    events.filter(([k]) => k !== 'worker'),
    [['limit', 'timeoutMs'], ['denial', 'fetch', 'https://nope.example/']],
  );
  assert.deepEqual(events.filter(([k]) => k === 'worker').map(([, e]) => e), ['start', 'exit']);
  assert.deepEqual(seen, [
    ['eval', '1 + 1', 2],
    ['eval', 'for (;;) {}', 'ERR_LIMIT'],
    ['eval', 'fetch("https://nope.example/").catch(() => 0)', 0],
    ['hostCall', 'ns.f', 'x'],
    ['eval', 'ns.f()', 'x'],
  ]);
  rt.close();
});

test('hooks are validated', () => {
  assert.throws(() => pool.tenant('acme').isolate({ hooks: { onLogg: () => {} } }), /hooks\.onLogg is not a hook/);
  assert.throws(() => new Runtime({ hooks: { onLog: 1 } }), /hooks\.onLog must be a function/);
});
