// The web platform (web: true): WinterTC Minimum Common API phases 1
// to 4, end to end through a real worker. Needs ISOLANE_WORKER.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Runtime } from '../dist/index.js';

const logs = [];
const runtime = new Runtime({ strict: process.env.ISOLANE_STRICT === '1', hooks: { onLog: (e) => logs.push(e) } });
const devBuild = process.env.ISOLANE_DEV_INSECURE === '1' && 'the dev build has no clock patch';
after(() => runtime.close());
const W = { tenant: 'web', web: true };
const run = (code, opts = {}) => runtime.run(code, { ...W, ...opts });

test('off by default: plain ECMAScript', async () => {
  assert.deepEqual(
    await runtime.run('[typeof URL, typeof TextEncoder, typeof crypto, typeof structuredClone, typeof performance]', { tenant: 'web' }),
    ['undefined', 'undefined', 'undefined', 'undefined', 'undefined'],
  );
});

test('the globals exist and are non-enumerable', async () => {
  const names = [
    'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'atob', 'btoa', 'Event', 'EventTarget', 'CustomEvent',
    'ErrorEvent', 'AbortController', 'AbortSignal', 'DOMException', 'structuredClone', 'performance',
    'queueMicrotask', 'reportError', 'self', 'navigator', 'crypto',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'ReadableStream', 'WritableStream',
    'TransformStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy', 'ReadableStreamBYOBReader',
    'Blob', 'File', 'FileReader', 'TextEncoderStream', 'TextDecoderStream', 'CompressionStream',
    'DecompressionStream', 'Headers', 'Request', 'Response', 'FormData', 'fetch',
    'MessageChannel', 'MessagePort', 'MessageEvent', 'Crypto', 'CryptoKey', 'SubtleCrypto',
  ];
  const types = await run(`${JSON.stringify(names)}.map((n) => typeof globalThis[n])`);
  assert.ok(types.every((t) => t !== 'undefined'), JSON.stringify(Object.fromEntries(names.map((n, i) => [n, types[i]]))));
  assert.equal(await run('Object.keys(globalThis).length'), 0);
});

test('the runtime internals are unreachable', async () => {
  assert.deepEqual(
    await run(`[typeof __bootstrap, typeof Deno, typeof core, Object.getOwnPropertyNames(globalThis).filter((n) => /bootstrap|^op_|__isolane/.test(n))]`),
    ['undefined', 'undefined', 'undefined', []],
  );
  // A setter planted before a lazy load can't catch the bootstrap object.
  assert.equal(
    await run(`let stolen; Object.defineProperty(globalThis, '__bootstrap', { set(v) { stolen = v }, get() { return stolen } });
      new URL('https://a.b'); new TextDecoder(); structuredClone(1); typeof stolen`),
    'undefined',
  );
});

test('isolates from the snapshot share nothing per isolate', async () => {
  // Randomness: fresh per isolate, reproducible with a seed.
  const draw = '[Math.random(), crypto.randomUUID()]';
  const [a, b] = [await run(draw), await run(draw)];
  assert.notEqual(a[0], b[0]);
  assert.notEqual(a[1], b[1]);
  assert.deepEqual(await run(draw, { random: { seed: 9 } }), await run(draw, { random: { seed: 9 } }));
  // The time origin is each isolate's start, not the snapshot's.
  const first = await run('performance.timeOrigin');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok((await run('performance.timeOrigin')) - first >= 20);
  // State set in one isolate doesn't reach the next: globals, base URL, limits.
  await run('globalThis.leak = 1; URL.leak = 2; location.href', { web: { baseUrl: 'https://one.example/' } });
  assert.deepEqual(await run('[typeof leak, typeof URL.leak, typeof location]'), ['undefined', 'undefined', 'undefined']);
  assert.equal(await run('new Request("/x").url', { web: { baseUrl: 'https://two.example/' } }), 'https://two.example/x');
  assert.equal(await run('let n = 0; try { for (;;) { setTimeout(() => {}, 1e6); n++ } } catch { n }', { limits: { timers: 3 } }), 3);
  // Every global is a plain value from the start (not an accessor).
  assert.deepEqual(
    await run('["URL", "fetch", "ReadableStream", "Response"].map((n) => "value" in Object.getOwnPropertyDescriptor(globalThis, n))'),
    [true, true, true, true],
  );
});

test('works with code generation off', async () => {
  assert.equal(await run('new URL("https://x.y/z").pathname + typeof eval("1")', { eval: true }), '/znumber');
  assert.equal(await run('new URL("https://x.y/z").pathname'), '/z');
  await assert.rejects(run('eval("1")'), /EvalError/);
});

test('URL and URLSearchParams', async () => {
  assert.equal(await run('new URL("../b?x=1#h", "https://Example.com/a/c").href'), 'https://example.com/b?x=1#h');
  assert.equal(
    await run('const u = new URL("http://a.com"); u.pathname = "/p q"; u.searchParams.set("k", "v w"); u.port = "8080"; u.href'),
    'http://a.com:8080/p%20q?k=v+w',
  );
  assert.equal(await run('new URL("https://xn--nxasmq6b.example/").hostname'), 'xn--nxasmq6b.example');
  assert.equal(await run('new URL("https://日本.jp/").hostname'), 'xn--wgv71a.jp');
  assert.equal(await run('URL.canParse("not a url")'), false);
  await assert.rejects(run('new URL("nope")'), /TypeError/);
  assert.deepEqual(await run('[...new URLSearchParams("a=1&b=%20&a=3")]'), [['a', '1'], ['b', ' '], ['a', '3']]);
  assert.equal(await run('const p = new URLSearchParams({ z: "1", a: "é" }); p.sort(); p.toString()'), 'a=%C3%A9&z=1');
});

