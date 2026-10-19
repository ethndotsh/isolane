// The web platform (webPlatform: true): WinterTC Minimum Common API phase 1,
// end to end through a real worker. Needs ISOLANE_WORKER.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../dist/index.js';

const logs = [];
const runtime = new Runtime({ strict: process.env.ISOLANE_STRICT === '1', onLog: (e) => logs.push(e) });
after(() => runtime.close());
const W = { tenant: 'web', webPlatform: true };
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
  ];
  const types = await run(`${JSON.stringify(names)}.map((n) => typeof globalThis[n])`);
  assert.ok(types.every((t) => t !== 'undefined'), JSON.stringify(Object.fromEntries(names.map((n, i) => [n, types[i]]))));
  assert.equal(await run('Object.keys(globalThis).length'), 0);
});

test('the runtime internals are unreachable', async () => {
  assert.deepEqual(
    await run(`[typeof __bootstrap, typeof Deno, typeof core, Object.getOwnPropertyNames(globalThis).filter((n) => /bootstrap|^op_/.test(n))]`),
    ['undefined', 'undefined', 'undefined', []],
  );
  // A setter planted before a lazy load can't catch the bootstrap object.
  assert.equal(
    await run(`let stolen; Object.defineProperty(globalThis, '__bootstrap', { set(v) { stolen = v }, get() { return stolen } });
      new URL('https://a.b'); new TextDecoder(); structuredClone(1); typeof stolen`),
    'undefined',
  );
});

test('works with code generation off', async () => {
  assert.equal(await run('new URL("https://x.y/z").pathname + typeof eval("1")', { allowCodeGeneration: true }), '/znumber');
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
});

test('performance', async () => {
  assert.deepEqual(
    await run(`performance.mark("a"); performance.measure("m", "a");
      [typeof performance.now(), performance.timeOrigin > 1e12, performance.getEntriesByType("measure").length]`),
    ['number', true, 1],
  );
  assert.deepEqual(await run('[performance.now(), performance.timeOrigin]', { clock: { fixedMs: 1e12 } }), [0, 1e12]);
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
  assert.deepEqual(await run(draw, { randomSeed: 9 }), await run(draw, { randomSeed: 9 }));
  assert.notDeepEqual(await run(draw), await run(draw));
});

test('self and navigator', async () => {
  assert.deepEqual(await run('[self === globalThis, navigator.userAgent]'), [true, 'isolane']);
});

test('lone surrogates in code or host errors no longer crash the worker', async () => {
  // A raw lone surrogate can't cross the UTF-8 protocol; it becomes U+FFFD.
  assert.equal(await runtime.run('"\ud800"', { tenant: 'web' }), '�');
  const hostFunctions = { bad: () => { throw new Error('bad \udc00'); } };
  assert.equal(await runtime.run('bad().catch((e) => e.message)', { tenant: 'web', hostFunctions }), 'bad �');
});
