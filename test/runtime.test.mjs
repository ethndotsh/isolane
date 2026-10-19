// End-to-end tests: the TypeScript supervisor driving real worker processes.
// Needs ISOLANE_WORKER pointing at a built isolane-worker binary.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime, IsolaneError, DEFAULT_LIMITS, hostFunction } from '../dist/index.js';
import { z } from 'zod';

// ISOLANE_STRICT=1 runs everything under strict mode (CI on native Linux).
const pool = new Runtime({ strict: process.env.ISOLANE_STRICT === '1' });
after(() => pool.close());

const T = { tenant: 'acme' };
const code = (c) => (err) => err instanceof IsolaneError && err.code === c;

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
  const vm = pool.createIsolate({ ...T, timeoutMs: 50 });
  await vm.eval('globalThis.kept = "yes"');
  for (let i = 0; i < 5; i++) await assert.rejects(vm.eval('while (true) {}'), code('ERR_TIMEOUT'));
  assert.equal(await vm.eval('kept'), 'yes');
  vm.dispose();
});

test('runaway recursion is a catchable RangeError', async () => {
  assert.equal(await pool.run('try { (function r() { r() })() } catch (e) { e instanceof RangeError }', T), true);
});

test('the heap limit retires the vm', async () => {
  const vm = pool.createIsolate({ ...T, memoryLimitBytes: 16 << 20 });
  await assert.rejects(
    vm.eval('const a = []; for (;;) a.push({ x: "y".repeat(1000) + Math.random() })'),
    code('ERR_MEMORY_LIMIT'),
  );
  await assert.rejects(vm.eval('1'), code('ERR_ISOLATE_RETIRED'));
  vm.dispose();
  assert.equal(await pool.run('"worker survives"', T), 'worker survives');
});

// ---- isolation ----

test('one-shot runs are isolated', async () => {
  await pool.run('globalThis.leak = 123', T);
  assert.equal(await pool.run('typeof globalThis.leak', T), 'undefined');
});

test('stateful vms keep globals; vms are isolated', async () => {
  const a = pool.createIsolate(T);
  const b = pool.createIsolate(T);
  await a.eval('globalThis.counter = 10');
  await a.eval('counter += 5');
  assert.equal(await a.eval('counter'), 15);
  assert.equal(await b.eval('typeof counter'), 'undefined');
  a.dispose();
  b.dispose();
});

test('disposed vms reject', async () => {
  const vm = pool.createIsolate(T);
  await vm.eval('1');
  vm.dispose();
  await assert.rejects(vm.eval('2'), code('ERR_ISOLATE_DISPOSED'));
});