test('TextEncoder and TextDecoder', async () => {
  assert.deepEqual(await run('[...new TextEncoder().encode("hé🌍")]'), [104, 195, 169, 240, 159, 140, 141]);
  assert.deepEqual(await run('[...new TextEncoder().encode("\\ud800")]'), [239, 191, 189]); // lone surrogate → U+FFFD
  assert.deepEqual(await run('new TextEncoder().encodeInto("héllo", new Uint8Array(3))'), { read: 2, written: 3 });
  assert.equal(await run('new TextDecoder().decode(new Uint8Array([0xef, 0xbb, 0xbf, 104, 0xff]))'), 'h�');
  assert.equal(await run('new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf]))'), '﻿');
  await assert.rejects(run('new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff]))'), /TypeError/);
  assert.equal(await run('new TextDecoder("windows-1252").decode(new Uint8Array([0x80, 0x41]))'), '€A');
  assert.equal(await run('new TextDecoder("shift_jis").decode(new Uint8Array([0x82, 0xa0]))'), 'あ');
  assert.equal(await run('new TextDecoder("latin1").encoding'), 'windows-1252');
  await assert.rejects(run('new TextDecoder("klingon")'), /RangeError/);
  assert.equal(
    await run(`const d = new TextDecoder();
      d.decode(new Uint8Array([0xe2, 0x82]), { stream: true }) + d.decode(new Uint8Array([0xac])) + d.decode(new Uint8Array([0xe2]))`),
    '€�',
  );
});

test('atob and btoa', async () => {
  assert.deepEqual(await run('[btoa("hi"), atob("aGk="), atob(" aG k "), btoa("\\xff")]'), ['aGk=', 'hi', 'hi', '/w==']);
  assert.equal(await run('try { atob("a") } catch (e) { e.name }'), 'InvalidCharacterError');
  assert.equal(await run('try { btoa("€") } catch (e) { e.name }'), 'InvalidCharacterError');
});

test('Event, EventTarget, CustomEvent, and the global object', async () => {
  assert.deepEqual(
    await run(`const t = new EventTarget(); const seen = [];
      t.addEventListener("x", (e) => seen.push(e.detail), { once: true });
      t.dispatchEvent(new CustomEvent("x", { detail: 1 })); t.dispatchEvent(new CustomEvent("x", { detail: 2 }));
      [seen, globalThis instanceof EventTarget]`),
    [[1], true],
  );
});

test('AbortController and AbortSignal', async () => {
  assert.deepEqual(
    await run(`const c = new AbortController(); let fired = 0; c.signal.onabort = () => fired++; c.abort("why");
      [c.signal.aborted, c.signal.reason, fired, AbortSignal.any([AbortSignal.abort(7)]).reason,
       (() => { try { c.signal.throwIfAborted() } catch (e) { return e } })()]`),
    [true, 'why', 1, 7, 'why'],
  );
  assert.equal(await run('AbortSignal.abort().reason.name'), 'AbortError');
});

test('DOMException', async () => {
  assert.deepEqual(
    await run('const e = new DOMException("m", "NotFoundError"); [e.name, e.message, e.code, e instanceof Error]'),
    ['NotFoundError', 'm', 8, true],
  );
});

test('structuredClone', async () => {
  assert.deepEqual(
    await run(`const o = { a: new Map([[1, { b: 2n }]]), d: new Date(5), u: new Uint16Array([1, 2]), s: new Set(["x"]), r: /x/g };
      o.self = o; const c = structuredClone(o);
      [c !== o, c.self === c, c.a.get(1).b === 2n, c.d.getTime(), [...c.u], [...c.s], c.r.flags]`),
    [true, true, true, 5, [1, 2], ['x'], 'g'],
  );
  assert.equal(await run('try { structuredClone(() => 1) } catch (e) { e.name }'), 'DataCloneError');
  assert.equal(await run('try { structuredClone(Symbol()) } catch (e) { e.name }'), 'DataCloneError');
  // Platform objects aren't cloneable, even nested.
  assert.equal(await run('try { structuredClone({ u: new URL("https://a.b") }) } catch (e) { e.name }'), 'DataCloneError');
});

test('structuredClone transfers ArrayBuffers and keeps resizable ones resizable', async () => {
  assert.deepEqual(
    await run(`const b = new ArrayBuffer(8, { maxByteLength: 16 });
      new Uint8Array(b)[0] = 7;
      const c = structuredClone({ b }, { transfer: [b] }).b;
      const kept = structuredClone(new ArrayBuffer(2, { maxByteLength: 4 }));
      [b.detached, b.byteLength, c.byteLength, c.resizable, c.maxByteLength, new Uint8Array(c)[0], kept.maxByteLength]`),
    [true, 0, 8, true, 16, 7, 4],
  );
  const name = (code) => run(`try { ${code}; 'no error' } catch (e) { e.name }`);
  // A detached buffer, a non-transferable platform object, and a view out
  // of bounds of its (shrunk) buffer can't be cloned.
  assert.equal(await name('const b = new ArrayBuffer(1); structuredClone(b, { transfer: [b] }); structuredClone(b, { transfer: [b] })'), 'DataCloneError');
  assert.equal(await name('const b = new Blob(); structuredClone(b, { transfer: [b] })'), 'DataCloneError');
  assert.equal(await name('const b = new ArrayBuffer(8, { maxByteLength: 8 }); const v = new Uint8Array(b, 4, 4); b.resize(2); structuredClone(v)'), 'DataCloneError');
  // A failed transfer detaches nothing.
  assert.deepEqual(await run('const b = new ArrayBuffer(1); try { structuredClone([b, () => 1], { transfer: [b] }) } catch {} [b.detached, b.byteLength]'), [false, 1]);
});

test('MessageChannel: each message is a task, in order, and ports transfer', async () => {
  assert.deepEqual(
    await run(`(async () => {
      const { port1, port2 } = new MessageChannel();
      const seen = [];
      const done = new Promise((resolve) => {
        port2.onmessage = (e) => {
          seen.push(e.data);
          queueMicrotask(() => seen.push('micro'));
          if (e.data === 3) resolve();
        };
      });
      port1.postMessage(1); port1.postMessage(2); port1.postMessage(3);
      seen.push('sync');
      await done;
      // Transfer a port: messages to it arrive where it went.
      const other = new MessageChannel();
      const arrived = new Promise((resolve) => (other.port2.onmessage = (e) => resolve(e.ports[0])));
      other.port1.postMessage('here', [port2]);
      const moved = await arrived;
      const got = new Promise((resolve) => (moved.onmessage = (e) => resolve(e.data)));
      port1.postMessage('to the moved port');
      const text = await got;
      const buf = new Uint8Array([1, 2]).buffer;
      const ab = new Promise((resolve) => (moved.onmessage = (e) => resolve(e.data.byteLength)));
      port1.postMessage(buf, [buf]);
      return [seen, text, buf.byteLength, await ab];
    })()`),
    [['sync', 1, 'micro', 2, 'micro', 3, 'micro'], 'to the moved port', 0, 2],
  );
});

