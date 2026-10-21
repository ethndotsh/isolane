// What a tenant's worker keeps for its next isolates: programs' files (sent
// once per worker), V8 code caches of their modules, compiled
// WebAssembly, and spare isolates made ahead of their VMs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../dist/index.js';
import { pool, code, limit, strict } from './helpers.mjs';

/** Load `source` with fresh instances (each call loads one), noting each load's `modules`. */
async function fresh(t, tenant, source, options = {}) {
  const loads = [];
  const off = pool.on('programLoad', (e) => {
    if (e.tenant === tenant) loads.push(e.modules);
  });
  const program = await pool.tenant(tenant).load(source, { ...options, instances: { reuse: false, max: 1 } });
  t.after(() => {
    off();
    return program.close();
  });
  return { program, loads };
}

test('later instances compile a program\'s modules from the code cache the first made', async (t) => {
  const files = {
    'index.js': "import { add } from './math.js'; import { tag } from './tag.ts'; export const f = (a, b) => tag + add(a, b);",
    'math.js': 'export const add = (a, b) => a + b;',
    'tag.ts': "export const tag: string = 'sum ';",
  };
  const { program, loads } = await fresh(t, 'cache-a', { main: 'index.js', files });
  assert.equal(await program.call('f', [1, 2]), 'sum 3');
  assert.equal(await program.call('f', [2, 2]), 'sum 4');
  assert.deepEqual(loads[0], { compiled: 3, cached: 0, rejected: 0 });
  assert.deepEqual(loads.at(-1), { compiled: 3, cached: 3, rejected: 0 });

  // Another program of the same files on the same worker finds the caches;
  // a changed file, a file moved to another path, and the same TypeScript
  // under other transform options don't.
  const again = await fresh(t, 'cache-a', { main: 'index.js', files });
  assert.deepEqual(again.loads[0], { compiled: 3, cached: 3, rejected: 0 });
  const changed = await fresh(t, 'cache-a', { main: 'index.js', files: { ...files, 'math.js': 'export const add = (a, b) => a + b + 0;' } });
  assert.deepEqual(changed.loads[0], { compiled: 3, cached: 2, rejected: 0 });
  assert.equal(await changed.program.call('f', [1, 2]), 'sum 3');
  const moved = await fresh(t, 'cache-a', { main: 'main.js', files: { 'main.js': files['index.js'], 'math.js': files['math.js'], 'tag.ts': files['tag.ts'] } });
  assert.deepEqual(moved.loads[0], { compiled: 3, cached: 2, rejected: 0 });
  const transformed = await fresh(t, 'cache-a', { main: 'index.js', files }, { ts: { mode: 'transform' } });
  assert.deepEqual(transformed.loads[0], { compiled: 3, cached: 2, rejected: 0 });
});

test('code caches stay with their tenant\'s worker', async (t) => {
  const source = 'export const f = () => "mine";';
  const a = await fresh(t, 'cache-mine', source);
  await a.program.call('f');
  await a.program.call('f');
  assert.equal(a.loads.at(-1).cached, 1);
  const b = await fresh(t, 'cache-theirs', source);
  assert.deepEqual(b.loads[0], { compiled: 1, cached: 0, rejected: 0 });
});

test('a worker keeps programs\' files within its budget, and is sent them again once it let them go', async (t) => {
  // Three programs of 24 MB each: the worker keeps 64 MB, so loading the
  // third has it forget the first, which is sent again when it loads.
  const big = (tag) => `export const tag = () => ${JSON.stringify(tag)};\n/*${'x'.repeat(24 << 20)}*/`;
  const tenant = pool.tenant('cache-trees');
  const programs = [];
  for (const tag of ['one', 'two', 'three']) {
    const program = await tenant.load(big(tag), { instances: { reuse: false, max: 1 }, limits: { moduleBytes: 32 << 20 } });
    programs.push(program);
    t.after(() => program.close());
  }
  for (const [i, tag] of ['one', 'two', 'three', 'one'].entries()) {
    assert.equal(await programs[i % 3].call('tag'), tag);
    assert.equal(await programs[i % 3].call('tag'), tag);
  }
});

