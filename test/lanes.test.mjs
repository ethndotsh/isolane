// End-to-end tests: the TypeScript supervisor driving real worker processes.
// Needs ISOLANE_WORKER pointing at a built isolane-worker binary.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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

test('the clock is frozen while guest code runs', async () => {
  // A busy loop can't measure itself, by Date, Intl, or new Date().
  const [elapsed, sameDate, sameIntl] = await pool.run(
    `const fmt = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: 'numeric', second: 'numeric', fractionalSecondDigits: 3, timeZone: 'UTC' });
     const t0 = Date.now(), s0 = fmt.format();
     let x = 0;
     for (let i = 0; i < 3e7; i++) x += i;
     [Date.now() - t0, new Date().getTime() === t0, fmt.format() === s0]`,
    T,
  );
  assert.deepEqual([elapsed, sameDate, sameIntl], [0, true, true]);
  const now = await pool.run('Date.now()', T);
  assert.ok(Math.abs(now - Date.now()) < 1000, `guest clock ${now} is not the real time`);
});

test('the clock moves forward at I/O', async () => {
  const hostFunctions = { wait: () => new Promise((r) => setTimeout(r, 50)) };
  const elapsed = await pool.run('(async () => { const t0 = Date.now(); await wait(); return Date.now() - t0; })()', {
    ...T,
    hostFunctions,
  });
  assert.ok(elapsed >= 40, `clock moved ${elapsed}ms across a 50ms host call`);
  const vm = pool.createVm(T);
  const t0 = await vm.eval('globalThis.t0 = Date.now()');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok((await vm.eval('Date.now()')) - t0 >= 40);
  vm.dispose();
});

test('clock: realtime and fixed', async () => {
  const elapsed = await pool.run('const t0 = Date.now(); let x = 0; for (let i = 0; i < 3e7; i++) x += i; Date.now() - t0', {
    ...T,
    clock: 'realtime',
  });
  assert.ok(elapsed > 0, `realtime clock didn't move over a busy loop (${elapsed}ms)`);
  const hostFunctions = { wait: () => new Promise((r) => setTimeout(r, 20)) };
  const vm = pool.createVm({ ...T, clock: { fixedMs: 1e12 }, hostFunctions });
  assert.equal(await vm.eval('Date.now()'), 1e12);
  assert.equal(await vm.eval('wait().then(() => new Date().toISOString())'), new Date(1e12).toISOString());
  vm.dispose();
  assert.throws(() => pool.createVm({ ...T, clock: 'sometimes' }), TypeError);
});

test('randomSeed makes Math.random reproducible', async () => {
  const draw = '[Math.random(), Math.random(), Math.random()]';
  const a = await pool.run(draw, { ...T, randomSeed: 7 });
  const b = await pool.run(draw, { ...T, randomSeed: 7 });
  const c = await pool.run(draw, { ...T, randomSeed: 8 });
  const d = await pool.run(draw, T);
  const e = await pool.run(draw, T);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.notDeepEqual(d, e);
  assert.throws(() => pool.createVm({ ...T, randomSeed: -1 }), TypeError);
});

test('allowCodeGeneration opts in to eval and new Function', async () => {
  const opts = { ...T, allowCodeGeneration: true };
  assert.equal(await pool.run('eval("1 + 1") + new Function("return 2")()', opts), 4);
  assert.equal(await pool.run('typeof WebAssembly', opts), 'undefined');
});

test('network and fs policies reach the guest through the worker', async () => {
  const server = createServer((req, res) => res.end(JSON.stringify({ path: req.url })));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'isolane-root-'));
  writeFileSync(join(dir, 'a.txt'), 'from disk');
  try {
    const url = `http://localhost:${server.address().port}/hi`;
    const network = { allow: ['localhost'], allowPrivateNetworks: true };
    assert.deepEqual(await pool.run(`fetch('${url}').then((r) => r.json())`, { ...T, network }), { path: '/hi' });
    assert.equal(await pool.run(`fs.readFile('/a.txt', 'utf8')`, { ...T, fs: { root: dir } }), 'from disk');
    assert.deepEqual(
      await pool.run('[typeof fetch, typeof fs, typeof __isolane_fetch, typeof __isolane_fs]', { ...T, network, fs: { root: dir } }),
      ['function', 'object', 'undefined', 'undefined'],
    );
    await assert.rejects(pool.run(`fetch('${url}')`, { ...T, network: { allow: ['localhost'] } }), /no public address/);
    await assert.rejects(pool.run(`fs.writeFile('/b.txt', 'x')`, { ...T, fs: { root: dir } }), /read-only/);
  } finally {
    server.close();
  }
});