test('MessageChannel: close stops delivery, and a listening port never holds an eval', async () => {
  assert.deepEqual(
    await run(`(async () => {
      const { port1, port2 } = new MessageChannel();
      let got = 0;
      port2.onmessage = () => got++;
      port1.postMessage(1);
      await new Promise((r) => setTimeout(r, 5));
      port2.close();
      port1.postMessage(2);
      await new Promise((r) => setTimeout(r, 5));
      return got;
    })()`),
    1,
  );
  assert.equal(await run('new MessageChannel().port1.onmessage = () => {}; "returned"'), 'returned');
  await assert.rejects(run('new MessagePort()'), (e) => e.guest?.name === 'TypeError');
});

test('performance', async () => {
  assert.deepEqual(
    await run(`performance.mark("a"); performance.measure("m", "a");
      [typeof performance.now(), performance.timeOrigin > 1e12, performance.getEntriesByType("measure").length]`),
    ['number', true, 1],
  );
  assert.deepEqual(await run('[performance.now(), performance.timeOrigin]', { time: { fixedMs: 1e12 } }), [0, 1e12]);
});

test('performance.now follows the frozen clock', { skip: process.env.ISOLANE_DEV_INSECURE === '1' && 'the dev build has no clock patch' }, async () => {
  assert.equal(await run('const t = performance.now(); let x = 0; for (let i = 0; i < 3e7; i++) x += i; performance.now() - t'), 0);
});

test('queueMicrotask and reportError', async () => {
  logs.length = 0;
  assert.equal(await run('new Promise((r) => { queueMicrotask(() => { throw new Error("in microtask") }); queueMicrotask(() => r(2)) })'), 2);
  assert.equal(
    await run('addEventListener("error", (e) => { e.preventDefault(); globalThis.seen = e.error.message }); reportError(new Error("boom")); seen'),
    'boom',
  );
  await run('reportError(new Error("nobody listens"))');
  assert.deepEqual(logs.map((l) => [l.level, l.message.split('\n')[0]]), [
    ['error', 'Uncaught Error: in microtask'],
    ['error', 'Uncaught Error: nobody listens'],
  ]);
});

test('crypto.getRandomValues and randomUUID', async () => {
  const [uuid, n, filled] = await run('[crypto.randomUUID(), crypto.getRandomValues(new Uint32Array(8)).length, crypto.getRandomValues(new Uint8Array(32)).some((b) => b)]');
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(n, 8);
  assert.equal(filled, true);
  assert.equal(await run('try { crypto.getRandomValues(new Float32Array(1)) } catch (e) { e.name }'), 'TypeMismatchError');
  assert.equal(await run('try { crypto.getRandomValues(new Uint8Array(65537)) } catch (e) { e.name }'), 'QuotaExceededError');
  const draw = '[crypto.randomUUID(), [...crypto.getRandomValues(new Uint8Array(4))], Math.random()]';
  assert.deepEqual(await run(draw, { random: { seed: 9 } }), await run(draw, { random: { seed: 9 } }));
  assert.notDeepEqual(await run(draw), await run(draw));
});

test('crypto.subtle: digests, MACs, ciphers, signatures, and key derivation', async () => {
  const result = await run(`(async () => {
    const { subtle } = crypto;
    const enc = new TextEncoder();
    const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
    const out = {};
    out.sha256 = hex(await subtle.digest('SHA-256', enc.encode('abc')));
    const hmacKey = await subtle.importKey('raw', enc.encode('key'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const mac = await subtle.sign('HMAC', hmacKey, enc.encode('The quick brown fox jumps over the lazy dog'));
    out.hmac = hex(mac);
    out.hmacVerifies = await subtle.verify('HMAC', hmacKey, mac, enc.encode('The quick brown fox jumps over the lazy dog'));
    const aes = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode('hello'));
    out.aes = new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv }, aes, sealed));
    new Uint8Array(sealed)[0] ^= 1;
    out.tampered = await subtle.decrypt({ name: 'AES-GCM', iv }, aes, sealed).then(() => 'decrypted', (e) => e.name);
    for (const alg of [{ name: 'ECDSA', namedCurve: 'P-256' }, { name: 'Ed25519' }]) {
      const pair = await subtle.generateKey(alg, true, ['sign', 'verify']);
      const params = { name: alg.name, hash: 'SHA-256' };
      const sig = await subtle.sign(params, pair.privateKey, enc.encode('m'));
      out[alg.name] = [await subtle.verify(params, pair.publicKey, sig, enc.encode('m')), await subtle.verify(params, pair.publicKey, sig, enc.encode('n'))];
    }
    const password = await subtle.importKey('raw', enc.encode('password'), 'PBKDF2', false, ['deriveBits']);
    out.pbkdf2 = hex(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('salt'), iterations: 1 }, password, 256));
    return out;
  })()`);
  assert.deepEqual(result, {
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    hmac: 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    hmacVerifies: true,
    aes: 'hello',
    tampered: 'OperationError',
    ECDSA: [true, false],
    Ed25519: [true, false],
    pbkdf2: '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b',
  });
});

test('crypto.subtle: keys come from the isolate\'s randomness, so a seed reproduces them', async () => {
  const draw = `(async () => {
    const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, true, ['sign']);
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const bytes = async (k, f) => [...new Uint8Array(await crypto.subtle.exportKey(f, k))];
    return [await bytes(key, 'raw'), await bytes(pair.publicKey, 'raw')];
  })()`;
  assert.deepEqual(await run(draw, { random: { seed: 7 } }), await run(draw, { random: { seed: 7 } }));
  assert.notDeepEqual(await run(draw), await run(draw));
});

