// Tenants and worker processes: one per tenant, spares, usage, environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Runtime, DEFAULT_LIMITS } from '../dist/index.js';
import { pool, code, isolate, strict } from './helpers.mjs';

test('each tenant gets its own worker process', async () => {
  const a = isolate({ tenant: 'tenant-a' });
  const a2 = isolate({ tenant: 'tenant-a' });
  const b = isolate({ tenant: 'tenant-b' });
  await Promise.all([a.eval('1'), a2.eval('1'), b.eval('1')]);
  const pa = pool.diagnostics.workerPid('tenant-a');
  const pb = pool.diagnostics.workerPid('tenant-b');
  assert.ok(pa && pb);
  assert.notEqual(pa, pb);
  [a, a2, b].forEach((vm) => vm.close());
});

test('spare workers still give each tenant its own process', async () => {
  const warm = new Runtime({ strict: process.env.ISOLANE_STRICT === '1', spares: 2 });
  await new Promise((r) => setTimeout(r, 500));
  const t0 = performance.now();
  assert.equal(await warm.run('1 + 1', { tenant: 'w1' }), 2);
  const fast = performance.now() - t0;
  await warm.run('1', { tenant: 'w2' });
  const pids = [warm.diagnostics.workerPid('w1'), warm.diagnostics.workerPid('w2')];
  assert.ok(pids[0] && pids[1] && pids[0] !== pids[1], `tenants share a worker: ${pids}`);
  assert.ok(fast < 1000, `a prewarmed tenant took ${fast} ms`);
  warm.close();
  assert.throws(() => new Runtime({ spares: -1 }), code('ERR_INVALID_CONFIG'));
});

test('usage is accounted per tenant', async () => {
  const rt = new Runtime({ strict: process.env.ISOLANE_STRICT === '1', defaults: { host: { two: () => 2 } } });
  const tenant = rt.tenant('billed');
  await tenant.run('let x = 0; for (let i = 0; i < 1e6; i++) x += i; two()');
  await tenant.run('console.log("hello"); new Array(1e5).fill(1).length');
  await tenant.run('throw new Error("x")').catch(() => {});
  const u = rt.tenant('billed').usage();
  assert.deepEqual([u.evals, u.failures, u.hostCalls, u.logBytes, u.securityEvents], [3, 1, 1, 5, 0]);
  assert.ok(u.peakMemoryBytes > 100_000, `peak ${u.peakMemoryBytes}`);
  if (process.platform === 'linux') assert.ok(u.cpuMs > 0);
  rt.tenant('billed').resetUsage();
  assert.equal(rt.tenant('billed').usage().evals, 0);
  assert.equal(rt.tenant('nobody').usage().evals, 0);
  rt.close();
});

test('usage keeps counting after resetUsage, and the supervisor measures worker CPU on Linux', async () => {
  const rt = new Runtime({ strict });
  const t = rt.tenant('meter');
  const vm = t.isolate();
  await vm.eval('1');
  t.resetUsage();
  await vm.eval('let x = 0; for (let i = 0; i < 3e7; i++) x += i; x');
  const u = t.usage();
  assert.equal(u.evals, 1, 'the live worker counts into the reset usage');
  if (process.platform === 'linux') {
    assert.ok(u.workerCpuMs > 0, `workerCpuMs ${u.workerCpuMs}`);
    // The process's CPU time covers its isolate threads' (to its 10 ms steps).
    assert.ok(u.workerCpuMs + 20 >= u.cpuMs, `workerCpuMs ${u.workerCpuMs} < cpuMs ${u.cpuMs}`);
  } else {
    assert.equal(u.workerCpuMs, undefined);
  }
  vm.close();
  rt.close();
});

test('recycling: worker defaults', () => {
  assert.equal(DEFAULT_LIMITS.workerLifetimeMs, 3_600_000);
  assert.equal(DEFAULT_LIMITS.workerEvals, 100_000);
  assert.throws(() => new Runtime({ defaults: { limits: { workerEvals: 0 } } }), code('ERR_INVALID_CONFIG'));
});

test('recycling limits are tenant limits', async () => {
  await assert.rejects(pool.run('1', { tenant: 'x', limits: { workerLifetimeMs: 10 } }), code('ERR_INVALID_CONFIG'));
});

test('a worker is recycled after limits.workerEvals evals', async () => {
  const events = [];
  const rt = new Runtime({ strict, defaults: { limits: { workerEvals: 3 } }, hooks: { onWorker: (e) => events.push(e) } });
  const t = rt.tenant('busy');
  const pids = [];
  for (let i = 0; i < 4; i++) {
    assert.equal(await t.run(`${i} + 1`), i + 1);
    pids.push(rt.diagnostics.workerPid('busy'));
  }
  // The third eval reached the limit, and its worker stopped once that
  // run was done: the fourth ran on a fresh worker.
  assert.equal(pids[0], pids[1], `${pids}`);
  assert.equal(pids[2], undefined, `${pids}`);
  assert.ok(pids[3] && pids[3] !== pids[0], `${pids}`);
  const recycle = events.find((e) => e.event === 'recycle');
  assert.ok(recycle, JSON.stringify(events));
  assert.equal(recycle.pid, pids[0]);
  assert.match(recycle.reason, /workerEvals/);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(events.some((e) => e.event === 'exit' && e.pid === pids[0]), 'the old worker exited once drained');
  rt.close();
});

