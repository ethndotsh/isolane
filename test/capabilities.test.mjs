// Network and fs brokers, and the guest-side prelude, without a worker: the
// prelude runs in a bare node:vm context (plain ECMAScript, like a VM) whose
// host functions cross a JSON boundary as they would over the protocol.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { splitBytes } from '../dist/binary.js';
import { capabilities, isPublicAddress } from '../dist/capabilities.js';

/**
 * How a value crosses the protocol: bytes as bytes (top-level byte
 * arguments to the host; byte values anywhere in a host's result, back to
 * the guest as Uint8Arrays), everything else through JSON.
 */
const isBytes = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v) || (v && typeof v === 'object' && typeof v.byteLength === 'number' && Object.prototype.toString.call(v) === '[object ArrayBuffer]');
const viewBytes = (v) => (ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v));
function argsToHost(args) {
  // The worker sends top-level byte arguments raw; the rest is JSON.
  const json = JSON.parse(JSON.stringify(args.map((a) => (isBytes(a) ? null : a))));
  return args.map((a, i) => (isBytes(a) ? Buffer.from(viewBytes(a)) : json[i]));
}
function resultToGuest(value, GuestUint8Array) {
  const { json, parts } = splitBytes(value);
  if (json === undefined) return undefined;
  let out = JSON.parse(json);
  for (const { path, bytes } of parts) {
    const u8 = new GuestUint8Array(bytes.length);
    u8.set(bytes);
    if (path.length === 0) out = u8;
    else path.slice(0, -1).reduce((o, k) => o[k], out)[path.at(-1)] = u8;
  }
  return out;
}

/** A guest context with the policies installed; returns an async eval. */
function guest(policies, track) {
  const caps = capabilities(policies, {});
  track?.(caps);
  const ctx = vm.createContext({});
  const GuestError = vm.runInContext('Error', ctx);
  const GuestTypeError = vm.runInContext('TypeError', ctx);
  const GuestUint8Array = vm.runInContext('Uint8Array', ctx);
  for (const [name, fn] of Object.entries(caps.hostFunctions)) {
    ctx[name] = (...args) =>
      Promise.resolve()
        .then(() => fn(...argsToHost(args)))
        .then((v) => resultToGuest(v, GuestUint8Array))
        .catch((e) => {
          const err = new (e instanceof TypeError ? GuestTypeError : GuestError)(e.message);
          if (typeof e.code === 'string') err.code = e.code;
          throw err;
        });
  }
  vm.runInContext(caps.prelude, ctx);
  // Results come back through JSON, as from a worker (bytes as arrays).
  return (code) =>
    vm.runInContext(`(async () => { ${code} })()`, ctx).then((v) => (v === undefined ? v : JSON.parse(JSON.stringify(v))));
}

// ---- network ----

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.url === '/json') return res.writeHead(200, { 'content-type': 'application/json', 'x-a': '1' }).end('{"hi":"wörld"}');
    if (req.url === '/echo') return res.writeHead(200).end(JSON.stringify({ method: req.method, headers: req.headers, body: body.toString('base64') }));
    if (req.url === '/big') return res.writeHead(200).end(Buffer.alloc(2048));
    if (req.url === '/to-json') return res.writeHead(302, { location: '/json' }).end();
    if (req.url === '/to-echo') return res.writeHead(307, { location: '/echo' }).end();
    if (req.url === '/to-other-origin') return res.writeHead(307, { location: `http://127.0.0.1:${server.address().port}/echo` }).end();
    if (req.url === '/to-evil') return res.writeHead(302, { location: 'http://evil.example/' }).end();
    if (req.url === '/slow') return setTimeout(() => res.end('late'), 2000);
    res.writeHead(404).end('nope');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const base = `http://localhost:${server.address().port}`;
const local = { allow: ['localhost'], allowPrivateNetworks: true };

