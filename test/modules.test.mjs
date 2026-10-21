// Programs of several files (tenant.load({ main, files })): imports
// resolved over the files in the worker, package exports, JSON, text, and
// bytes modules, TypeScript and JSX, source maps, import(), and the
// modules option's aliases and host modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { pool, code, limit } from './helpers.mjs';

const tenant = pool.tenant('modules');
const load = async (t, source, options) => {
  const program = await tenant.load(source, options);
  t.after(() => program.close());
  return program;
};
const guest = (name, pattern) => (err) => code('ERR_GUEST_EXCEPTION')(err) && err.guest?.name === name && pattern.test(err.message);

test('modules import each other, packages resolve by their exports for workers, and data files import', async (t) => {
  const program = await load(t, {
    main: './src/index.js',
    files: {
      'src/index.js': `
        import { add } from './math.js';
        import config from '../config.json';
        import { tag } from 'tagger';
        import sub from 'tagger/sub';
        import readme from './README.md' with { type: 'text' };
        import logo from './logo.bin' with { type: 'bytes' };
        export const sum = (a, b) => add(a, b) + config.base;
        export const tags = () => [tag, sub];
        export const files = () => [readme.trim(), [...logo], import.meta.url];
      `,
      'src/math.js': 'export const add = (a, b) => a + b;',
      'src/README.md': 'hello\n',
      'src/logo.bin': new Uint8Array([1, 2, 255]),
      'config.json': '{ "base": 100 }',
      'node_modules/tagger/package.json': JSON.stringify({
        name: 'tagger',
        exports: {
          '.': { node: './node.js', workerd: './worker.js', default: './default.js' },
          './sub': { browser: './browser.js', default: './default.js' },
        },
      }),
      'node_modules/tagger/node.js': 'export const tag = "node";',
      'node_modules/tagger/worker.js': 'export const tag = "workerd";',
      'node_modules/tagger/default.js': 'export const tag = "default"; export default "default";',
      'node_modules/tagger/browser.js': 'export default "browser";',
    },
  });
  assert.equal(await program.call('sum', [1, 2]), 103);
  assert.deepEqual(await program.call('tags'), ['workerd', 'browser']);
  assert.deepEqual(await program.call('files'), ['hello', [1, 2, 255], 'file:///src/index.js']);
});

test('TypeScript is stripped, and its non-erasable syntax compiles only in transform mode', async (t) => {
  const files = {
    'index.ts': `
      import { double, type Num } from './lib';
      import type { Unused } from './types';
      interface Shape { size: Num }
      export function area(s: Shape): Num { return double(s.size) as Num; }
    `,
    'lib.ts': 'export type Num = number;\nexport const double = (n: number): number => n * 2;\n',
    'types.ts': 'export interface Unused { x: 1 }\n',
  };
  const program = await load(t, { main: 'index.ts', files });
  assert.equal(await program.call('area', [{ size: 4 }]), 8);

  const enums = { main: 'a.ts', files: { 'a.ts': 'const a = 1;\nenum Color { Red, Green }\nexport const green = () => Color.Green;\n' } };
  await assert.rejects(tenant.load(enums), (err) => {
    assert.ok(guest('SyntaxError', /An enum is not erasable TypeScript/)(err), err.message);
    assert.deepEqual([err.guest.location.file, err.guest.location.line, err.guest.location.column], ['a.ts', 2, 1]);
    assert.match(err.message, /mode: 'transform'/);
    return true;
  });
  const transformed = await load(t, enums, { ts: { mode: 'transform' } });
  assert.equal(await transformed.call('green'), 1);
  const decorated = await load(
    t,
    { main: 'a.ts', files: { 'a.ts': 'const seen: string[] = [];\nfunction log(target: any, key: string) { seen.push(key); }\nclass C { @log m() {} }\nexport const keys = () => (new C(), seen);\nexport class P { constructor(private x: number) {} get() { return this.x; } }\nexport const p = () => new P(5).get();\n' } },
    { ts: { mode: 'transform', experimentalDecorators: true } },
  );
  assert.deepEqual(await decorated.call('keys'), ['m']);
  assert.equal(await decorated.call('p'), 5);
  await assert.rejects(tenant.load('1', { ts: { experimentalDecorators: true } }), code('ERR_INVALID_CONFIG'));
});

