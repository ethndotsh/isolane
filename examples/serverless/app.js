// Guest code for the example app. It runs inside isolane: plain
// ECMAScript plus the host functions its deployer serves (getUser, track)
// and the request as a global.
async function handle(request) {
  // (URL arrives with the WinterTC runtime; until then, a regex.)
  const id = Number(/[?&]id=(\d+)/.exec(request.url)?.[1] ?? 1);
  const user = await getUser(id);
  await track('view', id);
  console.log(`served user ${id} to ${request.headers['user-agent'] ?? 'someone'}`);
  if (!user) return { status: 404, body: { error: 'no such user' } };
  return { body: { greeting: `hello, ${user.name}`, plan: user.plan, at: new Date().toISOString() } };
}
