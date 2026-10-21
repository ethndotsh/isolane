// A deployed app, kept warm: one stateful isolate on the app's tenant runs
// the app's code once, and each HTTP request calls into it with
// `isolate.call`, so nothing is compiled per request. The app defines
// `async function handle(request: Request): Promise<Response>`; a setup shim
// (the platform's own code, installed once per isolate) adds
// `__platform_serve`, which builds the Request, calls handle, and returns
// the Response as plain data, checked against a schema on the way out.

import type { IncomingMessage } from 'node:http';
import { IsolaneError, type HostContext, type HostFunction, type Isolate, type Tenant } from 'isolane';
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

// Runs once, before the app's code. What handle throws is caught here and
// reported as data, so the platform can tell the app's errors (a 500 for
// its caller) from its own.
const SERVE = {
  filename: 'platform:serve.js',
  code: `
    globalThis.__platform_serve = async (incoming, body) => {
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
    };`,
};

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

/** Failures after which the isolate can't serve again: the next request starts a fresh one. */
const gone = (err: unknown) =>
  err instanceof IsolaneError && (err.code === 'ERR_ISOLATE_RETIRED' || err.code === 'ERR_ISOLATE_CLOSED' || err.kind === 'limit' || err.kind === 'infrastructure');

export class WarmApp {
  readonly deploy: Deploy;
  readonly connection: DeployerConnection;
  #tenant: Tenant;
  #origin: string;
  #isolate: Promise<Isolate> | undefined;
  /** Requests running on the current isolate, so a redeploy closes it only once they're done. */
  #inFlight = 0;
  #closing = false;

  constructor(tenant: Tenant, deploy: Deploy, connection: DeployerConnection, origin: string) {
    this.#tenant = tenant;
    this.deploy = deploy;
    this.connection = connection;
    this.#origin = origin;
  }

  /** Start the app's isolate and run its code (its "cold start"). Rejects if the code fails to load. */
  start(): Promise<Isolate> {
    if (this.#isolate) return this.#isolate;
    const { deploy, connection } = this;
    const isolate = this.#tenant.isolate({
      web: { baseUrl: this.#origin },
      host: remoteHost(deploy, connection),
      fetch: deploy.fetchHosts.length ? { hosts: deploy.fetchHosts } : undefined,
      hooks: { onLog: (e) => connection.send({ type: 'log', level: e.level, message: e.message }) },
      shims: { setup: SERVE },
    });
    const started = isolate.eval(deploy.code, { filename: 'app/index.ts' }).then(
      () => isolate,
      (err) => {
        isolate.close();
        if (this.#isolate === started) this.#isolate = undefined;
        throw err;
      },
    );
    this.#isolate = started;
    return started;
  }

  /** Run one HTTP request through the app's `handle`. */
  async serve(req: IncomingMessage, url: URL): Promise<Outcome> {
    const incoming = {
      method: req.method ?? 'GET',
      url: url.href,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
    };
    const body = await readBody(req);
    const current = this.start();
    const isolate = await current;
    this.#inFlight++;
    try {
      return await isolate.call('__platform_serve', [incoming, body], { returns: Outcome });
    } catch (err) {
      // Stopped part-way (out of time, say) or gone: start afresh next time.
      if (gone(err) && this.#isolate === current) {
        this.#isolate = undefined;
        isolate.close();
      }
      throw err;
    } finally {
      this.#inFlight--;
      if (this.#closing && this.#inFlight === 0) isolate.close();
    }
  }

  /** Stop serving: the isolate closes once its requests are done. */
  close(): void {
    this.#closing = true;
    if (this.#inFlight === 0) void this.#isolate?.then((isolate) => isolate.close(), () => {});
  }
}
