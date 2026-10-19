// The app: a fetch-style handler, run inside isolane with the web platform
// and the host functions its deployer serves (typed in env.d.ts).

async function handle(request: Request): Promise<Response> {
  const id = Number(new URL(request.url).searchParams.get('id') ?? 1);
  if (id === 0) throw new RangeError('ids start at 1'); // try ?id=0: a 500, with this line in the stack
  const user = await getUser(id);
  await track('view', id);
  console.log(`served user ${id} to ${request.headers.get('user-agent') ?? 'someone'}`);
  if (!user) return Response.json({ error: 'no such user' }, { status: 404 });
  return Response.json({ greeting: `hello, ${user.name}`, plan: user.plan, at: new Date().toISOString() });
}
