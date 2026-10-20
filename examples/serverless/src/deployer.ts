// The deployer's side: deploy app/index.ts, then serve its host functions
// from this process (here, an in-memory "database").
//
//   node src/deployer.ts [--watch] [ws://localhost:8787/connect]
//
// With --watch, saving app/index.ts deploys it again over the same
// connection, so the next request runs the new code.
//
// The app is TypeScript: its types are stripped here, on the deployer's
// machine, with Node's own stripper, which replaces them with whitespace,
// so line numbers in the app's stack traces match app/index.ts.

import { readFileSync, watch } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import type { HostApi, User } from './host-api.ts';
import type { FromDeployer, ToDeployer } from './protocol.ts';

const users = new Map<number, User>([
  [1, { name: 'Ada', plan: 'pro' }],
  [2, { name: 'Grace', plan: 'free' }],
]);
const views: { event: string; id: number; at: number }[] = [];

/** This deployer's implementation of the host API (checked against HostApi). */
const host: HostApi = {
  async getUser(id) {
    return users.get(id) ?? null;
  },
  async track(event, id) {
    views.push({ event, id, at: Date.now() });
  },
};

const args = process.argv.slice(2);
const watching = args.includes('--watch');
const appFile = new URL('../app/index.ts', import.meta.url);
const socket = new WebSocket(args.find((a) => !a.startsWith('--')) ?? 'ws://localhost:8787/connect');
const send = (message: FromDeployer) => socket.send(JSON.stringify(message));

function deploy(): void {
  let code: string;
  try {
    code = stripTypeScriptTypes(readFileSync(appFile, 'utf8'), { mode: 'strip' });
  } catch (err) {
    return console.error(`not deployed: ${err instanceof Error ? err.message : String(err)}`);
  }
  send({ type: 'deploy', app: 'hello', code, hostFunctions: Object.keys(host), fetchHosts: [] });
}

socket.addEventListener('open', () => {
  deploy();
  if (!watching) return;
  // Editors save in bursts (write, rename, touch): deploy once they settle.
  let timer: NodeJS.Timeout | undefined;
  watch(new URL('../app/', import.meta.url), (_, file) => {
    if (file !== 'index.ts') return;
    clearTimeout(timer);
    timer = setTimeout(deploy, 50);
  });
  console.log('watching app/index.ts');
});

socket.addEventListener('message', async (event) => {
  const message = JSON.parse(String(event.data)) as ToDeployer;
  switch (message.type) {
    case 'deployed':
      return console.log(`deployed ${message.app}: try ${message.url}?id=1`);
    case 'error':
      return console.error(`platform: ${message.message}`);
    case 'log':
      return console.log(`[app ${message.level}] ${message.message}`);
    case 'cancel':
      return; // nothing here is slow enough to be worth stopping
    case 'call': {
      const fn = Object.hasOwn(host, message.name) ? (host[message.name as keyof HostApi] as (...a: unknown[]) => Promise<unknown>) : undefined;
      if (!fn) return send({ type: 'reply', id: message.id, ok: false, error: `no host function ${message.name}` });
      try {
        send({ type: 'reply', id: message.id, ok: true, value: await fn(...message.args) });
      } catch (err) {
        send({ type: 'reply', id: message.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
});

socket.addEventListener('close', () => console.log(`disconnected (${views.length} views tracked)`));
