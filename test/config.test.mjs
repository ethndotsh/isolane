// Isolate config: time, randomness, eval, wasm, globals, policies, and layering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../dist/index.js';
import { pool, T, code, isolate, strict } from './helpers.mjs';

test('the clock is frozen while guest code runs', { skip: process.env.ISOLANE_DEV_INSECURE === '1' && 'the dev build has no clock patch' }, async () => {
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
  const host = { wait: () => new Promise((r) => setTimeout(r, 50)) };
  const elapsed = await pool.run('(async () => { const t0 = Date.now(); await wait(); return Date.now() - t0; })()', {
    ...T,
    host,
  });
  assert.ok(elapsed >= 40, `clock moved ${elapsed}ms across a 50ms host call`);
  const vm = isolate(T);
  const t0 = await vm.eval('globalThis.t0 = Date.now()');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok((await vm.eval('Date.now()')) - t0 >= 40);
  vm.close();
});

test('time: real and fixed', { skip: process.env.ISOLANE_DEV_INSECURE === '1' && 'the dev build has no clock patch' }, async () => {
  const elapsed = await pool.run('const t0 = Date.now(); let x = 0; for (let i = 0; i < 3e7; i++) x += i; Date.now() - t0', {
    ...T,
    time: 'real',
  });
  assert.ok(elapsed > 0, `realtime clock didn't move over a busy loop (${elapsed}ms)`);
  const host = { wait: () => new Promise((r) => setTimeout(r, 20)) };
  const vm = isolate({ ...T, time: { fixedMs: 1e12 }, host });
  assert.equal(await vm.eval('Date.now()'), 1e12);
  assert.equal(await vm.eval('wait().then(() => new Date().toISOString())'), new Date(1e12).toISOString());
  vm.close();
  assert.throws(() => isolate({ ...T, time: 'sometimes' }), code('ERR_INVALID_CONFIG'));
});

test('random.seed makes Math.random reproducible', async () => {
  const draw = '[Math.random(), Math.random(), Math.random()]';
  const a = await pool.run(draw, { ...T, random: { seed: 7 } });
  const b = await pool.run(draw, { ...T, random: { seed: 7 } });
  const c = await pool.run(draw, { ...T, random: { seed: 8 } });
  const d = await pool.run(draw, T);
  const e = await pool.run(draw, T);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.notDeepEqual(d, e);
  assert.throws(() => isolate({ ...T, random: { seed: -1 } }), code('ERR_INVALID_CONFIG'));
});

test('eval: true opts in to eval and new Function', async () => {
  const opts = { ...T, eval: true };
  assert.equal(await pool.run('eval("1 + 1") + new Function("return 2")()', opts), 4);
  assert.equal(await pool.run('typeof WebAssembly', opts), 'undefined');
});

test('fetch and fs policies reach the guest through the worker', async () => {
  const server = createServer((req, res) => res.end(JSON.stringify({ path: req.url })));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'isolane-root-'));
  writeFileSync(join(dir, 'a.txt'), 'from disk');
  try {
    const url = `http://localhost:${server.address().port}/hi`;
    const fetch = { hosts: ['localhost'], privateNetworks: true };
    assert.deepEqual(await pool.run(`fetch('${url}').then((r) => r.json())`, { ...T, fetch }), { path: '/hi' });
    assert.equal(await pool.run(`fs.readFile('/a.txt', 'utf8')`, { ...T, fs: { root: dir } }), 'from disk');
    assert.deepEqual(
      await pool.run('[typeof fetch, typeof fs, typeof __isolane_fetch, typeof __isolane_fs]', { ...T, fetch, fs: { root: dir } }),
      ['function', 'object', 'undefined', 'undefined'],
    );
    await assert.rejects(pool.run(`fetch('${url}')`, { ...T, fetch: { hosts: ['localhost'] } }), /no public address/);
    await assert.rejects(pool.run(`fs.writeFile('/b.txt', 'x')`, { ...T, fs: { root: dir } }), /read-only/);
  } finally {
    server.close();
  }
});

