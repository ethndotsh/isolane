// Hostile and crashing workers (fake ones, scripted in Node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../dist/index.js';
import { code, isolateOf, fakeWorker } from './helpers.mjs';

test('a crashing worker rejects in-flight evals and raises a security event', async () => {
  const events = [];
  const crashy = new Runtime({
    workerPath: fakeWorker(`send({ t: 'ready', protocol: 2, v8: 'fake', sandboxSecure: true, lockdown: { landlock: 'full', seccomp: 'full' } }); process.stdin.once('data', () => process.abort());`),
    hooks: { onSecurityEvent: (e) => events.push(e) },
  });
  await assert.rejects(crashy.run('1', { tenant: 'victim' }), code('ERR_WORKER_CRASHED'));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'crash');
  assert.equal(events[0].tenant, 'victim');
  assert.match(events[0].detail, /SIGABRT/);
  crashy.close();
});

test('a security event quarantines the tenant', async () => {
  const events = [];
  const rt = new Runtime({
    workerPath: fakeWorker(`send({ t: 'ready', protocol: 2, v8: 'fake', sandboxSecure: true, lockdown: { landlock: 'full', seccomp: 'full' } }); process.stdin.once('data', () => process.abort());`),
    hooks: { onSecurityEvent: (e) => events.push(e) },
    quarantineMs: 60_000,
  });
  await assert.rejects(rt.run('1', { tenant: 'prober' }), code('ERR_WORKER_CRASHED'));
  assert.ok(events[0].quarantinedUntil > Date.now());
  const err = (() => {
    try {
      isolateOf(rt, { tenant: 'prober' });
    } catch (e) {
      return e;
    }
  })();
  assert.deepEqual([err?.code, err?.kind, err?.tenant], ['ERR_TENANT_QUARANTINED', 'security', 'prober']);
  rt.tenant('prober').release();
  isolateOf(rt, { tenant: 'prober' }).close();
  rt.close();
});

test('a worker that breaks the protocol is killed', async () => {
  const events = [];
  const hostile = new Runtime({
    workerPath: fakeWorker(`send({ t: 'ready', protocol: 2, v8: 'fake', sandboxSecure: true, lockdown: { landlock: 'full', seccomp: 'full' } }); process.stdin.once('data', () => send({ t: 'result', req: 'not-a-number' })); setInterval(() => {}, 1000);`),
    hooks: { onSecurityEvent: (e) => events.push(e) },
  });
  await assert.rejects(hostile.run('1', { tenant: 'evil' }), code('ERR_WORKER_CRASHED'));
  assert.equal(events[0]?.kind, 'protocol');
  hostile.close();
});

test('a worker claiming an insecure sandbox never runs code', async (t) => {
  const dev = process.env.ISOLANE_DEV_INSECURE;
  delete process.env.ISOLANE_DEV_INSECURE;
  t.after(() => dev !== undefined && (process.env.ISOLANE_DEV_INSECURE = dev));
  const insecure = new Runtime({
    workerPath: fakeWorker(`send({ t: 'ready', protocol: 2, v8: 'fake', sandboxSecure: false, lockdown: { landlock: 'full', seccomp: 'full' } }); setInterval(() => {}, 1000);`),
  });
  await assert.rejects(insecure.run('1', { tenant: 't' }), code('ERR_WORKER_CRASHED'));
  insecure.close();
});

test('a worker that stops answering is killed after its timeout', async () => {
  const events = [];
  const silent = new Runtime({
    workerPath: fakeWorker(`send({ t: 'ready', protocol: 2, v8: 'fake', sandboxSecure: true, lockdown: { landlock: 'full', seccomp: 'full' } }); setInterval(() => {}, 1000);`),
    hooks: { onSecurityEvent: (e) => events.push(e) },
  });
  const started = Date.now();
  await assert.rejects(silent.run('1', { tenant: 't', limits: { timeoutMs: 100 } }), code('ERR_WORKER_UNRESPONSIVE'));
  assert.ok(Date.now() - started < 3000);
  assert.equal(events[0]?.kind, 'unresponsive');
  silent.close();
});

test('an oversized frame is a protocol violation', async () => {
  const big = new Runtime({
    workerPath: fakeWorker(`send({ t: 'ready', protocol: 2, v8: 'fake', sandboxSecure: true, lockdown: { landlock: 'full', seccomp: 'full' } }); process.stdin.once('data', () => { const h = Buffer.alloc(4); h.writeUInt32LE(0xffffffff); process.stdout.write(h); }); setInterval(() => {}, 1000);`),
  });
  await assert.rejects(big.run('1', { tenant: 't' }), code('ERR_WORKER_CRASHED'));
  big.close();
});

test('a worker speaking another protocol version is refused, not treated as hostile', async () => {
  for (const ready of [
    `send({ t: 'ready', protocol: 1, v8: 'old', sandboxSecure: true, lockdown: { landlock: 'full', seccomp: 'full' } });`,
    `send({ t: 'ready', v8: 'old', sandboxSecure: true, lockdown: { landlock: 'full', seccomp: 'full' } });`,
  ]) {
    const events = [];
    const old = new Runtime({ workerPath: fakeWorker(`${ready} setInterval(() => {}, 1000);`), hooks: { onSecurityEvent: (e) => events.push(e) } });
    const err = await old.run('1', { tenant: 't' }).catch((e) => e);
    assert.equal(err.code, 'ERR_WORKER_INCOMPATIBLE');
    assert.match(err.message, /speaks protocol 1, this library 2/);
    assert.deepEqual(events, []);
    old.close();
  }
});
