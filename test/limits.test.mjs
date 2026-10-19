// Limits: time, CPU, memory, sizes, counts, and their levels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Runtime, DEFAULT_LIMITS } from '../dist/index.js';
import { z } from 'zod';
import { pool, T, code, limit, isolate, isolateOf, strict } from './helpers.mjs';

test('an infinite loop is terminated by limits.timeoutMs', async () => {
  const started = Date.now();
  await assert.rejects(pool.run('while (true) {}', { ...T, limits: { timeoutMs: 100 } }), limit('timeoutMs'));
  assert.ok(Date.now() - started < 2000);
});

test('the guest cannot catch termination', async () => {
  await assert.rejects(
    pool.run('for (;;) { try { while (true) {} } catch {} }', { ...T, limits: { timeoutMs: 100 } }),
    limit('timeoutMs'),
  );
});

test('a timed-out isolate keeps its state', async () => {
  const vm = isolate({ ...T, limits: { timeoutMs: 50 } });
  await vm.eval('globalThis.kept = "yes"');
  for (let i = 0; i < 5; i++) await assert.rejects(vm.eval('while (true) {}'), limit('timeoutMs'));
  assert.equal(await vm.eval('kept'), 'yes');
  vm.close();
});

test('runaway recursion is a catchable RangeError', async () => {
  assert.equal(await pool.run('try { (function r() { r() })() } catch (e) { e instanceof RangeError }', T), true);
});

test('the heap limit retires the isolate', async () => {
  const vm = isolate({ ...T, limits: { heapBytes: 16 << 20 } });
  await assert.rejects(
    vm.eval('const a = []; for (;;) a.push({ x: "y".repeat(1000) + Math.random() })'),
    limit('heapBytes'),
  );
  await assert.rejects(vm.eval('1'), code('ERR_ISOLATE_RETIRED'));
  vm.close();
  assert.equal(await pool.run('"worker survives"', T), 'worker survives');
});

test('the worker memory limit bounds memory outside the heap', { skip: process.platform !== 'linux' }, async () => {
  const events = [];
  const capped = new Runtime({
    strict: process.env.ISOLANE_STRICT === '1',
    defaults: { limits: { workerMemoryBytes: 256 << 20 } },
    hooks: { onSecurityEvent: (e) => events.push(e) },
  });
  const bomb = 'const keep = []; for (;;) keep.push(new Uint8Array(16 << 20).fill(1));';
  const err = await capped.run(bomb, { ...T, limits: { timeoutMs: 20000 } }).catch((e) => e);
  assert.ok(
    limit('workerMemoryBytes')(err) || (err.code === 'ERR_GUEST_EXCEPTION' && /allocation failed/i.test(err.message)),
    `${err.code}: ${err.message} | worker stderr: ${events.map((e) => e.detail).join(' / ')}`,
  );
  assert.equal(await capped.run('1 + 1', T), 2); // the tenant keeps working
  assert.deepEqual(events, []); // running out of memory isn't a security event
  capped.close();
});

test('oversized results and error messages fail the eval, not the worker', async () => {
  const events = [];
  const rt = new Runtime({ strict: process.env.ISOLANE_STRICT === '1', hooks: { onSecurityEvent: (e) => events.push(e) } });
  // The resultBytes limit (16 MiB by default) catches it first...
  await assert.rejects(rt.run('"x".repeat(70 << 20)', T), (e) => e.code === 'ERR_LIMIT' && e.limit === 'resultBytes');
  // ...and past it, the 64 MiB frame cap still fails the eval, not the worker.
  await assert.rejects(rt.run('"x".repeat(70 << 20)', { ...T, limits: { resultBytes: 128 << 20 } }), code('ERR_NOT_SERIALIZABLE'));
  const err = await rt.run('throw new Error("y".repeat(70 << 20))', T).catch((e) => e);
  assert.equal(err.code, 'ERR_GUEST_EXCEPTION');
  assert.ok(err.guest.message.length < 70 << 10);
  assert.equal(await rt.run('1 + 1', T), 2);
  assert.deepEqual(events, []);
  rt.close();
});

test('limits.cpuMs bounds CPU time, not time spent waiting', { skip: process.platform !== 'linux' }, async () => {
  const host = { wait: () => new Promise((r) => setTimeout(r, 300)) };
  const opts = { ...T, limits: { cpuMs: 100, timeoutMs: 5000 }, host };
  // Waiting 300 ms on a host call uses no CPU.
  assert.equal(await pool.run('wait().then(() => "waited")', opts), 'waited');
  const err = await pool.run('for (;;) {}', opts).catch((e) => e);
  assert.deepEqual([err.code, err.kind], ['ERR_LIMIT', 'limit']);
  // The isolate stays usable after a CPU-limit termination.
  const vm = isolate(opts);
  await vm.eval('globalThis.n = 1').then(() => vm.eval('for (;;) {}')).catch(() => {});
  assert.equal(await vm.eval('n + 1'), 2);
  vm.close();
});

test('a slow host function counts against the timeout', async () => {
  const host = { slow: () => new Promise((r) => setTimeout(() => r(1), 1000)) };
  const started = Date.now();
  await assert.rejects(pool.run('slow()', { ...T, limits: { timeoutMs: 100 }, host }), limit('timeoutMs'));
  assert.ok(Date.now() - started < 800);
});

