// The WebSocket protocol between a deployer and the platform, as schemas.
// Everything a deployer sends is untrusted input to the platform, so it's
// parsed with these before anything acts on it; the types come from the
// same schemas.

import { z } from 'zod';

/** App names appear in URLs and tenant names. */
export const AppName = z.string().regex(/^[a-z0-9-]{1,40}$/, 'lowercase letters, digits, and dashes, up to 40');

const HostName = z.string().regex(/^[A-Za-z_$][\w$]*$/, 'a JavaScript identifier');

/** A file's path in the app: relative, without `.` or `..` segments. */
const FilePath = z.string().regex(/^(?!\.{1,2}(\/|$))[\w-]+(\.[\w-]+)*(\/[\w-]+(\.[\w-]+)*)*$/, 'a relative path like src/index.ts');

// ---- deployer → platform ----

export const Deploy = z.object({
  type: z.literal('deploy'),
  app: AppName,
  /** The app's files by path (TypeScript as it is: the worker strips its types), and which one is its entry. */
  files: z
    .record(FilePath, z.string())
    .refine((files) => Object.keys(files).length <= 100, 'at most 100 files')
    .refine((files) => Object.values(files).reduce((n, code) => n + code.length, 0) <= 4 << 20, 'at most 4 MiB of code'),
  main: FilePath,
  /** Host functions the deployer serves; the app calls them on `env` (`import { env } from 'isolane:env'`). */
  hostFunctions: z.array(HostName).max(100),
  /** Hosts the app may fetch from. */
  fetchHosts: z.array(z.string()).max(50).default([]),
});

export const Reply = z.discriminatedUnion('ok', [
  // A host function that returns undefined replies with no `value`.
  z.object({ type: z.literal('reply'), id: z.number().int(), ok: z.literal(true), value: z.unknown().optional() }),
  z.object({ type: z.literal('reply'), id: z.number().int(), ok: z.literal(false), error: z.string() }),
]);

export const FromDeployer = z.union([Deploy, Reply]);

export type Deploy = z.infer<typeof Deploy>;
export type FromDeployer = z.infer<typeof FromDeployer>;

// ---- platform → deployer (trusted, so types only) ----

export type ToDeployer =
  | { type: 'deployed'; app: string; url: string }
  | { type: 'error'; message: string }
  | { type: 'call'; id: number; name: string; args: unknown[] }
  | { type: 'cancel'; id: number }
  | { type: 'log'; level: string; message: string };
