// The fs broker's confinement to its root, tested on the broker directly
// (no worker needed). The race test needs Linux, where paths are walked
// from held directory descriptors (ts/fs-root.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fsBroker } from '../dist/capabilities.js';

const linux = process.platform === 'linux';
const decode = (bytes) => new TextDecoder().decode(bytes);

function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'isolane-confine-'));
  const root = join(tmp, 'root');
  const out = join(tmp, 'outside');
  mkdirSync(join(root, 'dir', 'sub'), { recursive: true });
  mkdirSync(out);
  writeFileSync(join(root, 'dir', 'a.txt'), 'inside');
  writeFileSync(join(out, 'secret'), 'top secret');
  symlinkSync('dir/a.txt', join(root, 'rel')); // stays inside
  symlinkSync(join(root, 'dir'), join(root, 'abs')); // absolute, inside
  symlinkSync('../outside/secret', join(root, 'up')); // climbs out
  symlinkSync(out, join(root, 'away')); // absolute, outside
  symlinkSync('loop2', join(root, 'loop1'));
  symlinkSync('loop1', join(root, 'loop2'));
  return { tmp, root, out };
}

test('fs confinement: symlinks are followed only while they stay inside the root', async () => {
  const { tmp, root, out } = fixture();
  const denials = [];
  const fs = fsBroker({ root, write: true }, (api, target, reason) => denials.push(reason));
  try {
    assert.equal(decode(await fs('readFile', '/rel')), 'inside');
    assert.equal(decode(await fs('readFile', '/abs/a.txt')), 'inside');
    assert.deepEqual(await fs('readdir', '/abs'), ['a.txt', 'sub']);
    assert.equal((await fs('stat', '/abs/sub')).isDirectory, true);
    await assert.rejects(fs('readFile', '/up'), /outside the root/);
    await assert.rejects(fs('readdir', '/away'), /outside the root/);
    await assert.rejects(fs('writeFile', '/away/planted', new Uint8Array([1])), /outside the root/);
    await assert.rejects(fs('mkdir', '/away/a/b', true), /outside the root/);
    await assert.rejects(fs('writeFile', '/rel', new Uint8Array([1])), /symbolic link/); // never written through
    await assert.rejects(fs('readFile', '/loop1'), /symbolic link/);
    assert.equal(await fs('exists', '/up'), false);
    assert.ok(denials.every((r) => r === 'outside the root') && denials.length >= 4, denials.join());
    // Removing a symlink removes the link, not what it points to.
    await fs('rm', '/away');
    assert.equal(existsSync(join(out, 'secret')), true);
    // Ordinary writes, nested directories, and recursive removal.
    await fs('mkdir', '/new/x/y', true);
    await fs('writeFile', '/new/x/y/f.txt', new TextEncoder().encode('ünï'));
    assert.equal(readFileSync(join(root, 'new/x/y/f.txt'), 'utf8'), 'ünï');
    symlinkSync(out, join(root, 'new', 'x', 'escape'));
    await fs('rm', '/new', true);
    assert.equal(existsSync(join(root, 'new')), false);
    assert.deepEqual(readdirSync(out), ['secret']); // the symlink inside was removed, not followed
    // Error messages name guest paths only.
    const message = await fs('readFile', '/up').catch((e) => e.message);
    assert.ok(!message.includes(tmp), message);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Flip /d between a real directory and a symlink to outside while the
// broker writes and reads through it. With resolve-then-open, a write lands
// outside whenever the flip falls between the two.
test('fs confinement: a symlink swapped in mid-operation never redirects outside', { skip: !linux }, async () => {
  const { tmp, root, out } = fixture();
  const fs = fsBroker({ root, write: true });
  const flipper = new Worker(
    `const { workerData: { root, out }, parentPort } = require('node:worker_threads');
     const fs = require('node:fs');
     const d = root + '/d';
     const stop = new Int32Array(new SharedArrayBuffer(4));
     parentPort.postMessage(stop);
     while (!Atomics.load(stop, 0)) {
       try { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d); fs.writeFileSync(d + '/secret', 'inside'); } catch {}
       try { fs.rmSync(d, { recursive: true, force: true }); fs.symlinkSync(out, d); } catch {}
     }`,
    { eval: true, workerData: { root, out } },
  );
  const stop = await new Promise((resolve) => flipper.once('message', resolve));
  const bytes = new TextEncoder().encode('planted');
  let wrote = 0;
  let read = 0;
  try {
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      await fs('writeFile', `/d/planted`, bytes).then(() => wrote++, () => {});
      await fs('readFile', '/d/secret').then((b) => {
        read++;
        assert.notEqual(decode(b), 'top secret'); // '' or 'inside', depending on where the flip is
      }, (e) => assert.doesNotMatch(String(e), /top secret/));
    }
  } finally {
    Atomics.store(stop, 0, 1);
    await flipper.terminate();
  }
  try {
    assert.deepEqual(readdirSync(out), ['secret'], 'a write landed outside the root');
    assert.equal(readFileSync(join(out, 'secret'), 'utf8'), 'top secret');
    assert.ok(wrote > 0 && read > 0, `the race never let an operation through (${wrote} writes, ${read} reads)`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
