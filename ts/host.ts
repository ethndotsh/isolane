// Host functions: what guest code can call. A `host` tree maps names to
// functions, and nested objects to namespaces (`{ db: { getUser } }` is
// `db.getUser(1)` in the guest). A bare function is async in the guest and
// unchecked; `hostFunction({ args, returns, handler, sync })` adds Standard
// Schema validation (guest arguments are untrusted), sync calls, and the
// call context as the handler's last parameter. Every function gets the
// context as `this` too.

import { invalidConfig } from './errors.js';
import { describeIssues, isStandardSchema, validate, type StandardSchemaV1 } from './schema.js';
import type { LogLevel } from './worker.js';

type Awaitable<T> = T | Promise<T>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySchema = StandardSchemaV1<any, any>;

/** What a host function knows about the call. */
export interface HostContext {
  readonly tenant: string;
  /** The calling isolate's id. */
  readonly isolate: number;
  /**
   * Aborts when nobody is waiting any more: the eval that made the call
   * hit its time or CPU limit, the isolate closed, or the worker exited.
   */
  readonly signal: AbortSignal;
  /** Log through the hook system (`onLog`, with `source: 'host'`). */
  log(level: LogLevel, ...args: unknown[]): void;
}

/** A bare host function: async in the guest, arguments unchecked, the context as `this`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HostFunction = (this: HostContext, ...args: any[]) => unknown;

type MapOutputs<A extends readonly AnySchema[]> = {
  -readonly [K in keyof A]: A[K] extends AnySchema ? StandardSchemaV1.InferOutput<A[K]> : never;
};
/** The handler's parameters: one per `args` schema then the context, or the whole-list schema's output. */
type HandlerArgs<A> = A extends readonly AnySchema[]
  ? [...MapOutputs<A>, HostContext]
  : A extends AnySchema
    ? StandardSchemaV1.InferOutput<A> extends readonly unknown[]
      ? StandardSchemaV1.InferOutput<A>
      : never
    : // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any[];
type ReturnOf<R> = R extends AnySchema ? StandardSchemaV1.InferInput<R> : unknown;

const DEFINITION = Symbol.for('isolane.hostFunction');

/**
 * A host function with options. Arguments come from untrusted guest code:
 * with `args`, they're validated before `handler` runs (the guest gets a
 * TypeError, code `ERR_INVALID_ARGUMENTS`, instead), and `handler` gets the
 * schemas' output, so defaults and transforms apply. A result that fails
 * `returns` never reaches the guest (it gets an Error, code
 * `ERR_INVALID_RETURN`).
 */
export interface HostFunctionDefinition<A extends readonly AnySchema[] | AnySchema | undefined = undefined, R extends AnySchema | undefined = undefined> {
  /**
   * Does the work. With per-position `args`, it gets exactly those
   * arguments and then the call context; otherwise the guest's arguments
   * (the context is `this` either way).
   */
  handler: (this: HostContext, ...args: HandlerArgs<A>) => Awaitable<ReturnOf<R>>;
  /** One schema per positional argument, or one schema for the whole argument list. */
  args?: A;
  /** The result's schema. */
  returns?: R;
  /** Call synchronously from the guest: it gets the result directly, not a Promise (its isolate waits, within `timeoutMs`). */
  sync?: boolean;
}

/** Define a host function, with its parameter types inferred from its schemas. */
export function hostFunction<const A extends readonly AnySchema[] | AnySchema | undefined = undefined, R extends AnySchema | undefined = undefined>(
  definition: HostFunctionDefinition<A, R>,
): HostFunctionDefinition<A, R> {
  checkDefinition(definition, 'hostFunction()');
  return Object.freeze({ ...definition, [DEFINITION]: true }) as HostFunctionDefinition<A, R>;
}

/** Functions and namespaces by name. */
export interface HostTree {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [name: string]: HostFunction | HostFunctionDefinition<any, any> | HostTree;
}

/** One host function, flattened from a tree. */
export interface HostEntry {
  /** Dotted for namespaces: `db.getUser`. */
  readonly name: string;
  readonly path: readonly string[];
  readonly sync: boolean;
  /** isolane's own brokers (fetch, connect, fs): hooks don't see them. */
  readonly internal: boolean;
  /** Validate, call, validate. Returns the result, or a Promise of it. */
  readonly run: (ctx: HostContext, args: unknown[]) => unknown;
}

function checkDefinition(def: unknown, path: string): void {
  const d = def as Partial<HostFunctionDefinition<readonly AnySchema[] | AnySchema | undefined, AnySchema | undefined>> & Record<string, unknown>;
  if (typeof d.handler !== 'function') throw invalidConfig(`${path}.handler`, 'must be a function');
  for (const key of Object.keys(d)) {
    if (!['handler', 'args', 'returns', 'sync'].includes(key)) {
      throw invalidConfig(`${path}.${key}`, 'is not a hostFunction field (fields: handler, args, returns, sync)');
    }
  }
  const argsOk = d.args === undefined || isStandardSchema(d.args) || (Array.isArray(d.args) && d.args.every(isStandardSchema));
  if (!argsOk) throw invalidConfig(`${path}.args`, 'must be a Standard Schema, or a list of them (one per argument)');
  if (d.returns !== undefined && !isStandardSchema(d.returns)) throw invalidConfig(`${path}.returns`, 'must be a Standard Schema');
  if (d.sync !== undefined && typeof d.sync !== 'boolean') throw invalidConfig(`${path}.sync`, 'must be a boolean');
}

