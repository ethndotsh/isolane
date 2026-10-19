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
  // With default limits, the isolate's heap limit (which V8 charges
  // ArrayBuffer memory to) stops it first.
  const byHeap = await capped.run(bomb, { ...T, limits: { timeoutMs: 20000 } }).catch((e) => e);
  assert.ok(limit('heapBytes')(byHeap) || limit('workerMemoryBytes')(byHeap), `${byHeap.code} ${byHeap.limit}: ${byHeap.message}`);
  // With a heap limit above the worker's cap, the worker's cap does.
  const err = await capped.run(bomb, { ...T, limits: { timeoutMs: 20000, heapBytes: 1 << 30 } }).catch((e) => e);
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

// ---- work between evals (limits.backgroundMs) ----

const until = async (check, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('limits.backgroundMs defaults to 1 s per minute', () => {
  assert.equal(DEFAULT_LIMITS.backgroundMs, 1_000);
});

test('10,000 setIntervals after an eval are stopped by limits.backgroundMs', async () => {
  const limits = [];
  const vm = isolate({ ...T, web: true, limits: { backgroundMs: 200 }, hooks: { onLimit: (e) => limits.push(e) } });
  await vm.eval('globalThis.n = 0; for (let i = 0; i < 10_000; i++) setInterval(() => { n++ }, 0); "started"');
  await until(() => limits.length > 0);
  assert.equal(limits[0].limit, 'backgroundMs');
  assert.equal(limits[0].isolate, vm.id);
  assert.match(limits[0].message, /limits\.backgroundMs/);
  await assert.rejects(vm.eval('n'), limit('backgroundMs'));
  await assert.rejects(vm.eval('n'), code('ERR_ISOLATE_RETIRED'));
  vm.close();
});

test('a host-call loop after an eval is stopped by limits.backgroundMs', async () => {
  let calls = 0;
  const limits = [];
  const vm = isolate({ ...T, limits: { backgroundMs: 50 }, host: { ping: () => ++calls }, hooks: { onLimit: (e) => limits.push(e) } });
  // The eval returns at once; the loop runs on replies, after it.
  assert.equal(await vm.eval('(async () => { for (;;) await ping() })(); "started"'), 'started');
  await until(() => limits.length > 0);
  assert.equal(limits[0].limit, 'backgroundMs');
  // Each continuation costs at least 0.25 ms of the 50 ms budget.
  assert.ok(calls <= 250, `${calls} calls`);
  const stopped = calls;
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(calls <= stopped + 1, 'the loop stopped');
  await assert.rejects(vm.eval('1'), limit('backgroundMs'));
  vm.close();
});

test('a timer storm leaves its own and other isolates responsive, and is charged to the tenant', async () => {
  const rt = new Runtime({ strict });
  const stormy = isolateOf(rt, { tenant: 'storm', web: true, limits: { backgroundMs: null } });
  const calm = isolateOf(rt, { tenant: 'storm' });
  await stormy.eval('globalThis.n = 0; for (let i = 0; i < 100; i++) setInterval(() => { for (let j = 0; j < 1e5; j++) n++ }, 0); "started"');
  await new Promise((r) => setTimeout(r, 200));
  for (const vm of [stormy, calm]) {
    for (let i = 0; i < 5; i++) {
      const started = Date.now();
      await vm.eval('1');
      assert.ok(Date.now() - started < 250, `an eval waited ${Date.now() - started} ms`);
    }
  }
  assert.ok((await stormy.eval('n')) > 0);
  stormy.close();
  calm.close();
  // CPU time is measured on Linux.
  if (process.platform === 'linux') {
    await until(() => rt.tenant('storm').usage().cpuMs > 100, 2000);
  }
  rt.close();
});

test('a modest setInterval keeps running between evals within the default budget', async () => {
  const vm = isolate({ ...T, web: true });
  await vm.eval('globalThis.ticks = 0; setInterval(() => ticks++, 10); 0');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok((await vm.eval('ticks')) >= 5);
  vm.close();
});
test('console output stays within logLineBytes and logBytes, with or without the web platform', async () => {
  for (const web of [false, true]) {
    const logs = [];
    await pool.run(
      `const big = 'x'.repeat(20 << 20);
       if (typeof reportError === 'function') reportError(new Error(big));
       console.log(big); console.error('a', big, { big });
       for (let i = 0; i < 100; i++) console.log(big);`,
      { ...T, web, limits: { logLineBytes: 1024, logBytes: 4096, heapBytes: 512 << 20 }, hooks: { onLog: (e) => logs.push(e.message) } },
    );
    const total = logs.reduce((n, m) => n + Buffer.byteLength(m), 0);
    assert.ok(logs.every((m) => Buffer.byteLength(m) <= 1024 + 3), `web ${web}: a line over logLineBytes`);
    assert.ok(total <= 4096 + 200, `web ${web}: ${total} bytes logged`);
    assert.match(logs.at(-1), /output limit reached/);
  }
});

test('a huge unhandled error is cut to size, not a protocol violation', async () => {
  const rt = new Runtime({ strict });
  const security = [];
  rt.on('securityEvent', (e) => security.push(e));
  const logs = [];
  const t = rt.tenant('huge-error');
  const limits = { heapBytes: 1 << 30, timeoutMs: 20_000 };
  // Past the 64 MiB frame limit, three ways: unhandled, thrown, and as a value.
  await t.run(`reportError(new Error('x'.repeat(80 << 20)))`, { web: true, limits, hooks: { onLog: (e) => logs.push(e.message) } });
  assert.ok(logs.length === 1 && Buffer.byteLength(logs[0]) <= 16 * 1024 + 3, `${logs.length} lines`);
  const thrown = await t.run(`throw new Error('y'.repeat(80 << 20))`, { limits }).catch((e) => e);
  assert.equal(thrown.code, 'ERR_GUEST_EXCEPTION');
  assert.ok(thrown.guest.message.length <= 64 * 1024 + 3);
  await assert.rejects(t.run(`'z'.repeat(80 << 20)`, { limits: { ...limits, resultBytes: 1 << 30 } }), limit('resultBytes'));
  assert.equal(await t.run('1'), 1);
  assert.deepEqual(security, []);
  rt.close();
});