test('JSX compiles with the automatic runtime from the program\'s own package, or a classic factory', async (t) => {
  const react = {
    'node_modules/react/package.json': JSON.stringify({ name: 'react', exports: { '.': './index.js', './jsx-runtime': './jsx-runtime.js' } }),
    'node_modules/react/jsx-runtime.js': 'export const Fragment = "#fragment"; export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;',
    'node_modules/react/index.js': 'export default {};',
  };
  const automatic = await load(t, {
    main: 'app.tsx',
    files: { ...react, 'app.tsx': 'const Hi = ({ name }: { name: string }) => <b>hi {name}</b>;\nexport const page = () => <><Hi name="ada" /></>;\n' },
  });
  const page = await automatic.call('page');
  assert.equal(page.type, '#fragment');
  assert.equal(page.props.children.props.name, 'ada');

  const classic = await load(
    t,
    { main: 'app.jsx', files: { 'app.jsx': 'const h = (type, props, ...children) => ({ type, props, children });\nexport const el = () => <i a="1">x</i>;\n' } },
    { jsx: { runtime: 'classic', factory: 'h' } },
  );
  assert.deepEqual(await classic.call('el'), { type: 'i', props: { a: '1' }, children: ['x'] });
});

test('define replaces compile-time constants in every module', async (t) => {
  const program = await load(
    t,
    { main: 'a.js', files: { 'a.js': 'import { mode } from "./b.js";\nexport const both = () => [process.env.NODE_ENV, mode, typeof DEBUG];', 'b.js': 'export const mode = __MODE__;' } },
    { define: { 'process.env.NODE_ENV': '"production"', __MODE__: '{"fast":true}', DEBUG: 'false' } },
  );
  assert.deepEqual(await program.call('both'), ['production', { fast: true }, 'boolean']);
  await assert.rejects(tenant.load('1', { define: { 'a-b': '1' } }), code('ERR_INVALID_CONFIG'));
  await assert.rejects(tenant.load('1', { define: { X: 'alert(1)' } }), code('ERR_INVALID_CONFIG'));
});

test('stacks point at the original files: transformed TypeScript, and a bundle with its source map', async (t) => {
  const ts = await load(t, { main: 'src/index.ts', files: { 'src/index.ts': 'type T = { a: number };\n\n\nexport function fail(t: T): never {\n  throw new Error(`bad ${t.a}`);\n}\n' } });
  await assert.rejects(ts.call('fail', [{ a: 1 }]), (err) => {
    assert.equal(err.guest.message, 'bad 1');
    assert.equal(err.guest.frames[0].file, 'src/index.ts');
    assert.equal(err.guest.frames[0].line, 5);
    return true;
  });

  // A bundle and its map: line 2 of the bundle came from src/orig.ts line 7.
  const map = { version: 3, sources: ['../src/orig.ts'], names: [], mappings: 'AAAA;AAMI' };
  for (const files of [
    { 'dist/out.js': 'export function f() {\n  throw new Error("x");\n}\n//# sourceMappingURL=out.js.map', 'dist/out.js.map': JSON.stringify(map) },
    { 'dist/out.js': `export function f() {\n  throw new Error("x");\n}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}` },
    { 'dist/out.js': 'export function f() {\n  throw new Error("x");\n}\n', 'dist/out.js.map': JSON.stringify(map) },
  ]) {
    const bundle = await load(t, { main: 'dist/out.js', files });
    await assert.rejects(bundle.call('f'), (err) => {
      assert.deepEqual([err.guest.frames[0].file, err.guest.frames[0].line, err.guest.frames[0].column], ['src/orig.ts', 7, 5]);
      return true;
    });
  }

  // A syntax error the transform finds, and one V8 finds in transformed code, both in the original file's terms.
  await assert.rejects(tenant.load({ main: 'a.ts', files: { 'a.ts': 'import "./b.ts";', 'b.ts': 'const a: number = 1;\nconst b: number = ;\n' } }), (err) => {
    assert.ok(guest('SyntaxError', /b\.ts:2/)(err), err.message);
    assert.equal(err.guest.location.file, 'b.ts');
    assert.match(err.guest.location.sourceLine, /const b: number = ;/);
    return true;
  });
});

test('imports that resolve to nothing, Node built-ins, and URLs fail the load and say why', async () => {
  const fails = async (files, pattern) => assert.rejects(tenant.load({ main: 'a.js', files: { 'a.js': files } }), guest('TypeError', pattern));
  await fails('import "./missing.js";', /Cannot find module "\.\/missing\.js" imported from a\.js/);
  await fails('import "left-pad";', /Cannot find module "left-pad"/);
  await fails('import fs from "node:fs";', /no Node\.js built-in modules; give the program one with the modules option/);
  await fails('import "https://example.com/x.js";', /Cannot import "https:\/\/example\.com\/x\.js"/);
  await fails('import x from "./a.js" with { type: "css" };', /Import attribute type "css" is not supported/);
  await assert.rejects(tenant.load({ main: 'a.js', files: { 'a.js': 'import d from "./d.json";', 'd.json': '{ nope' } }), (err) => err.guest?.name === 'SyntaxError');
  await assert.rejects(tenant.load({ main: 'nope.js', files: { 'a.js': '' } }), code('ERR_INVALID_CONFIG'));
  await assert.rejects(tenant.load({ main: 'a.js', files: { '../a.js': '' } }), code('ERR_INVALID_CONFIG'));
  await assert.rejects(tenant.load({ main: 'a.js', files: { 'a.js': '' } }, { filename: 'b.js' }), code('ERR_INVALID_CONFIG'));
});

