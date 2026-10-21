// Network and fs brokers, and the guest-side prelude, without a worker: the
// prelude runs in a node:vm context whose host functions cross a JSON
// boundary as they would over the protocol. The context has a stand-in for
// the web platform: TextEncoder/TextDecoder, a minimal fetch over the
// broker (WEB_FETCH below) where the real one is runtime/fetch.js, tested
// end to end in web.test.mjs, and the real runtime/fs.js on a stand-in for
// the bootstrap it's given.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { splitBytes } from '../dist/binary.js';
import { capabilities, connectBroker, isPublicAddress } from '../dist/capabilities.js';
import { parseWorkerMessage } from '../dist/worker.js';

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

/** Policy denials and limits the brokers reported (for onPolicyDenial and onLimit), most recent last. */
const denials = [];
const limitsHit = [];
const NO_REPORT = { denied: () => {}, limit: () => {} };
const reporter = { denied: (api, target, reason) => denials.push({ api, target, reason }), limit: (limit, message) => limitsHit.push({ limit, message }) };

/**
 * The web platform's fetch hook, minimally: Headers, Response (whole bodies),
 * and fetch() over the raw broker function the prelude hands it.
 */
const WEB_FETCH = String.raw`(rawFetch) => {
  const g = globalThis;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const toBytes = (data) => (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : encoder.encode(String(data)));
  class Headers {
    #map = new Map();
    constructor(init) {
      if (init == null) return;
      const pairs = init instanceof Headers ? [...init] : Array.isArray(init) ? init : Object.entries(init);
      for (const [k, v] of pairs) this.append(k, v);
    }
    append(k, v) {
      k = String(k).toLowerCase();
      this.#map.set(k, this.#map.has(k) ? this.#map.get(k) + ', ' + v : String(v));
    }
    get(k) { return this.#map.get(String(k).toLowerCase()) ?? null; }
    *[Symbol.iterator]() { yield* this.#map; }
  }
  class Response {
    #body;
    constructor(r, body) {
      Object.assign(this, { status: r.status, ok: r.status >= 200 && r.status < 300, url: r.url, redirected: r.redirected, headers: new Headers(r.headers) });
      this.#body = body;
      this.bodyUsed = false;
    }
    text() { this.bodyUsed = true; return Promise.resolve(decoder.decode(this.#body)); }
    json() { return this.text().then(JSON.parse); }
  }
  let next = 1;
  g.fetch = async (url, init = {}) => {
    const id = next++;
    const body = init.body == null ? undefined : toBytes(init.body);
    const head = await rawFetch('open', id, { url: String(url), method: String(init.method ?? 'GET'), headers: [...new Headers(init.headers)] }, body);
    const chunks = [];
    for (let chunk; (chunk = await rawFetch('read', id)) !== null; ) chunks.push(...chunk);
    return new Response(head, new Uint8Array(chunks));
  };
}`;

/** runtime/fs.js's `createFs`, with what it uses of the web platform's bootstrap. */
const WEB_FS = String.raw`((__bootstrap) => (
${readFileSync(new URL('../runtime/fs.js', import.meta.url), 'utf8').trim().replace(/;$/, '')}
))({
  core: {
    isArrayBuffer: (v) => v instanceof ArrayBuffer,
    isDataView: (v) => v instanceof DataView,
    isArrayBufferView: (v) => ArrayBuffer.isView(v),
    loadExtScript: () => ({ TextEncoder, TextDecoder }),
  },
  primordials: {
    DataViewPrototypeGetBuffer: (v) => v.buffer,
    DataViewPrototypeGetByteLength: (v) => v.byteLength,
    DataViewPrototypeGetByteOffset: (v) => v.byteOffset,
    ObjectFreeze: Object.freeze,
    String,
    TypeError,
    TypedArrayPrototypeGetBuffer: (v) => v.buffer,
    TypedArrayPrototypeGetByteLength: (v) => v.byteLength,
    TypedArrayPrototypeGetByteOffset: (v) => v.byteOffset,
    Uint8Array,
  },
}).createFs`;

