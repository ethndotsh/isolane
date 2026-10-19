// Running one HTTP request through a deployed app. The app defines
// `async function handle(request: Request): Promise<Response>`; the
// platform's own code (an `after` shim) builds the Request from the
// incoming one, calls handle, and returns the Response as plain data,
// checked against a schema on the way out.

import type { IncomingMessage } from 'node:http';
import type { HostContext, HostFunction, Tenant } from 'isolane';
import { z } from 'zod';
import type { DeployerConnection } from './connection.ts';
import type { Deploy } from './protocol.ts';

const MAX_BODY_BYTES = 1 << 20;

/** What the shim hands back: the app's Response, or what it threw. */
const Outcome = z.union([
  z.object({
    response: z.object({
      status: z.number().int().min(200).max(599),
      headers: z.array(z.tuple([z.string(), z.string()])),
      body: z.string(),
    }),
  }),
  z.object({ thrown: z.object({ name: z.string(), message: z.string(), stack: z.string() }) }),
]);
export type Outcome = z.infer<typeof Outcome>;

// Runs as the app's own code finishes: call handle() with a real Request.
// What handle throws is caught here and reported as data, so the platform
// can tell the app's errors (a 500 for its caller) from its own.
const INVOKE = {
  filename: 'platform:invoke.js',
  code: `
    const request = new Request(incoming.url, {
      method: incoming.method,
      headers: incoming.headers,
      body: incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : incoming.body,
    });
    try {
      const response = await handle(request);
      if (!(response instanceof Response)) throw new TypeError('handle() must return a Response');
      return { response: { status: response.status, headers: [...response.headers], body: await response.text() } };
    } catch (e) {
      return { thrown: { name: String(e?.name ?? 'Error'), message: String(e?.message ?? e), stack: String(e?.stack ?? e) } };
    }`,
};

export class RequestTooLarge extends Error {}

/** Read a request body as text, up to MAX_BODY_BYTES. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RequestTooLarge(`request body larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The deployer's host functions, called over its connection. */
function remoteHost(deploy: Deploy, connection: DeployerConnection): Record<string, HostFunction> {
  return Object.fromEntries(
    deploy.hostFunctions.map((name) => [
      name,
      function (this: HostContext, ...args: unknown[]) {
        return connection.call(name, args, this.signal);
      },
    ]),
  );
}

export async function invoke(
  tenant: Tenant,
  deploy: Deploy,
  connection: DeployerConnection,
  req: IncomingMessage,
  url: URL,
): Promise<Outcome> {
  const incoming = {
    method: req.method ?? 'GET',
    url: url.href,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
    body: await readBody(req),
  };
  return tenant.run(deploy.code, {
    web: { baseUrl: url.origin },
    globals: { incoming },
    host: remoteHost(deploy, connection),
    fetch: deploy.fetchHosts.length ? { hosts: deploy.fetchHosts } : undefined,
    hooks: { onLog: (e) => connection.send({ type: 'log', level: e.level, message: e.message }) },
    shims: { after: INVOKE },
    returns: Outcome,
  });
}
