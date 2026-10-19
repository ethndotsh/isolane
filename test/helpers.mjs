// Shared by the end-to-end tests. They need ISOLANE_WORKER pointing at a
// built isolane-worker binary; ISOLANE_STRICT=1 runs them under strict mode
// (CI on native Linux), ISOLANE_DEV_INSECURE=1 against a dev build.
import { after } from 'node:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime, IsolaneError } from '../dist/index.js';

export const strict = process.env.ISOLANE_STRICT === '1';

export const pool = new Runtime({ strict: process.env.ISOLANE_STRICT === '1' });
after(() => pool.close());
export const T = { tenant: 'acme' };
export const code = (c) => (err) => err instanceof IsolaneError && err.code === c;
export const limit = (name) => (err) => err instanceof IsolaneError && err.code === 'ERR_LIMIT' && err.limit === name;
// A stateful isolate for `{ tenant, ...config }`.
export const isolateOf = (rt, { tenant, ...config }) => rt.tenant(tenant).isolate(config);
export const isolate = (config) => isolateOf(pool, config);

// Fake workers are Node scripts. (They crash with abort(): Node absorbs a
// self-sent SIGSEGV, since it installs a handler for WebAssembly traps.)
export function fakeWorker(body) {
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