test('a tenant is required', () => {
  assert.throws(() => pool.createIsolate({}), code('ERR_INVALID_OPTION'));
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
  const vm = pool.createIsolate(T);
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
  const vm = pool.createIsolate({ ...T, clock: { fixedMs: 1e12 }, hostFunctions });
  assert.equal(await vm.eval('Date.now()'), 1e12);
  assert.equal(await vm.eval('wait().then(() => new Date().toISOString())'), new Date(1e12).toISOString());
  vm.dispose();
  assert.throws(() => pool.createIsolate({ ...T, clock: 'sometimes' }), code('ERR_INVALID_OPTION'));
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
  assert.throws(() => pool.createIsolate({ ...T, randomSeed: -1 }), code('ERR_INVALID_OPTION'));
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
  const logged = new Runtime({ strict: process.env.ISOLANE_STRICT === '1', onLog: (e) => logs.push(e) });
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
  const vm = acme.createIsolate();
  await vm.eval('globalThis.k = a');
  assert.equal(await vm.eval('k'), 1);
  vm.dispose();
  const withDefaults = new Runtime({ strict: process.env.ISOLANE_STRICT === '1', defaults: { globals: { d: 'yes' } } });
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
  const capped = new Runtime({ strict: process.env.ISOLANE_STRICT === '1', workerMemoryLimitBytes: 256 << 20, onSecurityEvent: (e) => events.push(e) });
  const bomb = 'const keep = []; for (;;) keep.push(new Uint8Array(16 << 20).fill(1));';
  const err = await capped.run(bomb, { ...T, timeoutMs: 20000 }).catch((e) => e);
  assert.ok(
    err.code === 'ERR_MEMORY_LIMIT' || (err.code === 'ERR_GUEST_EXCEPTION' && /allocation failed/i.test(err.message)),
    `${err.code}: ${err.message} | worker stderr: ${events.map((e) => e.detail).join(' / ')}`,
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

test('bytes cross host calls as bytes, both ways', async () => {
  const seen = [];
  const hostFunctions = {
    take: (a, b, nested) => {
      seen.push([Buffer.isBuffer(a), [...a], [...b], nested]);
      return { echo: Buffer.concat([a, b]), list: [new Uint8Array([7]), 'x'], ab: new Uint8Array([5, 6]).buffer };
    },
    big: () => Buffer.alloc(3 << 20, 1),
    whole: { sync: true, fn: (b) => b },
  };
  assert.deepEqual(
    await pool.run(
      `take(new Uint8Array([1, 2]), new Uint16Array([0x0403]).buffer, { n: 1 }).then((r) => [r.echo instanceof Uint8Array, [...r.echo], r.list[0] instanceof Uint8Array, [...r.list[0]], r.list[1], [...r.ab]])`,
      { ...T, hostFunctions },
    ),
    [true, [1, 2, 3, 4], true, [7], 'x', [5, 6]],
  );
  assert.deepEqual(seen, [[true, [1, 2], [3, 4], { n: 1 }]]);
  assert.equal(await pool.run('big().then((b) => b.length + b[100])', { ...T, hostFunctions }), (3 << 20) + 1);
  assert.deepEqual(await pool.run('[...whole(new Uint8Array([9, 8]))]', { ...T, hostFunctions }), [9, 8]);
  // Arguments past the frame limit throw in the guest instead of breaking the protocol.
  // (synchronously, like any argument that can't be serialized).
  assert.match(
    await pool.run('try { take(new Uint8Array(65 << 20)); "sent" } catch (e) { e.name + ": " + e.message }', { ...T, hostFunctions }),
    /RangeError: .*64 MiB/,
  );
});

test('oversized results and error messages fail the eval, not the worker', async () => {
  const events = [];
  const rt = new Runtime({ strict: process.env.ISOLANE_STRICT === '1', onSecurityEvent: (e) => events.push(e) });
  await assert.rejects(rt.run('"x".repeat(70 << 20)', T), code('ERR_NOT_SERIALIZABLE'));
  const err = await rt.run('throw new Error("y".repeat(70 << 20))', T).catch((e) => e);
  assert.equal(err.code, 'ERR_GUEST_EXCEPTION');
  assert.ok(err.guest.message.length < 70 << 10);
  assert.equal(await rt.run('1 + 1', T), 2);
  assert.deepEqual(events, []);
  rt.close();
});

test('host functions on a stateful vm', async () => {
  const log = [];
  const vm = pool.createIsolate({ ...T, hostFunctions: { log: (m) => void log.push(m) } });
  await vm.eval('log("a"); log({ b: 2 })');
  await vm.eval('log("c")');
  // Calls not awaited by the guest still reach the host.
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(log, ['a', { b: 2 }, 'c']);
  vm.dispose();
});

test('guests see UTC, not the host time zone', async () => {
  assert.deepEqual(await pool.run('[new Date(0).getTimezoneOffset(), new Date(Date.UTC(2026, 6, 1)).getTimezoneOffset(), Intl.DateTimeFormat().resolvedOptions().timeZone]', T), [0, 0, 'UTC']);
});

test('cpuTimeLimitMs bounds CPU time, not time spent waiting', { skip: process.platform !== 'linux' }, async () => {
  const hostFunctions = { wait: () => new Promise((r) => setTimeout(r, 300)) };
  const opts = { ...T, cpuTimeLimitMs: 100, timeoutMs: 5000, hostFunctions };
  // Waiting 300 ms on a host call uses no CPU.
  assert.equal(await pool.run('wait().then(() => "waited")', opts), 'waited');
  const err = await pool.run('for (;;) {}', opts).catch((e) => e);
  assert.deepEqual([err.code, err.kind], ['ERR_CPU_LIMIT', 'limit']);
  // The isolate stays usable after a CPU-limit termination.
  const vm = pool.createIsolate(opts);
  await vm.eval('globalThis.n = 1').then(() => vm.eval('for (;;) {}')).catch(() => {});
  assert.equal(await vm.eval('n + 1'), 2);
  vm.dispose();
});

test('sync host functions return directly', async () => {
  const hostFunctions = {
    add: { sync: true, fn: (a, b) => a + b },
    later: { sync: true, fn: async (x) => new Promise((r) => setTimeout(() => r(x * 2), 20)) },
    deny: {
      sync: true,
      fn: () => {
        throw Object.assign(new TypeError('nope'), { code: 'E_NOPE' });
      },
    },
    slow: { sync: true, fn: () => new Promise(() => {}) },
    echo: async (x) => x,
  };
  const opts = { ...T, hostFunctions };
  assert.equal(await pool.run('add(2, 3) + 1', opts), 6);
  assert.equal(await pool.run('later(21)', opts), 42);
  assert.deepEqual(
    await pool.run('try { deny() } catch (e) { [e instanceof TypeError, e.message, e.code] }', opts),
    [true, 'nope', 'E_NOPE'],
  );
  // Async replies that arrive while a sync call waits are kept and delivered.
  assert.deepEqual(await pool.run('(async () => { const p = echo(1); const s = later(2); return [await p, s]; })()', opts), [1, 4]);
  await assert.rejects(pool.run('slow()', { ...opts, timeoutMs: 150 }), code('ERR_TIMEOUT'));
  assert.throws(() => pool.createIsolate({ ...T, hostFunctions: { bad: { sync: 'yes' } } }), code('ERR_INVALID_OPTION'));
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
  assert.deepEqual(thrown.guest, { message: '42' });
  const timeout = await pool.run('for (;;) {}', { ...T, timeoutMs: 50 }).catch((e) => e);
  assert.deepEqual([timeout.code, timeout.kind], ['ERR_TIMEOUT', 'limit']);
  const usage = (() => {
    try {
      pool.createIsolate({ ...T, clock: 1 });
    } catch (e) {
      return e;
    }
  })();
  assert.deepEqual([usage.code, usage.kind], ['ERR_INVALID_OPTION', 'usage']);
});

test('policy errors inside the guest are spec-shaped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolane-errs-'));
  assert.deepEqual(
    await pool.run('fs.readFile("/missing").catch((e) => [e.code, e.message])', { ...T, fs: { root: dir } }),
    ['ENOENT', 'fs.readFile "/missing": no such file or directory'],
  );
  assert.equal(await pool.run('fs.writeFile("/x", "y").catch((e) => e.code)', { ...T, fs: { root: dir } }), 'EROFS');
  assert.deepEqual(
    await pool.run('fetch("https://not-allowed.example/").catch((e) => [e instanceof TypeError, /not allowed/.test(e.message)])', {
      ...T,
      network: { allow: ['api.example.com'] },
    }),
    [true, true],
  );
});

