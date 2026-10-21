// What the conformance gates share (test/wpt/run.mjs, test/test262/run.mjs):
// their arguments, the pinned sparse checkout, a runtime that notes worker
// crashes, lanes of runs, classified reasons, and the reports.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Runtime } from '../dist/index.js';

/**
 * The command line: `opt(name)` takes an option's value, `has(name)` a
 * flag, and `rest()` refuses whatever's left.
 */
export function args(argv = process.argv.slice(2)) {
  argv = [...argv];
  return {
    opt: (name) => {
      const i = argv.indexOf(name);
      return i < 0 ? undefined : argv.splice(i, 2)[1];
    },
    has: (name) => {
      const i = argv.indexOf(name);
      return i >= 0 && argv.splice(i, 1).length > 0;
    },
    rest: () => {
      if (!argv.length) return;
      console.error(`unknown arguments: ${argv.join(' ')}`);
      process.exit(2);
    },
  };
}

/** Retry `f` with backoff: git hosts return transient errors. */
export function retry(what, f) {
  for (let attempt = 1; ; attempt++) {
    try {
      return f();
    } catch (e) {
      if (attempt === 5) throw e;
      console.error(`${what} failed (attempt ${attempt}); retrying in ${attempt * 20}s`);
      execFileSync('sleep', [String(attempt * 20)]);
    }
  }
}

/**
 * A sparse checkout of `repo` at `commit` in `root`, cloned unless `marker`
 * (a file every checkout has) is there, and extended with the `paths` an
 * existing checkout wasn't made with (a directory can exist with only the
 * single files an earlier list named in it).
 */
export function sparseCheckout({ name, repo, commit, root, paths, marker }) {
  if (!existsSync(join(root, marker))) {
    retry(`cloning ${name}`, () => {
      execFileSync('rm', ['-rf', root]);
      execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', repo, root]);
    });
    execFileSync('git', ['-C', root, 'sparse-checkout', 'set', '--no-cone', ...paths]);
    retry(`checking out ${name}`, () => execFileSync('git', ['-C', root, 'checkout', '-q', commit]));
    return;
  }
  const have = new Set(execFileSync('git', ['-C', root, 'sparse-checkout', 'list'], { encoding: 'utf8' }).split('\n'));
  const missing = paths.filter((d) => !have.has(d));
  if (missing.length) retry(`extending the ${name} checkout`, () => execFileSync('git', ['-C', root, 'sparse-checkout', 'add', ...missing]));
}

/**
 * A runtime for a gate: strict when CI asks, never quarantining a tenant
 * (a crash is a result, not a reason to stop), and noting crashes.
 * `crashed(tenant, mark)` describes a crash of `tenant`'s since `mark()`.
 */
export function gateRuntime(options = {}) {
  const crashes = [];
  const runtime = new Runtime({
    strict: process.env.ISOLANE_STRICT === '1',
    quarantineMs: null,
    ...options,
    hooks: { onSecurityEvent: (e) => crashes.push(e) },
  });
  const crashed = (tenant, mark) => {
    const crash = crashes.slice(mark).find((c) => c.tenant === tenant);
    return crash && `${crash.kind}: ${crash.detail ?? ''}`.slice(0, 300);
  };
  return { runtime, mark: () => crashes.length, crashed };
}

/** Run every run on `concurrency` lanes, `runOne(run, lane)` each; `done(run, result)` as each finishes. */
export async function inLanes(runs, concurrency, runOne, done) {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, lane) => {
      while (next < runs.length) {
        const run = runs[next++];
        done(run, await runOne(run, lane));
      }
    }),
  );
}

/** What --update gives a new failure, which the gate refuses until a person classifies it. */
export const UNCLASSIFIED = { category: 'unclassified', reason: 'New since the last update: read the test and classify it.' };

/**
 * The problems that fail a gate, and the checks both gates make. A reason
 * needs one of the gate's categories and an explanation.
 */
export function problems(categories) {
  const list = [];
  const problem = (kind, key, detail) => list.push({ kind, key, detail });
  return {
    list,
    problem,
    commit: (path, theirs, ours, what) => {
      if (theirs !== ours) problem('commit', path, `expectations are for ${what} ${theirs}, the runner pins ${ours}`);
    },
    reasons: (reasons) => {
      for (const [id, r] of Object.entries(reasons)) {
        if (id === 'unclassified') continue;
        if (!categories.includes(r.category) || !r.reason) problem('reason', id, `reason "${id}" needs a category (${categories.join(', ')}) and a reason`);
      }
    },
  };
}

export const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');

/** Summary lines listing a gate's problems, or saying there are none. */
export function problemLines(list, { none, limit = 50 }) {
  if (!list.length) return [none];
  const lines = [`**${list.length} problems** (the gate fails):`, ''];
  for (const p of list.slice(0, limit)) lines.push(`- ${p.kind}: \`${p.key}\`${p.detail ? ` — ${p.detail}` : ''}`);
  if (list.length > limit) lines.push(`- … and ${list.length - limit} more (see the JSON report)`);
  return lines;
}

/**
 * Write the JSON report and the Markdown summary where the command line
 * asked (`append` adds to a summary file shared with other steps), and
 * print the summary.
 */
export function writeReports({ reportPath, report, summaryPath, lines, append = false }) {
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  const markdown = lines.join('\n') + '\n';
  if (summaryPath) writeFileSync(summaryPath, markdown, append ? { flag: 'a' } : undefined);
  console.log(markdown);
}