test('public and non-public addresses', () => {
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(a), true, a);
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', 'not-an-ip']) {
    assert.equal(isPublicAddress(a), false, a);
  }
});

test('fetch: text, json, status, headers', async () => {
  const run = guest({ network: local });
  assert.deepEqual(
    await run(`const r = await fetch('${base}/json'); return [r.status, r.ok, r.headers.get('X-A'), (await r.json()).hi, r.bodyUsed];`),
    [200, true, '1', 'wörld', true],
  );
  assert.deepEqual(await run(`const r = await fetch('${base}/missing'); return [r.status, r.ok, await r.text()];`), [404, false, 'nope']);
});

test('fetch: request bodies and headers cross intact, and the broker controls Host', async () => {
  const run = guest({ network: local });
  const out = await run(`
    const bytes = new Uint8Array([0, 255, 128, 10]);
    const r = await fetch('${base}/echo', { method: 'post', headers: { 'X-Thing': 'é', Host: 'evil.example' }, body: bytes });
    const s = await r.json();
    return [s.method, s.headers['x-thing'], s.headers.host, s.body];`);
  assert.deepEqual(out.slice(0, 2), ['POST', 'é']);
  assert.match(out[2], /^localhost:\d+$/);
  assert.equal(out[3], Buffer.from([0, 255, 128, 10]).toString('base64'));
  const text = await run(`const r = await fetch('${base}/echo', { method: 'PUT', body: 'héllo 🌍' }); return (await r.json()).body;`);
  assert.equal(Buffer.from(text, 'base64').toString(), 'héllo 🌍');
});

test('fetch: hosts outside the allowlist are refused', async () => {
  const run = guest({ network: { allow: ['api.example.com', '*.example.org'] } });
  await assert.rejects(run(`await fetch('${base}/json')`), /not allowed by the network policy/);
  await assert.rejects(run(`await fetch('https://example.org/')`), /not allowed by the network policy/);
  await assert.rejects(run(`await fetch('file:///etc/passwd')`), /not supported/);
});

test('fetch: private addresses are refused unless allowed, even for allowed names', async () => {
  const run = guest({ network: { allow: ['localhost', '127.0.0.1', '169.254.169.254'] } });
  await assert.rejects(run(`await fetch('${base}/json')`), /no public address/);
  await assert.rejects(run(`await fetch('http://127.0.0.1:1/')`), /not a public address/);
  await assert.rejects(run(`await fetch('http://169.254.169.254/latest/meta-data/')`), /not a public address/);
  await assert.rejects(run(`await fetch('http://[::ffff:127.0.0.1]:1/')`), /not a public address/);
});

test('fetch: redirects are followed and re-checked', async () => {
  const run = guest({ network: local });
  assert.deepEqual(await run(`const r = await fetch('${base}/to-json'); return [r.redirected, r.url.endsWith('/json'), (await r.json()).hi];`), [true, true, 'wörld']);
  await assert.rejects(run(`await fetch('${base}/to-evil')`), /evil\.example is not allowed/);
  const kept = await run(`const r = await fetch('${base}/to-echo', { method: 'POST', body: 'x', headers: { authorization: 'secret' } }); return await r.json();`);
  assert.equal(kept.method, 'POST'); // 307 keeps the method
  assert.equal(kept.headers.authorization, 'secret'); // same origin: credentials stay
  const both = guest({ network: { allow: ['localhost', '127.0.0.1'], allowPrivateNetworks: true } });
  const moved = await both(`const r = await fetch('${base}/to-other-origin', { headers: { authorization: 'secret' } }); return await r.json();`);
  assert.equal(moved.headers.authorization, undefined); // another origin: dropped
});