test('host function schemas validate guest arguments and host results', async () => {
  const seen = [];
  const hostFunctions = {
    getUser: hostFunction({
      args: [z.number().int().positive(), z.string().default('basic')],
      result: z.object({ id: z.number(), plan: z.string() }),
      fn: (id, plan) => (seen.push([id, plan]), { id, plan }),
    }),
    sum: hostFunction({ args: z.array(z.number()), fn: (...xs) => xs.reduce((a, b) => a + b, 0) }),
    liar: hostFunction({ result: z.string(), fn: () => 42 }),
    now: hostFunction({ sync: true, args: [], result: z.number(), fn: () => 7 }),
  };
  const opts = { ...T, hostFunctions };
  assert.deepEqual(await pool.run('getUser(1)', opts), { id: 1, plan: 'basic' }); // default applied
  assert.deepEqual(await pool.run('sum(1, 2, 3)', opts), 6);
  assert.equal(await pool.run('now() + 1', opts), 8);
  const bad = await pool.run('getUser(-1.5, 3).catch((e) => [e instanceof TypeError, e.code, e.message])', opts);
  assert.deepEqual(bad.slice(0, 2), [true, 'ERR_INVALID_ARGUMENTS']);
  assert.match(bad[2], /getUser: invalid arguments: args\.0: .*; args\.1: /);
  assert.deepEqual(seen, [[1, 'basic']]); // fn never ran for bad input
  assert.match(await pool.run('getUser(1, "x", "extra").catch((e) => e.message)', opts), /args\.2: unexpected argument/);
  assert.deepEqual(await pool.run('liar().catch((e) => [e.code, e.message.includes("42")])', opts), ['ERR_INVALID_HOST_RESULT', false]);
  assert.throws(() => pool.createIsolate({ ...T, hostFunctions: { x: { fn: () => 1, args: [1] } } }), code('ERR_INVALID_OPTION'));
});

