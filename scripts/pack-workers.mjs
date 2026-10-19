#!/usr/bin/env node
// Assemble the npm packages for a release into npm-out/:
//   npm-out/worker-<target>/   one per built worker binary (@isolane/worker-<target>)
//   npm-out/isolane/           the library, with optionalDependencies on exactly
//                              the platform packages built for this release
//
//   node scripts/pack-workers.mjs <version> <target>=<path/to/isolane-worker> ...
//   e.g. node scripts/pack-workers.mjs 0.1.0 linux-x64-gnu=bin/linux-x64/isolane-worker
//
// Then publish every npm-out/worker-* first, npm-out/isolane last.
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [version, ...builds] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '') || builds.length === 0) {
  console.error('usage: pack-workers.mjs <version> <target>=<binary> ...');
  process.exit(2);
}

// What each target is, for npm's install-time selection.
const TARGETS = {
  'linux-x64-gnu': { os: 'linux', cpu: 'x64', libc: 'glibc', note: '' },
  'linux-arm64-gnu': { os: 'linux', cpu: 'arm64', libc: 'glibc', note: '' },
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', note: ' Development only: macOS has no seccomp or Landlock, so strict mode refuses it.' },
  'darwin-x64': { os: 'darwin', cpu: 'x64', note: ' Development only: macOS has no seccomp or Landlock, so strict mode refuses it.' },
};

const lib = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const common = {
  version,
  license: lib.license,
  repository: lib.repository,
  homepage: lib.homepage,
  bugs: lib.bugs,
};

const out = join(root, 'npm-out');
rmSync(out, { recursive: true, force: true });
const optional = {};

for (const build of builds) {
  const [target, binary] = build.split('=');
  const t = TARGETS[target];
  if (!t || !binary) {
    console.error(`unknown target or missing binary: ${build} (targets: ${Object.keys(TARGETS).join(', ')})`);
    process.exit(2);
  }
  const name = `@isolane/worker-${target}`;
  const dir = join(out, `worker-${target}`);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  copyFileSync(binary, join(dir, 'bin', 'isolane-worker'));
  chmodSync(join(dir, 'bin', 'isolane-worker'), 0o755);
  for (const f of ['LICENSE', 'THIRD_PARTY.md']) copyFileSync(join(root, f), join(dir, f));
  writeFileSync(
    join(dir, 'README.md'),
    `# ${name}\n\nThe isolane worker binary (V8 with its sandbox, plus the process lockdown) for ${target}. Installed automatically as an optional dependency of [isolane](https://www.npmjs.com/package/isolane); you don't depend on it directly.${t.note}\n`,
  );
  const pkg = {
    name,
    ...common,
    description: `isolane's sandboxed V8 worker for ${target}`,
    os: [t.os],
    cpu: [t.cpu],
    ...(t.libc ? { libc: [t.libc] } : {}),
    files: ['bin', 'LICENSE', 'THIRD_PARTY.md'],
    publishConfig: { access: 'public' },
  };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  optional[name] = version;
  console.log(`packed ${name}@${version}`);
}

// The library: the built dist/ plus optionalDependencies on this release's
// platform packages, pinned to the same version.
const libDir = join(out, 'isolane');
mkdirSync(libDir, { recursive: true });
cpSync(join(root, 'dist'), join(libDir, 'dist'), { recursive: true });
for (const f of ['README.md', 'LICENSE', 'THIRD_PARTY.md', 'SECURITY.md']) copyFileSync(join(root, f), join(libDir, f));
const { devDependencies, scripts, ...published } = lib;
void devDependencies;
void scripts;
writeFileSync(
  join(libDir, 'package.json'),
  JSON.stringify({ ...published, version, optionalDependencies: optional, publishConfig: { access: 'public' } }, null, 2) + '\n',
);
console.log(`packed isolane@${version} (workers: ${Object.keys(optional).join(', ')})`);
