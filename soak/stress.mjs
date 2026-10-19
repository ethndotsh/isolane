// Operational stress: what a hostile or merely heavy tenant does to the
// host. Linux only (reads /proc). Each scenario has hard caps so it stops
// before the machine does; the report says where things degraded.
//   node soak/stress.mjs [scenario ...]
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Runtime } from '../dist/index.js';

const MB = 1 << 20;
const strict = process.env.ISOLANE_STRICT === '1';
const events = [];
const newPool = (o = {}) => new Runtime({ strict, hooks: { onSecurityEvent: (e) => events.push(e) }, ...o });

const status = (pid) => {
  try {
    const s = readFileSync(`/proc/${pid}/status`, 'utf8');
    const f = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(s)?.[1] ?? NaN);
    return { rssMB: Math.round(f('VmRSS') / 1024), threads: f('Threads') };
  } catch {
    return { rssMB: NaN, threads: NaN };
  }
};
const fds = () => readdirSync('/proc/self/fd').length;
const zombies = () => {
  try {
    return execFileSync('ps', ['--ppid', String(process.pid), '-o', 'stat='], { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('Z')).length;
  } catch {
    return 0;
  }
};
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2) : null;
};
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const now = () => process.hrtime.bigint();
const sleep = (t) => new Promise((r) => setTimeout(r, t));