test('result schemas validate and type what an eval returns', async () => {
  const Total = z.object({ total: z.number() });
  assert.deepEqual(await pool.run('({ total: 3, extra: true })', { ...T, result: Total }), { total: 3 }); // zod strips
  const err = await pool.run('({ total: "3" })', { ...T, result: Total }).catch((e) => e);
  assert.deepEqual([err.code, err.kind], ['ERR_INVALID_RESULT', 'guest']);
  assert.equal(err.issues[0].path[0], 'total');
  const vm = pool.tenant('acme').createIsolate();
  assert.equal(await vm.eval('21 * 2', { result: z.number() }), 42);
  await assert.rejects(vm.eval('"no"', { result: z.number() }), code('ERR_INVALID_RESULT'));
  vm.dispose();
  assert.equal(await pool.tenant('acme').run('[1, 2].length', { result: z.literal(2) }), 2);
});

test('a slow host function counts against the timeout', async () => {
  const hostFunctions = { slow: () => new Promise((r) => setTimeout(() => r(1), 1000)) };
  const started = Date.now();
  await assert.rejects(pool.run('slow()', { ...T, timeoutMs: 100, hostFunctions }), code('ERR_TIMEOUT'));
  assert.ok(Date.now() - started < 800);
});

test('concurrent vms keep their own host functions', async () => {
  const vms = Array.from({ length: 8 }, (_, i) => pool.createIsolate({ ...T, hostFunctions: { whoami: async () => i } }));
  const got = await Promise.all(vms.map((vm) => vm.eval('whoami().then((n) => n * 10)')));
  assert.deepEqual(got, [0, 10, 20, 30, 40, 50, 60, 70]);
  vms.forEach((vm) => vm.dispose());
});

// ---- tenants and worker processes ----

test('each tenant gets its own worker process', async () => {
  const a = pool.createIsolate({ tenant: 'tenant-a' });
  const a2 = pool.createIsolate({ tenant: 'tenant-a' });
  const b = pool.createIsolate({ tenant: 'tenant-b' });
  await Promise.all([a.eval('1'), a2.eval('1'), b.eval('1')]);
  const pa = pool._workerPid('tenant-a');
  const pb = pool._workerPid('tenant-b');
  assert.ok(pa && pb);
  assert.notEqual(pa, pb);
  [a, a2, b].forEach((vm) => vm.dispose());
});