/** A guest context with the policies installed; returns an async eval. */
function guest(policies, track) {
  const caps = capabilities({ globals: {}, ...policies }, new Set(), reporter);
  track?.(caps);
  const ctx = vm.createContext({ TextEncoder, TextDecoder });
  ctx.__isolane_web_fetch = vm.runInContext(WEB_FETCH, ctx);
  const createFs = vm.runInContext(WEB_FS, ctx);
  ctx.__isolane_web_fs = (raw) => (ctx.fs = createFs(raw));
  const GuestError = vm.runInContext('Error', ctx);
  const GuestTypeError = vm.runInContext('TypeError', ctx);
  const GuestUint8Array = vm.runInContext('Uint8Array', ctx);
  for (const entry of caps.entries) {
    ctx[entry.name] = (...args) =>
      Promise.resolve()
        .then(() => entry.run({}, argsToHost(args)))
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
const local = { hosts: ['localhost:*'], privateNetworks: true };

test('public and non-public addresses', () => {
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2a00:1450:4001:80e::200e', '2620:fe::fe']) assert.equal(isPublicAddress(a), true, a);
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:0:7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::a9fe:a9fe', '2002:7f00:1::', '2002:a9fe:a9fe::', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:2::1', 'fec0::1', '3fff::1', '5f00::1', 'not-an-ip']) {
    assert.equal(isPublicAddress(a), false, a);
  }
});

test('fetch: text, json, status, headers', async () => {
  const run = guest({ fetch: local });
  assert.deepEqual(
    await run(`const r = await fetch('${base}/json'); return [r.status, r.ok, r.headers.get('X-A'), (await r.json()).hi, r.bodyUsed];`),
    [200, true, '1', 'wörld', true],
  );
  assert.deepEqual(await run(`const r = await fetch('${base}/missing'); return [r.status, r.ok, await r.text()];`), [404, false, 'nope']);
});