const invalidArguments = (name: string, issues: string) =>
  Object.assign(new TypeError(`${name}: invalid arguments: ${issues}`), { code: 'ERR_INVALID_ARGUMENTS' });

function wrapDefinition(name: string, def: HostFunctionDefinition<readonly AnySchema[] | AnySchema | undefined, AnySchema | undefined>) {
  const { args, returns } = def;
  const handler = def.handler as (this: HostContext, ...a: unknown[]) => unknown;
  const perPosition = Array.isArray(args);
  if (args === undefined && returns === undefined) return (ctx: HostContext, raw: unknown[]) => handler.apply(ctx, raw);
  return async (ctx: HostContext, raw: unknown[]) => {
    let input: unknown[] = raw;
    if (perPosition) {
      const schemas = args as readonly AnySchema[];
      input = [];
      const problems: string[] = [];
      for (let i = 0; i < Math.max(schemas.length, raw.length); i++) {
        if (i >= schemas.length) {
          problems.push(`args.${i}: unexpected argument (takes ${schemas.length})`);
          continue;
        }
        const r = await validate(schemas[i], raw[i]);
        if (r.ok) input.push(r.value);
        else problems.push(describeIssues(r.issues, `args.${i}`));
      }
      if (problems.length) throw invalidArguments(name, problems.join('; '));
      input.push(ctx);
    } else if (args !== undefined) {
      const r = await validate(args as AnySchema, raw);
      if (!r.ok) throw invalidArguments(name, describeIssues(r.issues, 'args'));
      if (!Array.isArray(r.value)) throw invalidArguments(name, 'the args schema must produce an array');
      input = r.value;
    }
    const value = await handler.apply(ctx, input);
    if (returns === undefined) return value;
    const r = await validate(returns, value);
    if (!r.ok) {
      throw Object.assign(new Error(`${name} returned a value that doesn't match its returns schema`), { code: 'ERR_INVALID_RETURN' });
    }
    return r.value;
  };
}

const NAME = /^[A-Za-z_$][\w$]*$/;
const cache = new WeakMap<object, HostEntry[]>();

/** A tree's functions, with their paths. Throws ERR_INVALID_CONFIG naming the field. */
export function flattenHost(tree: unknown, where: string): HostEntry[] {
  if (tree === null || typeof tree !== 'object' || Array.isArray(tree)) throw invalidConfig(where, 'must be an object of functions and namespaces');
  const cached = cache.get(tree);
  if (cached) return cached;
  const out: HostEntry[] = [];
  const walk = (node: object, path: string[]) => {
    for (const [key, value] of Object.entries(node)) {
      const at = [...path, key];
      const field = `${where}.${at.join('.')}`;
      if (!NAME.test(key) || key === '__proto__' || key.startsWith('__isolane_')) {
        throw invalidConfig(field, 'is not a usable name (letters, digits, _ and $; not starting with __isolane_)');
      }
      const name = at.join('.');
      if (typeof value === 'function') {
        const fn = value as HostFunction;
        out.push(Object.freeze({ name, path: Object.freeze(at), sync: false, internal: false, run: (ctx: HostContext, args: unknown[]) => fn.apply(ctx, args) }));
      } else if (value && typeof value === 'object' && (value as Record<symbol, unknown>)[DEFINITION] === true) {
        const def = value as HostFunctionDefinition<readonly AnySchema[] | AnySchema | undefined, AnySchema | undefined>;
        out.push(Object.freeze({ name, path: Object.freeze(at), sync: def.sync === true, internal: false, run: wrapDefinition(name, def) }));
      } else if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
        if (typeof (value as { handler?: unknown }).handler === 'function' || typeof (value as { fn?: unknown }).fn === 'function') {
          throw invalidConfig(field, 'looks like a function definition; wrap it in hostFunction({ handler, ... })');
        }
        if (at.length > 8) throw invalidConfig(field, 'is nested too deeply (at most 8 levels)');
        walk(value, at);
      } else {
        throw invalidConfig(field, 'must be a function, hostFunction({...}), or a namespace object');
      }
    }
  };
  walk(tree, []);
  cache.set(tree, out);
  return out;
}

/** An isolane broker (fetch, connect, fs) as a host entry: a top-level internal function. */
export function internalEntry(name: string, fn: (...args: unknown[]) => unknown): HostEntry {
  return Object.freeze({ name, path: Object.freeze([name]), sync: false, internal: true, run: (_ctx: HostContext, args: unknown[]) => fn(...args) });
}
