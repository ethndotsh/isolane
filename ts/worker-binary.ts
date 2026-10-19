// Finding the worker binary: `$ISOLANE_WORKER` if set, else the platform
// package npm installed alongside isolane (one of its optionalDependencies;
// npm picks the one whose os/cpu/libc match this machine).

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** The platform package for this machine, e.g. `@isolane/worker-linux-x64-gnu`. */
export function platformPackage(platform = process.platform, arch = process.arch, libc = detectLibc()): string | undefined {
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64') && libc === 'gnu') return `@isolane/worker-linux-${arch}-gnu`;
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) return `@isolane/worker-darwin-${arch}`;
  return undefined;
}

function detectLibc(): 'gnu' | 'musl' | undefined {
  if (process.platform !== 'linux') return undefined;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime ? 'gnu' : 'musl';
}

/** The worker binary to run, or an explanation of why there isn't one. */
export function resolveWorkerBinary(): { path: string } | { error: string } {
  const fromEnv = process.env.ISOLANE_WORKER;
  if (fromEnv) return { path: fromEnv };
  const pkg = platformPackage();
  if (!pkg) {
    return {
      error: `isolane has no worker binary for ${process.platform}-${process.arch}${detectLibc() === 'musl' ? ' (musl)' : ''}; supported: Linux x64/arm64 (glibc), macOS x64/arm64 (development only). Set ISOLANE_WORKER to use your own build.`,
    };
  }
  try {
    const require = createRequire(import.meta.url);
    const path = join(dirname(require.resolve(`${pkg}/package.json`)), 'bin', 'isolane-worker');
    if (existsSync(path)) return { path };
    return { error: `${pkg} is installed but has no binary at ${path}` };
  } catch {
    return {
      error: `isolane's worker package ${pkg} isn't installed. It's an optional dependency: reinstall without --no-optional / --omit=optional, or set ISOLANE_WORKER.`,
    };
  }
}
