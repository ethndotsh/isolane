// Host functions: async and sync, bytes, schemas, returns schemas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime, hostFunction } from '../dist/index.js';
import { z } from 'zod';
import { pool, T, code, limit, isolate, strict } from './helpers.mjs';

test('host functions: sync, async, and errors', async () => {
  const host = {
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
  const opts = { ...T, host };
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
  const host = {
    take: (a, b, nested) => {
      seen.push([Buffer.isBuffer(a), [...a], [...b], nested]);
      return { echo: Buffer.concat([a, b]), list: [new Uint8Array([7]), 'x'], ab: new Uint8Array([5, 6]).buffer };
    },
    big: () => Buffer.alloc(3 << 20, 1),
    whole: hostFunction({ sync: true, handler: (b) => b }),
  };
  assert.deepEqual(
    await pool.run(
      `take(new Uint8Array([1, 2]), new Uint16Array([0x0403]).buffer, { n: 1 }).then((r) => [r.echo instanceof Uint8Array, [...r.echo], r.list[0] instanceof Uint8Array, [...r.list[0]], r.list[1], [...r.ab]])`,
      { ...T, host },
    ),
    [true, [1, 2, 3, 4], true, [7], 'x', [5, 6]],
  );
  assert.deepEqual(seen, [[true, [1, 2], [3, 4], { n: 1 }]]);
  assert.equal(await pool.run('big().then((b) => b.length + b[100])', { ...T, host }), (3 << 20) + 1);
  assert.deepEqual(await pool.run('[...whole(new Uint8Array([9, 8]))]', { ...T, host }), [9, 8]);
  // Arguments past the frame limit throw in the guest instead of breaking the protocol.
  // (synchronously, like any argument that can't be serialized).
  assert.match(
    await pool.run('try { take(new Uint8Array(65 << 20)); "sent" } catch (e) { e.name + ": " + e.message }', { ...T, host }),
    /RangeError: .*64 MiB/,
  );
});

test('host functions on a stateful isolate', async () => {
  const log = [];
  const vm = isolate({ ...T, host: { log: (m) => void log.push(m) } });
  await vm.eval('log("a"); log({ b: 2 })');
  await vm.eval('log("c")');
  // Calls not awaited by the guest still reach the host.
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(log, ['a', { b: 2 }, 'c']);
  vm.close();
});

test('sync host functions return directly', async () => {
  const host = {
    add: hostFunction({ sync: true, handler: (a, b) => a + b }),
    later: hostFunction({ sync: true, handler: async (x) => new Promise((r) => setTimeout(() => r(x * 2), 20)) }),
    deny: hostFunction({
      sync: true,
      handler: () => {
        throw Object.assign(new TypeError('nope'), { code: 'E_NOPE' });
      },
    }),
    slow: hostFunction({ sync: true, handler: () => new Promise(() => {}) }),
    echo: async (x) => x,
  };
  const opts = { ...T, host };
  assert.equal(await pool.run('add(2, 3) + 1', opts), 6);
  assert.equal(await pool.run('later(21)', opts), 42);
  assert.deepEqual(
    await pool.run('try { deny() } catch (e) { [e instanceof TypeError, e.message, e.code] }', opts),
    [true, 'nope', 'E_NOPE'],
  );
  // Async replies that arrive while a sync call waits are kept and delivered.
  assert.deepEqual(await pool.run('(async () => { const p = echo(1); const s = later(2); return [await p, s]; })()', opts), [1, 4]);
  await assert.rejects(pool.run('slow()', { ...opts, limits: { timeoutMs: 150 } }), limit('timeoutMs'));
  assert.throws(() => hostFunction({ sync: 'yes', handler: () => 1 }), code('ERR_INVALID_CONFIG'));
  assert.throws(() => isolate({ ...T, host: { bad: { sync: true, fn: () => 1 } } }), /wrap it in hostFunction/);
});

test('host function schemas validate guest arguments and host results', async () => {
  const seen = [];
  const host = {
    getUser: hostFunction({
      args: [z.number().int().positive(), z.string().default('basic')],
      returns: z.object({ id: z.number(), plan: z.string() }),
      handler: (id, plan) => (seen.push([id, plan]), { id, plan }),
    }),
    sum: hostFunction({ args: z.array(z.number()), handler: (...xs) => xs.reduce((a, b) => a + b, 0) }),
    liar: hostFunction({ returns: z.string(), handler: () => 42 }),
    now: hostFunction({ sync: true, args: [], returns: z.number(), handler: () => 7 }),
  };
  const opts = { ...T, host };
  assert.deepEqual(await pool.run('getUser(1)', opts), { id: 1, plan: 'basic' }); // default applied
  assert.deepEqual(await pool.run('sum(1, 2, 3)', opts), 6);
  assert.equal(await pool.run('now() + 1', opts), 8);
  const bad = await pool.run('getUser(-1.5, 3).catch((e) => [e instanceof TypeError, e.code, e.message])', opts);
  assert.deepEqual(bad.slice(0, 2), [true, 'ERR_INVALID_ARGUMENTS']);
  assert.match(bad[2], /getUser: invalid arguments: args\.0: .*; args\.1: /);
  assert.deepEqual(seen, [[1, 'basic']]); // fn never ran for bad input
  assert.match(await pool.run('getUser(1, "x", "extra").catch((e) => e.message)', opts), /args\.2: unexpected argument/);
  assert.deepEqual(await pool.run('liar().catch((e) => [e.code, e.message.includes("42")])', opts), ['ERR_INVALID_RETURN', false]);
  assert.throws(() => hostFunction({ handler: () => 1, args: [1] }), code('ERR_INVALID_CONFIG'));
});

test('returns schemas validate and type what an eval returns', async () => {
  const Total = z.object({ total: z.number() });
  assert.deepEqual(await pool.run('({ total: 3, extra: true })', { ...T, returns: Total }), { total: 3 }); // zod strips
  const err = await pool.run('({ total: "3" })', { ...T, returns: Total }).catch((e) => e);
  assert.deepEqual([err.code, err.kind], ['ERR_INVALID_RETURN', 'guest']);
  assert.equal(err.issues[0].path[0], 'total');
  const vm = pool.tenant('acme').isolate();
  assert.equal(await vm.eval('21 * 2', { returns: z.number() }), 42);
  await assert.rejects(vm.eval('"no"', { returns: z.number() }), code('ERR_INVALID_RETURN'));
  vm.close();
  assert.equal(await pool.tenant('acme').run('[1, 2].length', { returns: z.literal(2) }), 2);
});

test('concurrent isolates keep their own host functions', async () => {
  const vms = Array.from({ length: 8 }, (_, i) => isolate({ ...T, host: { whoami: async () => i } }));
  const got = await Promise.all(vms.map((vm) => vm.eval('whoami().then((n) => n * 10)')));
  assert.deepEqual(got, [0, 10, 20, 30, 40, 50, 60, 70]);
  vms.forEach((vm) => vm.close());
});

test('nested host objects are frozen namespaces in the guest', async () => {
  const host = { db: { users: { get: (id) => ({ id }) }, count: () => 2 }, top: () => 't' };
  assert.deepEqual(
    await pool.run(
      `(async () => {
        const frozen = [Object.isFrozen(db), Object.isFrozen(db.users)];
        db.count = () => 99; // ignored: frozen
        return [await db.users.get(7), await db.count(), await top(), frozen, typeof db.users.get];
      })()`,
      { ...T, host },
    ),
    [{ id: 7 }, 2, 't', [true, true], 'function'],
  );
  assert.throws(() => isolate({ ...T, host: { 'bad-name': () => 1 } }), /host\.bad-name is not a usable name/);
  const both = new Runtime({ strict, defaults: { host: { db: () => 1 } } });
  assert.throws(() => both.tenant('t').isolate({ host: { db: { f: () => 2 } } }), /both a function and a namespace/);
  both.close();
});

test('host functions get a call context: tenant, isolate, signal, log', async () => {
  const logs = [];
  const seen = [];
  const host = {
    bare(x) {
      seen.push(['bare', this.tenant, typeof this.isolate, x]);
      return this.isolate;
    },
    defined: hostFunction({
      args: [z.string()],
      handler: (s, ctx) => {
        seen.push(['defined', ctx.tenant, s]);
        ctx.log('info', 'from host', { s });
        return ctx.signal.aborted;
      },
    }),
  };
  const vm = isolate({ ...T, host, hooks: { onLog: (e) => logs.push(e) } });
  const [id, aborted] = await vm.eval('Promise.all([bare(1), defined("x")])');
  assert.equal(id, vm.id);
  assert.equal(aborted, false);
  assert.deepEqual(seen, [['bare', 'acme', 'number', 1], ['defined', 'acme', 'x']]);
  assert.deepEqual(logs.map((l) => [l.source, l.level, l.message]), [['host', 'info', 'from host {"s":"x"}']]);
  vm.close();
});

test('ctx.signal aborts when the eval times out or the isolate closes', async () => {
  const signals = [];
  const host = {
    hang: hostFunction({ handler: (ctx) => (signals.push(ctx.signal), new Promise(() => {})), args: [] }),
  };
  await assert.rejects(pool.run('hang()', { ...T, host, limits: { timeoutMs: 100 } }), limit('timeoutMs'));
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[0].reason.limit, 'timeoutMs');
  const vm = isolate({ ...T, host });
  await vm.eval('hang(); 1'); // not awaited by the guest: still in flight
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(signals[1].aborted, false);
  vm.close();
  assert.equal(signals[1].aborted, true);
});
