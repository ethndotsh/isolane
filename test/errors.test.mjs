// Guest errors: script names, compile locations, host-call attribution,
// causes and properties, isolane's own frames, and errors nothing handled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime, hostFunction } from '../dist/index.js';
import { pool, T, code, isolate, strict } from './helpers.mjs';

const guestOf = (p) => p.then(
  (v) => assert.fail(`expected a guest error, got ${JSON.stringify(v)}`),
  (e) => {
    assert.equal(e.code, 'ERR_GUEST_EXCEPTION', e.message);
    return e.guest;
  },
);

test('scripts are named: <tenant>/eval-<n>.js by default, or the filename given', async () => {
  const g = await guestOf(pool.run('function handler() {\n  throw new Error("x");\n}\nhandler()', T));
  assert.deepEqual(g.frames, [
    { function: 'handler', file: 'acme/eval-1.js', line: 2, column: 9 },
    { function: null, file: 'acme/eval-1.js', line: 4, column: 1 },
  ]);
  assert.match(g.stack, /^Error: x\n {4}at handler \(acme\/eval-1\.js:2:9\)/);

  const named = await guestOf(pool.run('throw new Error("y")', { ...T, filename: 'src/index.js' }));
  assert.deepEqual(named.frames[0], { function: null, file: 'src/index.js', line: 1, column: 7 });

  // A stateful isolate counts its evals.
  const vm = isolate(T);
  const files = [];
  for (let i = 0; i < 3; i++) files.push((await guestOf(vm.eval('throw new Error()'))).frames[0].file);
  assert.deepEqual(files, ['acme/eval-1.js', 'acme/eval-2.js', 'acme/eval-3.js']);
  assert.equal((await guestOf(vm.eval('throw new Error()', { filename: 'step.js' }))).frames[0].file, 'step.js');
  vm.close();

  // Tenant names are made safe for a path.
  const odd = await guestOf(pool.run('throw new Error()', { tenant: 'a b/(c)' }));
  assert.equal(odd.frames[0].file, 'a_b__c_/eval-1.js');

  for (const filename of ['', 'a\nb', 'ext:x.js', 'isolane:core.js', 7, 'x'.repeat(2000)]) {
    await assert.rejects(pool.run('1', { ...T, filename }), code('ERR_INVALID_CONFIG'), String(filename));
  }
});

test('the eval event and hooks see the filename', async () => {
  const seen = [];
  const rt = new Runtime({ strict, hooks: { beforeEval: (e) => void seen.push(e.filename) } });
  try {
    await rt.run('1', { ...T, filename: 'job.js' });
    await rt.run('1', T);
    assert.deepEqual(seen, ['job.js', 'acme/eval-1.js']);
  } finally {
    rt.close();
  }
});

test('a SyntaxError says where: location, the source line, and a caret', async () => {
  const g = await guestOf(pool.run('const a = 1;\nconst b = a +;\n', { ...T, filename: 'src/bad.js' }));
  assert.equal(g.name, 'SyntaxError');
  assert.deepEqual(g.location, { file: 'src/bad.js', line: 2, column: 14, sourceLine: 'const b = a +;' });
  assert.equal(g.stack, "src/bad.js:2\nconst b = a +;\n             ^\n\nSyntaxError: Unexpected token ';'");
  assert.deepEqual(g.frames, []);

  // A long (minified) line: a window around the column.
  const long = `const x = [${'1,'.repeat(5000)}];\nlet = ;`;
  const one = await guestOf(pool.run(`var y = ${'1+'.repeat(3000)};`, T));
  assert.ok(one.location.sourceLine.length < 300, one.location.sourceLine.length);
  assert.ok(one.location.sourceLine.startsWith('…'));
  const caret = one.stack.split('\n')[2];
  assert.equal(caret.indexOf('^'), one.location.sourceLine.indexOf(';'));
  assert.equal((await guestOf(pool.run(long, T))).location.line, 2);

  // Runtime errors have frames instead (and no location).
  const runtime = await guestOf(pool.run('null.x', T));
  assert.equal(runtime.location, undefined);
  assert.equal(runtime.frames[0].line, 1);
});

