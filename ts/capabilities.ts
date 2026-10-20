// Network and filesystem access for guest code, brokered by the supervisor.
// The worker can't open sockets or files (seccomp, Landlock); an isolate
// given a policy gets `fetch`, `connect`, or `fs` globals that are host
// calls, and this module checks every request against the policy before
// doing it on the guest's behalf. A policy is named for the guest API it
// enables and is only as wide as it says: by default there are none.

import { connectBroker, type ConnectPolicy } from './brokers/connect.js';
import { fetchBroker, type FetchPolicy } from './brokers/fetch.js';
import { fsBroker, type FsPolicy } from './brokers/fs.js';
import type { BrokerReporter } from './brokers/net.js';
import { internalEntry, type HostEntry } from './host.js';

export type { ConnectPolicy } from './brokers/connect.js';
export type { FetchPolicy } from './brokers/fetch.js';
export type { FsPolicy } from './brokers/fs.js';
export type { BrokerReporter } from './brokers/net.js';
// For tests, which drive the brokers directly.
export { connectBroker } from './brokers/connect.js';
export { fsBroker } from './brokers/fs.js';
export { isPublicAddress } from './brokers/net.js';

export const FETCH_HOST_FUNCTION = '__isolane_fetch';
export const FS_HOST_FUNCTION = '__isolane_fs';
export const SOCKET_HOST_FUNCTION = '__isolane_socket';

/**
 * The hooks an isolate's web platform (runtime/globals.js) leaves for the
 * prelude: the prelude hands each the raw host function, and the web
 * platform's `fetch` and `connect()` use it. The worker deletes the hooks
 * before guest code runs.
 */
export const WEB_FETCH_HOOK = '__isolane_web_fetch';
/** The same for `connect()`: the Sockets API (runtime/sockets.js) over the socket broker. */
export const WEB_CONNECT_HOOK = '__isolane_web_connect';

/**
 * Trusted setup the worker runs in a VM's context before any guest code:
 * hands the raw `fetch` and socket host functions to the web platform,
 * wraps the raw `fs` one in an `fs` object, then deletes the raw ones.
 * Config resolution only allows these policies with the web platform on.
 * Bytes cross as Uint8Arrays (host calls carry them raw). Guest code can
 * tamper with the wrappers, which only affects itself: the brokers above
 * validate every request on their own.
 */
export const PRELUDE = String.raw`(() => {
  'use strict';
  const g = globalThis;
  const rawFetch = g.${FETCH_HOST_FUNCTION};
  const rawFs = g.${FS_HOST_FUNCTION};
  const rawSocket = g.${SOCKET_HOST_FUNCTION};
  delete g.${FETCH_HOST_FUNCTION};
  delete g.${FS_HOST_FUNCTION};
  delete g.${SOCKET_HOST_FUNCTION};
  const handOver = (hook, raw, api) => {
    if (typeof g[hook] !== 'function') throw new TypeError(api + ' needs the web platform');
    g[hook](raw);
  };
  if (rawFetch) handOver('${WEB_FETCH_HOOK}', rawFetch, 'fetch');
  if (rawSocket) handOver('${WEB_CONNECT_HOOK}', rawSocket, 'connect');

  if (rawFs) {
    if (typeof g.TextEncoder !== 'function') throw new TypeError('fs needs the web platform');
    const encoder = new g.TextEncoder();
    const decoder = new g.TextDecoder();
    // A guest's text, bytes, or buffer as a Uint8Array (the bytes cross to
    // the host as they are when called).
    const toBytes = (data) => {
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return encoder.encode(String(data));
    };
    const encodingOf = (options) => (typeof options === 'string' ? options : options?.encoding);
    g.fs = Object.freeze({
      async readFile(path, options) {
        const bytes = await rawFs('readFile', path);
        const enc = encodingOf(options);
        if (enc == null) return bytes;
        if (enc === 'utf8' || enc === 'utf-8') return decoder.decode(bytes);
        throw new TypeError('fs.readFile: unsupported encoding ' + enc);
      },
      writeFile: (path, data) => rawFs('writeFile', path, toBytes(data)),
      readdir: (path) => rawFs('readdir', path),
      stat: (path) => rawFs('stat', path),
      exists: (path) => rawFs('exists', path),
      mkdir: (path, options) => rawFs('mkdir', path, options?.recursive === true),
      rm: (path, options) => rawFs('rm', path, options?.recursive === true),
    });
  }
})();`;

export interface Capabilities {
  /** The brokers, as host functions. */
  entries: HostEntry[];
  prelude?: string;
  /** Release what the isolate holds open (sockets, fetches) when it goes away. */
  dispose(): void;
}

/**
 * The brokers, setup script, and cleanup for an isolate's policies.
 * `topLevel`: the guest-global names its host functions take (they can't
 * collide with the policies' globals or `globals`).
 */
export function capabilities(
  config: { fetch?: FetchPolicy; fs?: FsPolicy; connect?: ConnectPolicy; globals: Readonly<Record<string, unknown>> },
  topLevel: ReadonlySet<string>,
  report: BrokerReporter,
): Capabilities {
  const entries: HostEntry[] = [];
  const reserved = new Map<string, string>();
  const disposers: (() => void)[] = [];
  if (config.fetch) {
    const broker = fetchBroker(config.fetch, report);
    entries.push(internalEntry(FETCH_HOST_FUNCTION, broker.fn));
    disposers.push(broker.dispose);
    for (const n of ['fetch', 'Headers', 'Response']) reserved.set(n, 'fetch');
  }
  if (config.fs) {
    entries.push(internalEntry(FS_HOST_FUNCTION, fsBroker(config.fs, report)));
    reserved.set('fs', 'fs');
  }
  if (config.connect) {
    const broker = connectBroker(config.connect, report);
    entries.push(internalEntry(SOCKET_HOST_FUNCTION, broker.fn));
    disposers.push(broker.dispose);
    reserved.set('connect', 'connect');
  }
  for (const name of topLevel) {
    const policy = reserved.get(name);
    if (policy) throw new TypeError(`host.${name} is taken by the ${policy} policy's global`);
  }
  let prelude = reserved.size ? PRELUDE : '';
  const globalNames = Object.keys(config.globals);
  if (globalNames.length) {
    for (const name of globalNames) {
      if (reserved.has(name)) throw new TypeError(`globals.${name} is taken by the ${reserved.get(name)} policy's global`);
      if (topLevel.has(name)) throw new TypeError(`globals.${name} is also a host function or namespace`);
    }
    // JSON text inside a JS string literal: values arrive as plain data,
    // each a new global (never one the platform already has).
    const json = JSON.stringify(config.globals);
    prelude =
      `(() => { const g = JSON.parse(${JSON.stringify(json)}); for (const k of Object.keys(g)) {` +
      ` if (Object.hasOwn(globalThis, k)) throw new TypeError('globals.' + k + ' would replace a built-in global');` +
      ` Object.defineProperty(globalThis, k, { value: g[k], writable: true, enumerable: true, configurable: true }); } })();\n` +
      prelude;
  }
  return {
    entries,
    prelude: prelude || undefined,
    dispose: () => disposers.forEach((d) => d()),
  };
}
