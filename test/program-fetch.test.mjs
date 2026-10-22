// program.fetch (a Workers-style fetch handler: fetch(request, env, ctx)),
// ctx.waitUntil, and instances that run several calls at once
// (instances.concurrency).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IsolaneError } from '../dist/index.js';
import { pool, code, limit } from './helpers.mjs';

const tenant = pool.tenant('program-fetch');
const load = (source, options) => tenant.load(source, options);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('program.fetch calls the fetch handler with a Request, env, and ctx, and returns its Response', async (t) => {
  const program = await load(
    `
    import { env as imported } from 'isolane:env';
    let n = 0;
    export default {
      async fetch(request, env, ctx) {
        n++;
        return Response.json({
          n,
          url: request.url,
          method: request.method,
          header: request.headers.get('x-test'),
          body: await request.text(),
          sameEnv: env === imported,
          greeting: env.greeting,
          ctx: Object.keys(ctx),
        }, { status: 201, statusText: 'Made', headers: { 'x-answer': '42' } });
      },
    };`,
    { env: { greeting: 'hi' } },
  );
  t.after(() => program.close());
  const response = await program.fetch('https://example.com/path?q=1', { method: 'POST', body: 'hello', headers: { 'x-test': 'yes' } });
  assert.ok(response instanceof Response);
  assert.equal(response.status, 201);
  assert.equal(response.statusText, 'Made');
  assert.equal(response.headers.get('x-answer'), '42');
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), {
    n: 1,
    url: 'https://example.com/path?q=1',
    method: 'POST',
    header: 'yes',
    body: 'hello',
    sameEnv: true,
    greeting: 'hi',
    ctx: ['waitUntil'],
  });
  // Warm: module state persists. A Request works as the input too.
  const again = await program.fetch(new Request('https://example.com/'));
  assert.equal((await again.json()).n, 2);
});

test('bodies are bytes both ways, and statuses, redirects, and empty bodies come through', async (t) => {
  const program = await load(`
    export async function fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/echo') return new Response(await request.arrayBuffer(), { headers: { 'content-type': 'application/octet-stream' } });
      if (path === '/redirect') return Response.redirect('https://example.com/elsewhere', 307);
      if (path === '/empty') return new Response(null, { status: 204 });
      if (path === '/stream') {
        return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close(); } }));
      }
      return new Response('not found', { status: 404 });
    }`);
  t.after(() => program.close());
  const bytes = new Uint8Array(256).map((_, i) => i);
  const echo = await program.fetch('https://example.com/echo', { method: 'PUT', body: bytes });
  assert.deepEqual(new Uint8Array(await echo.arrayBuffer()), bytes);
  const redirect = await program.fetch('https://example.com/redirect');
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get('location'), 'https://example.com/elsewhere');
  const empty = await program.fetch('https://example.com/empty');
  assert.equal(empty.status, 204);
  assert.equal(empty.body, null);
  assert.deepEqual([...new Uint8Array(await (await program.fetch('https://example.com/stream')).arrayBuffer())], [1, 2, 3]);
  const missing = await program.fetch('https://example.com/nope');
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), 'not found');
});

test('a handler that throws, returns no Response, or is missing fails as the guest\'s', async (t) => {
  const throws = await load('export default { fetch() { throw new RangeError("nope"); } };', { filename: 'app.js' });
  t.after(() => throws.close());
  await assert.rejects(throws.fetch('https://example.com/'), (err) => {
    return code('ERR_GUEST_EXCEPTION')(err) && err.guest.name === 'RangeError' && /app\.js:1/.test(err.guest.stack);
  });
  const junk = await load('export default { fetch() { return { status: 200 }; } };');
  t.after(() => junk.close());
  await assert.rejects(junk.fetch('https://example.com/'), (err) => code('ERR_GUEST_EXCEPTION')(err) && /must return a Response/.test(err.message));
  const none = await load('export function handle() {}');
  t.after(() => none.close());
  await assert.rejects(none.fetch('https://example.com/'), (err) => code('ERR_HANDLER_NOT_FOUND')(err) && err.kind === 'guest');
  // The instance stays in service after each.
  await assert.rejects(throws.fetch('https://example.com/'), code('ERR_GUEST_EXCEPTION'));
  assert.equal(throws.usage().loads, 1);
});

test('limits.bodyBytes bounds the request and the response bodies', async (t) => {
  const program = await load(
    `export default { async fetch(request) { const n = Number(new URL(request.url).searchParams.get('n')); return new Response(new Uint8Array(n)); } };`,
    { limits: { bodyBytes: 1024 } },
  );
  t.after(() => program.close());
  assert.equal((await (await program.fetch('https://example.com/?n=1024')).arrayBuffer()).byteLength, 1024);
  await assert.rejects(program.fetch('https://example.com/?n=1025'), limit('bodyBytes'));
  await assert.rejects(program.fetch('https://example.com/?n=1', { method: 'POST', body: new Uint8Array(1025) }), limit('bodyBytes'));
  // Neither retires the instance.
  assert.equal((await (await program.fetch('https://example.com/?n=1')).arrayBuffer()).byteLength, 1);
  assert.equal(program.usage().loads, 1);
});

