// The deployer's side: deploy app.js, then serve its host functions from
// this process (here, an in-memory "database"). Uses Node's built-in
// WebSocket client.
//
//   node deployer.mjs [ws://localhost:8787/connect]
import { readFileSync } from 'node:fs';

const users = new Map([
  [1, { name: 'Ada', plan: 'pro' }],
  [2, { name: 'Grace', plan: 'free' }],
]);
const views = [];

// The host functions this deployer offers its guest code.
const hostFunctions = {
  getUser: (id) => users.get(id) ?? null,
  track: (event, id) => void views.push({ event, id, at: Date.now() }),
};

const ws = new WebSocket(process.argv[2] ?? 'ws://localhost:8787/connect');
const send = (m) => ws.send(JSON.stringify(m));

ws.addEventListener('open', () =>
  send({
    t: 'deploy',
    app: 'hello',
    code: readFileSync(new URL('./app.js', import.meta.url), 'utf8'),
    hostFunctions: Object.keys(hostFunctions),
  }),
);

ws.addEventListener('message', async (event) => {
  const m = JSON.parse(event.data);
  if (m.t === 'deployed') console.log(`deployed ${m.app}: try ${m.url}?id=1`);
  else if (m.t === 'log') console.log(`[app ${m.level}] ${m.message}`);
  else if (m.t === 'error') console.error(`platform: ${m.message}`);
  else if (m.t === 'call') {
    try {
      const value = await hostFunctions[m.name](...m.args);
      send({ t: 'reply', id: m.id, ok: true, value });
    } catch (err) {
      send({ t: 'reply', id: m.id, ok: false, error: err.message });
    }
  }
});

ws.addEventListener('close', () => console.log(`disconnected (${views.length} views tracked)`));
