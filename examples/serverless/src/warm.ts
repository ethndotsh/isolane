// A deployed app, kept warm: a program on the app's tenant (`tenant.load`),
// whose instances evaluate the app's module once and then serve request
// after request, several at once, so nothing is compiled per request. The
// app is a fetch handler (`export default { fetch(request, env, ctx) }`),
// and each HTTP request goes to it as a Request (`program.fetch`).

import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import type { HostContext, HostFunction, Program, Tenant } from 'isolane';
import type { DeployerConnection } from './connection.ts';
import type { Deploy } from './protocol.ts';

/** Largest request (and response) body an app gets: past it, the platform answers 413. */
const MAX_BODY_BYTES = 1 << 20;

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

/** An incoming HTTP request as a web Request, its body streamed from the socket. */
function toRequest(req: IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, v);
  }
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? null : (Readable.toWeb(req) as ReadableStream<Uint8Array>);
  return new Request(url, { method, headers, body, duplex: 'half' } as RequestInit);
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
    // Under app/, so stack traces name the files as the deployer has them.
    const files = Object.fromEntries(Object.entries(deploy.files).map(([path, code]) => [`app/${path}`, code]));
    const program = await tenant.load({ main: `app/${deploy.main}`, files }, {
      web: { baseUrl: origin },
      host: remoteHost(deploy, connection),
      fetch: deploy.fetchHosts.length ? { hosts: deploy.fetchHosts } : undefined,
      limits: { bodyBytes: MAX_BODY_BYTES },
      // Most of an app's time is spent waiting for its deployer's replies,
      // so each instance serves several requests at once.
      instances: { max: 2, concurrency: 8 },
      hooks: { onLog: (e) => connection.send({ type: 'log', level: e.level, message: e.message }) },
    });
    return new WarmApp(deploy, connection, program);
  }

  /** Run one HTTP request through the app's fetch handler, in an instance with room. */
  serve(req: IncomingMessage, url: URL): Promise<Response> {
    return this.#program.fetch(toRequest(req, url));
  }

  /** Stop serving: the program closes once its requests (and their waitUntil work) are done. */
  close(): Promise<void> {
    return this.#program.close();
  }
}