test('a failed host call points at the guest line that made it', async () => {
  const host = {
    db: {
      // Async: the reply comes later, so the stack is the call site's.
      get: async (id) => {
        const e = new Error(`user ${id} not found`);
        e.code = 'ENOTFOUND';
        throw e;
      },
      // Sync: the error is made inside the call.
      getSync: hostFunction({
        sync: true,
        handler: () => {
          throw new TypeError('bad id');
        },
      }),
    },
  };
  const hostErrors = [];
  const rt = new Runtime({ strict, hooks: { afterHostCall: (c) => void (c.error && hostErrors.push(c.error)) } });
  try {
    const code = 'async function load(id) {\n  return await db.get(id);\n}\nload(42)';
    const g = await guestOf(rt.run(code, { ...T, host, filename: 'src/db.js' }));
    assert.equal(g.message, 'user 42 not found');
    assert.deepEqual(g.properties, { code: 'ENOTFOUND' });
    assert.deepEqual(g.frames.slice(0, 2), [
      { function: 'db.get', file: '<host>', line: null, column: null },
      { function: 'load', file: 'src/db.js', line: 2, column: 19 },
    ]);
    // The guest never sees the host's stack, only its message, name, and code.
    assert.doesNotMatch(g.stack, /errors\.test|node:|file:/);
    assert.match(hostErrors[0].stack, /errors\.test\.mjs/);

    const s = await guestOf(rt.run('function check() {\n  return db.getSync(1);\n}\ncheck()', { ...T, host }));
    assert.equal(s.name, 'TypeError');
    assert.deepEqual(s.frames.slice(0, 2), [
      { function: 'db.getSync', file: '<host>', line: null, column: null },
      { function: 'check', file: 'acme/eval-1.js', line: 2, column: 13 },
    ]);

    // The guest's own error.stack has the same frames, and so does a caught one.
    const caught = await rt.run('db.get(1).catch((e) => [e.stack, e.code])', { ...T, host });
    assert.match(caught[0], /^Error: user 1 not found\n {4}at db\.get \(<host>\)\n {4}at acme\/eval-1\.js:1:4/);
    assert.equal(caught[1], 'ENOTFOUND');
  } finally {
    rt.close();
  }
});

test('causes, AggregateError, and own properties are described, within bounds', async () => {
  const g = await guestOf(
    pool.run(
      `const root = new RangeError('disk full');
       const e = new Error('save failed', { cause: new Error('write failed', { cause: root }) });
       e.code = 'ESAVE'; e.status = 503; e.detail = { path: '/x' };
       e.fn = () => 1; e.big = 'x'.repeat(10000); e[Symbol('s')] = 1;
       throw e`,
      T,
    ),
  );
  assert.equal(g.cause.message, 'write failed');
  assert.equal(g.cause.cause.name, 'RangeError');
  assert.equal(g.cause.cause.cause, undefined);
  assert.ok(g.cause.cause.frames.length > 0);
  assert.deepEqual(g.properties, { code: 'ESAVE', status: 503, detail: { path: '/x' } });

  // A non-Error cause.
  assert.deepEqual((await guestOf(pool.run('throw new Error("x", { cause: "why" })', T))).cause, { message: 'why', frames: [] });

  // A cycle, and a chain longer than 8, end.
  const cyc = await guestOf(pool.run('const a = new Error("a"); const b = new Error("b", { cause: a }); a.cause = b; throw a', T));
  let depth = 0;
  for (let c = cyc; c; c = c.cause) depth++;
  assert.equal(depth, 8);

  const agg = await guestOf(pool.run('throw new AggregateError(Array.from({ length: 40 }, (_, i) => new Error(`e${i}`)), "all failed")', T));
  assert.equal(agg.name, 'AggregateError');
  assert.equal(agg.errors.length, 16);
  assert.equal(agg.errors[3].message, 'e3');

  // Plain objects, primitives, symbols.
  assert.deepEqual((await guestOf(pool.run('throw { code: 7, why: "no" }', T))).properties, { code: 7, why: 'no' });
  assert.deepEqual(await guestOf(pool.run('throw 42', T)), { message: '42', frames: [] });
  assert.equal((await guestOf(pool.run('throw Symbol("s")', T))).message, 'Symbol(s)');

  // Hostile errors: throwing getters and traps, revoked proxies, huge messages.
  const hostile = await guestOf(
    pool.run(
      `const e = new Error('ok');
       Object.defineProperty(e, 'code', { enumerable: true, get() { throw new Error('getter'); } });
       Object.defineProperty(e, 'cause', { get() { throw new Error('cause getter'); } });
       throw e`,
      T,
    ),
  );
  assert.equal(hostile.message, 'ok');
  assert.equal(hostile.properties, undefined);
  const proxy = await guestOf(pool.run('throw new Proxy({}, { get() { throw 1 }, ownKeys() { throw 2 }, has() { throw 3 } })', T));
  assert.equal(typeof proxy.message, 'string');
  assert.equal(typeof (await guestOf(pool.run('const r = Proxy.revocable({}, {}); r.revoke(); throw r.proxy', T))).message, 'string');
  const huge = await guestOf(pool.run('throw new Error("x".repeat(1 << 20), { cause: new Error("y".repeat(1 << 20)) })', T));
  assert.ok(huge.message.length <= (64 << 10) + 1);
  assert.ok(huge.cause.message.length <= (8 << 10) + 1);
});

