// Compile-only: hostFunction and returns schemas infer their types.
import { z } from 'zod';
import { deny, hostFunction, Runtime, type HostContext } from '../ts/index.js';

const User = z.object({ id: z.number(), name: z.string() });
const getUser = hostFunction({
  args: [z.number().int(), z.string().optional()],
  returns: User.nullable(),
  handler: (id, tag, ctx) => {
    const n: number = id;
    const t: string | undefined = tag;
    const tenant: string = ctx.tenant;
    const signal: AbortSignal = ctx.signal;
    void t;
    void tenant;
    void signal;
    return n > 0 ? { id: n, name: 'x' } : null;
  },
});
// @ts-expect-error: the result must match the returns schema's input
hostFunction({ args: [z.number()], returns: User, handler: (id) => ({ id }) });
// @ts-expect-error: parameters come from the schemas
hostFunction({ args: [z.number()], handler: (id: string) => id });
// Without per-position args, the context is `this`.
hostFunction({
  handler(this: HostContext, ...xs: unknown[]) {
    return [this.tenant, xs.length];
  },
});
// Bare functions get the context as `this` too.
const bare = function (this: HostContext, a: number) {
  return this.isolate + a;
};

declare const rt: Runtime;
async function typed() {
  const total: { total: number } = await rt.run('({ total: 1 })', {
    tenant: 't',
    returns: z.object({ total: z.number() }),
    host: { db: { getUser }, bare },
    hooks: { beforeHostCall: ({ name }) => (name === 'db.getUser' ? deny('no') : undefined) },
  });
  const untyped: unknown = await rt.run('1', { tenant: 't' });
  const viaTenant: number = await rt.tenant('t').run('1', { returns: z.number() });
  rt.tenant('t').isolate({ shims: { setup: 'x', before: ['y', { code: 'z', filename: 'z.js' }], after: { code: 'return result' } } });
  // @ts-expect-error a shim is code or { code, filename }
  rt.tenant('t').isolate({ shims: { after: { filename: 'x.js' } } });
  const off = rt.on('limit', (e) => void (e.limit satisfies string));
  off();
  await using program = await rt.tenant('t').load('export const f = () => 1;', { env: { a: 1 }, instances: { max: 2 }, host: { db: { getUser } } });
  const fromProgram: { id: number; name: string } = await program.call('f', [1], { returns: User });
  const loads: number = program.usage().loads;
  const response: Response = await program.fetch('https://example.com/', { method: 'POST', body: 'x' });
  void program.fetch(new Request('https://example.com/'));
  void rt.tenant('t').load('', { instances: { concurrency: 4, queue: 10 }, limits: { bodyBytes: 1024 } });
  void response;
  // @ts-expect-error instances fields are named
  void rt.tenant('t').load('', { instances: { size: 2 } });
  rt.on('programLoad', (e) => void (e.durationMs satisfies number));
  void rt.tenant('t').load(
    { main: 'src/index.ts', files: { 'src/index.ts': 'export {}', 'logo.png': new Uint8Array(1) } },
    { ts: { mode: 'transform', experimentalDecorators: true }, jsx: { runtime: 'classic', factory: 'h' }, define: { DEBUG: 'false' }, modules: { 'node:fs': './fs.js', 'isolane:kv': { get: (key: string) => key } } },
  );
  // @ts-expect-error ts.mode is strip or transform
  void rt.tenant('t').load('', { ts: { mode: 'compile' } });
  void fromProgram;
  void loads;
  void total;
  void untyped;
  void viaTenant;
}
void typed;
