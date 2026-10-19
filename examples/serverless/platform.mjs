// A toy serverless platform on isolane.
//
// Deployers connect over a WebSocket, deploy guest code, and serve that
// code's host functions themselves: when guest code calls `getUser(42)`, the
// platform forwards the call over the deployer's socket and hands the reply
// back to the guest. Each app runs as its own isolane tenant (its own
// sandboxed worker process); every HTTP request runs in a fresh isolate.
//
//   node platform.mjs                 # listens on :8787
//   GET/POST http://localhost:8787/<app>/...   invokes the app
//
// Messages (JSON) on ws://localhost:8787/connect:
//   deployer → platform  { t: 'deploy', app, code, hostFunctions: [names], network?: [hosts] }
//                        { t: 'reply', id, ok, value?, error? }
//   platform → deployer  { t: 'deployed', app } | { t: 'error', message }
//                        { t: 'call', id, name, args }
//                        { t: 'log', level, message }
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Runtime, IsolaneError } from 'isolane';

const PORT = Number(process.env.PORT ?? 8787);
const HOST_CALL_TIMEOUT_MS = 5000;

const runtime = new Runtime({
  defaults: { timeoutMs: 2000, memoryLimitBytes: 64 << 20 },
  workerMemoryLimitBytes: 512 << 20,
  onSecurityEvent: (e) => console.warn(`[security] ${e.kind} in ${e.tenant}: ${e.detail ?? e.signal ?? ''}`),
});

/** app name → { code, hostFunctions, network, socket } */
const apps = new Map();

// ---- deployers ----

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 << 20 });
wss.on('connection', (socket) => {
  const calls = new Map(); // id → { resolve, reject, timer }
  let nextId = 1;
  let deployed;
  const send = (m) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(m));

  // A host function that runs on the deployer's side.
  const remote = (name) => (...args) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(new Error(`host function ${name} timed out`));
      }, HOST_CALL_TIMEOUT_MS);
      calls.set(id, { resolve, reject, timer });
      send({ t: 'call', id, name, args });
    });

  socket.on('message', (data) => {
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return send({ t: 'error', message: 'messages are JSON' });
    }
    if (m.t === 'deploy') {
      const ok = typeof m.app === 'string' && /^[a-z0-9-]{1,40}$/.test(m.app) && typeof m.code === 'string';
      if (!ok) return send({ t: 'error', message: 'deploy needs app (a-z, 0-9, -) and code' });
      const owner = apps.get(m.app);
      if (owner && owner.socket !== socket) return send({ t: 'error', message: `${m.app} belongs to another deployer` });
      const names = Array.isArray(m.hostFunctions) ? m.hostFunctions.filter((n) => typeof n === 'string') : [];
      deployed = m.app;
      apps.set(m.app, {
        code: m.code,
        socket,
        hostFunctions: Object.fromEntries(names.map((n) => [n, remote(n)])),
        network: Array.isArray(m.network) ? { allow: m.network.filter((h) => typeof h === 'string') } : undefined,
        log: (e) => send({ t: 'log', level: e.level, message: e.message }),
      });
      return send({ t: 'deployed', app: m.app, url: `http://localhost:${PORT}/${m.app}/` });
    }
    if (m.t === 'reply' && calls.has(m.id)) {
      const { resolve, reject, timer } = calls.get(m.id);
      calls.delete(m.id);
      clearTimeout(timer);
      if (m.ok) resolve(m.value);
      else reject(new Error(typeof m.error === 'string' ? m.error : 'host function failed'));
    }
  });

  socket.on('close', () => {
    for (const { reject, timer } of calls.values()) {
      clearTimeout(timer);
      reject(new Error('the deployer disconnected'));
    }
    // An app lives as long as its deployer's connection.
    if (deployed && apps.get(deployed)?.socket === socket) apps.delete(deployed);
  });
});

// ---- invocations ----

// Guest code defines `async function handle(request)` and returns
// `{ status?, headers?, body? }` (body: a string or any JSON value).
const INVOKE = `(async () => {
  const r = await handle(request);
  if (r === null || typeof r !== 'object') return { status: 200, body: r };
  return r;
})()`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const [, appName] = url.pathname.split('/');
  const app = apps.get(appName);
  if (!app) return res.writeHead(404).end(`no app named ${appName}\n`);

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1 << 20) return res.writeHead(413).end('request body too large\n');
    chunks.push(chunk);
  }
  const request = {
    method: req.method,
    url: url.href,
    headers: req.headers,
    body: Buffer.concat(chunks).toString('utf8'),
  };

  const started = performance.now();
  try {
    const out = await runtime.tenant(appName).run(`${app.code}\n;${INVOKE}`, {
      globals: { request },
      hostFunctions: app.hostFunctions,
      network: app.network,
      onLog: app.log,
    });
    const body = typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? null);
    res.writeHead(Number.isInteger(out.status) ? out.status : 200, {
      'content-type': typeof out.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
      ...(out.headers && typeof out.headers === 'object' ? out.headers : {}),
      'x-isolane-ms': (performance.now() - started).toFixed(1),
    });
    res.end(body);
  } catch (err) {
    const e = err instanceof IsolaneError ? err : new IsolaneError('ERR_INTERNAL', String(err));
    const status = e.kind === 'guest' ? 500 : e.kind === 'limit' ? 503 : 502;
    app.log({ level: 'error', message: `${e.code}: ${e.guest?.stack ?? e.message}` });
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.code, message: e.guest?.message ?? e.message }));
  }
});

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/connect') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.listen(PORT, () => console.log(`platform on http://localhost:${PORT} (deployers: ws://localhost:${PORT}/connect)`));
process.on('SIGINT', () => {
  runtime.close();
  process.exit(0);
});