test('program.fetch needs the web platform, and takes what fetch takes', async (t) => {
  const bare = await load('export function fetch() {}', { web: false });
  t.after(() => bare.close());
  await assert.rejects(bare.fetch('https://example.com/'), code('ERR_INVALID_CONFIG'));
  const program = await load('export default { fetch: () => new Response("ok") };');
  t.after(() => program.close());
  await assert.rejects(program.fetch('/relative'), code('ERR_INVALID_CONFIG'));
  assert.equal(await (await program.fetch(new URL('https://example.com/'))).text(), 'ok');
});

test('the request\'s signal stops the call, and retires its instance', async (t) => {
  const program = await load('export default { async fetch() { await new Promise((r) => setTimeout(r, 10_000)); return new Response(""); } };');
  t.after(() => program.close());
  const ac = new AbortController();
  const pending = program.fetch('https://example.com/', { signal: ac.signal });
  setTimeout(() => ac.abort('enough'), 50);
  await assert.rejects(pending, (err) => code('ERR_ABORTED')(err) && err.reason === 'enough');
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(program.fetch('https://example.com/', { signal: aborted.signal }), code('ERR_ABORTED'));
});

test('ctx.waitUntil work runs after the response, and close() waits for it', async (t) => {
  const program = await load(
    `
    import { env } from 'isolane:env';
    export default {
      fetch(request, _env, ctx) {
        ctx.waitUntil(new Promise((r) => setTimeout(r, 300)).then(() => env.done('late')));
        ctx.waitUntil(Promise.reject(new Error('lost')));
        return new Response('early');
      },
    };`,
    { host: { done: (what) => void finished.push(what) } },
  );
  const finished = [];
  const errors = [];
  const off = pool.on('guestError', (e) => e.tenant === 'program-fetch' && errors.push(e.error.message));
  t.after(off);
  const started = Date.now();
  assert.equal(await (await program.fetch('https://example.com/')).text(), 'early');
  assert.ok(Date.now() - started < 300, 'the response came before the waitUntil work finished');
  assert.deepEqual(finished, []);
  await program.close();
  assert.deepEqual(finished, ['late']);
  // A rejected waitUntil promise is reported, as an unhandled rejection.
  assert.ok(errors.includes('lost'), JSON.stringify(errors));
});

test('call hooks see program.fetch as fetch, with the Request and the Response', async (t) => {
  const seen = [];
  const program = await load('export default { fetch: (r) => new Response("from " + new URL(r.url).pathname) };', {
    hooks: {
      beforeCall: (e) => {
        seen.push([e.name, e.args[0] instanceof Request]);
        return { args: [new Request('https://example.com/replaced')] };
      },
      afterCall: (e) => {
        seen.push([e.name, e.result instanceof Response]);
      },
    },
  });
  t.after(() => program.close());
  assert.equal(await (await program.fetch('https://example.com/original')).text(), 'from /replaced');
  assert.deepEqual(seen, [
    ['fetch', true],
    ['fetch', true],
  ]);
});

test('instances.concurrency runs several calls in one instance at once', async (t) => {
  const program = await load(
    `
    let running = 0, peak = 0;
    export async function wait(ms) {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return peak;
    }
    export default { async fetch() { await wait(50); return new Response(String(peak)); } };`,
    { instances: { max: 1, concurrency: 3 } },
  );
  t.after(() => program.close());
  const started = Date.now();
  const peaks = await Promise.all([program.call('wait', [100]), program.call('wait', [100]), program.call('wait', [100])]);
  assert.deepEqual(peaks, [3, 3, 3]);
  assert.ok(Date.now() - started < 290, `three 100 ms calls together took ${Date.now() - started} ms`);
  assert.equal(program.usage().instances, 1);
  // A fourth waits for room; fetch calls share the instance too.
  const texts = await Promise.all([1, 2, 3, 4].map(() => program.fetch('https://example.com/').then((r) => r.text())));
  assert.equal(texts.length, 4);
  assert.equal(program.usage().loads, 1);
});

