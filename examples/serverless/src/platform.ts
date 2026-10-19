// A small serverless platform on isolane.
//
// Deployers connect over a WebSocket, deploy an app, and serve its host
// functions from their own process; HTTP requests to /<app>/... run the
// app's `handle(request)` in a fresh isolate on the app's own tenant (its
// own sandboxed worker process).
//
//   node src/platform.ts          # HTTP on :8787, deployers on ws://localhost:8787/connect

import { createServer, type ServerResponse } from 'node:http';
import { IsolaneError, Runtime } from 'isolane';
import { WebSocketServer } from 'ws';
import { DeployerConnection } from './connection.ts';
import { invoke, RequestTooLarge } from './invoke.ts';
import type { Deploy } from './protocol.ts';

const PORT = Number(process.env.PORT ?? 8787);

interface App {
  deploy: Deploy;
  connection: DeployerConnection;
}

const apps = new Map<string, App>();

const runtime = new Runtime({
  // ISOLANE_STRICT=0 allows a development worker without the full lockdown.
  strict: process.env.ISOLANE_STRICT !== '0',
  defaults: { limits: { timeoutMs: 2_000, heapBytes: 64 << 20, workerMemoryBytes: 512 << 20 } },
  hooks: { onSecurityEvent: (e) => console.warn(`[security] ${e.kind} in ${e.tenant}: ${e.detail ?? ''}`) },
});

function deployed(deploy: Deploy, connection: DeployerConnection): void {
  const current = apps.get(deploy.app);
  if (current && current.connection !== connection) {
    return connection.send({ type: 'error', message: `${deploy.app} belongs to another deployer` });
  }
  apps.set(deploy.app, { deploy, connection });
  connection.send({ type: 'deployed', app: deploy.app, url: `http://localhost:${PORT}/${deploy.app}/` });
}

/** An app lives as long as its deployer's connection. */
function disconnected(connection: DeployerConnection): void {
  for (const [name, app] of apps) if (app.connection === connection) apps.delete(name);
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const name = url.pathname.split('/')[1] ?? '';
  const app = apps.get(name);
  if (!app) return reply(res, 404, { error: `no app named ${name}` });

  const started = performance.now();
  try {
    const outcome = await invoke(runtime.tenant(name), app.deploy, app.connection, req, url);
    if ('thrown' in outcome) {
      app.connection.send({ type: 'log', level: 'error', message: `handle threw: ${outcome.thrown.stack}` });
      return reply(res, 500, { error: outcome.thrown.name, message: outcome.thrown.message });
    }
    const { status, headers, body } = outcome.response;
    res.writeHead(status, [...headers.flat(), 'x-isolane-ms', (performance.now() - started).toFixed(1)]).end(body);
  } catch (err) {
    if (err instanceof RequestTooLarge) return reply(res, 413, { error: err.message });
    const e = err instanceof IsolaneError ? err : new IsolaneError('ERR_INTERNAL', String(err));
    app.connection.send({ type: 'log', level: 'error', message: `${e.code}: ${e.guest?.stack ?? e.message}` });
    // The app's own failures (it threw at load, returned junk) are a 500;
    // running out of time or memory, a 503; anything else, ours: a 502.
    const status = e.kind === 'guest' ? 500 : e.kind === 'limit' ? 503 : 502;
    reply(res, status, { error: e.code, message: e.guest?.message ?? e.message });
  }
});

const deployers = new WebSocketServer({ noServer: true, maxPayload: 8 << 20 });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/connect') return socket.destroy();
  deployers.handleUpgrade(req, socket, head, (ws) => {
    const connection: DeployerConnection = new DeployerConnection(ws, deployed, () => disconnected(connection));
  });
});

server.listen(PORT, () => console.log(`platform on http://localhost:${PORT}; deployers connect to ws://localhost:${PORT}/connect`));
process.on('SIGINT', () => {
  runtime.close();
  process.exit(0);
});