test('console output reaches onLog', async () => {
  const logs = [];
  const logged = new LanePool({ strict: process.env.ISOLANE_STRICT === '1', onLog: (e) => logs.push(e) });
  await logged.run('console.log("hi", 1, { a: [2] }); console.error(new Error("bad").message); console.warn(undefined, null)', T);
  assert.deepEqual(logs, [
    { tenant: 'acme', level: 'log', message: 'hi 1 {"a":[2]}' },
    { tenant: 'acme', level: 'error', message: 'bad' },
    { tenant: 'acme', level: 'warn', message: 'undefined null' },
  ]);
  const mine = [];
  await logged.run('console.info("x".repeat(10))', { ...T, onLog: (e) => mine.push(e.message) });
  assert.deepEqual(mine, ['xxxxxxxxxx']);
  logs.length = 0;
  await logged.run('for (let i = 0; i < 1e5; i++) console.log("y".repeat(100))', T);
  assert.ok(logs.length < 12000, `${logs.length} lines got through the per-eval budget`);
  assert.match(logs.at(-1).message, /output limit reached/);
  logged.close();
});

test('globals pass inputs without touching the code string', async () => {
  const input = { name: 'O\'Brien"); throw 1; //', n: 41 };
  assert.deepEqual(await pool.run('[input.name, input.n + 1]', { ...T, globals: { input } }), [input.name, 42]);
});

test('tenant handles and defaults', async () => {
  const acme = pool.tenant('acme', { globals: { a: 1 }, hostFunctions: { two: () => 2 } });
  assert.equal(await acme.run('two().then((t) => a + t + b)', { globals: { b: 3 } }), 6);
  const vm = acme.createVm();
  await vm.eval('globalThis.k = a');
  assert.equal(await vm.eval('k'), 1);
  vm.dispose();
  const withDefaults = new LanePool({ strict: process.env.ISOLANE_STRICT === '1', defaults: { globals: { d: 'yes' } } });
  assert.equal(await withDefaults.tenant('t').run('d'), 'yes');
  withDefaults.close();
});

test('allowWebAssembly opts in to WebAssembly', async () => {
  // (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
  const wasm = [0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11];
  const code = 'WebAssembly.instantiate(new Uint8Array(bytes)).then(({ instance }) => instance.exports.add(2, 3))';
  assert.equal(await pool.run(code, { ...T, allowWebAssembly: true, globals: { bytes: wasm } }), 5);
  await assert.rejects(pool.run(code, { ...T, globals: { bytes: wasm } }), /WebAssembly is not defined/);
});

test('the worker memory limit bounds memory outside the heap', { skip: process.platform !== 'linux' }, async () => {
  const events = [];
  const capped = new LanePool({ strict: process.env.ISOLANE_STRICT === '1', workerMemoryLimitBytes: 256 << 20, onSecurityEvent: (e) => events.push(e) });
  const bomb = 'const keep = []; for (;;) keep.push(new Uint8Array(16 << 20).fill(1));';
  const err = await capped.run(bomb, { ...T, timeoutMs: 20000 }).catch((e) => e);
  assert.ok(
    err.code === 'ERR_MEMORY_LIMIT' || (err.code === 'ERR_GUEST_EXCEPTION' && /allocation failed/i.test(err.message)),
    `${err.code}: ${err.message}`,
  );
  assert.equal(await capped.run('1 + 1', T), 2); // the tenant keeps working
  assert.deepEqual(events, []); // running out of memory isn't a security event
  capped.close();
});

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

test('a worker that stops answering is killed after its timeout', async () => {
  const events = [];
  const silent = new LanePool({
    workerPath: fakeWorker(`send({ t: 'ready', v8: 'fake', sandboxSecure: true, lockdown: { landlock: 'full', seccomp: 'full' } }); setInterval(() => {}, 1000);`),
    onSecurityEvent: (e) => events.push(e),
  });
  const started = Date.now();
  await assert.rejects(silent.run('1', { tenant: 't', timeoutMs: 100 }), code('ERR_WORKER_CRASHED'));
  assert.ok(Date.now() - started < 3000);
  assert.equal(events[0]?.kind, 'worker-unresponsive');
  silent.close();
});

test('queued evals on one vm are not mistaken for an unresponsive worker', async () => {
  const vm = pool.createVm({ ...T, timeoutMs: 400 });
  const loops = Array.from({ length: 4 }, () => vm.eval('for (;;) {}'));
  for (const r of await Promise.allSettled(loops)) assert.equal(r.reason?.code, 'ERR_TIMEOUT');
  assert.equal(await vm.eval('2'), 2);
  vm.dispose();
});

test('an oversized frame is a protocol violation', async () => {
  const big = new LanePool({
    workerPath: fakeWorker(`send({ t: 'ready', v8: 'fake', sandboxSecure: true, lockdown: { landlock: 'full', seccomp: 'full' } }); process.stdin.once('data', () => { const h = Buffer.alloc(4); h.writeUInt32LE(0xffffffff); process.stdout.write(h); }); setInterval(() => {}, 1000);`),
  });
  await assert.rejects(big.run('1', { tenant: 't' }), code('ERR_WORKER_CRASHED'));
  big.close();
});
