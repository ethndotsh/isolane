// Compile-only: hostFunction and result schemas infer their types.
import { z } from 'zod';
import { hostFunction, Runtime } from '../ts/index.js';

const User = z.object({ id: z.number(), name: z.string() });
const getUser = hostFunction({
  args: [z.number().int(), z.string().optional()],
  result: User.nullable(),
  fn: (id, tag) => {
    const n: number = id;
    const t: string | undefined = tag;
    void t;
    return n > 0 ? { id: n, name: 'x' } : null;
  },
});
// @ts-expect-error: the result must match the result schema's input
hostFunction({ args: [z.number()], result: User, fn: (id) => ({ id }) });
// @ts-expect-error: parameters come from the schemas
hostFunction({ args: [z.number()], fn: (id: string) => id });

declare const rt: Runtime;
async function typed() {
  const total: { total: number } = await rt.run('({ total: 1 })', { tenant: 't', result: z.object({ total: z.number() }), hostFunctions: { getUser } });
  const untyped: unknown = await rt.run('1', { tenant: 't' });
  void total;
  void untyped;
}
void typed;
