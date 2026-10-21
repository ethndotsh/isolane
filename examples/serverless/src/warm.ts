// A deployed app, kept warm: a program on the app's tenant (`tenant.load`),
// whose instances evaluate the app's module once and then serve request
// after request, so nothing is compiled per request. The app exports
// `async function handle(request: Request): Promise<Response>`; the
// platform appends its own small export, `__platform_serve`, to the module
// (after the app's last line, so line numbers stay the app's): it builds
// the Request, calls handle, and returns the Response as plain data,
// checked against a schema on the way out.

import type { IncomingMessage } from 'node:http';
import type { HostContext, HostFunction, Program, Tenant } from 'isolane';
import { z } from 'zod';
import type { DeployerConnection } from './connection.ts';
import type { Deploy } from './protocol.ts';

const MAX_BODY_BYTES = 1 << 20;

/** What `__platform_serve` hands back: the app's Response, or what it threw. */
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

// The platform's end of the module. What handle throws is caught here and
// reported as data, so the platform can tell the app's errors (a 500 for
// its caller) from its own. The check runs in setup, so an app without a
// handle fails to deploy.
const SERVE = `
if (typeof handle !== 'function') throw new TypeError('the app must export async function handle(request)');
export async function __platform_serve(incoming, body) {
  const request = new Request(incoming.url, {
    method: incoming.method,
    headers: incoming.headers,
    body: incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : body,
  });
  try {
    const response = await handle(request);
    if (!(response instanceof Response)) throw new TypeError('handle() must return a Response');
    return { response: { status: response.status, headers: [...response.headers], body: await response.text() } };
  } catch (e) {
    return { thrown: { name: String(e?.name ?? 'Error'), message: String(e?.message ?? e), stack: String(e?.stack ?? e) } };
  }
}`;

export class RequestTooLarge extends Error {}

/** Read a request body, up to MAX_BODY_BYTES. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RequestTooLarge(`request body larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The deployer's host functions, called over its connection (the app finds them in `env`). */
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

export class WarmApp {
  readonly deploy: Deploy;
  readonly connection: DeployerConnection;
  #program: Program;

  private constructor(deploy: Deploy, connection: DeployerConnection, program: Program) {
    this.deploy = deploy;
    this.connection = connection;
    this.#program = program;
  }

  /** Load the app (its "cold start": its first instance evaluates it). Rejects if its code fails to load. */
  static async load(tenant: Tenant, deploy: Deploy, connection: DeployerConnection, origin: string): Promise<WarmApp> {
    const program = await tenant.load(`${deploy.code}\n${SERVE}`, {
      filename: 'app/index.ts',
      web: { baseUrl: origin },
      host: remoteHost(deploy, connection),
      fetch: deploy.fetchHosts.length ? { hosts: deploy.fetchHosts } : undefined,
      hooks: { onLog: (e) => connection.send({ type: 'log', level: e.level, message: e.message }) },
    });
    return new WarmApp(deploy, connection, program);
  }

  /** Run one HTTP request through the app's `handle`, in a free instance. */
  async serve(req: IncomingMessage, url: URL): Promise<Outcome> {
    const incoming = {
      method: req.method ?? 'GET',
      url: url.href,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
    };
    const body = await readBody(req);
    return this.#program.call('__platform_serve', [incoming, body], { returns: Outcome });
  }

  /** Stop serving: the program closes once its requests are done. */
  close(): Promise<void> {
    return this.#program.close();
  }
}