test('crypto.subtle: a non-extractable key\'s material stays out of reach', async () => {
  const result = await run(`(async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt']);
    const out = {};
    out.exportKey = await crypto.subtle.exportKey('raw', key).then(() => 'exported', (e) => e.name);
    // Nothing on the key leads to its bytes: no string or symbol property,
    // and Deno's registered host-object symbol isn't there.
    const reachable = [];
    for (const k of Reflect.ownKeys(key)) {
      const v = key[k];
      if (v instanceof Uint8Array || typeof v === 'function') reachable.push(String(k));
      if (v && typeof v === 'object') for (const kk of Reflect.ownKeys(v)) if (v[kk] instanceof Uint8Array) reachable.push(String(k) + '.' + String(kk));
    }
    out.reachable = reachable;
    out.hostObject = typeof key[Symbol.for('Deno.core.hostObject')];
    // It still clones (within the isolate), as a working key.
    const clone = structuredClone(key);
    const iv = new Uint8Array(12);
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array([1, 2, 3]));
    out.clone = [clone instanceof CryptoKey, [...new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, clone, sealed))]];
    // Guest code can't forge one from bytes of its choice through the host-object symbol.
    const forged = { [Symbol.for('Deno.core.hostObject')]: () => ({ type: 'CryptoKey', keyType: 'secret', extractable: true, usages: ['encrypt'], algorithm: { name: 'AES-GCM', length: 128 }, keyData: { type: 'secret', data: new Uint8Array(16) } }) };
    try { out.forged = structuredClone(forged) instanceof CryptoKey; } catch (e) { out.forged = e.name; }
    return out;
  })()`);
  assert.equal(result.exportKey, 'InvalidAccessError');
  assert.deepEqual(result.reachable, []);
  assert.equal(result.hostObject, 'undefined');
  assert.deepEqual(result.clone, [true, [1, 2, 3]]);
  assert.notEqual(result.forged, true);
});

test('crypto.subtle: long native work stops at the isolate\'s limits', async () => {
  // PBKDF2 with 2^32 - 1 iterations would run for hours; it stops with the eval.
  const started = Date.now();
  await assert.rejects(
    run(`(async () => {
      const k = await crypto.subtle.importKey('raw', new Uint8Array(8), 'PBKDF2', false, ['deriveBits']);
      return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(8), iterations: 2 ** 32 - 1 }, k, 256);
    })()`, { limits: { timeoutMs: 300 } }),
    (err) => err.code === 'ERR_LIMIT' && err.limit === 'timeoutMs',
  );
  assert.ok(Date.now() - started < 10_000);
  // RSA keys are capped at 4096 bits (generation can't be interrupted).
  assert.equal(
    await run(`crypto.subtle.generateKey({ name: 'RSA-PSS', modulusLength: 8192, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['sign']).then(() => 'generated', (e) => e.name)`),
    'OperationError',
  );
});

test('self and navigator', async () => {
  assert.deepEqual(await run('[self === globalThis, navigator.userAgent]'), [true, 'isolane']);
});

test('lone surrogates in code or host errors no longer crash the worker', async () => {
  // A raw lone surrogate can't cross the UTF-8 protocol; it becomes U+FFFD.
  assert.equal(await runtime.run('"\ud800"', { tenant: 'web' }), '�');
  const host = { bad: () => { throw new Error('bad \udc00'); } };
  assert.equal(await runtime.run('bad().catch((e) => e.message)', { tenant: 'web', host }), 'bad �');
});

// ---- phase 2: timers and the event loop ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('setTimeout runs in deadline order, then creation order', async () => {
  assert.deepEqual(
    await run(`new Promise((done) => {
      const out = [];
      setTimeout(() => out.push('b'), 10);
      setTimeout(() => out.push('a1'), 0);
      setTimeout(() => out.push('a2'), 0);
      setTimeout((x, y) => { out.push(x + y); done(out); }, 20, 'c', '!');
    })`),
    ['a1', 'a2', 'b', 'c!'],
  );
});

test('each timer callback is its own task: microtasks run in between', async () => {
  assert.deepEqual(
    await run(`new Promise((done) => {
      const out = [];
      setTimeout(() => { out.push(1); Promise.resolve().then(() => out.push('micro')); }, 0);
      setTimeout(() => { out.push(2); done(out); }, 0);
    })`),
    [1, 'micro', 2],
  );
});

test('clearTimeout, setInterval, clearInterval', async () => {
  assert.equal(
    await run(`new Promise((done) => { const id = setTimeout(() => done('no'), 5); clearTimeout(id); setTimeout(() => done('cleared'), 15); })`),
    'cleared',
  );
  assert.equal(
    await run(`new Promise((done) => { let n = 0; const id = setInterval(() => { if (++n === 4) { clearInterval(id); setTimeout(() => done(n), 20); } }, 2); })`),
    4,
  );
});

test('nested timers are clamped to 4 ms past nesting level 5', async () => {
  const gaps = await run(`new Promise((done) => {
    const at = [];
    const tick = () => { at.push(performance.now()); if (at.length < 10) setTimeout(tick, 0); else done(at); };
    setTimeout(tick, 0);
  })`, { time: 'real' });
  const late = gaps.slice(6).map((t, i) => t - gaps[5 + i]);
  assert.ok(late.every((g) => g >= 3.5), `gaps past level 5: ${late.map((g) => g.toFixed(1))}`);
});

test('a callback that throws reports an error event and the loop goes on', async () => {
  assert.equal(
    await run(`new Promise((done) => {
      addEventListener('error', (e) => { e.preventDefault(); });
      setTimeout(() => { throw new Error('boom'); }, 0);
      setTimeout(() => done('still running'), 5);
    })`),
    'still running',
  );
});

test('an isolate holds at most 10,000 timers', async () => {
  assert.equal(await run(`try { for (let i = 0; i < 10001; i++) setTimeout(() => {}, 1e6); 'no limit' } catch (e) { e.name + ': ' + /10000/.test(e.message) }`), 'RangeError: true');
  // Cancelled timers free their slots.
  assert.equal(await run(`for (let i = 0; i < 20000; i++) clearTimeout(setTimeout(() => {}, 1e6)); 'ok'`), 'ok');
});