test('fetch: request bodies and headers cross intact, and the broker controls Host', async () => {
  const run = guest({ fetch: local });
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

test('fetch: a bare host allows only its scheme\'s default port', async () => {
  const port = new URL(base).port;
  await assert.rejects(guest({ fetch: { hosts: ['localhost'], privateNetworks: true } })(`await fetch('${base}/json')`), /not allowed by the fetch policy/);
  for (const hosts of [[`localhost:${port}`], ['localhost:*']]) {
    assert.equal(await guest({ fetch: { hosts, privateNetworks: true } })(`return (await fetch('${base}/json')).status`), 200, hosts[0]);
  }
  await assert.rejects(guest({ fetch: { hosts: ['localhost:1'], privateNetworks: true } })(`await fetch('${base}/json')`), /not allowed by the fetch policy/);
  await assert.rejects(guest({ fetch: { hosts: ['api.example.com'] } })(`await fetch('https://api.example.com:8443/')`), /not allowed by the fetch policy/);
});

test('fetch: hosts outside the allowlist are refused', async () => {
  const run = guest({ fetch: { hosts: ['api.example.com', '*.example.org'] } });
  await assert.rejects(run(`await fetch('${base}/json')`), /not allowed by the fetch policy/);
  await assert.rejects(run(`await fetch('https://example.org/')`), /not allowed by the fetch policy/);
  await assert.rejects(run(`await fetch('file:///etc/passwd')`), /not supported/);
});

test('fetch: private addresses are refused unless allowed, even for allowed names', async () => {
  const run = guest({ fetch: { hosts: ['localhost:*', '127.0.0.1:*', '169.254.169.254'] } });
  await assert.rejects(run(`await fetch('${base}/json')`), /no public address/);
  await assert.rejects(run(`await fetch('http://127.0.0.1:1/')`), /not a public address/);
  await assert.rejects(run(`await fetch('http://169.254.169.254/latest/meta-data/')`), /not a public address/);
  await assert.rejects(run(`await fetch('http://[::ffff:127.0.0.1]:1/')`), /not a public address/);
});

test('fetch: redirects are followed and re-checked', async () => {
  const run = guest({ fetch: local });
  assert.deepEqual(await run(`const r = await fetch('${base}/to-json'); return [r.redirected, r.url.endsWith('/json'), (await r.json()).hi];`), [true, true, 'wörld']);
  await assert.rejects(run(`await fetch('${base}/to-evil')`), /evil\.example is not allowed/);
  const kept = await run(`const r = await fetch('${base}/to-echo', { method: 'POST', body: 'x', headers: { authorization: 'secret' } }); return await r.json();`);
  assert.equal(kept.method, 'POST'); // 307 keeps the method
  assert.equal(kept.headers.authorization, 'secret'); // same origin: credentials stay
  const both = guest({ fetch: { hosts: ['localhost:*', '127.0.0.1:*'], privateNetworks: true } });
  const moved = await both(`const r = await fetch('${base}/to-other-origin', { headers: { authorization: 'secret' } }); return await r.json();`);
  assert.equal(moved.headers.authorization, undefined); // another origin: dropped
});

test('fetch: limits', async () => {
  await assert.rejects(guest({ fetch: { ...local, limits: { responseBytes: 1000 } } })(`await fetch('${base}/big')`), /larger than 1000 bytes/);
  await assert.rejects(guest({ fetch: { ...local, methods: ['GET'] } })(`await fetch('${base}/echo', { method: 'DELETE' })`), /method DELETE is not allowed/);
  await assert.rejects(guest({ fetch: { ...local, limits: { timeoutMs: 200 } } })(`await fetch('${base}/slow')`), /timed out/);
  const counted = guest({ fetch: { ...local, limits: { requests: 1 } } });
  await counted(`await fetch('${base}/json')`);
  await assert.rejects(counted(`await fetch('${base}/json')`), /used its 1 requests/);
  assert.deepEqual(limitsHit.at(-1), { limit: 'fetch.limits.requests', message: 'fetch: this isolate has used its 1 requests (fetch.limits.requests)' });
  // Body bytes over the isolate's life, both ways, across fetches.
  const moved = guest({ fetch: { ...local, limits: { transferBytes: 40 } } });
  await moved(`await (await fetch('${base}/json')).text()`);
  await assert.rejects(moved(`await (await fetch('${base}/big')).text()`), /moved its 40 bytes \(fetch.limits.transferBytes\)/);
  await assert.rejects(guest({ fetch: { ...local, limits: { transferBytes: 4 } } })(`await fetch('${base}/echo', { method: 'POST', body: 'hello' })`), /fetch.limits.transferBytes/);
});

test('fetch: a policy function decides each hop', async () => {
  const seen = [];
  const run = guest({ fetch: { hosts: (url, method) => (seen.push(`${method} ${url.pathname}`), url.pathname !== '/json'), privateNetworks: true } });
  await assert.rejects(run(`await fetch('${base}/to-json')`), /not allowed/);
  assert.deepEqual(seen, ['GET /to-json', 'GET /json']);
});

// ---- sockets ----
// The broker behind connect(). The guest's Sockets API over it is
// runtime/sockets.js, tested end to end in sockets.test.mjs.

const tcp = createTcpServer((sock) => {
  sock.on('data', (d) => {
    if (d.toString() === 'bye') sock.end('ok bye');
    else sock.write(Buffer.concat([Buffer.from('echo:'), d]));
  });
});
await new Promise((r) => tcp.listen(0, '127.0.0.1', r));
after(() => tcp.close());
const tcpPort = tcp.address().port;

const tcpLocal = { hosts: [`localhost:${tcpPort}`], privateNetworks: true };

test('connect broker: open, write, read, end of stream', async () => {
  const { fn: sock } = connectBroker(tcpLocal);
  const { id, remoteAddress } = await sock('open', { hostname: 'localhost', port: tcpPort });
  assert.match(remoteAddress, /^(127\.0\.0\.1|\[::1\]):\d+$/);
  await sock('write', id, Buffer.from('hi ✓'));
  assert.equal(String(await sock('read', id)), 'echo:hi ✓');
  await sock('write', id, Buffer.from('bye'));
  let rest = '';
  for (let chunk; (chunk = await sock('read', id)) !== null; ) rest += chunk;
  assert.equal(rest, 'ok bye');
  await sock('close', id);
  await assert.rejects(sock('read', id), /socket is closed/);
});

test('connect broker: the allowlist and private-address rules apply', async () => {
  const { fn: sock } = connectBroker({ hosts: ['localhost:1', '*.example.com:443', 'db.example.com:*'] });
  const open = (hostname, port) => sock('open', { hostname, port });
  await assert.rejects(open('localhost', tcpPort), /not allowed by the connect policy/);
  await assert.rejects(open('localhost', 1), /no public address/);
  await assert.rejects(open('10.0.0.1', 5432), /not a public address/);
  await assert.rejects(open('example.com', 443), /not allowed/); // apex isn't a subdomain
  await assert.rejects(open('localhost', 99999), /port from 1 to 65535/);
});

test('connect broker: startTls refuses unread bytes, and a malformed server name', async () => {
  const { fn: sock } = connectBroker(tcpLocal);
  const { id } = await sock('open', { hostname: 'localhost', port: tcpPort });
  await assert.rejects(sock('startTls', id, { servername: '' }), /expected a server hostname/);
  await sock('write', id, Buffer.from('x'));
  await new Promise((r) => setTimeout(r, 50)); // the echo arrives, unread
  await assert.rejects(sock('startTls', id, { servername: 'localhost' }), /sent data before the TLS handshake/);
  await sock('close', id);
});

test('connect broker: connection cap, and disposal closes them', async () => {
  const { fn: sock, dispose } = connectBroker({ ...tcpLocal, limits: { connections: 1 } });
  const { id } = await sock('open', { hostname: 'localhost', port: tcpPort });
  await assert.rejects(sock('open', { hostname: 'localhost', port: tcpPort }), /already has 1 sockets open/);
  dispose();
  await assert.rejects(sock('write', id, Buffer.from('x')), /socket is closed/);
  await assert.rejects(sock('open', { hostname: 'localhost', port: tcpPort }), /socket is closed/);
});

test('connect broker: transferBytes counts both ways, across sockets', async () => {
  const { fn: sock } = connectBroker({ ...tcpLocal, limits: { transferBytes: 16 } });
  const a = await sock('open', { hostname: 'localhost', port: tcpPort });
  await sock('write', a.id, Buffer.from('abc')); // 3 out, 8 back ('echo:abc')
  assert.equal(String(await sock('read', a.id)), 'echo:abc');
  await sock('close', a.id);
  const b = await sock('open', { hostname: 'localhost', port: tcpPort });
  await assert.rejects(sock('write', b.id, Buffer.from('123456')), /moved its 16 bytes \(connect.limits.transferBytes\)/);
});

test('the prelude needs the web platform for each policy', () => {
  for (const [policy, fn] of [['connect', '__isolane_socket'], ['fetch', '__isolane_fetch'], ['fs', '__isolane_fs']]) {
    const caps = capabilities({ globals: {}, [policy]: policy === 'fs' ? { root: tmpdir() } : tcpLocal }, new Set(), NO_REPORT);
    const ctx = vm.createContext({});
    ctx[fn] = () => {};
    assert.throws(() => vm.runInContext(caps.prelude, ctx), new RegExp(`${policy} needs the web platform`));
  }
});

// ---- globals ----

test('globals arrive as plain data', async () => {
  const caps = capabilities({ globals: { input: { n: 21, s: '"); throw 1; ("' } } }, new Set(), NO_REPORT);
  const ctx = vm.createContext({});
  vm.runInContext(caps.prelude, ctx);
  assert.equal(vm.runInContext('input.n * 2 + input.s.length', ctx), 42 + 15);
  assert.throws(() => capabilities({ globals: { f: 1 } }, new Set(['f']), NO_REPORT), /also a host function/);
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
  const run = guest({ fs: { root, write: true, limits: { fileBytes: 16 } } });
  await run(`await fs.mkdir('/out/a/b', { recursive: true }); await fs.writeFile('/out/a/b/f.txt', 'ünïcode');`);
  assert.equal(readFileSync(join(root, 'out/a/b/f.txt'), 'utf8'), 'ünïcode');
  await assert.rejects(run(`await fs.writeFile('/out/big', 'x'.repeat(17))`), /larger than 16 bytes/);
  await assert.rejects(run(`await fs.rm('/out')`), /is a directory/);
  await run(`await fs.rm('/out', { recursive: true })`);
  assert.equal(await run(`return fs.exists('/out')`), false);
});

test('fs: totals per isolate, and operations in flight at once', async () => {
  const run = guest({ fs: { root, write: true, limits: { writtenBytes: 10, pendingOperations: 4 } } });
  // Bytes written over the isolate's life, across files.
  await assert.rejects(
    run(`await fs.mkdir('/quota'); await fs.writeFile('/quota/a', 'x'.repeat(6)); await fs.writeFile('/quota/b', 'x'.repeat(6));`),
    /written its 10 bytes \(fs.limits.writtenBytes\)/,
  );
  assert.equal(readFileSync(join(root, 'quota/a'), 'utf8'), 'xxxxxx');
  // At most 4 at once; later ones work again.
  assert.deepEqual(
    await run(`const all = await Promise.allSettled(Array.from({ length: 50 }, () => fs.readFile('/hello.txt')));
      const refused = all.filter((r) => r.status === 'rejected');
      return [all.length - refused.length, refused.every((r) => /fs.limits.pendingOperations/.test(r.reason.message)), (await fs.readFile('/hello.txt', 'utf8'))];`),
    [4, true, 'héllo'],
  );
  rmSync(join(root, 'quota'), { recursive: true });
});

test('policy names are reserved', () => {
  const none = NO_REPORT;
  assert.throws(() => capabilities({ globals: {}, fetch: { hosts: [] } }, new Set(['fetch']), none), /taken by the fetch policy/);
  assert.throws(() => capabilities({ globals: {}, fs: { root } }, new Set(['fs']), none), /taken by the fs policy/);
  assert.throws(() => capabilities({ globals: { connect: 1 }, connect: { hosts: [] } }, new Set(), none), /globals\.connect is taken/);
  assert.throws(() => capabilities({ globals: {}, fetch: {} }, new Set(), none), /fetch\.hosts/);
});

test('refusals are reported as policy denials', async () => {
  denials.length = 0;
  await assert.rejects(guest({ fetch: { hosts: ['api.example.com'] } })(`await fetch('https://nope.example/x')`), /not allowed/);
  const sockets = capabilities({ globals: {}, connect: { hosts: ['db.example.com:5432'] } }, new Set(), reporter);
  await assert.rejects(Promise.resolve(sockets.entries[0].run({}, ['open', { hostname: '10.0.0.1', port: 5432 }])), /not a public address/);
  await assert.rejects(guest({ fs: { root } })(`await fs.writeFile('/x', 'y')`), /read-only/);
  assert.deepEqual(denials.map((d) => [d.api, d.target]), [
    ['fetch', 'https://nope.example/x'],
    ['connect', '10.0.0.1:5432'],
    ['fs', '/x'],
  ]);
  // A denied URL is reported without the credentials in it.
  denials.length = 0;
  const fetches = capabilities({ globals: {}, fetch: { hosts: ['api.example.com'] } }, new Set(), reporter);
  const meta = { url: 'https://user:secret@nope.example/x', method: 'GET', headers: [] };
  await assert.rejects(Promise.resolve(fetches.entries[0].run({}, ['open', 1, meta])), /not allowed/);
  assert.deepEqual(denials.map((d) => d.target), ['https://nope.example/x']);
});

// ---- binary frames ----

test('splitBytes finds bytes wherever JSON goes, with their paths', () => {
  const buf = Buffer.from([1, 2]);
  const { json, parts } = splitBytes({ a: buf, b: [1, new Uint8Array([3]), { c: new ArrayBuffer(2) }], d: 'x', e: new Date(0) });
  assert.deepEqual(JSON.parse(json), { a: null, b: [1, null, { c: null }], d: 'x', e: '1970-01-01T00:00:00.000Z' });
  assert.deepEqual(parts.map((p) => [p.path, [...p.bytes]]), [[['a'], [1, 2]], [['b', 1], [3]], [['b', 2, 'c'], [0, 0]]]);
  assert.deepEqual(splitBytes(buf).parts[0].path, []);
  assert.equal(splitBytes(undefined).json, undefined);
  const view = new Uint16Array([1, 2]).subarray(1);
  assert.deepEqual([...splitBytes(view).parts[0].bytes], [2, 0]);
});

test('byte attachments from a worker are parsed strictly', () => {
  const call = (args, bin) => ({ t: 'hostCall', vm: 1, call: 1, fn: 0, args, bin });
  const ok = parseWorkerMessage(call([null, 'x', null], [[0, 2], [2, 1]]), Buffer.from([9, 8, 7]));
  assert.deepEqual(ok.args.map((a) => (Buffer.isBuffer(a) ? [...a] : a)), [[9, 8], 'x', [7]]);
  const bad = [
    [call([null], [[0, 2]]), Buffer.from([1])], // fewer bytes than claimed
    [call([null], [[0, 1]]), Buffer.from([1, 2])], // unclaimed bytes
    [call([null], [[1, 1]]), Buffer.from([1])], // index past the arguments
    [call([null, null], [[0, 1], [0, 1]]), Buffer.from([1, 2])], // an index twice
    [call(['x'], [[0, 1]]), Buffer.from([1])], // placeholder isn't null
    [call([null], [[-1, 1]]), Buffer.from([1])],
    [call([null], [['0', 1]]), Buffer.from([1])],
    [call([null], [[0, 1.5]]), Buffer.from([1])],
    [call([null], 'nope'), Buffer.from([1])],
    [call([null], []), Buffer.alloc(0)],
    [{ t: 'result', req: 1, ok: true, value: 1 }, Buffer.from([1])], // bytes on a message that takes none
    [{ t: 'result', req: 1, ok: true, value: 1, bin: [[0, 1]] }, undefined], // bin in a plain JSON frame
    [call([null], [[0, 1]]), undefined],
  ];
  for (const [msg, bytes] of bad) assert.equal(parseWorkerMessage(msg, bytes), null, JSON.stringify(msg));
});
