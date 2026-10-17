// End-to-end tests: the TypeScript supervisor driving real worker processes.
// Needs ISOLANE_WORKER pointing at a built isolane-worker binary.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LanePool, LaneError } from '../dist/index.js';

// ISOLANE_STRICT=1 runs everything under strict mode (CI on native Linux).
const pool = new LanePool({ strict: process.env.ISOLANE_STRICT === '1' });
after(() => pool.close());

const T = { tenant: 'acme' };
const code = (c) => (err) => err instanceof LaneError && err.code === c;

// ---- basics (ported from clockwork's lane tests) ----

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

// ---- limits ----

test('an infinite loop is terminated by timeoutMs', async () => {
  const started = Date.now();
  await assert.rejects(pool.run('while (true) {}', { ...T, timeoutMs: 100 }), code('ERR_TIMEOUT'));
  assert.ok(Date.now() - started < 2000);
});

test('the guest cannot catch termination', async () => {
  await assert.rejects(
    pool.run('for (;;) { try { while (true) {} } catch {} }', { ...T, timeoutMs: 100 }),
    code('ERR_TIMEOUT'),
  );
});

test('a timed-out vm keeps its state', async () => {
  const vm = pool.createVm({ ...T, timeoutMs: 50 });
  await vm.eval('globalThis.kept = "yes"');
  for (let i = 0; i < 5; i++) await assert.rejects(vm.eval('while (true) {}'), code('ERR_TIMEOUT'));
  assert.equal(await vm.eval('kept'), 'yes');
  vm.dispose();
});

test('runaway recursion is a catchable RangeError', async () => {
  assert.equal(await pool.run('try { (function r() { r() })() } catch (e) { e instanceof RangeError }', T), true);
});

test('the heap limit retires the vm', async () => {
  const vm = pool.createVm({ ...T, memoryLimitBytes: 16 << 20 });
  await assert.rejects(
    vm.eval('const a = []; for (;;) a.push({ x: "y".repeat(1000) + Math.random() })'),
    code('ERR_MEMORY_LIMIT'),
  );
  await assert.rejects(vm.eval('1'), code('ERR_VM_TERMINATED'));
  vm.dispose();
  assert.equal(await pool.run('"worker survives"', T), 'worker survives');
});

// ---- isolation ----

test('one-shot runs are isolated', async () => {
  await pool.run('globalThis.leak = 123', T);
  assert.equal(await pool.run('typeof globalThis.leak', T), 'undefined');
});

test('stateful vms keep globals; vms are isolated', async () => {
  const a = pool.createVm(T);
  const b = pool.createVm(T);
  await a.eval('globalThis.counter = 10');
  await a.eval('counter += 5');
  assert.equal(await a.eval('counter'), 15);
  assert.equal(await b.eval('typeof counter'), 'undefined');
  a.dispose();
  b.dispose();
});

test('disposed vms reject', async () => {
  const vm = pool.createVm(T);
  await vm.eval('1');
  vm.dispose();
  await assert.rejects(vm.eval('2'), code('ERR_VM_DISPOSED'));
});

test('a tenant is required', () => {
  assert.throws(() => pool.createVm({}), TypeError);
});

// ---- hardening ----

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
    await pool.run('[typeof require, typeof process, typeof fetch, typeof setTimeout]', T),
    ['undefined', 'undefined', 'undefined', 'undefined'],
  );
});

// ---- host functions ----

test('host functions: sync, async, and errors', async () => {
  const hostFunctions = {
    add: (a, b) => a + b,
    fetchUser: async (id) => ({ id, name: `user${id}` }),
    nothing: () => undefined,
    nil: () => null,
    fail: () => {
      throw new Error('host says no');
    },
    rejects: async () => {
      throw new Error('async no');
    },
    bad: () => 1n,
  };
  const opts = { ...T, hostFunctions };
  assert.equal(await pool.run('add(2, 3)', opts), 5);
  assert.equal(await pool.run('fetchUser(7).then((u) => u.name + "!")', opts), 'user7!');
  assert.equal(await pool.run('(async () => (await nothing()) === undefined)()', opts), true);
  assert.equal(await pool.run('(async () => (await nil()) === null)()', opts), true);
  assert.equal(await pool.run('fail().catch((e) => e.message)', opts), 'host says no');
  assert.equal(await pool.run('rejects().catch((e) => e.message)', opts), 'async no');
  await assert.rejects(pool.run('bad()', opts), /non-JSON/);
  await assert.rejects(pool.run('add(1n, 2)', opts), code('ERR_GUEST_EXCEPTION'));
});

test('host functions on a stateful vm', async () => {
  const log = [];
  const vm = pool.createVm({ ...T, hostFunctions: { log: (m) => void log.push(m) } });
  await vm.eval('log("a"); log({ b: 2 })');
  await vm.eval('log("c")');
  // Calls not awaited by the guest still reach the host.
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(log, ['a', { b: 2 }, 'c']);
  vm.dispose();
});

