// Limits: time, CPU, memory, sizes, counts, and their levels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Runtime, DEFAULT_LIMITS, hostFunction } from '../dist/index.js';
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

test('an eval stopped by a time or CPU limit retires its isolate; a throw does not', async () => {
  // (CPU time is measured on Linux only.)
  for (const limits of process.platform === 'linux' ? [{ timeoutMs: 50 }, { cpuMs: 50 }] : [{ timeoutMs: 50 }]) {
    const vm = isolate({ ...T, limits });
    await vm.eval('globalThis.kept = "yes"');
    await assert.rejects(vm.eval('throw new Error("no")'), code('ERR_GUEST_EXCEPTION'));
    assert.equal(await vm.eval('kept'), 'yes');
    // Stopped part-way: its state may be half-updated.
    await assert.rejects(vm.eval('globalThis.kept = "half"; while (true) {}'), limit(Object.keys(limits)[0]));
    await assert.rejects(vm.eval('kept'), (err) => code('ERR_ISOLATE_RETIRED')(err) && err.message.includes('stopped part-way'));
    vm.close();
  }
  // So does a timeout that comes while the eval waits (no termination).
  const waiting = isolate({ ...T, limits: { timeoutMs: 50 } });
  await assert.rejects(waiting.eval('new Promise((r) => setTimeout(r, 10_000))'), limit('timeoutMs'));
  await assert.rejects(waiting.eval('1'), code('ERR_ISOLATE_RETIRED'));
  waiting.close();
  // The tenant's other isolates carry on.
  assert.equal(await pool.run('1 + 1', T), 2);
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
  // ...and set past the 64 MiB frame cap, the cap still fails the eval, not the worker.
  await assert.rejects(rt.run('"x".repeat(70 << 20)', { ...T, limits: { resultBytes: 128 << 20 } }), limit('resultBytes'));
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
  // A CPU-limit termination retires the isolate.
  const vm = isolate(opts);
  await vm.eval('globalThis.n = 1').then(() => vm.eval('for (;;) {}')).catch(() => {});
  await assert.rejects(vm.eval('n + 1'), code('ERR_ISOLATE_RETIRED'));
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
  const rt = new Runtime({ strict: process.env.ISOLANE_STRICT === "1", defaults: { limits: { pendingEvals: 2 } } });
  const vm = isolateOf(rt, { tenant: 'c', host: { wait: () => new Promise((r) => setTimeout(r, 100)) } });
  const running = [vm.eval('wait()'), vm.eval('wait()')];
  await assert.rejects(vm.eval('1'), (e) => e.code === 'ERR_LIMIT' && e.limit === 'pendingEvals');
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
  // Each takes most of its timeout, so the last waits about 900ms for the others.
  const waits = Array.from({ length: 4 }, () => vm.eval('new Promise((r) => setTimeout(() => r(1), 300))'));
  assert.deepEqual(await Promise.all(waits), [1, 1, 1, 1]);
  // Queued behind one that times out: it retires the isolate, and they fail with that.
  const loops = Array.from({ length: 3 }, () => vm.eval('for (;;) {}'));
  const [first, ...rest] = await Promise.allSettled(loops);
  assert.equal(first.reason?.code, 'ERR_LIMIT');
  for (const r of rest) assert.equal(r.reason?.code, 'ERR_ISOLATE_RETIRED');
  vm.close();
  assert.equal(await pool.run('2', T), 2);
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

test('time blocked in sync host calls between evals counts against limits.backgroundMs', async () => {
  let calls = 0;
  const limits = [];
  // 20 ms of waiting per call, almost no CPU: on Linux, where the budget is
  // CPU time, the wait is charged too.
  const slow = hostFunction({ sync: true, handler: () => new Promise((r) => setTimeout(() => r(++calls), 20)) });
  const vm = isolate({ ...T, web: true, limits: { backgroundMs: 100 }, host: { slow }, hooks: { onLimit: (e) => limits.push(e) } });
  await vm.eval('setInterval(() => slow(), 0); "started"');
  await until(() => limits.length > 0, 5_000);
  assert.equal(limits[0].limit, 'backgroundMs');
  assert.ok(calls <= 10, `${calls} calls`);
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

test('limits.workerBackgroundMs bounds a tenant\'s isolates together, pausing them without retiring any', async () => {
  assert.equal(DEFAULT_LIMITS.workerBackgroundMs, 10_000);
  const limits = [];
  const rt = new Runtime({
    strict,
    defaults: { web: true, time: 'real', limits: { backgroundMs: null, workerBackgroundMs: 300 } },
    hooks: { onLimit: (e) => limits.push(e) },
  });
  const work = 'for (let j = 0; j < 2e5; j++) globalThis.x = (globalThis.x ?? 0) + j';
  // What one tick costs, measured alone in an eval.
  const probe = isolateOf(rt, { tenant: 'many' });
  const tickMs = (await probe.eval(`const s = Date.now(); for (let i = 0; i < 50; i++) { ${work} } (Date.now() - s) / 50`)) || 0.05;
  probe.close();
  const vms = Array.from({ length: 20 }, () => isolateOf(rt, { tenant: 'many' }));
  for (const vm of vms) await vm.eval(`globalThis.ticks = 0; setInterval(() => { ${work}; ticks++ }, 0); 0`);
  await new Promise((r) => setTimeout(r, 1500));
  let ticks = 0;
  for (const vm of vms) ticks += await vm.eval('ticks');
  // 300 ms of budget, plus what isolates mid-batch overdrew when it ran
  // out (about a 10 ms slice each); without the tenant budget, 20 isolates
  // would run for seconds of CPU.
  assert.ok(ticks * tickMs < 1200, `${ticks} ticks of ${tickMs.toFixed(3)} ms`);
  const hit = limits.filter((e) => e.limit === 'workerBackgroundMs');
  assert.ok(hit.length > 0, JSON.stringify(limits));
  assert.match(hit[0].message, /limits\.workerBackgroundMs/);
  // Nothing was retired, and evals still run at once.
  for (const vm of vms) {
    const started = Date.now();
    assert.ok((await vm.eval('ticks')) >= 0);
    assert.ok(Date.now() - started < 500, `an eval waited ${Date.now() - started} ms`);
  }
  for (const vm of vms) vm.close();
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

test('console formats any value without throwing', async () => {
  for (const web of [false, true]) {
    const logs = [];
    const result = await pool.run(
      `const cyclic = {}; cyclic.self = cyclic;
       const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
       const values = [
         Symbol('x'), Symbol(), [Symbol('in array')],
         { [Symbol.toPrimitive]() { throw new Error('no'); }, toJSON() { throw new Error('no'); } },
         { get boom() { throw new Error('getter'); } },
         new Proxy({}, { get() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); } }),
         proxy, cyclic, new Array(1e6).fill(1), 10n, Object.create(null),
       ];
       for (const v of values) console.log('v', v);
       console.log(...values);
       try { throw Symbol('thrown'); } catch {}
       'done'`,
      { ...T, web, limits: { logLineBytes: 4096 }, hooks: { onLog: (e) => logs.push(e.message) } },
    );
    assert.equal(result, 'done', `web ${web}`);
    assert.equal(logs.length, 12, `web ${web}: ${JSON.stringify(logs)}`);
    assert.equal(logs[0], 'v Symbol(x)');
    assert.equal(logs[1], 'v Symbol()');
    assert.ok(logs.every((m) => Buffer.byteLength(m) <= 4096 + 3));
  }
  // A thrown symbol is reported, not lost.
  const err = await pool.run(`throw Symbol('thrown')`, T).catch((e) => e);
  assert.equal(err.code, 'ERR_GUEST_EXCEPTION');
  assert.match(err.guest.message, /Symbol\(thrown\)/);
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
  const unserializable = await t.run(`({ toJSON() { throw new Error('w'.repeat(80 << 20)); } })`, { limits }).catch((e) => e);
  assert.equal(unserializable.code, 'ERR_NOT_SERIALIZABLE');
  assert.ok(unserializable.message.length <= 64 * 1024 + 3);
  assert.equal(await t.run('1'), 1);
  assert.deepEqual(security, []);
  rt.close();
});

test('limits.pendingHostCalls and limits.hostCalls bound host-call floods', async () => {
  let ran = 0;
  const never = () => (ran++, new Promise(() => {}));
  // 100,000 calls that never settle: the worker stops at the limit.
  const flood = await pool
    .run('for (let i = 0; i < 100000; i++) never(); 1', { ...T, host: { never }, limits: { pendingHostCalls: 50 } })
    .catch((e) => e);
  assert.deepEqual([flood.code, flood.limit], ['ERR_LIMIT', 'pendingHostCalls']);
  assert.equal(ran, 50);
  // Calls that do settle: limits.hostCalls per eval, even if the guest
  // catches the RangeError.
  let fast = 0;
  const host = { one: () => (fast++, 1) };
  const caught = await pool
    .run(
      `(async () => { let seen; for (let i = 0; i < 20000; i++) { try { await one(); } catch (e) { seen = [e.name, e.code, e.limit]; break; } } return seen; })()`,
      { ...T, host, limits: { hostCalls: 300 } },
    )
    .catch((e) => e);
  assert.deepEqual([caught.code, caught.limit], ['ERR_LIMIT', 'hostCalls']);
  assert.equal(fast, 300);
  // The count is per eval: a stateful isolate keeps working.
  const vm = isolate({ ...T, host, limits: { hostCalls: 3 } });
  for (let i = 0; i < 3; i++) assert.equal(await vm.eval('Promise.all([one(), one(), one()]).then((r) => r.length)'), 3);
  vm.close();
  // Their bytes, too: 100 calls of 1 MiB that never settle.
  ran = 0;
  const held = await pool
    .run('for (let i = 0; i < 100; i++) never(new Uint8Array(1 << 20)); 1', { ...T, host: { never }, limits: { pendingHostCallBytes: 10 << 20 } })
    .catch((e) => e);
  assert.deepEqual([held.code, held.limit], ['ERR_LIMIT', 'pendingHostCallBytes']);
  assert.equal(ran, 9);
  // The defaults allow ordinary use.
  assert.equal(await pool.run('Promise.all(Array.from({ length: 900 }, () => one())).then((r) => r.length)', { ...T, host }), 900);
  // An eval that runs out of a limit frees its isolate's slots: the
  // abandoned calls don't block the next eval.
  const signals = [];
  // The call context is `this` for a plain function.
  function hang() {
    signals.push(this.signal);
    return new Promise(() => {});
  }
  // (One that runs out of time retires its isolate instead.)
  const timedOut = isolate({ ...T, host: { hang, one: host.one }, limits: { timeoutMs: 100, pendingHostCalls: 5 } });
  await assert.rejects(timedOut.eval('(async () => { for (let i = 0; i < 5; i++) hang(); await new Promise(() => {}) })()'), limit('timeoutMs'));
  assert.ok(signals.length === 5 && signals.every((s) => s.aborted), 'abandoned calls are aborted');
  await assert.rejects(timedOut.eval('one()'), code('ERR_ISOLATE_RETIRED'));
  timedOut.close();
  for (const [limits, code] of [
    [{ pendingHostCalls: 5 }, 'for (let i = 0; i < 6; i++) hang()'],
    [{ pendingHostCallBytes: 3 << 20 }, 'for (let i = 0; i < 4; i++) hang(new Uint8Array(1 << 20))'],
  ]) {
    signals.length = 0;
    const stateful = isolate({ ...T, host: { hang, one: host.one }, limits });
    const first = await stateful.eval(`(async () => { ${code} })()`).catch((e) => e);
    assert.equal(first.code, 'ERR_LIMIT', JSON.stringify(limits));
    assert.equal(await stateful.eval('Promise.all([one(), one(), one(), one(), one()]).then((r) => r.length)'), 5, JSON.stringify(limits));
    assert.ok(signals.length > 0 && signals.every((s) => s.aborted), 'abandoned calls are aborted');
    stateful.close();
  }
  // Calls an eval left behind when it returned: each expires a second
  // after timeoutMs, so the isolate's slots come back.
  signals.length = 0;
  const left = isolate({ ...T, host: { hang, one: host.one }, limits: { timeoutMs: 100, pendingHostCalls: 5 } });
  assert.equal(await left.eval('globalThis.p = Array.from({ length: 5 }, () => hang()); 1'), 1);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(await left.eval('one()'), 1);
  assert.deepEqual(
    await left.eval('Promise.allSettled(p).then((r) => r.map((x) => [x.status, x.reason?.name, x.reason?.code]))'),
    Array(5).fill(['rejected', 'RangeError', 'ERR_LIMIT']),
  );
  assert.ok(signals.length === 5 && signals.every((s) => s.aborted));
  left.close();
});

test('an eval waiting behind its isolate\'s background work is not mistaken for an unresponsive worker', async () => {
  const rt = new Runtime({ strict });
  const security = [];
  rt.on('securityEvent', (e) => security.push(e.detail));
  const vm = isolateOf(rt, {
    tenant: 'behind',
    limits: { timeoutMs: 400, backgroundMs: null },
    host: { soon: () => new Promise((r) => setTimeout(r, 20)) },
  });
  // Five continuations, each spinning until its 400 ms budget, run ahead
  // of the next eval: 2.4 s in all, past its first deadline (1.4 s).
  await vm.eval('for (let i = 0; i < 5; i++) soon().then(() => { for (;;) {} }); 1');
  await new Promise((r) => setTimeout(r, 40));
  await assert.rejects(vm.eval('for (;;) {}'), limit('timeoutMs'));
  assert.deepEqual(security, []);
  rt.close();
});
