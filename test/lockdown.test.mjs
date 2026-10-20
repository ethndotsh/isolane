// Process lockdown (Linux). Needs a native Linux kernel: under emulation
// such as Rosetta, seccomp filters don't behave like on real hardware.
//   ISOLANE_WORKER         release worker; checks the isolation report
//   ISOLANE_ESCAPE_WORKER  worker built with --features escape-tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { Runtime } from '../dist/index.js';

const linux = process.platform === 'linux';
const escapeWorker = process.env.ISOLANE_ESCAPE_WORKER;

test('the host provides strict-mode isolation', { skip: !linux || !process.env.ISOLANE_WORKER }, async () => {
  const report = await new Runtime().isolationReport();
  assert.equal(report.sandboxSecure, true);
  assert.equal(report.lockdown.seccomp, 'full');
  assert.notEqual(report.lockdown.landlock, 'none');
  assert.equal(report.meetsStrict, true);
});

test('a serving worker holds no files or sockets, only its pipes', { skip: !linux || !process.env.ISOLANE_WORKER }, async () => {
  // A file or socket open at lockdown would stay usable through read and
  // write, which seccomp allows: the worker must have none.
  const rt = new Runtime();
  await rt.run('1', { tenant: 'fds', web: true });
  const pid = rt.diagnostics.workerPid('fds');
  const fds = readdirSync(`/proc/${pid}/fd`).map((fd) => [fd, readlinkSync(`/proc/${pid}/fd/${fd}`)]);
  const unix = new Set(readFileSync('/proc/self/net/unix', 'utf8').split('\n').slice(1).map((line) => line.trim().split(/\s+/)[6]));
  rt.close();
  // stdin, stdout, and stderr are what spawn() made: pipes, or, from libuv,
  // connected Unix socket pairs to the supervisor (same network namespace,
  // so they show in our own table). Nothing else may be a file or socket,
  // and nothing inherited survives past stderr.
  const stdio = ([fd, target]) => Number(fd) <= 2 && (/^pipe:/.test(target) || (/^socket:\[(\d+)\]$/.test(target) && unix.has(target.slice(8, -1))));
  const unexpected = fds.filter((e) => !stdio(e) && !/^anon_inode:/.test(e[1]));
  assert.deepEqual(unexpected, [], JSON.stringify(fds));
  assert.ok(fds.some(([fd]) => fd === '0') && fds.some(([fd]) => fd === '1'));
});

const probe = (name) => spawnSync(escapeWorker, ['--escape-test', name], { env: {}, encoding: 'utf8', timeout: 30_000 });

for (const name of ['socket', 'execve', 'ptrace', 'fork', 'clone-namespace', 'clone-unshared', 'prctl-dumpable']) {
  test(`seccomp kills the worker on ${name}`, { skip: !linux || !escapeWorker }, () => {
    const r = probe(name);
    assert.match(r.stdout, /LOCKED/, `lockdown did not complete: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /SURVIVED/);
    assert.equal(r.signal, 'SIGSYS');
  });
}

test('seccomp refuses opening files with EACCES', { skip: !linux || !escapeWorker }, () => {
  const r = probe('open');
  assert.match(r.stdout, /DENIED/, `${r.stdout} ${r.stderr}`);
  assert.equal(r.status, 0);
});

test('clone3 is refused with ENOSYS (threads fall back to clone)', { skip: !linux || !escapeWorker }, () => {
  const r = probe('clone3');
  assert.match(r.stdout, /ENOSYS/, r.stderr);
  assert.equal(r.status, 0);
});

test('prctl options outside the allowlist are refused with EPERM; thread names still work', { skip: !linux || !escapeWorker }, () => {
  const r = probe('prctl-other');
  assert.match(r.stdout, /EPERM/, `${r.stdout} ${r.stderr}`);
  assert.equal(r.status, 0);
});

test('Landlock alone denies filesystem access', { skip: !linux || !escapeWorker }, () => {
  const r = probe('landlock-open');
  assert.match(r.stdout, /DENIED/, `${r.stdout} ${r.stderr}`);
  assert.equal(r.status, 0);
});