test('prewarmed workers still give each tenant its own process', async () => {
  const warm = new Runtime({ strict: process.env.ISOLANE_STRICT === '1', prewarm: 2 });
  await new Promise((r) => setTimeout(r, 500));
  const t0 = performance.now();
  assert.equal(await warm.run('1 + 1', { tenant: 'w1' }), 2);
  const fast = performance.now() - t0;
  await warm.run('1', { tenant: 'w2' });
  const pids = [warm._workerPid('w1'), warm._workerPid('w2')];
  assert.ok(pids[0] && pids[1] && pids[0] !== pids[1], `tenants share a worker: ${pids}`);
  assert.ok(fast < 1000, `a prewarmed tenant took ${fast} ms`);
  warm.close();
  assert.throws(() => new Runtime({ prewarm: -1 }), code('ERR_INVALID_OPTION'));
});

test('usage is accounted per tenant', async () => {
  const rt = new Runtime({ strict: process.env.ISOLANE_STRICT === '1' });
  const tenant = rt.tenant('billed', { hostFunctions: { two: () => 2 } });
  await tenant.run('let x = 0; for (let i = 0; i < 1e6; i++) x += i; two()');
  await tenant.run('console.log("hello"); new Array(1e5).fill(1).length');
  await tenant.run('throw new Error("x")').catch(() => {});
  const u = rt.usage('billed');
  assert.deepEqual([u.evals, u.failures, u.hostCalls, u.logBytes, u.securityEvents], [3, 1, 1, 5, 0]);
  assert.ok(u.peakMemoryBytes > 100_000, `peak ${u.peakMemoryBytes}`);
  if (process.platform === 'linux') assert.ok(u.cpuMs > 0);
  rt.resetUsage('billed');
  assert.equal(rt.usage('billed').evals, 0);
  assert.equal(rt.usage('nobody').evals, 0);
  rt.close();
});

test('limits: defaults, levels, and validation', async () => {
  assert.equal(DEFAULT_LIMITS.timeoutMs, 30_000);
  assert.equal(DEFAULT_LIMITS.heapBytes, 128 << 20);
  const rt = new Runtime({
    strict: process.env.ISOLANE_STRICT === '1',
    limits: { timeoutMs: 5000, isolates: 3 },
    tenantLimits: (t) => (t === 'small' ? { isolates: 1, timeoutMs: 100 } : undefined),
  });
  const limitOf = (f) => {
    try {
      f();
    } catch (e) {
      return [e.code, e.limit];
    }
  };
  // Tenant-level caps come from the runtime, then tenantLimits.
  const big = [rt.createIsolate({ tenant: 'big' }), rt.createIsolate({ tenant: 'big' }), rt.createIsolate({ tenant: 'big' })];
  assert.deepEqual(limitOf(() => rt.createIsolate({ tenant: 'big' })), ['ERR_RESOURCE_LIMIT', 'isolates']);
  big[0].dispose();
  rt.createIsolate({ tenant: 'big' }).dispose();
  big.forEach((v) => v.dispose());
  const small = rt.createIsolate({ tenant: 'small' });
  assert.deepEqual(limitOf(() => rt.createIsolate({ tenant: 'small' })), ['ERR_RESOURCE_LIMIT', 'isolates']);
  // ...and isolate-level ones from the tenant, then the call (shorthand or limits).
  await assert.rejects(small.eval('for (;;) {}'), code('ERR_TIMEOUT'));
  small.dispose();
  await assert.rejects(rt.run('for (;;) {}', { tenant: 'small', limits: { timeoutMs: 50 } }), code('ERR_TIMEOUT'));
  assert.deepEqual(limitOf(() => rt.createIsolate({ tenant: 'big', limits: { isolates: 9 } })), ['ERR_INVALID_OPTION', undefined]);
  assert.deepEqual(limitOf(() => rt.createIsolate({ tenant: 'big', limits: { nope: 1 } })), ['ERR_INVALID_OPTION', undefined]);
  assert.deepEqual(limitOf(() => rt.createIsolate({ tenant: 'big', timeoutMs: 5, limits: { timeoutMs: 6 } })), ['ERR_INVALID_OPTION', undefined]);
  assert.throws(() => new Runtime({ limits: { tenants: 0 } }), code('ERR_INVALID_OPTION'));
  rt.close();
});

