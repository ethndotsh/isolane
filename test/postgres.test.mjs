// postgres.js (its Cloudflare Workers build) from guest code, over
// connect(): the Sockets API against a real Postgres. Needs ISOLANE_WORKER
// and ISOLANE_PG_URL (postgres://user:password@host:port/db); skipped
// without it. With a password, Postgres authenticates with SCRAM-SHA-256,
// which postgres.js does in the guest with crypto.subtle.
//
// Guest code can't import modules yet, so the test bundles postgres.js
// with esbuild, as a Workers deployment would be: `cloudflare:sockets` is
// the global connect(), node:events and node:buffer are the npm
// polyfills, and node:stream (only for COPY and large objects) is a stub.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Runtime } from '../dist/index.js';

const pgUrl = process.env.ISOLANE_PG_URL;
const skip = !pgUrl && 'set ISOLANE_PG_URL to a Postgres database to run';

const runtime = new Runtime({ strict: process.env.ISOLANE_STRICT === '1' });
after(() => runtime.close());

const VIRTUAL = {
  'cloudflare:sockets': 'export const connect = (address, options) => globalThis.connect(address, options);',
  'node:stream': 'export default {};',
};

async function bundle() {
  const { build } = await import('esbuild');
  const out = await build({
    stdin: { contents: "import postgres from 'postgres'; globalThis.postgres = postgres;", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'import'],
    mainFields: ['module', 'main'],
    alias: { 'node:events': 'events', 'node:buffer': 'buffer' },
    logLevel: 'silent',
    plugins: [
      {
        name: 'virtual',
        setup(b) {
          b.onResolve({ filter: /^(cloudflare:sockets|node:stream)$/ }, (args) => ({ path: args.path, namespace: 'virtual' }));
          b.onLoad({ filter: /.*/, namespace: 'virtual' }, (args) => ({ contents: VIRTUAL[args.path], loader: 'js' }));
        },
      },
    ],
  });
  return out.outputFiles[0].text;
}

test('postgres.js queries Postgres from a guest', { skip }, async () => {
  const url = new URL(pgUrl);
  const port = Number(url.port || 5432);
  const library = await bundle();
  const out = await runtime.run(
    `${library}
     (async () => {
       const sql = postgres(${JSON.stringify(pgUrl)}, { max: 1, ssl: false });
       try {
         await sql\`create temporary table notes (id serial primary key, body text not null)\`;
         await sql\`insert into notes (body) values (\${'hello'}), (\${'from a guest ✓'})\`;
         const rows = await sql\`select id, body from notes order by id\`;
         const [{ sum }] = await sql\`select \${2}::int + \${40}::int as sum\`;
         return { rows: rows.map((r) => [r.id, r.body]), sum };
       } finally {
         await sql.end();
       }
     })()`,
    {
      tenant: 'postgres',
      web: true,
      connect: { hosts: [`${url.hostname}:${port}`], privateNetworks: true },
      limits: { timeoutMs: 20_000 },
    },
  );
  assert.deepEqual(out, { rows: [[1, 'hello'], [2, 'from a guest ✓']], sum: 42 });
});

test('the connect policy still decides', { skip }, async () => {
  const library = await bundle();
  await assert.rejects(
    runtime.run(
      `${library}
       (async () => {
         const sql = postgres(${JSON.stringify(pgUrl)}, { max: 1, ssl: false, connect_timeout: 5 });
         try { await sql\`select 1\`; } finally { await sql.end({ timeout: 0 }); }
       })()`,
      { tenant: 'postgres', web: true, connect: { hosts: ['db.example.com:5432'] } },
    ),
    /not allowed by the connect policy/,
  );
});