test('fetch: limits', async () => {
  await assert.rejects(guest({ network: { ...local, maxResponseBytes: 1000 } })(`await fetch('${base}/big')`), /larger than 1000 bytes/);
  await assert.rejects(guest({ network: { ...local, methods: ['GET'] } })(`await fetch('${base}/echo', { method: 'DELETE' })`), /method DELETE is not allowed/);
  await assert.rejects(guest({ network: { ...local, timeoutMs: 200 } })(`await fetch('${base}/slow')`), /timed out/);
  const counted = guest({ network: { ...local, maxRequests: 1 } });
  await counted(`await fetch('${base}/json')`);
  await assert.rejects(counted(`await fetch('${base}/json')`), /used its 1 requests/);
});

test('fetch: a policy function decides each hop', async () => {
  const seen = [];
  const run = guest({ network: { allow: (url, method) => (seen.push(`${method} ${url.pathname}`), url.pathname !== '/json'), allowPrivateNetworks: true } });
  await assert.rejects(run(`await fetch('${base}/to-json')`), /not allowed/);
  assert.deepEqual(seen, ['GET /to-json', 'GET /json']);
});

// ---- sockets ----

const tcp = createTcpServer((sock) => {
  sock.on('data', (d) => {
    if (d.toString() === 'bye') sock.end('ok bye');
    else sock.write(Buffer.concat([Buffer.from('echo:'), d]));
  });
});
await new Promise((r) => tcp.listen(0, '127.0.0.1', r));
after(() => tcp.close());
const tcpPort = tcp.address().port;

test('sockets: connect, write, read, end of stream', async () => {
  const run = guest({ sockets: { allow: [`localhost:${tcpPort}`], allowPrivateNetworks: true } });
  const out = await run(`
    const s = await connect('localhost:${tcpPort}');
    await s.write('hi ✓');
    const first = await s.read();
    await s.write('bye');
    let rest = '', chunk;
    while ((chunk = await s.read()) !== null) rest += String.fromCharCode(...chunk);
    return [first.length, rest];`);
  assert.deepEqual(out, [Buffer.byteLength('echo:hi ✓'), 'ok bye']);
});

test('sockets: the allowlist and private-address rules apply', async () => {
  const run = guest({ sockets: { allow: ['localhost:1', '*.example.com:443', 'db.example.com:*'] } });
  await assert.rejects(run(`await connect('localhost:${tcpPort}')`), /not allowed by the socket policy/);
  await assert.rejects(run(`await connect('localhost:1')`), /no public address/);
  await assert.rejects(run(`await connect({ hostname: '10.0.0.1', port: 5432 })`), /not a public address/);
  await assert.rejects(run(`await connect('example.com:443')`), /not allowed/); // apex isn't a subdomain
  await assert.rejects(run(`await connect('localhost:99999')`), /port from 1 to 65535/);
});

test('sockets: connection cap, and disposal closes them', async () => {
  let caps;
  const run = guest({ sockets: { allow: [`localhost:${tcpPort}`], allowPrivateNetworks: true, maxConnections: 1 } }, (c) => (caps = c));
  await run(`globalThis.s = await connect('localhost:${tcpPort}')`);
  await assert.rejects(run(`await connect('localhost:${tcpPort}')`), /already has 1 sockets open/);
  caps.dispose();
  await assert.rejects(run(`await s.write('x')`), /socket is closed/);
});

// ---- globals ----

test('globals arrive as plain data', async () => {
  const caps = capabilities({ globals: { input: { n: 21, s: '"); throw 1; ("' } } }, {});
  const ctx = vm.createContext({});
  vm.runInContext(caps.prelude, ctx);
  assert.equal(vm.runInContext('input.n * 2 + input.s.length', ctx), 42 + 15);
  assert.throws(() => capabilities({ globals: JSON.parse('{"__proto__": 1}') }, {}), /reserved/);
  assert.throws(() => capabilities({ globals: { f: 1 } }, { f: () => 1 }), /reserved or already a host function/);
});

// ---- fs ----

