// A program's source and the options that shape its modules: which files
// it has, what TypeScript and JSX become, compile-time constants, and the
// specifiers it resolves differently (aliases, overrides, and host
// modules). Checked here; resolving and transforming happen in the worker.

import { invalidConfig } from './errors.js';
import { flattenHost, type HostEntry, type HostTree } from './host.js';
import type { ProgramFiles } from './program.js';
import type { ModuleOptionsWire } from './worker.js';

/** A program of several files: `main` is the entry, a path in `files`. */
export interface ProgramSource {
  main: string;
  /** Files by path (`src/index.ts`, `node_modules/pkg/package.json`): text, or bytes. */
  files: Readonly<Record<string, string | Uint8Array>>;
}

/** How TypeScript files become JavaScript. */
export interface TsOptions {
  /**
   * `strip` (the default): remove types, refusing syntax with runtime
   * behaviour (enums, namespaces with values, parameter properties), as
   * Node.js does. `transform`: compile that syntax too.
   */
  mode?: 'strip' | 'transform';
  /** Legacy decorators (TypeScript's `experimentalDecorators`), in transform mode. */
  experimentalDecorators?: boolean;
  /** With `experimentalDecorators`: TypeScript's `emitDecoratorMetadata`. */
  emitDecoratorMetadata?: boolean;
}

/** How JSX (in `.jsx` and `.tsx` files) is compiled. */
export interface JsxOptions {
  /** `automatic` (the default): calls imported from `<importSource>/jsx-runtime`. `classic`: calls to `factory`. */
  runtime?: 'automatic' | 'classic';
  /** The automatic runtime's package, resolved in the program's files. Default `react`. */
  importSource?: string;
  /** The classic runtime's element and fragment factories. Default `React.createElement` and `React.Fragment`. */
  factory?: string;
  fragment?: string;
  /** The development runtime (`jsx-dev-runtime`). Default false. */
  development?: boolean;
}

/** The module options of `tenant.load()`. */
export interface ModuleLoadOptions {
  /**
   * Specifiers resolved to something else: a file of the program
   * (`'node:fs': './shims/fs.js'`), another specifier (`pg: 'postgres'`),
   * or an object of host functions, a module the guest imports them from
   * (`'isolane:kv': { get, put }`: `import { get } from 'isolane:kv'`).
   */
  modules?: Record<string, string | HostTree>;
  ts?: TsOptions;
  jsx?: JsxOptions;
  /**
   * Compile-time constants, as esbuild's `define`: an identifier or member
   * expression (`process.env.NODE_ENV`), and what replaces it, which is
   * JSON (`'"production"'`) or an identifier or member expression.
   */
  define?: Record<string, string>;
}

/** What `load` sends for the program, and the host modules' functions. */
export interface ResolvedModules {
  main: string;
  files: Readonly<ProgramFiles>;
  options: ModuleOptionsWire;
  hostModules: { specifier: string; entries: HostEntry[] }[];
}

const PATH_MAX = 1024;
const MEMBER = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