test('globals pass inputs without touching the code string', async () => {
  const input = { name: 'O\'Brien"); throw 1; //', n: 41 };
  assert.deepEqual(await pool.run('[input.name, input.n + 1]', { ...T, globals: { input } }), [input.name, 42]);
  // They can't replace built-ins: ECMAScript's are refused up front, the
  // web platform's when the isolate starts.
  for (const name of ['Object', 'JSON', 'undefined', 'console', 'WebAssembly']) {
    await assert.rejects(pool.run('1', { ...T, globals: { [name]: 1 } }), (e) => e.code === 'ERR_INVALID_CONFIG' && /would replace a built-in global/.test(e.message), name);
  }
  for (const name of ['TextEncoder', 'fetch', 'URL']) {
    await assert.rejects(pool.run('1', { ...T, globals: { [name]: 1 } }), /globals\.\w+ would replace a built-in global/, name);
  }
  assert.equal(await pool.run('typeof TextEncoder', { ...T, web: false, globals: { TextEncoder: 'mine' } }), 'string');
});

test('tenant config layers: defaults, tenants(name), the call', async () => {
  const layered = new Runtime({
    strict: process.env.ISOLANE_STRICT === '1',
    defaults: { globals: { d: 'yes' } },
    tenants: (name) => (name === 'acme' ? { globals: { a: 1 }, host: { two: () => 2 } } : undefined),
  });
  const acme = layered.tenant('acme');
  assert.equal(await acme.run('two().then((t) => a + t + b + d)', { globals: { b: 3 } }), '6yes');
  const vm = acme.isolate();
  await vm.eval('globalThis.k = a');
  assert.equal(await vm.eval('k'), 1);
  vm.close();
  assert.equal(await layered.tenant('other').run('typeof a + d'), 'undefinedyes');
  layered.close();
});

test('wasm: true opts in to WebAssembly', async () => {
  // (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
  const wasm = [0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11];
  const code = 'WebAssembly.instantiate(new Uint8Array(bytes)).then(({ instance }) => instance.exports.add(2, 3))';
  assert.equal(await pool.run(code, { ...T, wasm: true, globals: { bytes: wasm } }), 5);
  await assert.rejects(pool.run(code, { ...T, globals: { bytes: wasm } }), /WebAssembly is not defined/);
});

test('wasm: true still gives no shared memory (no SharedArrayBuffer through WebAssembly)', async () => {
  // (module (memory (export "m") 1 1 shared))
  const shared = [0, 97, 115, 109, 1, 0, 0, 0, 5, 4, 1, 3, 1, 1, 7, 5, 1, 1, 109, 2, 0];
  const result = await pool.run(`(async () => {
    const bytes = new Uint8Array(shared);
    const name = (f) => { try { const v = f(); return v instanceof Promise ? v.then(() => 'ok', (e) => e.name) : 'ok'; } catch (e) { return e.name; } };
    return {
      sab: typeof SharedArrayBuffer,
      memory: name(() => new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })),
      viaPrototype: name(() => new WebAssembly.Memory.prototype.constructor({ initial: 1, maximum: 1, shared: true })),
      plainMemory: name(() => new WebAssembly.Memory({ initial: 1 })),
      instance: name(() => new WebAssembly.Instance(new WebAssembly.Module(bytes))),
      viaInstancePrototype: name(() => new WebAssembly.Instance.prototype.constructor(new WebAssembly.Module(bytes))),
      instantiate: await name(() => WebAssembly.instantiate(bytes)),
      instantiateModule: await name(() => WebAssembly.instantiate(new WebAssembly.Module(bytes))),
      // Compiling is fine: only an instance's exports could hand out the memory.
      compile: await name(() => WebAssembly.compile(bytes)),
      // Nor does a promise's then or constructor lookup see an unchecked instance.
      leaked: await (async () => {
        const seen = [];
        const look = (v) => { try { const m = v?.exports?.m ?? v?.instance?.exports?.m; if (m) seen.push(m.buffer); } catch {} };
        Object.defineProperty(Object.prototype, 'then', { configurable: true, get() { look(this); return undefined; } });
        Object.defineProperty(Promise.prototype, 'constructor', { configurable: true, get() { seen.push('promise'); return Promise; } });
        try {
          await WebAssembly.instantiate(bytes).catch(() => {});
          await WebAssembly.instantiate(new WebAssembly.Module(bytes)).catch(() => {});
        } finally {
          delete Object.prototype.then;
          Object.defineProperty(Promise.prototype, 'constructor', { value: Promise, writable: true, configurable: true });
        }
        return seen.filter((v) => v !== 'promise' ).length;
      })(),
    };
  })()`, { ...T, wasm: true, globals: { shared } });
  assert.deepEqual(result, {
    sab: 'undefined',
    memory: 'TypeError',
    viaPrototype: 'TypeError',
    plainMemory: 'ok',
    instance: 'TypeError',
    viaInstancePrototype: 'TypeError',
    instantiate: 'TypeError',
    instantiateModule: 'TypeError',
    compile: 'ok',
    leaked: 0,
  });
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
      fetch: { hosts: ['api.example.com'] },
    }),
    [true, true],
  );
});

