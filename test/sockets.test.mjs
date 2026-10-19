// connect(): the Sockets API (runtime/sockets.js) over the socket broker,
// end to end through a real worker, against local TCP and TLS servers.
// Needs ISOLANE_WORKER.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';
import { Runtime } from '../dist/index.js';

/** A throwaway CA and a localhost certificate it signed, made with openssl for this run. */
function testCertificates() {
  const dir = mkdtempSync(join(tmpdir(), 'isolane-tls-'));
  try {
    const at = (name) => join(dir, name);
    const openssl = (...args) => execFileSync('openssl', args, { stdio: 'pipe' });
    const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
    openssl('req', '-x509', ...ec, '-keyout', at('ca.key'), '-out', at('ca.pem'), '-days', '1', '-subj', '/CN=isolane test CA');
    openssl('req', ...ec, '-keyout', at('server.key'), '-out', at('server.csr'), '-subj', '/CN=localhost');
    writeFileSync(at('ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
    openssl('x509', '-req', '-in', at('server.csr'), '-CA', at('ca.pem'), '-CAkey', at('ca.key'), '-CAcreateserial',
      '-out', at('server.pem'), '-days', '1', '-extfile', at('ext.cnf'));
    const read = (name) => readFileSync(at(name), 'utf8');
    return { ca: read('ca.pem'), key: read('server.key'), cert: read('server.pem') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const { ca, ...tlsOptions } = testCertificates();

const denials = [];
const runtime = new Runtime({
  strict: process.env.ISOLANE_STRICT === '1',
  hooks: { onPolicyDenial: (e) => denials.push(e) },
});
after(() => runtime.close());

const listen = async (server) => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  after(() => server.close());
  return server.address().port;
};

// Echoes each chunk back as "echo:<chunk>"; on its input's end, writes "bye" and ends.
const echoPort = await listen(
  createTcpServer({ allowHalfOpen: true }, (sock) => {
    sock.on('data', (d) => sock.write(Buffer.concat([Buffer.from('echo:'), d])));
    sock.on('end', () => sock.end('bye'));
    sock.on('error', () => {});
  }),
);

const tlsPort = await listen(
  createTlsServer(tlsOptions, (sock) => {
    sock.on('data', (d) => sock.write(Buffer.concat([Buffer.from('tls:'), d])));
    sock.on('error', () => {});
  }),
);

// A STARTTLS server: answers "STARTTLS\n" with "OK\n" (plus `extra`, to
// test injection: they arrive after "OK\n", before the guest's handshake) and then speaks TLS, echoing as "tls:<chunk>".
function startTlsServer(extra = '') {
  return createTcpServer((plain) => {
    plain.on('error', () => {});
    plain.once('data', (d) => {
      if (d.toString() !== 'STARTTLS\n') return plain.end('ERR\n');
      plain.write('OK\n');
      if (extra) setTimeout(() => plain.write(extra), 10);
      const secure = new TLSSocket(plain, { isServer: true, ...tlsOptions });
      secure.on('data', (c) => secure.write(Buffer.concat([Buffer.from('tls:'), c])));
      secure.on('error', () => {});
    });
  });
}
const startTlsPort = await listen(startTlsServer());
const injectingPort = await listen(startTlsServer('INJECTED'));

const local = (port) => ({ hosts: [`localhost:${port}`, `127.0.0.1:${port}`], privateNetworks: true, ca });
// Guest code is an async function body.
const run = (body, connect, opts = {}) => runtime.run(`(async () => {\n${body}\n})()`, { tenant: 'sockets', web: true, connect, ...opts });

// Guest helpers: read one chunk as text, write text.
const H = `
  const dec = new TextDecoder(), enc = new TextEncoder();
  const readText = async (reader) => { const { value, done } = await reader.read(); return done ? null : dec.decode(value); };
`;

test('connect is the Sockets API, and only with a policy', async () => {
  assert.equal(await runtime.run('typeof connect', { tenant: 'sockets', web: true }), 'undefined');
  assert.deepEqual(
    await run(
      `const s = connect('localhost:${echoPort}');
       const info = await s.opened;
       const out = [typeof connect, s.constructor.name, s.readable instanceof ReadableStream, s.writable instanceof WritableStream,
         s.secureTransport, s.upgraded, /^127\\.0\\.0\\.1:\\d+$/.test(info.remoteAddress)];
       await s.close();
       return out;`,
      local(echoPort),
    ),
    ['function', 'Socket', true, true, 'off', false, true],
  );
  assert.equal(await run('return Object.getOwnPropertyNames(globalThis).filter((n) => n.startsWith("__isolane")).length', local(echoPort)), 0);
});

test('connect needs the web platform', async () => {
  await assert.rejects(runtime.run('1', { tenant: 'sockets', web: false, connect: local(echoPort) }), /connect needs the web platform/);
});

test('write and read; the end of the input closes the socket', async () => {
  const out = await run(
    `${H}
     const s = connect({ hostname: 'localhost', port: ${echoPort} });
     const w = s.writable.getWriter(), r = s.readable.getReader();
     await w.write(enc.encode('hi ✓'));
     const first = await readText(r);
     await w.close(); // half-close: the server answers "bye" and ends
     let rest = '';
     for (let t; (t = await readText(r)) !== null; ) rest += t;
     await s.closed;
     return [first, rest];`,
    local(echoPort),
  );
  assert.deepEqual(out, ['echo:hi ✓', 'bye']);
});

test('pipes through, with a BYOB reader too', async () => {
  const out = await run(
    `${H}
     const s = connect('localhost:${echoPort}');
     const w = s.writable.getWriter();
     await w.write(new TextEncoder().encode('abc'));
     const reader = s.readable.getReader({ mode: 'byob' });
     const { value } = await reader.read(new Uint8Array(64));
     await s.close();
     return dec.decode(value);`,
    local(echoPort),
  );
  assert.equal(out, 'echo:abc');
});

test('writes take bytes only', async () => {
  await assert.rejects(
    run(`const s = connect('localhost:${echoPort}'); await s.writable.getWriter().write('text')`, local(echoPort)),
    /takes bytes/,
  );
});

test('close() ends both streams and resolves closed', async () => {
  const out = await run(
    `const s = connect('localhost:${echoPort}');
     await s.opened;
     const r = s.readable.getReader();
     const pending = r.read();
     await s.close();
     const after = await pending;
     let wrote;
     try { await s.writable.getWriter().write(new Uint8Array(1)); wrote = 'yes'; } catch (e) { wrote = e.message; }
     return [after.done, wrote];`,
    local(echoPort),
  );
  assert.deepEqual(out, [true, 'the socket is closed']);
});

test('TLS with a trusted CA, and refused without it', async () => {
  const code = `${H}
    const s = connect('localhost:${tlsPort}', { secureTransport: 'on' });
    const w = s.writable.getWriter(), r = s.readable.getReader();
    await w.write(enc.encode('secret'));
    const t = await readText(r);
    await s.close();
    return t;`;
  assert.equal(await run(code, local(tlsPort)), 'tls:secret');
  const { ca: _, ...untrusted } = local(tlsPort);
  await assert.rejects(run(code, untrusted), /certificate/);
});

test('startTls upgrades a plain connection', async () => {
  const out = await run(
    `${H}
     const plain = connect('localhost:${startTlsPort}', { secureTransport: 'starttls' });
     let w = plain.writable.getWriter(), r = plain.readable.getReader();
     await w.write(enc.encode('STARTTLS\\n'));
     const ok = await readText(r);
     w.releaseLock(); r.releaseLock();
     const secure = plain.startTls();
     await plain.closed;
     w = secure.writable.getWriter(); r = secure.readable.getReader();
     await w.write(enc.encode('hello'));
     const reply = await readText(r);
     const info = await secure.opened;
     await secure.close();
     return [ok, reply, plain.upgraded, secure.secureTransport, typeof info.remoteAddress];`,
    local(startTlsPort),
  );
  assert.deepEqual(out, ['OK\n', 'tls:hello', true, 'on', 'string']);
});

test('startTls refuses bytes sent before the handshake, and checks the hostname', async () => {
  const handshake = (port, options = '') => `${H}
    const plain = connect('localhost:${port}', { secureTransport: 'starttls' });
    const w = plain.writable.getWriter(), r = plain.readable.getReader();
    await w.write(enc.encode('STARTTLS\\n'));
    await r.read();
    await new Promise((res) => setTimeout(res, 50));
    w.releaseLock(); r.releaseLock();
    const secure = plain.startTls(${options});
    await secure.opened;`;
  await assert.rejects(run(handshake(injectingPort), local(injectingPort)), /sent data before the TLS handshake/);
  await assert.rejects(
    run(handshake(startTlsPort, `{ expectedServerHostname: 'db.example.com' }`), local(startTlsPort)),
    /db\.example\.com|altnames|certificate/i,
  );
});

test('startTls only for starttls sockets, once', async () => {
  const out = await run(
    `const errors = [];
     const a = connect('localhost:${echoPort}');
     try { a.startTls(); } catch (e) { errors.push(e.message); }
     const b = connect('localhost:${echoPort}', { secureTransport: 'starttls' });
     b.startTls();
     try { b.startTls(); } catch (e) { errors.push(e.message); }
     try { connect('localhost:${echoPort}', { secureTransport: 'sometimes' }); } catch (e) { errors.push(e.message); }
     await a.close();
     return errors;`,
    local(echoPort),
  );
  assert.deepEqual(out, [
    "startTls() needs a socket opened with secureTransport: 'starttls'",
    'startTls() was already called on this socket',
    "connect: secureTransport must be 'off', 'on', or 'starttls'",
  ]);
});

test('the policy: refusals reject opened and closed', async () => {
  denials.length = 0;
  const policy = { hosts: ['db.example.com:5432', '*.example.com:443'] };
  const refusal = (address) =>
    run(
      `const s = connect(${JSON.stringify(address)});
       const [o, c] = await Promise.allSettled([s.opened, s.closed]);
       return [o.status, c.status, o.reason?.message];`,
      policy,
    );
  assert.deepEqual(await refusal(`localhost:${echoPort}`), ['rejected', 'rejected', `connect to localhost:${echoPort} is not allowed by the connect policy`]);
  assert.deepEqual(await refusal('10.0.0.1:5432'), ['rejected', 'rejected', 'connect to 10.0.0.1:5432 is not allowed: not a public address']);
  assert.deepEqual(denials.map((d) => [d.api, d.target]), [
    ['connect', `localhost:${echoPort}`],
    ['connect', '10.0.0.1:5432'],
  ]);
  // Malformed addresses throw right away.
  const thrown = await run(
    `return ['nope', 'localhost:99999', '::1:80', { hostname: '', port: 1 }].map((a) => { try { connect(a); } catch (e) { return e.message; } })`,
    policy,
  );
  assert.deepEqual(thrown, [
    'connect: the address must be "hostname:port"',
    'connect: expected a port from 1 to 65535',
    'connect: write an IPv6 address in brackets: "[::1]:5432"',
    'connect: the address has no hostname',
  ]);
});

test('the connection limit', async () => {
  const out = await run(
    `const a = connect('localhost:${echoPort}');
     await a.opened;
     const b = connect('localhost:${echoPort}');
     const r = await b.opened.then(() => 'opened', (e) => e.message);
     await a.close();
     return r;`,
    { ...local(echoPort), limits: { connections: 1 } },
  );
  assert.equal(out, 'connect: this isolate already has 1 sockets open (connect.limits.connections)');
});

test('a closed isolate closes its sockets', async () => {
  let closed;
  const seen = new Promise((r) => (closed = r));
  const port = await listen(
    createTcpServer((sock) => {
      sock.on('close', closed);
      sock.on('error', () => {});
    }),
  );
  const vm = runtime.tenant('sockets').isolate({ web: true, connect: local(port) });
  await vm.eval(`globalThis.s = connect('localhost:${port}'); s.opened.then(() => 1)`);
  vm.close();
  await seen;
});

test('the connection limit holds for opens racing each other', async () => {
  const slow = { ...local(echoPort), hosts: async () => (await new Promise((r) => setTimeout(r, 30)), true), limits: { connections: 2 } };
  const out = await run(
    `const all = Array.from({ length: 6 }, () => connect('localhost:${echoPort}'));
     const r = await Promise.allSettled(all.map((s) => s.opened));
     await Promise.all(all.map((s) => s.close().catch(() => {})));
     return r.map((x) => x.status);`,
    slow,
  );
  assert.equal(out.filter((s) => s === 'fulfilled').length, 2, out.join());
});

test('a name that resolves only to private addresses is a policy denial', async () => {
  denials.length = 0;
  const out = await run(
    `const s = connect('localhost:${echoPort}');
     return await s.opened.then(() => 'opened', (e) => e.message);`,
    { hosts: [`localhost:${echoPort}`] },
  );
  assert.match(out, /no public address/);
  assert.deepEqual(denials.map((d) => [d.api, d.target, d.reason]), [['connect', `localhost:${echoPort}`, 'not a public address']]);
  denials.length = 0;
  const fetched = await runtime.run(`fetch('http://localhost:${echoPort}/').then(() => 'ok', (e) => e.message)`, {
    tenant: 'sockets',
    fetch: { hosts: ['localhost'] },
  });
  assert.match(fetched, /no public address/);
  assert.deepEqual(denials.map((d) => [d.api, d.target, d.reason]), [['fetch', `http://localhost:${echoPort}/`, 'not a public address']]);
});