test('limits: defaults, levels, and validation', async () => {
  assert.equal(DEFAULT_LIMITS.timeoutMs, 30_000);
  assert.equal(DEFAULT_LIMITS.heapBytes, 128 << 20);
  const rt = new Runtime({
    strict: process.env.ISOLANE_STRICT === '1',
    defaults: { limits: { timeoutMs: 5000, isolates: 3 } },
    tenants: (t) => (t === 'small' ? { limits: { isolates: 1, timeoutMs: 100 } } : undefined),
  });
  const limitOf = (f) => {
    try {
      f();
    } catch (e) {
      return [e.code, e.limit];
    }
  };
  // Tenant-level caps come from defaults, then tenants(name).
  const big = [isolateOf(rt, { tenant: 'big' }), isolateOf(rt, { tenant: 'big' }), isolateOf(rt, { tenant: 'big' })];
  assert.deepEqual(limitOf(() => isolateOf(rt, { tenant: 'big' })), ['ERR_LIMIT', 'isolates']);
  big[0].close();
  isolateOf(rt, { tenant: 'big' }).close();
  big.forEach((v) => v.close());
  const small = isolateOf(rt, { tenant: 'small' });
  assert.deepEqual(limitOf(() => isolateOf(rt, { tenant: 'small' })), ['ERR_LIMIT', 'isolates']);
  // ...and isolate-level ones from the tenant, then the call (shorthand or limits).
  await assert.rejects(small.eval('for (;;) {}'), limit('timeoutMs'));
  small.close();
  await assert.rejects(rt.run('for (;;) {}', { tenant: 'small', limits: { timeoutMs: 50 } }), limit('timeoutMs'));
  assert.deepEqual(limitOf(() => isolateOf(rt, { tenant: 'big', limits: { isolates: 9 } })), ['ERR_INVALID_CONFIG', undefined]);
  assert.deepEqual(limitOf(() => isolateOf(rt, { tenant: 'big', limits: { nope: 1 } })), ['ERR_INVALID_CONFIG', undefined]);
  assert.deepEqual(limitOf(() => isolateOf(rt, { tenant: 'big', timeoutMs: 5 })), ['ERR_INVALID_CONFIG', undefined]);
  assert.throws(() => new Runtime({ limits: { tenants: 0 } }), code('ERR_INVALID_CONFIG'));
  assert.throws(() => new Runtime({ limits: { isolates: 2 } }), /defaults\.limits or tenants/);
  rt.close();
});

test('limits: code, results, timers, console, concurrency', async () => {
  const L = (limits) => ({ ...T, limits });
  const err = (p) => p.then(() => null, (e) => [e.code, e.limit]);
  assert.deepEqual(await err(pool.run('1 + 1 // ' + 'x'.repeat(200), L({ codeBytes: 100 }))), ['ERR_LIMIT', 'codeBytes']);
  assert.deepEqual(await err(pool.run('"x".repeat(1000)', L({ resultBytes: 100 }))), ['ERR_LIMIT', 'resultBytes']);
  assert.equal(
    await pool.run('let n = 0; try { for (;;) { setTimeout(() => {}, 1e6); n++; } } catch (e) { [n, e instanceof RangeError] }', {
      ...L({ timers: 5 }),
      web: true,
    }).then(JSON.stringify),
    '[5,true]',
  );
  const logs = [];
  await pool.run('console.log("y".repeat(100)); for (let i = 0; i < 50; i++) console.log("z".repeat(10))', {
    ...L({ logLineBytes: 20, logBytes: 100 }),
    hooks: { onLog: (e) => logs.push(e.message) },
  });
  assert.ok(logs[0].length <= 22, logs[0]);
  assert.match(logs.at(-1), /output limit reached/);
  const rt = new Runtime({ strict: process.env.ISOLANE_STRICT === "1", defaults: { limits: { concurrentEvals: 2 } } });
  const vm = isolateOf(rt, { tenant: 'c', host: { wait: () => new Promise((r) => setTimeout(r, 100)) } });
  const running = [vm.eval('wait()'), vm.eval('wait()')];
  await assert.rejects(vm.eval('1'), (e) => e.code === 'ERR_LIMIT' && e.limit === 'concurrentEvals');
  await Promise.all(running);
  vm.close();
  rt.close();
});

test('limits.tenants evicts the least recently used idle tenant', async () => {
  const rt = new Runtime({ strict: process.env.ISOLANE_STRICT === '1', limits: { tenants: 2 } });
  await rt.run('1', { tenant: 'a' });
  await rt.run('1', { tenant: 'b' });
  const pidA = rt.diagnostics.workerPid('a');
  await rt.run('1', { tenant: 'c' }); // evicts a (idle longest)
  assert.equal(rt.diagnostics.workerPid('a'), undefined);
  assert.ok(rt.diagnostics.workerPid('b') && rt.diagnostics.workerPid('c'));
  assert.notEqual(pidA, undefined);
  const busy = [isolateOf(rt, { tenant: 'b' }), isolateOf(rt, { tenant: 'c' })];
  assert.throws(() => isolateOf(rt, { tenant: 'd' }), (e) => e.code === 'ERR_LIMIT' && e.limit === 'tenants');
  busy.forEach((v) => v.close());
  rt.close();
});

test('queued evals on one isolate are not mistaken for an unresponsive worker', async () => {
  const vm = isolate({ ...T, limits: { timeoutMs: 400 } });
  const loops = Array.from({ length: 4 }, () => vm.eval('for (;;) {}'));
  for (const r of await Promise.allSettled(loops)) assert.equal(r.reason?.code, 'ERR_LIMIT');
  assert.equal(await vm.eval('2'), 2);
  vm.close();
});