test('a loaded program\'s files don\'t change when the caller\'s bytes do', async (t) => {
  const data = new TextEncoder().encode('before');
  const program = await pool.tenant('cache-bytes').load(
    { main: 'index.js', files: { 'index.js': "import d from './d.txt' with { type: 'text' }; export const f = () => d;", 'd.txt': data } },
    { instances: { reuse: false } },
  );
  t.after(() => program.close());
  data.set(new TextEncoder().encode('after!'));
  assert.equal(await program.call('f'), 'before');
  assert.equal(await program.call('f'), 'before');
});

test('WebAssembly compiled in one isolate is reused by the next, and its API is unchanged', async () => {
  // (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
  const bytes = [0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11];
  const config = { tenant: 'cache-wasm', wasm: true, globals: { bytes } };
  const code = `(async () => {
    const b = new Uint8Array(bytes);
    const m = new WebAssembly.Module(b);
    const viaCompile = await WebAssembly.compile(b);
    const { instance, module } = await WebAssembly.instantiate(b);
    const fromModule = await WebAssembly.instantiate(m);
    return [
      m instanceof WebAssembly.Module, viaCompile instanceof WebAssembly.Module, module instanceof WebAssembly.Module,
      WebAssembly.Module.exports(m).map((e) => e.name + ':' + e.kind).join(),
      WebAssembly.Module.imports(m).length, WebAssembly.Module.customSections(m, 'x').length,
      WebAssembly.Module.name, WebAssembly.Module.length, m.constructor === WebAssembly.Module,
      instance.exports.add(2, 3), fromModule.exports.add(4, 5), new WebAssembly.Instance(viaCompile).exports.add(1, 1),
    ];
  })()`;
  const expected = [true, true, true, 'add:function', 0, 0, 'Module', 1, true, 5, 9, 2];
  assert.deepEqual(await pool.run(code, config), expected);
  assert.deepEqual(await pool.run(code, config), expected);
  await assert.rejects(pool.run('WebAssembly.Module()', config), /must be invoked with 'new'/);
});

test('spare isolates: fresh web isolates start from one, with their own config', async (t) => {
  assert.throws(() => new Runtime({ spareIsolates: 9 }), code('ERR_INVALID_CONFIG'));
  assert.throws(() => new Runtime({ spareIsolates: -1 }), code('ERR_INVALID_CONFIG'));
  const rt = new Runtime({ strict, spareIsolates: 2 });
  t.after(() => rt.close());
  const tenant = rt.tenant('spares');
  for (let i = 0; i < 5; i++) {
    assert.equal(await tenant.run('[typeof URL, typeof globalThis.n, globalThis.n = 1][0]'), 'function');
  }
  assert.equal(await tenant.run('location.href', { web: { baseUrl: 'https://a.example/x' } }), 'https://a.example/x');
  assert.equal(await tenant.run('typeof URL', { web: false }), 'undefined');
  // A seeded VM makes its own isolate (V8 draws an isolate's entropy as it
  // makes it), so its randomness is still the seed's.
  const seeded = () => tenant.run('[Math.random(), crypto.getRandomValues(new Uint32Array(1))[0]]', { random: { seed: 7 } });
  assert.deepEqual(await seeded(), await seeded());
  // A spare made for one heap limit isn't used for another; each VM's limit holds.
  const fill = 'const a = []; for (;;) a.push({ x: "y".repeat(1000) + Math.random() })';
  for (const heapBytes of [16 << 20, 16 << 20, 24 << 20, 16 << 20]) {
    await assert.rejects(tenant.run(fill, { limits: { heapBytes } }), limit('heapBytes'));
    assert.equal(await tenant.run('1 + 1', { limits: { heapBytes } }), 2);
  }
  // Programs' instances take them too.
  const program = await tenant.load('export const f = () => typeof Response;', { instances: { reuse: false } });
  t.after(() => program.close());
  for (let i = 0; i < 3; i++) assert.equal(await program.call('f'), 'function');
});