test('a pending eval waits for timers, within timeoutMs', async () => {
  assert.equal(await run('new Promise((r) => setTimeout(() => r(1), 30))'), 1);
  await assert.rejects(run('new Promise((r) => setTimeout(r, 5000))', { limits: { timeoutMs: 100 } }), (e) => e.code === 'ERR_LIMIT' && e.limit === 'timeoutMs');
  // Only a timer nobody waits on (an unobserved AbortSignal.timeout) is not enough.
  await assert.rejects(run('AbortSignal.timeout(10); new Promise(() => {})'), (e) => e.code === 'ERR_UNSETTLED');
});

test('AbortSignal.timeout', async () => {
  assert.deepEqual(
    await run(`new Promise((done) => { const s = AbortSignal.timeout(10); s.onabort = () => done([s.aborted, s.reason.name]); })`),
    [true, 'TimeoutError'],
  );
});

test('timers left when run() returns never fire', async () => {
  const before = logs.length;
  assert.equal(await run(`setTimeout(() => console.log('late'), 0); setInterval(() => console.log('late'), 1); 1`), 1);
  await sleep(100);
  assert.equal(logs.slice(before).filter((e) => e.message === 'late').length, 0);
});

test('a stateful isolate keeps its timers between evals', async () => {
  const vm = runtime.tenant(W.tenant).isolate({ web: true, limits: { timeoutMs: 1000 } });
  await vm.eval('globalThis.hits = 0; globalThis.id = setInterval(() => hits++, 10); setTimeout(() => { globalThis.later = true }, 20)');
  await sleep(150);
  const [hits, later] = await vm.eval('clearInterval(id); [hits, later]');
  assert.ok(hits >= 5, `${hits} interval ticks while idle`);
  assert.equal(later, true);
  vm.close();
});

test('timers advance the frozen clock', { skip: devBuild }, async () => {
  const moved = await run('(async () => { const t0 = Date.now(); await new Promise((r) => setTimeout(r, 50)); return Date.now() - t0; })()');
  assert.ok(moved >= 45, `clock moved ${moved}ms over a 50 ms timer`);
  // ...but not while code runs.
  assert.equal(await run('const t0 = Date.now(); let x = 0; for (let i = 0; i < 3e7; i++) x += i; Date.now() - t0'), 0);
});

test('setTimeout with a string needs eval', async () => {
  // HTML reports the timer task's error rather than throwing it anywhere.
  const before = logs.length;
  await assert.rejects(run(`new Promise((r) => { globalThis.r = r; setTimeout("r(1)", 0); })`), (e) => e.code === 'ERR_UNSETTLED');
  assert.ok(logs.slice(before).some((e) => e.level === 'error' && /EvalError/.test(e.message)));
  assert.equal(await run(`new Promise((r) => { globalThis.r = r; setTimeout("r(1)", 0); })`, { eval: true }), 1);
});

// ---- phase 2: streams ----

test('ReadableStream, async iteration, tee', async () => {
  assert.deepEqual(
    await run(`(async () => {
      const rs = new ReadableStream({ start(c) { c.enqueue(1); c.enqueue(2); c.close(); } });
      const [a, b] = rs.tee();
      const out = [];
      for await (const x of a) out.push(x);
      const r = b.getReader();
      out.push((await r.read()).value, (await r.read()).value, (await r.read()).done);
      return out;
    })()`),
    [1, 2, 1, 2, true],
  );
});

test('pipeThrough, pipeTo, WritableStream backpressure', async () => {
  assert.deepEqual(
    await run(`(async () => {
      const seen = [];
      const ws = new WritableStream({ write(chunk) { seen.push(chunk); } }, new CountQueuingStrategy({ highWaterMark: 1 }));
      const upper = new TransformStream({ transform(chunk, c) { c.enqueue(chunk.toUpperCase()); } });
      await new ReadableStream({ start(c) { c.enqueue('a'); c.enqueue('b'); c.close(); } }).pipeThrough(upper).pipeTo(ws);
      return seen;
    })()`),
    ['A', 'B'],
  );
});

test('byte streams and BYOB readers', async () => {
  assert.deepEqual(
    await run(`(async () => {
      const rs = new ReadableStream({ type: 'bytes', start(c) { c.enqueue(new Uint8Array([1, 2, 3, 4])); c.close(); } });
      const r = rs.getReader({ mode: 'byob' });
      const first = await r.read(new Uint8Array(2));
      const second = await r.read(new Uint8Array(8));
      return [[...first.value], [...second.value], new ByteLengthQueuingStrategy({ highWaterMark: 16 }).size(new Uint8Array(3))];
    })()`),
    [[1, 2], [3, 4], 3],
  );
});

// ---- phase 2: Blob, File, FileReader, encoding streams, compression ----

test('Response bodies are byte streams, and pipeTo never writes inside enqueue()', async () => {
  assert.deepEqual(
    await run(`(async () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const reader = new Response(bytes).body.getReader({ mode: 'byob' });
      const first = await reader.read(new Uint8Array(2));
      const second = await reader.read(new Uint8Array(2));
      const end = await reader.read(new Uint8Array(2));
      let controller, synchronous = false;
      new ReadableStream({ start(c) { controller = c; } }, { highWaterMark: 0 })
        .pipeTo(new WritableStream({ write() { synchronous = true; } }));
      await Promise.resolve();
      controller.enqueue('x');
      const during = synchronous;
      await new Promise((r) => setTimeout(r, 0));
      return [[...first.value], [...second.value], end.done, [...bytes], during, synchronous];
    })()`),
    [[1, 2], [3], true, [1, 2, 3], false, true],
  );
});

test('Blob and File', async () => {
  assert.deepEqual(
    await run(`(async () => {
      const b = new Blob(['héllo ', new Uint8Array([119, 111]), new Blob(['rld'])], { type: 'Text/Plain' });
      const f = new File([b], 'a.txt', { lastModified: 42 });
      const streamed = [];
      for await (const chunk of b.stream()) streamed.push(...chunk);
      return [b.size, b.type, await b.text(), await b.slice(1, 5).text(), (await b.arrayBuffer()).byteLength,
        new TextDecoder().decode(new Uint8Array(streamed)), f.name, f.lastModified, f instanceof Blob, await f.text()];
    })()`),
    [12, 'text/plain', 'héllo world', 'éll', 12, 'héllo world', 'a.txt', 42, true, 'héllo world'],
  );
});