test('with concurrency, a call stopped part-way stops the others in its instance, which are not retried', async (t) => {
  const program = await load(
    `
    export async function wait(ms) { await new Promise((r) => setTimeout(r, ms)); return 'waited'; }
    export function spin() { for (;;) {} }`,
    { limits: { timeoutMs: 300 }, instances: { max: 1, concurrency: 2 } },
  );
  t.after(() => program.close());
  const waiting = program.call('wait', [2_000]);
  await sleep(20);
  const results = await Promise.allSettled([waiting, program.call('spin')]);
  for (const r of results) {
    assert.equal(r.status, 'rejected');
    assert.ok(r.reason instanceof IsolaneError);
    assert.equal(r.reason.retryable, false, `${r.reason.code}: ${r.reason.message}`);
  }
  assert.ok(results.some((r) => r.reason.code === 'ERR_LIMIT' && r.reason.limit === 'timeoutMs'));
  // The instance was replaced.
  assert.equal(await program.call('wait', [1]), 'waited');
  assert.ok(program.usage().loads >= 2);
});

test('with concurrency, a call stuck in a synchronous loop fails the calls it holds up, even ones whose work was done', async (t) => {
  // Defined behaviour: the calls in an instance share its event loop, so a
  // call blocking it keeps the others from finishing, and they reach their
  // own timeoutMs (or are retired with the instance) before they can.
  const program = await load(
    `
    export async function quick() { await new Promise((r) => setTimeout(r, 20)); return 'quick'; }
    export function spin() { for (;;) {} }`,
    { limits: { timeoutMs: 300 }, instances: { max: 1, concurrency: 3 } },
  );
  t.after(() => program.close());
  const quick = [program.call('quick'), program.call('quick')];
  const results = await Promise.allSettled([...quick, program.call('spin')]);
  for (const r of results) {
    assert.equal(r.status, 'rejected');
    assert.ok(['ERR_LIMIT', 'ERR_ISOLATE_RETIRED'].includes(r.reason.code), `${r.reason.code}: ${r.reason.message}`);
    if (r.reason.code === 'ERR_LIMIT') assert.equal(r.reason.limit, 'timeoutMs');
  }
  assert.ok(results.slice(0, 2).some((r) => r.reason.code === 'ERR_LIMIT'), 'a held-up call reaches its own timeoutMs');
  assert.equal(await program.call('quick'), 'quick');
});

test('with concurrency, an aborted call stops its instance; the other call there fails with ERR_ISOLATE_RETIRED', async (t) => {
  const program = await load('export async function wait(ms) { await new Promise((r) => setTimeout(r, ms)); return "waited"; }', {
    instances: { max: 1, concurrency: 2 },
  });
  t.after(() => program.close());
  const ac = new AbortController();
  const results = Promise.allSettled([program.call('wait', [300], { signal: ac.signal }), program.call('wait', [300])]);
  setTimeout(() => ac.abort('stop'), 50);
  const [aborted, other] = await results;
  assert.equal(aborted.reason.code, 'ERR_ABORTED');
  assert.equal(other.reason.code, 'ERR_ISOLATE_RETIRED');
  assert.equal(other.reason.retryable, false);
});

test('instances.queue caps the calls waiting for an instance', async (t) => {
  const program = await load('export async function wait(ms) { await new Promise((r) => setTimeout(r, ms)); return 1; }', {
    instances: { max: 1, queue: 1 },
  });
  t.after(() => program.close());
  const running = program.call('wait', [100]);
  await sleep(10);
  const queued = program.call('wait', [1]);
  await assert.rejects(program.call('wait', [1]), (err) => limit('instances.queue')(err) && err.kind === 'limit' && !/limits\./.test(err.message));
  assert.deepEqual(await Promise.all([running, queued]), [1, 1]);
});

test('instances options are checked', async () => {
  for (const instances of [{ concurrency: 0 }, { concurrency: 2, reuse: false }, { queue: -1 }, { concurrency: 1.5 }]) {
    await assert.rejects(load('export function f() {}', { instances }), code('ERR_INVALID_CONFIG'), JSON.stringify(instances));
  }
});

test('a multi-file TypeScript program serves fetch, with errors pointing at its sources', async (t) => {
  const program = await load(
    {
      main: 'src/index.ts',
      files: {
        'src/index.ts': `import { greet } from './greet';\nexport default {\n  async fetch(request: Request): Promise<Response> {\n    return new Response(greet(new URL(request.url).searchParams.get('who')));\n  },\n};\n`,
        'src/greet.ts': `export function greet(who: string | null): string {\n  if (!who) throw new TypeError('who?');\n  return 'hello ' + who;\n}\n`,
      },
    },
    { instances: { concurrency: 2 } },
  );
  t.after(() => program.close());
  assert.equal(await (await program.fetch('https://example.com/?who=ada')).text(), 'hello ada');
  await assert.rejects(program.fetch('https://example.com/'), (err) => code('ERR_GUEST_EXCEPTION')(err) && /src\/greet\.ts:2/.test(err.guest.stack));
});