const scenarios = {
  // How many VMs can one tenant hold? Each is an isolate plus two threads.
  async vmFlood() {
    const pool = newPool();
    const vms = [];
    const steps = [];
    let failure = null;
    try {
      while (vms.length < 3000) {
        const t0 = now();
        const batch = Array.from({ length: 100 }, () => pool.tenant('flood').isolate());
        vms.push(...batch);
        await Promise.all(batch.map((vm) => vm.eval('globalThis.x = new Array(1000).fill(1); 1')));
        const st = status(pool.diagnostics.workerPid('flood'));
        steps.push({ vms: vms.length, batchMs: +ms(t0).toFixed(0), ...st });
        if (st.rssMB > 4096 || ms(t0) > 30000) break;
      }
    } catch (e) {
      failure = `${e.code ?? ''} ${e.message}`.slice(0, 300);
    }
    pool.close();
    return { reached: vms.length, failure, steps: steps.filter((_, i) => i % 3 === 2 || i === steps.length - 1) };
  },

  // Many tenants at once: one process each.
  async tenantFlood() {
    const pool = newPool();
    const n = 150;
    const cold = [];
    const t0 = now();
    const results = await Promise.allSettled(
      Array.from({ length: n }, async (_, i) => {
        const t = now();
        await pool.run('1', { tenant: `t${i}` });
        cold.push(ms(t));
      }),
    );
    const wall = ms(t0);
    let rss = 0;
    for (let i = 0; i < n; i++) rss += status(pool.diagnostics.workerPid(`t${i}`)).rssMB || 0;
    pool.close();
    return {
      tenants: n,
      failed: results.filter((r) => r.status === 'rejected').length,
      wallMs: +wall.toFixed(0),
      coldStartP50Ms: pct(cold, 50),
      coldStartP99Ms: pct(cold, 99),
      totalWorkerRssMB: rss,
      perTenantRssMB: +(rss / n).toFixed(1),
    };
  },

  // Workers dying over and over: does the supervisor leak fds or zombies?
  async crashChurn() {
    // These kills are ours, not the tenant's: no quarantine.
    const pool = newPool({ quarantineMs: null });
    const fd0 = fds();
    let ok = 0;
    for (let i = 0; i < 300; i++) {
      await pool.run('1', { tenant: 'churn' });
      ok++;
      process.kill(pool.diagnostics.workerPid('churn'), 'SIGKILL');
      await sleep(5);
    }
    await sleep(500);
    const r = { cycles: ok, fdsBefore: fd0, fdsAfter: fds(), zombies: zombies(), supervisorHeapMB: Math.round(process.memoryUsage().heapUsed / MB) };
    pool.close();
    return r;
  },

  // Create and dispose VMs repeatedly: do isolates and threads get freed?
  async vmCycleLeak() {
    const pool = newPool();
    await pool.run('1', { tenant: 'cycle' });
    const pid = pool.diagnostics.workerPid('cycle');
    const samples = [{ cycles: 0, ...status(pid) }];
    for (let i = 1; i <= 3000; i++) {
      await pool.run('new Array(10000).fill(Math.random()).length', { tenant: 'cycle' });
      if (i % 1000 === 0) {
        await sleep(200);
        samples.push({ cycles: i, ...status(pid) });
      }
    }
    pool.close();
    return { samples };
  },

  // One long-lived VM, many evals that allocate: does its memory plateau?
  async evalLeak() {
    const pool = newPool();
    const vm = pool.tenant('leak').isolate({ limits: { heapBytes: 256 * MB } });
    await vm.eval('1');
    const pid = pool.diagnostics.workerPid('leak');
    const samples = [{ evals: 0, ...status(pid) }];
    for (let i = 1; i <= 20000; i++) {
      await vm.eval('({ a: new Array(200).fill(Math.random()), s: "x".repeat(1000) }).a.length');
      if (i % 5000 === 0) samples.push({ evals: i, ...status(pid) });
    }
    vm.close();
    pool.close();
    return { samples };
  },

  // A tenant burning CPU with back-to-back timeouts: how much does it slow
  // a quiet tenant (separate process) and a quiet VM in the same worker?
  async noisyNeighbor() {
    const pool = newPool();
    const quietOther = pool.tenant('quiet').isolate();
    const quietSame = pool.tenant('noisy').isolate();
    await Promise.all([quietOther.eval('1'), quietSame.eval('1')]);
    const probe = async (vm, out, until) => {
      while (Date.now() < until) {
        const t = now();
        await vm.eval('1');
        out.push(ms(t));
        await sleep(20);
      }
    };
    const baseline = [];
    await probe(quietOther, baseline, Date.now() + 2000);
    const until = Date.now() + 10000;
    const other = [];
    const same = [];
    let timeouts = 0;
    const hogs = Array.from({ length: 8 }, async () => {
      const vm = pool.tenant('noisy').isolate({ limits: { timeoutMs: 200 } });
      while (Date.now() < until) await vm.eval('for (;;) {}').catch(() => timeouts++);
      vm.close();
    });
    await Promise.all([...hogs, probe(quietOther, other, until), probe(quietSame, same, until)]);
    pool.close();
    return {
      hogVms: 8,
      hogTimeouts: timeouts,
      baselineP50Ms: pct(baseline, 50),
      baselineP99Ms: pct(baseline, 99),
      otherTenantP50Ms: pct(other, 50),
      otherTenantP99Ms: pct(other, 99),
      sameWorkerP50Ms: pct(same, 50),
      sameWorkerP99Ms: pct(same, 99),
    };
  },

  // Many VMs hitting their heap limit at once.
  async memoryBomb() {
    const pool = newPool();
    const n = 20;
    const t0 = now();
    let peak = 0;
    const sampler = setInterval(() => (peak = Math.max(peak, status(pool.diagnostics.workerPid('bomb')).rssMB || 0)), 50);
    const results = await Promise.allSettled(
      Array.from({ length: n }, () => pool.run('const a = []; for (;;) a.push(new Array(1e5).fill(1));', { tenant: 'bomb', limits: { heapBytes: 64 * MB, timeoutMs: 20000 } })),
    );
    clearInterval(sampler);
    const codes = {};
    for (const r of results) codes[r.reason?.code ?? 'ok'] = (codes[r.reason?.code ?? 'ok'] ?? 0) + 1;
    const after = await pool.run('1', { tenant: 'bomb' }).then(() => 'worker still serving', (e) => e.code);
    pool.close();
    return { vms: n, heapLimitMB: 64, codes, peakWorkerRssMB: peak, wallMs: +ms(t0).toFixed(0), after };
  },
};

const pickNames = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios);
const report = {};
for (const name of pickNames) {
  const t0 = now();
  const before = events.length;
  try {
    report[name] = await scenarios[name]();
  } catch (e) {
    report[name] = { error: String(e?.stack ?? e).slice(0, 500) };
  }
  report[name].seconds = +(ms(t0) / 1000).toFixed(1);
  const evs = events.slice(before).filter((e) => !(name === 'crashChurn' && e.signal === 'SIGKILL'));
  if (evs.length) report[name].securityEvents = evs.slice(0, 5).map((e) => `${e.kind} ${e.detail}`.slice(0, 200));
  process.stderr.write(`${name}: ${JSON.stringify(report[name]).slice(0, 400)}\n`);
}
console.log(JSON.stringify(report, null, 2));
