// Evaluation basics, isolation, and the hardened default surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IsolaneError } from '../dist/index.js';
import { pool, T, code, limit, isolate } from './helpers.mjs';

test('basic arithmetic', async () => {
  assert.equal(await pool.run('1 + 2', T), 3);
});

test('objects and arrays round-trip', async () => {
  assert.deepEqual(await pool.run('({a: [1, "two", {three: true}], b: null})', T), {
    a: [1, 'two', { three: true }],
    b: null,
  });
});

test('undefined and functions map to null', async () => {
  assert.equal(await pool.run('undefined', T), null);
  assert.equal(await pool.run('(() => 1)', T), null);
});

test('strings, including unicode', async () => {
  assert.equal(await pool.run('"héllo " + "wörld 🌍"', T), 'héllo wörld 🌍');
});

test('thrown errors carry message and stack', async () => {
  await assert.rejects(
    pool.run('function boom() { throw new Error("kapow") }; boom()', T),
    (err) => code('ERR_GUEST_EXCEPTION')(err) && err.message.includes('kapow') && err.message.includes('boom'),
  );
});

test('syntax errors reject', async () => {
  await assert.rejects(pool.run('this is not js', T), code('ERR_GUEST_EXCEPTION'));
});

test('promises and async functions settle', async () => {
  assert.equal(await pool.run('Promise.resolve(6).then((x) => x * 7)', T), 42);
  assert.equal(await pool.run('(async () => (await Promise.resolve(20)) + 1)()', T), 21);
});

test('rejected promises reject the eval', async () => {
  await assert.rejects(pool.run('Promise.reject(new Error("nope"))', T), /nope/);
});

test('a promise that can never settle', async () => {
  await assert.rejects(pool.run('new Promise(() => {})', T), code('ERR_UNSETTLED'));
});

test('unserializable results', async () => {
  await assert.rejects(pool.run('1n', T), code('ERR_NOT_SERIALIZABLE'));
  await assert.rejects(pool.run('const o = {}; o.o = o; o', T), code('ERR_NOT_SERIALIZABLE'));
});

test('one-shot runs are isolated', async () => {
  await pool.run('globalThis.leak = 123', T);
  assert.equal(await pool.run('typeof globalThis.leak', T), 'undefined');
});

test('stateful isolates keep globals; isolates are isolated', async () => {
  const a = isolate(T);
  const b = isolate(T);
  await a.eval('globalThis.counter = 10');
  await a.eval('counter += 5');
  assert.equal(await a.eval('counter'), 15);
  assert.equal(await b.eval('typeof counter'), 'undefined');
  a.close();
  b.close();
});

test('closed isolates reject', async () => {
  const vm = isolate(T);
  await vm.eval('1');
  vm.close();
  await assert.rejects(vm.eval('2'), code('ERR_ISOLATE_CLOSED'));
});

test('a tenant is required', () => {
  assert.throws(() => isolate({}), code('ERR_INVALID_CONFIG'));
});

test('no code generation from strings', async () => {
  await assert.rejects(pool.run('eval("1 + 1")', T), /EvalError|disallowed|not allowed/i);
  await assert.rejects(pool.run('new Function("return 1")()', T), /EvalError|disallowed|not allowed/i);
});

test('no WebAssembly, shared memory, Atomics, or Temporal', async () => {
  assert.deepEqual(
    await pool.run(
      '[typeof WebAssembly, typeof SharedArrayBuffer, typeof Atomics, typeof Temporal]',
      T,
    ),
    ['undefined', 'undefined', 'undefined', 'undefined'],
  );
});

test('no ambient host access', async () => {
  assert.deepEqual(
    await pool.run('[typeof require, typeof process, typeof Deno, typeof connect, typeof fs]', T),
    ['undefined', 'undefined', 'undefined', 'undefined', 'undefined'],
  );
  // The web platform's fetch is there, but there's no network without a policy.
  assert.equal(
    await pool.run('fetch("https://example.com/").then(() => "fetched", (e) => e.message)', T),
    'fetch is not available: this isolate has no fetch policy',
  );
});

test('errors carry kind, retryability, tenant, and what the guest threw', async () => {
  const err = await pool.run('class MyError extends Error { name = "MyError" }; throw new MyError("bad thing")', T).catch((e) => e);
  assert.ok(err instanceof IsolaneError);
  assert.equal(err.code, 'ERR_GUEST_EXCEPTION');
  assert.equal(err.kind, 'guest');
  assert.equal(err.retryable, false);
  assert.equal(err.tenant, 'acme');
  assert.equal(err.guest.name, 'MyError');
  assert.equal(err.guest.message, 'bad thing');
  assert.match(err.guest.stack, /MyError: bad thing/);
  const thrown = await pool.run('throw 42', T).catch((e) => e);
  assert.deepEqual(thrown.guest, { message: '42', frames: [] });
  const timeout = await pool.run('for (;;) {}', { ...T, limits: { timeoutMs: 50 } }).catch((e) => e);
  assert.deepEqual([timeout.code, timeout.kind], ['ERR_LIMIT', 'limit']);
  const usage = (() => {
    try {
      isolate({ ...T, time: 1 });
    } catch (e) {
      return e;
    }
  })();
  assert.deepEqual([usage.code, usage.kind], ['ERR_INVALID_CONFIG', 'usage']);
});

test('guests see UTC, not the host time zone', async () => {
  assert.deepEqual(await pool.run('[new Date(0).getTimezoneOffset(), new Date(Date.UTC(2026, 6, 1)).getTimezoneOffset(), Intl.DateTimeFormat().resolvedOptions().timeZone]', T), [0, 0, 'UTC']);
});