test('import() loads the program\'s other modules, during setup and in calls', async (t) => {
  const program = await load(t, {
    main: 'a.js',
    files: {
      'a.js': 'const early = await import("./b.js");\nexport const first = () => early.n;\nexport const later = async (name) => (await import(`./${name}.js`)).n;\nexport const missing = () => import("./nope.js");',
      'b.js': 'export const n = 1;',
      'c.js': 'export const n = await Promise.resolve(2);',
    },
  });
  assert.equal(await program.call('first'), 1);
  assert.equal(await program.call('later', ['c']), 2);
  await assert.rejects(program.call('missing'), guest('TypeError', /Cannot find module "\.\/nope\.js"/));
  // Scripts outside programs still can't import.
  await assert.rejects(tenant.run('import("./x.js")'), guest('TypeError', /import\(\) works in programs/));
});

test('the modules option aliases specifiers to files or other specifiers, and makes host modules', async (t) => {
  const calls = [];
  const program = await load(
    t,
    {
      main: 'a.js',
      files: {
        'a.js': `
          import fs from 'node:fs';
          import { real } from 'pg';
          import kv, { get } from 'isolane:kv';
          export const run = async () => [fs.readFileSync(), real, await get('a'), await kv.put('b', 2)];
        `,
        'shims/fs.js': 'export default { readFileSync: () => "shimmed" };',
        'node_modules/postgres/package.json': '{ "name": "postgres", "module": "./pg.js" }',
        'node_modules/postgres/pg.js': 'export const real = "postgres";',
      },
    },
    {
      modules: {
        'node:fs': './shims/fs.js',
        pg: 'postgres',
        'isolane:kv': { get: (key) => (calls.push(['get', key]), `value of ${key}`), put: (key, value) => (calls.push(['put', key, value]), true) },
      },
    },
  );
  assert.deepEqual(await program.call('run'), ['shimmed', 'postgres', 'value of a', true]);
  assert.deepEqual(calls, [['get', 'a'], ['put', 'b', 2]]);
  for (const modules of [{ 'isolane:env': './a.js' }, { './x': 'y' }, { x: './missing.js' }, { x: 5 }]) {
    await assert.rejects(tenant.load('1', { modules }), code('ERR_INVALID_CONFIG'), JSON.stringify(modules));
  }
});

test('a host module\'s functions are host calls: no I/O in setup', async () => {
  await assert.rejects(
    tenant.load({ main: 'a.js', files: { 'a.js': 'import { get } from "isolane:kv";\nawait get("x");' } }, { modules: { 'isolane:kv': { get: () => 1 } } }),
    code('ERR_SETUP_IO'),
  );
});

test('cloudflare:sockets gives a postgres.js-style import the Sockets API', async (t) => {
  const server = createServer((socket) => socket.on('data', (d) => socket.end(`pong:${d}`)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();
  const program = await load(
    t,
    {
      main: 'index.js',
      files: {
        'index.js': 'import { ping } from "pgish";\nexport { ping };',
        // As postgres.js's cloudflare build does: import connect from the module, not the global.
        'node_modules/pgish/package.json': JSON.stringify({ name: 'pgish', exports: { workerd: './cf.js', default: './node.js' } }),
        'node_modules/pgish/cf.js': `
          import { connect } from 'cloudflare:sockets';
          export async function ping(port) {
            const socket = connect({ hostname: '127.0.0.1', port });
            const writer = socket.writable.getWriter();
            await writer.write(new TextEncoder().encode('ping'));
            let text = '';
            for await (const chunk of socket.readable) text += new TextDecoder().decode(chunk);
            return text;
          }`,
        'node_modules/pgish/node.js': 'export const ping = () => "node";',
      },
    },
    { connect: { hosts: [`127.0.0.1:${port}`], privateNetworks: true } },
  );
  assert.equal(await program.call('ping', [port]), 'pong:ping');
  const without = await load(t, { main: 'a.js', files: { 'a.js': 'import { connect } from "cloudflare:sockets";\nexport const f = () => connect("x:1");' } });
  await assert.rejects(without.call('f'), guest('TypeError', /without a connect policy/));
});

test('limits.modules and limits.moduleBytes bound a program\'s files', async () => {
  const files = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`m${i}.js`, `export const n = ${i};`]));
  await assert.rejects(tenant.load({ main: 'm0.js', files }, { limits: { modules: 4 } }), limit('modules'));
  await assert.rejects(tenant.load({ main: 'm0.js', files }, { limits: { moduleBytes: 50 } }), limit('moduleBytes'));
  await assert.rejects(tenant.load('1', { limits: { moduleBytes: 1 << 30 } }), code('ERR_INVALID_CONFIG'));
});
