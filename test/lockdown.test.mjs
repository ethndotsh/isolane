// Process lockdown (Linux). Needs a native Linux kernel: under emulation
// such as Rosetta, seccomp filters don't behave like on real hardware.
//   ISOLANE_WORKER         release worker; checks the isolation report
//   ISOLANE_ESCAPE_WORKER  worker built with --features escape-tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { LanePool } from '../dist/index.js';

const linux = process.platform === 'linux';
const escapeWorker = process.env.ISOLANE_ESCAPE_WORKER;

test('the host provides strict-mode isolation', { skip: !linux || !process.env.ISOLANE_WORKER }, async () => {
  const report = await new LanePool().isolationReport();
  assert.equal(report.sandboxSecure, true);
  assert.equal(report.lockdown.seccomp, 'full');
  assert.notEqual(report.lockdown.landlock, 'none');
  assert.equal(report.meetsStrict, true);
});

const probe = (name) => spawnSync(escapeWorker, ['--escape-test', name], { env: {}, encoding: 'utf8', timeout: 30_000 });

for (const name of ['open', 'socket', 'execve', 'ptrace', 'fork']) {
  test(`seccomp kills the worker on ${name}`, { skip: !linux || !escapeWorker }, () => {
    const r = probe(name);
    assert.match(r.stdout, /LOCKED/, `lockdown did not complete: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /SURVIVED/);
    assert.equal(r.signal, 'SIGSYS');
  });
}

test('clone3 is refused with ENOSYS (threads fall back to clone)', { skip: !linux || !escapeWorker }, () => {
  const r = probe('clone3');
  assert.match(r.stdout, /ENOSYS/, r.stderr);
  assert.equal(r.status, 0);
});

test('Landlock alone denies filesystem access', { skip: !linux || !escapeWorker }, () => {
  const r = probe('landlock-open');
  assert.match(r.stdout, /DENIED/, `${r.stdout} ${r.stderr}`);
  assert.equal(r.status, 0);
});
