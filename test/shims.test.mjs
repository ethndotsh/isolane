// Shims: the embedder's JS around guest code (setup, before, after).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../dist/index.js';
import { pool, T, code, isolate, strict } from './helpers.mjs';

const shimError = (phase, filename) => (err) =>
  code('ERR_SHIM')(err) && err.kind === 'usage' && err.shim?.phase === phase && err.shim.filename === filename;

test('setup runs once, before and after around each eval', async () => {
  const vm = isolate({
    ...T,
    shims: {
      setup: 'globalThis.trace = ["setup"]',
      before: 'trace.push("before")',
      after: 'trace.push("after")',
    },
  });
  await vm.eval('trace.push("guest")');
  assert.deepEqual(await vm.eval('trace.slice()'), ['setup', 'before', 'guest', 'after', 'before']);
  vm.close();
});

test('levels concatenate: setup and before outermost first, after innermost first', async () => {
  const at = (level) => ({
    setup: `(globalThis.trace ??= []).push("setup:${level}")`,
    before: `trace.push("before:${level}")`,
    after: [`trace.push("after:${level}")`, `trace.push("after2:${level}")`],
  });
  const rt = new Runtime({ strict, defaults: { shims: at('defaults') }, tenants: () => ({ shims: at('tenant') }) });
  after(() => rt.close());
  const vm = rt.tenant('t').isolate({ shims: at('call') });
  await vm.eval('1');
  assert.deepEqual(await vm.eval('trace.splice(0)'), [
    'setup:defaults',
    'setup:tenant',
    'setup:call',
    'before:defaults',
    'before:tenant',
    'before:call',
    'after:call',
    'after2:call',
    'after:tenant',
    'after2:tenant',
    'after:defaults',
    'after2:defaults',
    'before:defaults',
    'before:tenant',
    'before:call',
  ]);
  vm.close();
});

test('an after shim gets the settled value and can replace it', async () => {
  assert.equal(await pool.run('20', { ...T, shims: { after: 'return result + 1' } }), 21);
  // Awaited guest value in, awaited shim value out; undefined keeps the result.
  const shims = { after: ['await null; return { wrapped: result }', 'globalThis.seen = result', 'return [result.wrapped, seen.wrapped]'] };
  assert.deepEqual(await pool.run('Promise.resolve(5)', { ...T, shims }), [5, 5]);
});

test('setup can wrap what the guest gets', async () => {
  const value = await pool.run('getUser(1)', {
    ...T,
    host: { getUser: async (id) => ({ id }) },
    shims: { setup: 'const inner = getUser; globalThis.getUser = async (id) => ({ ...(await inner(id)), wrapped: true });' },
  });
  assert.deepEqual(value, { id: 1, wrapped: true });
});

test('shim failures are ERR_SHIM, naming the shim', async () => {
  await assert.rejects(
    pool.run('1', { ...T, shims: { before: { code: 'throw new Error("before broke")', filename: 'audit.js' } } }),
    (err) => shimError('before', 'audit.js')(err) && err.message.includes('before broke') && err.message.includes('audit.js:1'),
  );
  await assert.rejects(pool.run('1', { ...T, shims: { after: '\nawait null;\nthrow new TypeError("after broke")' } }), (err) =>
    // Lines count from the shim's own first line.
    shimError('after', 'shim:call.after.0')(err) && err.message.includes('after broke') && err.message.includes('shim:call.after.0:3'),
  );
  await assert.rejects(pool.run('1', { ...T, shims: { after: 'return new Promise(() => {})' } }), (err) =>
    shimError('after', 'shim:call.after.0')(err) && err.message.includes('never settled'),
  );
  // A setup failure fails every eval.
  const vm = isolate({ ...T, shims: { setup: ['1', 'null.x'] } });
  await assert.rejects(vm.eval('1'), shimError('setup', 'shim:call.setup.1'));
  await assert.rejects(vm.eval('1'), shimError('setup', 'shim:call.setup.1'));
  vm.close();
});

test("the guest's own errors stay guest errors, and after shims don't run", async () => {
  const vm = isolate({ ...T, shims: { after: 'globalThis.ran = true' } });
  await assert.rejects(vm.eval('throw new Error("mine")'), code('ERR_GUEST_EXCEPTION'));
  assert.equal(await vm.eval('typeof ran'), 'undefined');
  vm.close();
});

test('shims work with eval off, and leave it off for the guest', async () => {
  const shims = { setup: 'globalThis.x = 1', before: 'x++', after: 'return result * 10' };
  assert.equal(await pool.run('x', { ...T, shims }), 20);
  await assert.rejects(pool.run('new Function("return 1")()', { ...T, shims }), code('ERR_GUEST_EXCEPTION'));
});

test('guest line numbers are unaffected by shims', async () => {
  const guest = '1;\n2;\nthrow new Error("line 3")';
  const stackOf = (config) => pool.run(guest, { ...T, ...config }).catch((e) => e.guest.stack);
  const plain = await stackOf({});
  const shimmed = await stackOf({ shims: { setup: 'a = 1;\nb = 2', before: 'c = 1;\nd = 2;\ne = 3', after: 'return result' } });
  assert.match(plain, /acme\/eval-1\.js:3:7/);
  assert.equal(shimmed, plain);
});

test('shims are validated, naming the field', () => {
  const t = pool.tenant('acme');
  assert.throws(() => t.isolate({ shims: { around: 'x' } }), (e) => code('ERR_INVALID_CONFIG')(e) && e.message.includes('shims.around'));
  assert.throws(() => t.isolate({ shims: { before: ['x', { code: 1 }] } }), (e) => code('ERR_INVALID_CONFIG')(e) && e.message.includes('shims.before.1.code'));
  assert.throws(() => t.isolate({ shims: { after: { code: 'x', filename: '' } } }), (e) => code('ERR_INVALID_CONFIG')(e) && e.message.includes('shims.after.filename'));
});

test('setup runs under the time limit', async () => {
  const vm = isolate({ ...T, limits: { timeoutMs: 100 }, shims: { setup: 'for (;;) {}' } });
  await assert.rejects(vm.eval('1'), (err) => code('ERR_LIMIT')(err) && err.limit === 'timeoutMs');
  vm.close();
});