test('limits out of the range the worker can hold are config errors, not worker crashes', async () => {
  const rt = new Runtime({ strict: process.env.ISOLANE_STRICT === '1' });
  const events = [];
  rt.on('securityEvent', (e) => events.push(e.kind));
  const code = (limits) => rt.run('1 + 1', { tenant: 'ranges', limits }).then(() => 'ran', (e) => e.code);
  for (const limits of [
    { timers: 2 ** 32 },
    { heapBytes: 2 ** 50 },
    { timeoutMs: 2 ** 53 - 1 },
    { cpuMs: 2 ** 53 - 1 },
    { backgroundMs: 2 ** 31 },
    { decompressedBytes: 1.5 },
  ]) {
    assert.equal(await code(limits), 'ERR_INVALID_CONFIG', JSON.stringify(limits));
  }
  // The largest allowed values work.
  assert.equal(await code({ timers: 2 ** 32 - 1, timeoutMs: 2 ** 31 - 1, cpuMs: 2 ** 31 - 1, heapBytes: 4 * 1024 ** 3 }), 'ran');
  assert.deepEqual(events, []);
  rt.close();
});

test('config errors name the field, and old names say what to use instead', () => {
  const message = (f) => {
    try {
      f();
    } catch (e) {
      return [e.code, e.message];
    }
  };
  const t = pool.tenant('acme');
  assert.deepEqual(message(() => t.isolate({ timeoutMs: 5 })), ['ERR_INVALID_CONFIG', 'isolane: timeoutMs is not a config field; use limits.timeoutMs']);
  assert.deepEqual(message(() => t.isolate({ hostFunctions: {} })), ['ERR_INVALID_CONFIG', 'isolane: hostFunctions is not a config field; use host']);
  assert.deepEqual(message(() => t.isolate({ limits: { cpuTimeMs: 5 } })), ['ERR_INVALID_CONFIG', 'isolane: limits.cpuTimeMs is now limits.cpuMs']);
  assert.deepEqual(message(() => t.isolate({ fetch: { allow: [] } })), ['ERR_INVALID_CONFIG', 'isolane: fetch.allow is not a fetch policy field (fields: hosts, methods, privateNetworks, limits)']);
  assert.deepEqual(message(() => t.isolate({ fetch: true })), ['ERR_INVALID_CONFIG', 'isolane: fetch needs a policy object (there is no safe default target list)']);
  assert.deepEqual(message(() => t.isolate({ fs: { root: '/x', limits: { maxFileBytes: 1 } } })), ['ERR_INVALID_CONFIG', 'isolane: fs.limits.maxFileBytes is not a fs limit (limits: fileBytes)']);
  assert.deepEqual(message(() => t.isolate({ random: { seed: -1 } })), ['ERR_INVALID_CONFIG', 'isolane: random.seed must be an integer from 0 to 2^53 - 1']);
  assert.deepEqual(message(() => t.isolate({ time: 'realtime' })), ['ERR_INVALID_CONFIG', "isolane: time must be 'frozen', 'real', or { fixedMs }"]);
  assert.deepEqual(message(() => t.isolate({ limits: { isolates: 2 } })), ['ERR_INVALID_CONFIG', 'isolane: limits.isolates is a tenant limit; set it in defaults.limits or tenants(name).limits']);
  assert.deepEqual(message(() => new Runtime({ prewarm: 1 })), ['ERR_INVALID_CONFIG', 'isolane: prewarm is not a Runtime option; use spares']);
  assert.deepEqual(message(() => new Runtime({ defaults: { web: { baseUrl: 'ftp://x/' } } })), ['ERR_INVALID_CONFIG', 'isolane: defaults.web.baseUrl must be an absolute http: or https: URL']);
  assert.deepEqual(message(() => new Runtime({ tenants: () => ({ nope: 1 }) }).tenant('x').isolate()), ['ERR_INVALID_CONFIG', 'isolane: tenants("x").nope is not a config field']);
});
