// The web platform (webPlatform: true): WinterTC Minimum Common API phases 1
// and 2, end to end through a real worker. Needs ISOLANE_WORKER.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../dist/index.js';

const logs = [];
const runtime = new Runtime({ strict: process.env.ISOLANE_STRICT === '1', onLog: (e) => logs.push(e) });
const devBuild = process.env.ISOLANE_DEV_INSECURE === '1' && 'the dev build has no clock patch';
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
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'ReadableStream', 'WritableStream',
    'TransformStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy', 'ReadableStreamBYOBReader',
    'Blob', 'File', 'FileReader', 'TextEncoderStream', 'TextDecoderStream', 'CompressionStream',
    'DecompressionStream',
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
  // Platform objects aren't cloneable, even nested.
  assert.equal(await run('try { structuredClone({ u: new URL("https://a.b") }) } catch (e) { e.name }'), 'DataCloneError');
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
  })`, { clock: 'realtime' });
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
  await assert.rejects(run('new Promise((r) => setTimeout(r, 5000))', { timeoutMs: 100 }), (e) => e.code === 'ERR_TIMEOUT');
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
  const vm = runtime.createIsolate({ ...W, timeoutMs: 1000 });
  await vm.eval('globalThis.hits = 0; globalThis.id = setInterval(() => hits++, 10); setTimeout(() => { globalThis.later = true }, 20)');
  await sleep(150);
  const [hits, later] = await vm.eval('clearInterval(id); [hits, later]');
  assert.ok(hits >= 5, `${hits} interval ticks while idle`);
  assert.equal(later, true);
  vm.dispose();
});

test('timers advance the frozen clock', { skip: devBuild }, async () => {
  const moved = await run('(async () => { const t0 = Date.now(); await new Promise((r) => setTimeout(r, 50)); return Date.now() - t0; })()');
  assert.ok(moved >= 45, `clock moved ${moved}ms over a 50 ms timer`);
  // ...but not while code runs.
  assert.equal(await run('const t0 = Date.now(); let x = 0; for (let i = 0; i < 3e7; i++) x += i; Date.now() - t0'), 0);
});

test('setTimeout with a string needs allowCodeGeneration', async () => {
  // HTML reports the timer task's error rather than throwing it anywhere.
  const before = logs.length;
  await assert.rejects(run(`new Promise((r) => { globalThis.r = r; setTimeout("r(1)", 0); })`), (e) => e.code === 'ERR_UNSETTLED');
  assert.ok(logs.slice(before).some((e) => e.level === 'error' && /EvalError/.test(e.message)));
  assert.equal(await run(`new Promise((r) => { globalThis.r = r; setTimeout("r(1)", 0); })`, { allowCodeGeneration: true }), 1);
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

test('Blob.text() strips one UTF-8 byte order mark', async () => {
  assert.deepEqual(await run(`Promise.all([new Blob(['\ufeffA']).text(), new Blob(['\ufeff\ufeffB']).text()])`), ['A', '\ufeffB']);
});