test('FileReader', async () => {
  assert.deepEqual(
    await run(`new Promise((done) => { const r = new FileReader(); r.onload = () => done([r.result, r.readyState]); r.readAsText(new Blob(['hi'])); })`),
    ['hi', 2],
  );
});

test('structuredClone and object URLs for Blob and File', async () => {
  assert.deepEqual(
    await run(`(async () => {
      const f = structuredClone(new File(['abc'], 'x.bin', { type: 'a/b' }));
      const url = URL.createObjectURL(f);
      URL.revokeObjectURL(url);
      return [f instanceof File, f.name, f.type, await f.text(), url.startsWith('blob:null/')];
    })()`),
    [true, 'x.bin', 'a/b', 'abc', true],
  );
});

test('TextEncoderStream and TextDecoderStream', async () => {
  assert.equal(
    await run(`(async () => {
      const bytes = new ReadableStream({ start(c) { c.enqueue('wö'); c.enqueue('rld'); c.close(); } }).pipeThrough(new TextEncoderStream());
      let s = '';
      for await (const chunk of bytes.pipeThrough(new TextDecoderStream())) s += chunk;
      return s;
    })()`),
    'wörld',
  );
});

test('CompressionStream and DecompressionStream round trip', async () => {
  const roundTrip = (format) => run(`(async () => {
    const input = new TextEncoder().encode('hello '.repeat(1000));
    const z = new Blob([input]).stream().pipeThrough(new CompressionStream('${format}'));
    const compressed = [];
    for await (const c of z) compressed.push(...c);
    const back = new Blob([new Uint8Array(compressed)]).stream().pipeThrough(new DecompressionStream('${format}'));
    let n = 0;
    for await (const c of back) n += c.length;
    return [compressed.length < input.length, n];
  })()`);
  for (const format of ['gzip', 'deflate', 'deflate-raw', 'brotli']) assert.deepEqual(await roundTrip(format), [true, 6000], format);
  await assert.rejects(run(`new CompressionStream('zstd')`), (e) => e.guest?.name === 'TypeError');
  // Corrupt input fails the stream instead of crashing the worker.
  assert.match(
    await run(`(async () => { try { for await (const _ of new Blob([new Uint8Array([1, 2, 3])]).stream().pipeThrough(new DecompressionStream('gzip'))); return 'no error'; } catch (e) { return e.name; } })()`),
    /TypeError/,
  );
});

test('decompression keeps the output before trailing garbage, then errors', async () => {
  assert.deepEqual(
    await run(`(async () => {
      const z = [];
      for await (const c of new Blob(['hi']).stream().pipeThrough(new CompressionStream('gzip'))) z.push(...c);
      const ds = new DecompressionStream('gzip');
      const w = ds.writable.getWriter();
      w.write(new Uint8Array([...z, 0])).catch(() => {});
      w.close().catch(() => {}); // the error surfaces at the next write or at close
      const r = ds.readable.getReader();
      const first = await r.read();
      const second = await r.read().then(() => 'no error', (e) => e.name);
      return [new TextDecoder().decode(first.value), second];
    })()`),
    ['hi', 'TypeError'],
  );
});

test('decompression: truncated input and input after the end are errors', async () => {
  const decode = (format, mutate, close = true) => run(`(async () => {
    const z = [];
    for await (const c of new Blob(['hello']).stream().pipeThrough(new CompressionStream('${format}'))) z.push(...c);
    const ds = new DecompressionStream('${format}');
    const w = ds.writable.getWriter();
    w.write(new Uint8Array(${mutate})).catch(() => {});
    ${close ? 'w.close().catch(() => {});' : ''}
    const r = ds.readable.getReader();
    let text = '';
    try {
      for (;;) {
        const { done, value } = await r.read();
        if (done) return [text, 'done'];
        text += new TextDecoder().decode(value);
      }
    } catch (e) {
      return [text, e.name];
    }
  })()`);
  for (const format of ['deflate', 'deflate-raw', 'gzip']) {
    assert.deepEqual((await decode(format, 'z.slice(0, -1)'))[1], 'TypeError', `${format} truncated`);
    // Without closing the writer: the error comes right after the output.
    assert.deepEqual(await decode(format, '[...z, 0]', false), ['hello', 'TypeError'], `${format} extra input`);
    assert.deepEqual(await decode(format, 'z'), ['hello', 'done'], format);
  }
});

test('Blob.text() strips one UTF-8 byte order mark', async () => {
  assert.deepEqual(await run(`Promise.all([new Blob(['\ufeffA']).text(), new Blob(['\ufeff\ufeffB']).text()])`), ['A', '\ufeffB']);
});

// ---- fetch (phase 3) ----

const opened = [];
let closedEarly = 0;
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.url === '/json') return res.writeHead(200, { 'content-type': 'application/json', 'x-a': '1' }).end('{"hi":"wörld"}');
    if (req.url === '/echo') {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ method: req.method, headers: req.headers, body: body.toString('base64') }),
      );
    }
    if (req.url === '/redir') return res.writeHead(302, { location: '/json' }).end();
    if (req.url === '/redir307') return res.writeHead(307, { location: '/echo' }).end();
    if (req.url === '/no-content') return res.writeHead(204).end();
    if (req.url === '/bytes') return res.end(Buffer.from([0, 1, 2, 254, 255]));
    if (req.url === '/stream') {
      res.write('one ');
      setTimeout(() => res.write('two '), 30);
      setTimeout(() => res.end('three'), 60);
      return;
    }
    if (req.url === '/hang') {
      opened.push(req.url);
      res.write('start');
      res.on('close', () => closedEarly++);
      return; // never ends
    }
    res.writeHead(404).end('nope');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const base = `http://localhost:${server.address().port}`;
const NET = { fetch: { hosts: ['localhost'], privateNetworks: true }, limits: { timeoutMs: 5000 } };
const fetchRun = (body, opts = {}) => run(`(async () => { ${body} })()`, { ...NET, ...opts });