test('a slow host function counts against the timeout', async () => {
  const hostFunctions = { slow: () => new Promise((r) => setTimeout(() => r(1), 1000)) };
  const started = Date.now();
  await assert.rejects(pool.run('slow()', { ...T, timeoutMs: 100, hostFunctions }), code('ERR_TIMEOUT'));
  assert.ok(Date.now() - started < 800);
});

test('concurrent vms keep their own host functions', async () => {
  const vms = Array.from({ length: 8 }, (_, i) => pool.createVm({ ...T, hostFunctions: { whoami: async () => i } }));
  const got = await Promise.all(vms.map((vm) => vm.eval('whoami().then((n) => n * 10)')));
  assert.deepEqual(got, [0, 10, 20, 30, 40, 50, 60, 70]);
  vms.forEach((vm) => vm.dispose());
});

// ---- tenants and worker processes ----

test('each tenant gets its own worker process', async () => {
  const a = pool.createVm({ tenant: 'tenant-a' });
  const a2 = pool.createVm({ tenant: 'tenant-a' });
  const b = pool.createVm({ tenant: 'tenant-b' });
  await Promise.all([a.eval('1'), a2.eval('1'), b.eval('1')]);
  const pa = pool._workerPid('tenant-a');
  const pb = pool._workerPid('tenant-b');
  assert.ok(pa && pb);
  assert.notEqual(pa, pb);
  [a, a2, b].forEach((vm) => vm.dispose());
});

test('workers get an empty environment', { skip: process.platform !== 'linux' }, async () => {
  process.env.ISOLANE_TEST_SECRET = 'leak';
  try {
    const vm = pool.createVm({ tenant: 'env-check' });
    await vm.eval('1');
    const environ = readFileSync(`/proc/${pool._workerPid('env-check')}/environ`);
    assert.equal(environ.length, 0);
    vm.dispose();
  } finally {
    delete process.env.ISOLANE_TEST_SECRET;
  }
});

// ---- hostile and crashing workers ----

// Fake workers are Node scripts. (They crash with abort(): Node absorbs a
// self-sent SIGSEGV, since it installs a handler for WebAssembly traps.)
function fakeWorker(body) {
  const dir = mkdtempSync(join(tmpdir(), 'isolane-fake-'));
  const path = join(dir, 'worker');
  writeFileSync(
    path,
    `#!${process.execPath}\n` +
      `const send = (m) => { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); process.stdout.write(Buffer.concat([h, b])); };\n` +
      body,
  );
  chmodSync(path, 0o755);
  return path;
}

test('a crashing worker rejects in-flight evals and raises a security event', async () => {
  const events = [];
  const crashy = new LanePool({
    workerPath: fakeWorker(`send({ t: 'ready', v8: 'fake', sandboxSecure: true, lockdown: { landlock: 'full', seccomp: 'full' } }); process.stdin.once('data', () => process.abort());`),
    onSecurityEvent: (e) => events.push(e),
  });
  await assert.rejects(crashy.run('1', { tenant: 'victim' }), code('ERR_WORKER_CRASHED'));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'worker-crash');
  assert.equal(events[0].tenant, 'victim');
  assert.equal(events[0].signal, 'SIGABRT');
  crashy.close();
});

test('a worker that breaks the protocol is killed', async () => {
  const events = [];
  const hostile = new LanePool({
    workerPath: fakeWorker(`send({ t: 'ready', v8: 'fake', sandboxSecure: true, lockdown: { landlock: 'full', seccomp: 'full' } }); process.stdin.once('data', () => send({ t: 'result', req: 'not-a-number' })); setInterval(() => {}, 1000);`),
    onSecurityEvent: (e) => events.push(e),
  });
  await assert.rejects(hostile.run('1', { tenant: 'evil' }), code('ERR_WORKER_CRASHED'));
  assert.equal(events[0]?.kind, 'protocol-violation');
  hostile.close();
});

test('a worker claiming an insecure sandbox never runs code', async () => {
  const insecure = new LanePool({
    workerPath: fakeWorker(`send({ t: 'ready', v8: 'fake', sandboxSecure: false, lockdown: { landlock: 'full', seccomp: 'full' } }); setInterval(() => {}, 1000);`),
  });
  await assert.rejects(insecure.run('1', { tenant: 't' }), code('ERR_WORKER_CRASHED'));
  insecure.close();
});

test('an oversized frame is a protocol violation', async () => {
  const big = new LanePool({
    workerPath: fakeWorker(`send({ t: 'ready', v8: 'fake', sandboxSecure: true, lockdown: { landlock: 'full', seccomp: 'full' } }); process.stdin.once('data', () => { const h = Buffer.alloc(4); h.writeUInt32LE(0xffffffff); process.stdout.write(h); }); setInterval(() => {}, 1000);`),
  });
  await assert.rejects(big.run('1', { tenant: 't' }), code('ERR_WORKER_CRASHED'));
  big.close();
});
