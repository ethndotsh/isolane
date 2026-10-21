// The app: a Workers-style fetch handler, an ES module run inside isolane
// with the web platform. `env` holds the host functions its deployer
// serves (typed in env.d.ts), and `ctx.waitUntil` keeps work running after
// the response.

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const id = Number(new URL(request.url).searchParams.get('id') ?? 1);
    if (id === 0) throw new RangeError('ids start at 1'); // try ?id=0: a 500, with this line in the stack
    const user = await env.getUser(id);
    // Counted after the response is sent.
    ctx.waitUntil(env.track('view', id));
    console.log(`served user ${id} to ${request.headers.get('user-agent') ?? 'someone'}`);
    if (!user) return Response.json({ error: 'no such user' }, { status: 404 });
    return Response.json({ greeting: `hello, ${user.name}`, plan: user.plan, at: new Date().toISOString() });
  },
};