/** A file path as the program names it: `./src/a.ts` is `src/a.ts`. */
function programPath(path: unknown, where: string): string {
  if (typeof path !== 'string' || path === '' || path.length > PATH_MAX) throw invalidConfig(where, `must be a non-empty string of at most ${PATH_MAX} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) throw invalidConfig(where, 'must not contain control characters or backslashes');
  const clean = path.replace(/^(\.\/)+/, '');
  if (clean.startsWith('/') || clean.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw invalidConfig(where, 'must be a relative path without empty, `.`, or `..` segments (src/index.ts)');
  }
  if (/^(ext|isolane):/.test(clean)) throw invalidConfig(where, "must not start with ext: or isolane: (isolane's own scripts)");
  return clean;
}

/** `source` (one module's code, or `{ main, files }`) and the module options, checked. */
export function resolveModules(source: unknown, filename: string | undefined, options: ModuleLoadOptions): ResolvedModules {
  let main: string;
  const files: ProgramFiles = Object.create(null);
  if (typeof source === 'string') {
    main = filename === undefined ? 'main.js' : programPath(filename, 'filename');
    files[main] = source;
  } else if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    if (filename !== undefined) throw invalidConfig('filename', 'is for a single-module source; name the main module with source.main');
    const s = source as Partial<ProgramSource>;
    for (const key of Object.keys(s)) if (key !== 'main' && key !== 'files') throw invalidConfig(`source.${key}`, 'is not a source field (main, files)');
    if (s.files === null || typeof s.files !== 'object' || Array.isArray(s.files)) throw invalidConfig('source.files', 'must be an object of files by path');
    for (const [path, content] of Object.entries(s.files)) {
      const clean = programPath(path, `source.files[${JSON.stringify(path)}]`);
      if (typeof content !== 'string' && !(content instanceof Uint8Array)) {
        throw invalidConfig(`source.files[${JSON.stringify(path)}]`, 'must be a string or a Uint8Array');
      }
      if (clean in files) throw invalidConfig(`source.files[${JSON.stringify(path)}]`, `names the same file as another path (${clean})`);
      // Bytes are copied: a loaded program's files don't change.
      files[clean] = typeof content === 'string' ? content : new Uint8Array(content);
    }
    main = programPath(s.main, 'source.main');
    if (!(main in files)) throw invalidConfig('source.main', `must be one of source.files (${JSON.stringify(main)} isn't)`);
  } else {
    throw invalidConfig('source', "must be a module's code (a string) or { main, files }");
  }

  const wire: ModuleOptionsWire = {};
  const hostModules: { specifier: string; entries: HostEntry[] }[] = [];
  if (options.modules !== undefined) {
    if (options.modules === null || typeof options.modules !== 'object' || Array.isArray(options.modules)) throw invalidConfig('modules', 'must be an object of specifiers');
    const aliases: NonNullable<ModuleOptionsWire['aliases']> = {};
    for (const [specifier, target] of Object.entries(options.modules)) {
      const where = `modules[${JSON.stringify(specifier)}]`;
      if (specifier === '' || specifier.length > PATH_MAX) throw invalidConfig(where, `must name a specifier of 1 to ${PATH_MAX} characters`);
      if (specifier === 'isolane:env' || specifier.startsWith('isolane:runtime/')) throw invalidConfig(where, "is isolane's own module");
      if (/^\.{0,2}\//.test(specifier)) throw invalidConfig(where, 'must be a bare specifier or a scheme (pg, node:fs, isolane:kv), not a path');
      if (typeof target === 'string') {
        if (/^\.{0,2}\//.test(target)) {
          const path = programPath(target, where);
          if (!(path in files)) throw invalidConfig(where, `names ${JSON.stringify(path)}, which isn't one of the program's files`);
          aliases[specifier] = { file: path };
        } else {
          if (target === '' || target.length > PATH_MAX) throw invalidConfig(where, `must be a path (./x.js) or a specifier of 1 to ${PATH_MAX} characters`);
          aliases[specifier] = { specifier: target };
        }
      } else {
        const entries = flattenHost(target, where).map((entry) => ({ ...entry, name: `${specifier}.${entry.name}` }));
        hostModules.push({ specifier, entries });
        aliases[specifier] = 'host';
      }
    }
    wire.aliases = aliases;
  }
  if (options.ts !== undefined) {
    const ts = checkObject(options.ts, 'ts', ['mode', 'experimentalDecorators', 'emitDecoratorMetadata']);
    if (ts.mode !== undefined && ts.mode !== 'strip' && ts.mode !== 'transform') throw invalidConfig('ts.mode', "must be 'strip' or 'transform'");
    for (const key of ['experimentalDecorators', 'emitDecoratorMetadata'] as const) {
      if (ts[key] !== undefined && typeof ts[key] !== 'boolean') throw invalidConfig(`ts.${key}`, 'must be a boolean');
    }
    if ((ts.experimentalDecorators || ts.emitDecoratorMetadata) && ts.mode !== 'transform') {
      throw invalidConfig('ts.experimentalDecorators', "needs ts.mode 'transform' (decorators are compiled, not stripped)");
    }
    wire.ts = { mode: ts.mode as TsOptions['mode'], decorators: ts.experimentalDecorators as boolean | undefined, emitDecoratorMetadata: ts.emitDecoratorMetadata as boolean | undefined };
  }
  if (options.jsx !== undefined) {
    const jsx = checkObject(options.jsx, 'jsx', ['runtime', 'importSource', 'factory', 'fragment', 'development']);
    if (jsx.runtime !== undefined && jsx.runtime !== 'automatic' && jsx.runtime !== 'classic') throw invalidConfig('jsx.runtime', "must be 'automatic' or 'classic'");
    if (jsx.importSource !== undefined && (typeof jsx.importSource !== 'string' || jsx.importSource === '' || jsx.importSource.length > PATH_MAX)) {
      throw invalidConfig('jsx.importSource', 'must be a package name');
    }
    for (const key of ['factory', 'fragment'] as const) {
      if (jsx[key] !== undefined && (typeof jsx[key] !== 'string' || !MEMBER.test(jsx[key] as string))) throw invalidConfig(`jsx.${key}`, 'must be an identifier or member expression (React.createElement)');
    }
    if (jsx.development !== undefined && typeof jsx.development !== 'boolean') throw invalidConfig('jsx.development', 'must be a boolean');
    wire.jsx = jsx as NonNullable<ModuleOptionsWire['jsx']>;
  }
  if (options.define !== undefined) {
    const define = checkObject(options.define, 'define');
    wire.define = Object.entries(define).map(([key, value]) => {
      const where = `define[${JSON.stringify(key)}]`;
      if (!MEMBER.test(key)) throw invalidConfig(where, 'must be an identifier or member expression (process.env.NODE_ENV)');
      if (typeof value !== 'string' || !(MEMBER.test(value) || isJson(value))) {
        throw invalidConfig(where, 'must be JSON (\'"production"\', 1, true, {...}) or an identifier or member expression, as a string');
      }
      return [key, value];
    });
  }
  return { main, files: Object.freeze(files), options: wire, hostModules };
}

function checkObject(value: unknown, where: string, keys?: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidConfig(where, 'must be an object');
  if (keys) for (const key of Object.keys(value)) if (!keys.includes(key)) throw invalidConfig(`${where}.${key}`, `is not a ${where} field (fields: ${keys.join(', ')})`);
  return value as Record<string, unknown>;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