test('a recycled worker drains: open isolates keep working, then are retired', async () => {
  const events = [];
  const rt = new Runtime({ strict, defaults: { limits: { workerLifetimeMs: 400 } }, hooks: { onWorker: (e) => events.push(e) } });
  const t = rt.tenant('long');
  const vm = t.isolate();
  await vm.eval('globalThis.kept = 1');
  const first = rt.diagnostics.workerPid('long');
  await new Promise((r) => setTimeout(r, 500)); // past its lifetime
  assert.ok(events.some((e) => e.event === 'recycle' && e.pid === first), JSON.stringify(events));
  // New work starts on a fresh worker; the open isolate is still on the old one.
  assert.equal(await t.run('2'), 2);
  assert.notEqual(rt.diagnostics.workerPid('long'), first);
  assert.equal(await vm.eval('kept'), 1);
  // Its drain period (its lifetime, here) ends: the isolate is retired.
  await new Promise((r) => setTimeout(r, 400));
  const err = await vm.eval('kept').catch((e) => e);
  assert.equal(err.code, 'ERR_ISOLATE_RETIRED', String(err));
  assert.equal(err.retryable, true);
  assert.match(err.message, /recycled/);
  vm.close();
  rt.close();
});

test('workers get an empty environment', { skip: process.platform !== 'linux' }, async () => {
  process.env.ISOLANE_TEST_SECRET = 'leak';
  try {
    const vm = isolate({ tenant: 'env-check' });
    await vm.eval('1');
    const environ = readFileSync(`/proc/${pool.diagnostics.workerPid('env-check')}/environ`);
    assert.equal(environ.length, 0);
    vm.close();
  } finally {
    delete process.env.ISOLANE_TEST_SECRET;
  }
});

// ---- hostile and crashing workers ----

test('a tenant handle owns its operations: usage, release, stop', async () => {
  const rt = new Runtime({ strict });
  const t = rt.tenant('ops');
  assert.equal(t.name, 'ops');
  const vm = t.isolate({ host: { wait: () => new Promise((r) => setTimeout(r, 1000)) } });
  await vm.eval('globalThis.x = 1');
  const pid = rt.diagnostics.workerPid('ops');
  assert.ok(pid);
  const pending = vm.eval('wait()').catch((e) => e.code); // in flight when the tenant stops
  await new Promise((r) => setTimeout(r, 20));
  t.stop();
  assert.equal(await pending, 'ERR_ISOLATE_CLOSED');
  assert.equal(rt.diagnostics.workerPid('ops'), undefined);
  assert.equal(await t.run('1 + 1'), 2); // a fresh worker
  assert.notEqual(rt.diagnostics.workerPid('ops'), pid);
  assert.ok(t.usage().evals >= 2);
  t.resetUsage();
  assert.equal(t.usage().evals, 0);
  t.release(); // no quarantine: a no-op
  rt.close();
  await assert.rejects(t.run('1'), code('ERR_RUNTIME_CLOSED'));
});

test('closing the runtime rejects in-flight evals with ERR_RUNTIME_CLOSED', async () => {
  const rt = new Runtime({ strict });
  const vm = rt.tenant('closing').isolate({ host: { wait: () => new Promise((r) => setTimeout(r, 1000)) } });
  await vm.eval('1');
  const pending = vm.eval('wait()').catch((e) => e.code);
  await new Promise((r) => setTimeout(r, 20));
  rt.close();
  assert.equal(await pending, 'ERR_RUNTIME_CLOSED');
});

test('an idle tenant worker stops after limits.idleMs', async () => {
  const rt = new Runtime({ strict, defaults: { limits: { idleMs: 100 } } });
  await rt.run('1', { tenant: 'idle' });
  assert.ok(rt.diagnostics.workerPid('idle'));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(rt.diagnostics.workerPid('idle'), undefined);
  rt.close();
});

test('closing an isolate rejects its in-flight evals at once, and the worker stays healthy', async () => {
  const rt = new Runtime({ strict });
  const security = [];
  rt.on('securityEvent', (e) => security.push(e));
  const t = rt.tenant('close-in-flight');
  const vm = t.isolate({ limits: { timeoutMs: 300 } });
  await vm.eval('1');
  const busy = vm.eval('for (;;) {}').catch((e) => e.code);
  const queued = vm.eval('2').catch((e) => e.code);
  await new Promise((r) => setTimeout(r, 20));
  const started = Date.now();
  vm.close();
  assert.equal(await busy, 'ERR_ISOLATE_CLOSED');
  assert.equal(await queued, 'ERR_ISOLATE_CLOSED');
  assert.ok(Date.now() - started < 100, 'rejected promptly');
  // Past the supervisor's deadline for the abandoned eval: no false alarm.
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(security, []);
  assert.equal(await t.run('3'), 3);
  // A busy isolate with no time limit is stopped too, not left running.
  const forever = t.isolate();
  const spin = forever.eval('for (;;) {}').catch((e) => e.code);
  await new Promise((r) => setTimeout(r, 20));
  forever.close();
  assert.equal(await spin, 'ERR_ISOLATE_CLOSED');
  assert.equal(await t.run('4'), 4);
  rt.close();
});

test('isolates from different snapshots can start while others stop', async () => {
  // A web isolate closed, a plain one stopping, and a web one starting, on
  // one worker: V8's shared heaps must not be torn down in between.
  const rt = new Runtime({ strict });
  const security = [];
  rt.on('securityEvent', (e) => security.push(e.detail));
  for (let round = 0; round < 12; round++) {
    const t = rt.tenant(`snapshots-${round}`);
    const vm = t.isolate({ web: true });
    await vm.eval('setInterval(() => {}, 10); 0');
    await new Promise((r) => setTimeout(r, 100));
    vm.close();
    await t.run(`console.log('x'.repeat(20 << 20)); 1`, { web: false, limits: { heapBytes: 512 << 20 } });
    await t.run('1', { web: true });
  }
  assert.deepEqual(security, []);
  rt.close();
});