test("isolane's own frames are left out of err.guest, but not the guest's own error.stack", async () => {
  const code = 'new ReadableStream({ start() { throw new Error("in start") } })';
  const g = await guestOf(pool.run(code, T));
  assert.doesNotMatch(g.stack, /ext:|isolane:/);
  assert.ok(g.frames.every((f) => !/^(ext|isolane):/.test(f.file)));
  assert.deepEqual(g.frames.at(-1), { function: null, file: 'acme/eval-1.js', line: 1, column: 1 });
  const inGuest = await pool.run(`try { ${code} } catch (e) { e.stack }`, T);
  assert.match(inGuest, /ext:deno_web\/06_streams\.js/);
});

test("the guest's Error.prepareStackTrace and Error.captureStackTrace still work", async () => {
  const g = await guestOf(pool.run('Error.prepareStackTrace = (e, sites) => `custom ${sites[0].getLineNumber()}`;\nthrow new Error("x")', T));
  assert.equal(g.stack, 'custom 2');
  assert.deepEqual(g.frames, []);
  const captured = await pool.run('const o = {}; function f() { Error.captureStackTrace(o) } f(); o.stack', T);
  assert.match(captured, /at f \(acme\/eval-1\.js:1:36\)/);
});

test('onGuestError: exceptions in timers and unhandled rejections, logged too, without failing the eval', async () => {
  const events = [];
  const logs = [];
  const listened = [];
  const rt = new Runtime({
    strict,
    hooks: {
      onGuestError: (e) => events.push(e),
      onLog: (e) => logs.push(e.message),
    },
  });
  rt.on('guestError', (e) => listened.push(e.kind));
  try {
    assert.equal(await rt.run('setTimeout(() => { throw new RangeError("in timer") }, 1); new Promise((r) => setTimeout(() => r(1), 5))', T), 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'exception');
    assert.equal(events[0].tenant, 'acme');
    assert.equal(events[0].error.name, 'RangeError');
    assert.equal(events[0].error.frames[0].file, 'acme/eval-1.js');
    assert.match(logs[0], /^Uncaught RangeError: in timer\n {4}at acme\/eval-1\.js:1:/);
    assert.doesNotMatch(logs[0], /ext:|isolane:/);

    events.length = 0;
    logs.length = 0;
    assert.equal(await rt.run('Promise.reject(new Error("floating")); 2', T), 2);
    assert.deepEqual(events.map((e) => [e.kind, e.error.message]), [['rejection', 'floating']]);
    assert.match(logs[0], /^Uncaught \(in promise\) Error: floating/);

    // Without the web platform too.
    events.length = 0;
    assert.equal(await rt.run('(async () => { throw new TypeError("async fn") })(); 3', { ...T, web: false }), 3);
    assert.deepEqual(events.map((e) => [e.kind, e.error.name]), [['rejection', 'TypeError']]);

    // Handled within the task, or by an unhandledrejection listener: nothing.
    events.length = 0;
    await rt.run('const p = Promise.reject(new Error("late")); p.catch(() => {}); 4', T);
    await rt.run('addEventListener("unhandledrejection", (e) => e.preventDefault()); Promise.reject(new Error("seen")); 5', T);
    assert.equal(await rt.run('let got; addEventListener("unhandledrejection", (e) => { got = e.reason.message }); Promise.reject(new Error("r")); new Promise((r) => setTimeout(() => r(got), 1))', T), 'r');
    assert.equal(events.length, 1, JSON.stringify(events));

    // The eval's own rejection is its result, not unhandled.
    events.length = 0;
    await assert.rejects(rt.run('Promise.reject(new Error("result"))', T), code('ERR_GUEST_EXCEPTION'));
    await assert.rejects(rt.run('(async () => { throw new Error("result") })()', T), code('ERR_GUEST_EXCEPTION'));
    assert.deepEqual(events, []);

    // Between evals: a stateful isolate's interval.
    events.length = 0;
    const vm = rt.tenant('acme').isolate();
    await vm.eval('let n = 0; setInterval(() => { if (++n === 2) throw new Error("tick 2") }, 1); 0');
    for (let i = 0; i < 100 && events.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    vm.close();
    assert.deepEqual(events.map((e) => [e.kind, e.error.message, e.isolate === vm.id]), [['exception', 'tick 2', true]]);
    assert.ok(listened.includes('exception') && listened.includes('rejection'));
  } finally {
    rt.close();
  }
});

test('onerror and onunhandledrejection: handler attributes on the global object', async () => {
  const events = [];
  const rt = new Runtime({ strict, hooks: { onGuestError: (e) => events.push(e), onLog: () => {} } });
  const wait = 'new Promise((r) => setTimeout(r, 5))';
  try {
    assert.deepEqual(
      await rt.run('[onerror, onunhandledrejection, Object.getOwnPropertyDescriptor(globalThis, "onerror").enumerable]', T),
      [null, null, false],
    );
    // onerror gets HTML's five arguments; returning true handles the error.
    assert.deepEqual(
      await rt.run(
        `let got; onerror = (message, filename, line, column, error) => { got = [message, typeof filename, typeof line, typeof column, error.message]; return true };
         setTimeout(() => { throw new Error("in timer") }, 1); ${wait}.then(() => got)`,
        T,
      ),
      ['Uncaught Error: in timer', 'string', 'number', 'number', 'in timer'],
    );
    assert.deepEqual(events, []);
    // Any other return value leaves it unhandled, and null takes the handler off.
    await rt.run(`let calls = 0; onerror = () => { calls++ }; reportError(new Error("a")); onerror = null; reportError(new Error("b")); calls`, T);
    assert.deepEqual(events.map((e) => [e.kind, e.error.message]), [['exception', 'a'], ['exception', 'b']]);
    // onunhandledrejection gets the event; preventDefault() handles it.
    events.length = 0;
    assert.equal(
      await rt.run(`let got; onunhandledrejection = (e) => { got = e.reason.message; e.preventDefault() }; Promise.reject(new Error("r")); ${wait}.then(() => got)`, T),
      'r',
    );
    assert.equal(await rt.run(`onunhandledrejection = (e) => {}; Promise.reject(new Error("unhandled")); ${wait}.then(() => typeof onunhandledrejection)`, T), 'function');
    assert.deepEqual(events.map((e) => [e.kind, e.error.message]), [['rejection', 'unhandled']]);
    // A value that isn't an object is null, and a handler sits alongside listeners.
    assert.deepEqual(
      await rt.run(`onerror = 5; const a = onerror; let n = 0; addEventListener("error", (e) => { n++; e.preventDefault() }); onerror = () => { n++ }; reportError(1); [a, n]`, T),
      [null, 2],
    );
  } finally {
    rt.close();
  }
});

test('errors nothing handled stay within the console budget', async () => {
  const events = [];
  const logs = [];
  const rt = new Runtime({ strict, hooks: { onGuestError: (e) => events.push(e), onLog: (e) => logs.push(e.message) } });
  try {
    await rt.run('for (let i = 0; i < 10000; i++) Promise.reject(new Error("r" + i + "x".repeat(1000))); 1', {
      ...T,
      limits: { logBytes: 64 << 10, logLineBytes: 2048 },
    });
    const logged = logs.reduce((n, m) => n + m.length, 0);
    assert.ok(logged <= (64 << 10) + 200, `${logged} bytes logged`);
    assert.ok(events.length > 0 && events.length < 100, `${events.length} events`);
    assert.ok(events.every((e) => e.error.message.length <= 2049));
  } finally {
    rt.close();
  }
});