const tmp = mkdtempSync(join(tmpdir(), 'isolane-fs-'));
const root = join(tmp, 'root');
mkdirSync(join(root, 'dir'), { recursive: true });
writeFileSync(join(root, 'hello.txt'), 'héllo');
writeFileSync(join(root, 'dir', 'bin'), Buffer.from([0, 1, 2, 255]));
writeFileSync(join(tmp, 'secret.txt'), 'top secret');
symlinkSync(join(tmp, 'secret.txt'), join(root, 'leak'));
symlinkSync(tmp, join(root, 'leakdir'));
symlinkSync('hello.txt', join(root, 'alias'));

test('fs: reads, listings, stats', async () => {
  const run = guest({ fs: { root } });
  assert.equal(await run(`return fs.readFile('/hello.txt', 'utf8')`), 'héllo');
  assert.deepEqual(await run(`return [...await fs.readFile('dir/bin')]`), [0, 1, 2, 255]);
  assert.deepEqual(await run(`return fs.readdir('/')`), ['alias', 'dir', 'hello.txt', 'leak', 'leakdir']);
  assert.deepEqual(await run(`const s = await fs.stat('/dir'); return [s.isDirectory, s.isFile]`), [true, false]);
  assert.equal(await run(`return fs.readFile('alias', 'utf8')`), 'héllo'); // a symlink that stays inside is fine
  assert.deepEqual(await run(`return [await fs.exists('/hello.txt'), await fs.exists('/nope'), await fs.exists('/leak')]`), [true, false, false]);
});

test('fs: nothing outside the root is reachable', async () => {
  const run = guest({ fs: { root, write: true } });
  await assert.rejects(run(`await fs.readFile('../secret.txt')`), /no such file/); // .. stops at the root
  await assert.rejects(run(`await fs.readFile('/../../../../etc/hostname')`), /no such file/);
  await assert.rejects(run(`await fs.readFile('/leak')`), /outside the root/);
  await assert.rejects(run(`await fs.readdir('/leakdir')`), /outside the root/);
  await assert.rejects(run(`await fs.writeFile('/leakdir/planted', 'x')`), /outside the root/);
  await assert.rejects(run(`await fs.writeFile('/leak', 'overwritten')`), /symbolic link/);
  await assert.rejects(run(`await fs.mkdir('/leakdir/a/b', { recursive: true })`), /outside the root/);
  await assert.rejects(run(`await fs.rm('/')`), /root itself/);
  assert.equal(readFileSync(join(tmp, 'secret.txt'), 'utf8'), 'top secret');
  // Errors name guest paths, never host paths.
  const message = await run(`await fs.readFile('/leak')`).catch((e) => e.message);
  assert.ok(!message.includes(tmp), message);
});

test('fs: read-only unless write is set', async () => {
  const run = guest({ fs: { root } });
  await assert.rejects(run(`await fs.writeFile('/new.txt', 'x')`), /read-only/);
  await assert.rejects(run(`await fs.rm('/hello.txt')`), /read-only/);
});

test('fs: writes, directories, removal, and size limits', async () => {
  const run = guest({ fs: { root, write: true, maxFileBytes: 16 } });
  await run(`await fs.mkdir('/out/a/b', { recursive: true }); await fs.writeFile('/out/a/b/f.txt', 'ünïcode');`);
  assert.equal(readFileSync(join(root, 'out/a/b/f.txt'), 'utf8'), 'ünïcode');
  await assert.rejects(run(`await fs.writeFile('/out/big', 'x'.repeat(17))`), /larger than 16 bytes/);
  await assert.rejects(run(`await fs.rm('/out')`), /is a directory/);
  await run(`await fs.rm('/out', { recursive: true })`);
  assert.equal(await run(`return fs.exists('/out')`), false);
});

test('policy names are reserved', () => {
  assert.throws(() => capabilities({ network: { allow: [] } }, { fetch: () => 1 }), /reserved/);
  assert.throws(() => capabilities({ fs: { root } }, { fs: () => 1 }), /reserved/);
  assert.throws(() => capabilities({ network: {} }, {}), /network.allow/);
});
