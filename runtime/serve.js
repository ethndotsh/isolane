// A program's fetch handler, called as Cloudflare Workers calls one:
// fetch(request, env, ctx), with a spec Request built from what the host
// sent and the handler's Response read back for the host. For
// program.fetch the worker (crates/worker/src/vm/module.rs) calls serve(),
// runs the `after` shims on its Response, then finish(); and drain()
// before the host closes an instance whose ctx.waitUntil work is still
// running.
//
// Bodies are buffered both ways for now: the request's arrives with the
// call, and finish() reads the response's to its end, at most `maxBody`
// bytes.
(function () {
const { core, primordials } = __bootstrap;
const {
  ArrayPrototypePush,
  ObjectFreeze,
  ObjectPrototypeIsPrototypeOf,
  PromisePrototypeThen,
  PromiseReject,
  PromiseResolve,
  ReflectApply,
  SafePromiseAllSettled,
  SafeSet,
  SafeSetIterator,
  SetPrototypeAdd,
  SetPrototypeDelete,
  SetPrototypeGetSize,
  TypeError,
  TypedArrayPrototypeGetByteLength,
  TypedArrayPrototypeSet,
  Uint8Array,
  Uint8ArrayPrototype,
} = primordials;

const { Request } = core.loadExtScript("ext:deno_fetch/23_request.js");
const { ResponsePrototype } = core.loadExtScript("ext:deno_fetch/23_response.js");

/** ctx.waitUntil promises still running, across the instance's requests. */
const waiting = new SafeSet();

/** Keep `promise` running past the response; report it if it rejects. */
function waitUntil(promise) {
  const settled = PromisePrototypeThen(
    PromiseResolve(promise),
    () => {
      SetPrototypeDelete(waiting, settled);
    },
    (error) => {
      SetPrototypeDelete(waiting, settled);
      // Nothing waits for it: report it as the unhandled rejection it is.
      PromiseReject(error);
    },
  );
  SetPrototypeAdd(waiting, settled);
}

const ctx = ObjectFreeze({ __proto__: null, waitUntil });

/**
 * Call the handler for one request: `head` is { url, method, headers }
 * and `body` its bytes or null. Returns what the handler returned (a
 * Response, or a promise for one), which the `after` shims see next.
 */
function serve(handler, self, head, body, env) {
  const request = new Request(head.url, {
    method: head.method,
    headers: head.headers,
    body: body ?? null,
  });
  return ReflectApply(handler, self, [request, env, ctx]);
}

/**
 * Read the handler's Response for the host: { status, statusText,
 * headers, body, waiting } (body: a Uint8Array; waiting: the waitUntil
 * promises still running), or { tooLarge } when its body is larger than
 * `maxBody` bytes.
 */
async function finish(response, maxBody) {
  if (!ObjectPrototypeIsPrototypeOf(ResponsePrototype, response)) {
    throw new TypeError("The fetch handler must return a Response (or a promise for one)");
  }
  const chunks = [];
  let length = 0;
  if (response.body !== null) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!ObjectPrototypeIsPrototypeOf(Uint8ArrayPrototype, value)) {
        throw new TypeError("The response body's stream must give Uint8Arrays");
      }
      length += TypedArrayPrototypeGetByteLength(value);
      if (length > maxBody) {
        reader.cancel();
        return { tooLarge: length };
      }
      ArrayPrototypePush(chunks, value);
    }
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (let i = 0; i < chunks.length; i++) {
    TypedArrayPrototypeSet(bytes, chunks[i], at);
    at += TypedArrayPrototypeGetByteLength(chunks[i]);
  }
  const headers = [];
  for (const pair of response.headers) ArrayPrototypePush(headers, pair);
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: bytes,
    waiting: SetPrototypeGetSize(waiting),
  };
}

/** Settle once every waitUntil promise has (including ones those add). */
async function drain() {
  while (SetPrototypeGetSize(waiting) > 0) {
    await SafePromiseAllSettled([...new SafeSetIterator(waiting)]);
  }
}

return { serve, finish, drain };
})();