test('Headers, Request, Response, and FormData follow the spec', async () => {
  assert.deepEqual(
    await run(`(async () => {
      const h = new Headers([['B', '2'], ['a', '1']]);
      h.append('a', '3');
      const req = new Request('https://example.com/x?y', { method: 'post', body: 'q', headers: h });
      const res = new Response('{"k":1}', { status: 201, statusText: 'Made', headers: { 'content-type': 'application/json' } });
      const fd = new FormData();
      fd.append('f', new Blob(['data'], { type: 'text/plain' }), 'f.txt');
      fd.append('s', 'v');
      const json = await res.clone().json();
      return [[...h], h.get('A'), req.method, req.url, await req.text(), res.status, res.statusText, res.ok, json,
        await res.text(), res.bodyUsed, fd.get('s'), fd.get('f').name, [...fd.keys()],
        Response.json({ a: 1 }).headers.get('content-type'), Response.error().type, Response.redirect('https://a.example/', 301).status];
    })()`),
    [
      [['a', '1, 3'], ['b', '2']], '1, 3', 'POST', 'https://example.com/x?y', 'q', 201, 'Made', true, { k: 1 },
      '{"k":1}', true, 'v', 'f.txt', ['f', 's'], 'application/json', 'error', 301,
    ],
  );
  await assert.rejects(run(`new Response('x', { status: 99 })`), /RangeError/);
  await assert.rejects(run(`new Request('/relative')`), /TypeError/);
});

test('fetch: text, json, bytes, headers, status', async () => {
  assert.deepEqual(
    await fetchRun(`
      const r = await fetch('${base}/json');
      const b = await (await fetch('${base}/bytes')).bytes();
      const missing = await fetch('${base}/missing');
      return [r.status, r.ok, r.headers.get('x-a'), r.url, (await r.json()).hi, [...b], missing.status, await missing.text()];`),
    [200, true, '1', `${base}/json`, 'wörld', [0, 1, 2, 254, 255], 404, 'nope'],
  );
});

test('fetch: request bodies of every kind', async () => {
  const out = await fetchRun(`
    const post = async (body, init = {}) => (await (await fetch('${base}/echo', { method: 'POST', body, ...init })).json());
    const fd = new FormData(); fd.append('a', '1');
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('str')); c.enqueue(new TextEncoder().encode('eam')); c.close(); } });
    return [
      await post('text'),
      await post(new Uint8Array([0, 255])),
      await post(new Blob(['blob'], { type: 'x/y' })),
      await post(new URLSearchParams({ q: 'v w' })),
      await post(fd),
      await post(stream, { duplex: 'half' }),
    ].map((j) => [j.headers['content-type'] ?? null, atob(j.body)]);`);
  assert.deepEqual(out[0], ['text/plain;charset=UTF-8', 'text']);
  assert.deepEqual(out[1], [null, '\u0000\u00ff']);
  assert.deepEqual(out[2], ['x/y', 'blob']);
  assert.deepEqual(out[3], ['application/x-www-form-urlencoded;charset=UTF-8', 'q=v+w']);
  assert.match(out[4][0], /^multipart\/form-data; boundary=/);
  assert.match(out[4][1], /name="a"\r\n\r\n1/);
  assert.deepEqual(out[5], [null, 'stream']);
});

test('fetch: a ReadableStream request body streams to the server', async () => {
  const out = await fetchRun(`
    let pulls = 0;
    const body = new ReadableStream({
      pull(c) {
        if (++pulls > 3) return c.close();
        c.enqueue(new TextEncoder().encode('part' + pulls + ' '));
      },
    });
    const r = await (await fetch('${base}/echo', { method: 'POST', body, duplex: 'half' })).json();
    const bad = await fetch('${base}/echo', { method: 'POST', body: new ReadableStream({ start(c) { c.enqueue('not bytes'); c.close(); } }), duplex: 'half' })
      .then(() => 'ok', (e) => e.name);
    const big = await fetch('${base}/echo', { method: 'POST', body: new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); } }), duplex: 'half' })
      .then(() => 'ok', (e) => [e.name, e.message]);
    const redirected = await fetch('${base}/redir307', { method: 'POST', body: new ReadableStream({ start(c) { c.close(); } }), duplex: 'half' })
      .then(() => 'ok', (e) => e.name);
    return [atob(r.body), r.headers['transfer-encoding'], r.headers['content-length'] ?? null, bad, big, redirected];`,
    { fetch: { ...NET.fetch, limits: { requestBytes: 8192 } } },
  );
  assert.deepEqual(out.slice(0, 4), ['part1 part2 part3 ', 'chunked', null, 'TypeError']);
  assert.equal(out[4][0], 'TypeError');
  assert.match(out[4][1], /larger than 8192 bytes/);
  assert.equal(out[5], 'TypeError');
});

test('fetch: the response body streams', async () => {
  assert.deepEqual(
    await fetchRun(`
      const r = await fetch('${base}/stream');
      const reader = r.body.getReader();
      const parts = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(new TextDecoder().decode(value));
      }
      return [parts.join(''), parts.length > 1, r.bodyUsed];`),
    ['one two three', true, true],
  );
  // Byte stream: BYOB reads work.
  assert.deepEqual(
    await fetchRun(`
      const r = await fetch('${base}/bytes');
      const reader = r.body.getReader({ mode: 'byob' });
      const { value } = await reader.read(new Uint8Array(16));
      return [...value];`),
    [0, 1, 2, 254, 255],
  );
  assert.deepEqual(await fetchRun(`const r = await fetch('${base}/no-content'); return [r.status, r.body];`), [204, null]);
});

test('fetch: redirect modes', async () => {
  assert.deepEqual(
    await fetchRun(`
      const follow = await fetch('${base}/redir');
      const manual = await fetch('${base}/redir', { redirect: 'manual' });
      const error = await fetch('${base}/redir', { redirect: 'error' }).catch((e) => e);
      return [follow.status, follow.redirected, follow.url.endsWith('/json'), manual.status, manual.headers.get('location'),
        error instanceof TypeError];`),
    [200, true, true, 302, '/json', true],
  );
});