test('limits: code, results, timers, console, concurrency', async () => {
  const L = (limits) => ({ ...T, limits });
  const err = (p) => p.then(() => null, (e) => [e.code, e.limit]);
  assert.deepEqual(await err(pool.run('1 + 1 // ' + 'x'.repeat(200), L({ codeBytes: 100 }))), ['ERR_RESOURCE_LIMIT', 'codeBytes']);
  assert.deepEqual(await err(pool.run('"x".repeat(1000)', L({ resultBytes: 100 }))), ['ERR_RESOURCE_LIMIT', 'resultBytes']);
  assert.equal(
    await pool.run('let n = 0; try { for (;;) { setTimeout(() => {}, 1e6); n++; } } catch (e) { [n, e instanceof RangeError] }', {
      ...L({ timers: 5 }),
      webPlatform: true,
    }).then(JSON.stringify),
    '[5,true]',
  );
  const logs = [];
  await pool.run('console.log("y".repeat(100)); for (let i = 0; i < 50; i++) console.log("z".repeat(10))', {
    ...L({ logMessageBytes: 20, logBytesPerEval: 100 }),
    onLog: (e) => logs.push(e.message),
  });
  assert.ok(logs[0].length <= 22, logs[0]);
  assert.match(logs.at(-1), /output limit reached/);
  const rt = new Runtime({ strict: process.env.ISOLANE_STRICT === '1', limits: { concurrentEvals: 2 } });
  const vm = rt.createIsolate({ tenant: 'c', hostFunctions: { wait: () => new Promise((r) => setTimeout(r, 100)) } });
  const running = [vm.eval('wait()'), vm.eval('wait()')];
  await assert.rejects(vm.eval('1'), (e) => e.code === 'ERR_RESOURCE_LIMIT' && e.limit === 'concurrentEvals');
  await Promise.all(running);
  vm.dispose();
  rt.close();
});

test('limits.tenants evicts the least recently used idle tenant', async () => {
  const rt = new Runtime({ strict: process.env.ISOLANE_STRICT === '1', limits: { tenants: 2 } });
  await rt.run('1', { tenant: 'a' });
  await rt.run('1', { tenant: 'b' });
  const pidA = rt._workerPid('a');
  await rt.run('1', { tenant: 'c' }); // evicts a (idle longest)
  assert.equal(rt._workerPid('a'), undefined);
  assert.ok(rt._workerPid('b') && rt._workerPid('c'));
  assert.notEqual(pidA, undefined);
  const busy = [rt.createIsolate({ tenant: 'b' }), rt.createIsolate({ tenant: 'c' })];
  assert.throws(() => rt.createIsolate({ tenant: 'd' }), (e) => e.code === 'ERR_RESOURCE_LIMIT' && e.limit === 'tenants');
  busy.forEach((v) => v.dispose());
  rt.close();
});

