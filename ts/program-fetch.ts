// program.fetch's host side: a Request taken apart for the wire (its head
// as JSON, its body as bytes, read whole up to `limits.bodyBytes`), and the
// worker's answer put back together as a Response. The guest side is
// runtime/serve.js.

import { IsolaneError, limitError } from './errors.js';

/** What the guest's Request is built from. */
export interface RequestHead {
  url: string;
  method: string;
  headers: [string, string][];
}

/** What the worker sends back for the guest's Response. */
interface ResponseHead {
  status: number;
  statusText: string;
  headers: [string, string][];
  /** The instance's `ctx.waitUntil` promises still running. */
  waiting: number;
}

/** A fetch call's raw result: the Response's head, and its body. */
export interface RawResponse {
  head: unknown;
  body: Uint8Array;
}

/** Statuses whose responses have no body (Fetch's null body statuses). */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/** `request` for the wire: its head, and its body (null without one), at most `maxBytes`. */
export async function requestParts(request: Request, maxBytes: number, tenant: string): Promise<{ head: RequestHead; body: Uint8Array | null }> {
  const head: RequestHead = { url: request.url, method: request.method, headers: [...request.headers] };
  if (request.body === null) return { head, body: null };
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      // Not awaited: a request cloned for a retry (a tee) cancels its
      // source only once both copies are cancelled.
      reader.cancel().catch(() => {});
      throw limitError('bodyBytes', `the request's body is more than ${maxBytes} bytes`, tenant);
    }
    chunks.push(value);
  }
  return { head, body: Buffer.concat(chunks, length) };
}

const internal = (tenant: string, what: string) => new IsolaneError('ERR_INTERNAL', `isolane: the worker sent a malformed response (${what})`, { tenant });

/** The worker's answer as a Response, and how many `ctx.waitUntil` promises its instance still runs. */
export function responseFrom(raw: unknown, tenant: string): { response: Response; waiting: number } {
  const { head, body } = (raw ?? {}) as Partial<RawResponse>;
  if (!(body instanceof Uint8Array) || head === null || typeof head !== 'object') throw internal(tenant, 'no head or body');
  const h = head as Partial<ResponseHead>;
  if (!(Number.isInteger(h.status) && (h.status as number) >= 200 && (h.status as number) <= 599)) throw internal(tenant, 'status');
  if (typeof h.statusText !== 'string') throw internal(tenant, 'statusText');
  const pairs = h.headers;
  if (!Array.isArray(pairs) || !pairs.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string')) {
    throw internal(tenant, 'headers');
  }
  const waiting = Number.isSafeInteger(h.waiting) && (h.waiting as number) >= 0 ? (h.waiting as number) : 0;
  const status = h.status as number;
  let response: Response;
  try {
    response = new Response(NULL_BODY.has(status) ? null : body, { status, statusText: h.statusText, headers: pairs });
  } catch (err) {
    throw internal(tenant, (err as Error).message);
  }
  return { response, waiting };
}