test('fetch: aborting cancels the request at the broker', async () => {
  const before = closedEarly;
  assert.deepEqual(
    await fetchRun(`
      const early = new AbortController();
      early.abort();
      const pre = await fetch('${base}/json', { signal: early.signal }).catch((e) => e.name);
      const c = new AbortController();
      const r = await fetch('${base}/hang', { signal: c.signal });
      const reader = r.body.getReader();
      await reader.read();
      c.abort();
      const mid = await reader.read().catch((e) => e.name);
      return [pre, mid];`),
    ['AbortError', 'AbortError'],
  );
  // The broker's connection to the server is gone.
  for (let i = 0; i < 50 && closedEarly === before; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(closedEarly, before + 1);
});

test('fetch: the fetch policy still decides, and failures are TypeErrors', async () => {
  assert.deepEqual(
    await fetchRun(`
      const denied = await fetch('https://not-allowed.example/').catch((e) => [e instanceof TypeError, e.message]);
      const scheme = await fetch('ftp://x.example/').catch((e) => e instanceof TypeError);
      const port = await fetch('http://localhost:22/').catch((e) => [e instanceof TypeError, e.message]);
      return [denied, scheme, port];`),
    [
      [true, 'fetch to https://not-allowed.example is not allowed by the fetch policy'],
      true,
      [true, 'Fetch failed: Requests to port 22 are blocked'],
    ],
  );
  // No fetch policy: fetch exists, and rejects.
  assert.deepEqual(
    await run(`fetch('${base}/json').catch((e) => [e instanceof TypeError, e.message])`),
    [true, 'fetch is not available: this isolate has no fetch policy'],
  );
  // A private address without privateNetworks.
  await assert.rejects(
    run(`fetch('${base}/json')`, { fetch: { hosts: ['localhost'] } }),
    /no public address/,
  );
});

test('fetch: data: and blob: URLs', async () => {
  assert.deepEqual(
    await run(`(async () => {
      const data = await fetch('data:text/plain;base64,aGk=');
      const pct = await fetch('data:,a%20b');
      const url = URL.createObjectURL(new Blob(['from a blob'], { type: 'x/y' }));
      const blob = await fetch(url);
      return [await data.text(), data.headers.get('content-type'), await pct.text(), pct.headers.get('content-type'),
        await blob.text(), blob.headers.get('content-type')];
    })()`),
    ['hi', 'text/plain', 'a b', 'text/plain;charset=US-ASCII', 'from a blob', 'x/y'],
  );
  // Fetch's data: URL processor: MIME parameters as the MIME Sniffing
  // standard serializes them (an empty quoted value is kept), and invalid
  // base64 is a network error.
  assert.deepEqual(
    await run(`(async () => {
      const r = await fetch('data:text/plain;a="";B=c,X');
      const bad = await fetch('data:;base64,%', { method: 'POST' }).then(() => 'ok', (e) => e.name);
      return [r.headers.get('content-type'), await r.text(), bad];
    })()`),
    ['text/plain;a="";b=c', 'X', 'TypeError'],
  );
});

test('fetch: Subresource Integrity', async () => {
  const { createHash } = await import('node:crypto');
  const body = '{"hi":"wörld"}';
  const sri = (alg, url = false) => {
    const b64 = createHash(alg).update(body).digest('base64');
    return `${alg}-${url ? b64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') : b64}`;
  };
  const bad = 'sha512-' + Buffer.alloc(64).toString('base64');
  const check = (integrity) => fetchRun(`return fetch('${base}/json', { integrity: ${JSON.stringify(integrity)} }).then((r) => r.text(), (e) => e.name);`);
  assert.equal(await check(sri('sha256')), body);
  assert.equal(await check(sri('sha512', true)), body); // base64url, no padding
  assert.equal(await check(`${bad.replace('512', '256')} ${sri('sha384')}`), body); // the strongest decides
  assert.equal(await check(`${sri('sha384')} ${bad}`), 'TypeError');
  assert.equal(await check('md5-abc'), body); // no metadata it knows: no check
  assert.equal(await run(`fetch('data:,x', { integrity: 'sha256-AAAA' }).then(() => 'ok', (e) => e.name)`), 'TypeError');
});

test('Request follows the Fetch standard for credentials, duplex, and stream bodies', async () => {
  const name = (code) => run(`try { ${code}; 'ok' } catch (e) { e.name }`);
  assert.equal(await name(`new Request('https://user:pw@example.com/')`), 'TypeError');
  assert.equal(await name(`new Request('https://example.com/', { method: 'POST', body: new ReadableStream() })`), 'TypeError');
  assert.equal(await name(`new Request('https://example.com/', { method: 'POST', body: new ReadableStream(), duplex: 'half' })`), 'ok');
  assert.equal(await name(`new Request('https://example.com/', { method: 'POST', body: 'x', duplex: 'full' })`), 'TypeError');
  assert.equal(await name(`new Request('https://example.com/', { method: 'POST', body: new ReadableStream(), duplex: 'half', keepalive: true })`), 'TypeError');
  assert.deepEqual(
    await run(`const r = new Request('https://example.com/'); [r.destination, r.isReloadNavigation, r.isHistoryNavigation, r.duplex]`),
    ['', false, false, 'half'],
  );
});

test('without web, a fetch policy still gives the minimal fetch', async () => {
  assert.deepEqual(
    await runtime.run(`fetch('${base}/json').then(async (r) => [typeof Request, r.status, await r.json()])`, { tenant: 'web', ...NET }),
    ['undefined', 200, { hi: 'wörld' }],
  );
});

test('web.baseUrl: relative URLs resolve against it, and location exists', async () => {
  const W2 = { tenant: 'web', web: { baseUrl: 'https://app.example.com/base/' } };
  assert.deepEqual(
    await runtime.run(
      `[new Request('x?y=1').url, Response.redirect('/z').headers.get('location'), location.href, location.origin, Object.isFrozen(location)]`,
      W2,
    ),
    ['https://app.example.com/base/x?y=1', 'https://app.example.com/z', 'https://app.example.com/base/', 'https://app.example.com', true],
  );
  assert.equal(await run('typeof location'), 'undefined');
  await assert.rejects(run(`new Request('x')`), /Invalid URL/);
});