test('workers get an empty environment', { skip: process.platform !== 'linux' }, async () => {
  process.env.ISOLANE_TEST_SECRET = 'leak';
  try {
    const vm = pool.createIsolate({ tenant: 'env-check' });
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
  const crashy = new Runtime({
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

test('a security event quarantines the tenant', async () => {
  const events = [];
  const rt = new Runtime({
    workerPath: fakeWorker(`send({ t: 'ready', v8: 'fake', sandboxSecure: true, lockdown: { landlock: 'full', seccomp: 'full' } }); process.stdin.once('data', () => process.abort());`),
    onSecurityEvent: (e) => events.push(e),
    quarantineMs: 60_000,
  });
  await assert.rejects(rt.run('1', { tenant: 'prober' }), code('ERR_WORKER_CRASHED'));
  assert.ok(events[0].quarantinedUntil > Date.now());
  const err = (() => {
    try {
      rt.createIsolate({ tenant: 'prober' });
    } catch (e) {
      return e;
    }
  })();
  assert.deepEqual([err?.code, err?.kind, err?.tenant], ['ERR_TENANT_QUARANTINED', 'security', 'prober']);
  rt.releaseQuarantine('prober');
  rt.createIsolate({ tenant: 'prober' }).dispose();
  rt.close();
});

test('a worker that breaks the protocol is killed', async () => {
  const events = [];
  const hostile = new Runtime({
    workerPath: fakeWorker(`send({ t: 'ready', v8: 'fake', sandboxSecure: true, lockdown: { landlock: 'full', seccomp: 'full' } }); process.stdin.once('data', () => send({ t: 'result', req: 'not-a-number' })); setInterval(() => {}, 1000);`),
    onSecurityEvent: (e) => events.push(e),
  });
  await assert.rejects(hostile.run('1', { tenant: 'evil' }), code('ERR_WORKER_CRASHED'));
  assert.equal(events[0]?.kind, 'protocol-violation');
  hostile.close();
});

test('a worker claiming an insecure sandbox never runs code', async (t) => {
  const dev = process.env.ISOLANE_DEV_INSECURE;
  delete process.env.ISOLANE_DEV_INSECURE;
  t.after(() => dev !== undefined && (process.env.ISOLANE_DEV_INSECURE = dev));
  const insecure = new Runtime({
    workerPath: fakeWorker(`send({ t: 'ready', v8: 'fake', sandboxSecure: false, lockdown: { landlock: 'full', seccomp: 'full' } }); setInterval(() => {}, 1000);`),
  });
  await assert.rejects(insecure.run('1', { tenant: 't' }), code('ERR_WORKER_CRASHED'));
  insecure.close();
});

test('a worker that stops answering is killed after its timeout', async () => {
  const events = [];
  const silent = new Runtime({
    workerPath: fakeWorker(`send({ t: 'ready', v8: 'fake', sandboxSecure: true, lockdown: { landlock: 'full', seccomp: 'full' } }); setInterval(() => {}, 1000);`),
    onSecurityEvent: (e) => events.push(e),
  });
  const started = Date.now();
  await assert.rejects(silent.run('1', { tenant: 't', timeoutMs: 100 }), code('ERR_WORKER_UNRESPONSIVE'));
  assert.ok(Date.now() - started < 3000);
  assert.equal(events[0]?.kind, 'worker-unresponsive');
  silent.close();
});

test('queued evals on one vm are not mistaken for an unresponsive worker', async () => {
  const vm = pool.createIsolate({ ...T, timeoutMs: 400 });
  const loops = Array.from({ length: 4 }, () => vm.eval('for (;;) {}'));
  for (const r of await Promise.allSettled(loops)) assert.equal(r.reason?.code, 'ERR_TIMEOUT');
  assert.equal(await vm.eval('2'), 2);
  vm.dispose();
});

test('an oversized frame is a protocol violation', async () => {
  const big = new Runtime({
    workerPath: fakeWorker(`send({ t: 'ready', v8: 'fake', sandboxSecure: true, lockdown: { landlock: 'full', seccomp: 'full' } }); process.stdin.once('data', () => { const h = Buffer.alloc(4); h.writeUInt32LE(0xffffffff); process.stdout.write(h); }); setInterval(() => {}, 1000);`),
  });
  await assert.rejects(big.run('1', { tenant: 't' }), code('ERR_WORKER_CRASHED'));
  big.close();
});
