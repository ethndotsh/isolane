// The spec fetch() (WHATWG Fetch: "fetch" and "main fetch") for VMs with
// the web platform, over isolane's network broker instead of a network
// stack. Adapted from Deno's ext/fetch/26_fetch.js (MIT; see
// deno/LICENSE.md): Request, Response, Headers, and bodies are Deno's
// vendored classes (with patches/deno-*.patch); this file replaces the part that talks
// to the network, which here is a host function handed over by the
// prelude (ts/capabilities.ts). The broker sends each request, follows
// redirects (each hop checked against the isolate's fetch policy), and streams
// the response body: open(id, meta, body) → status and headers, then
// read(id) → the next bytes (null at the end), cancel(id) to abort.
//
// A ReadableStream request body streams to the broker (write(id, chunk));
// other bodies go whole with open().
//
// Differences from Deno's fetch: blob: and data: URLs are fetched here,
// other non-HTTP(S) schemes are network errors; Subresource Integrity
// (`integrity`) is checked; no HTTP client options, telemetry, or inspector
// events.
(function () {
const { core, primordials } = __bootstrap;
const {
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  ObjectPrototypeIsPrototypeOf,
  Promise,
  PromisePrototypeCatch,
  PromisePrototypeThen,
  SafeArrayIterator,
  StringPrototypeCharCodeAt,
  StringPrototypeIndexOf,
  StringPrototypeReplaceAll,
  StringPrototypeSlice,
  StringPrototypeToLowerCase,
  TypedArrayPrototypeGetSymbolToStringTag,
  TypeError,
  Uint8Array,
} = primordials;

const webidl = core.loadExtScript("ext:deno_webidl/00_webidl.js");
const { URL } = core.loadExtScript("ext:deno_web/00_url.js");
const {
  ReadableStream,
  ReadableStreamPrototype,
  readableStreamCollectIntoUint8Array,
  readableStreamPipeTo,
  WritableStream,
} = core.loadExtScript("ext:deno_web/06_streams.js");
const { InnerBody } = core.loadExtScript("ext:deno_fetch/22_body.js");
const { processUrlList, Request, toInnerRequest } = core.loadExtScript(
  "ext:deno_fetch/23_request.js",
);
const {
  abortedNetworkError,
  fromInnerResponse,
  networkError,
  nullBodyStatus,
  toInnerResponse,
} = core.loadExtScript("ext:deno_fetch/23_response.js");
const abortSignal = core.loadExtScript("ext:deno_web/03_abort_signal.js");
const { parseMimeType } = core.loadExtScript("ext:deno_web/01_mimesniff.js");
const { forgivingBase64Decode } = core.loadExtScript("ext:deno_web/00_infra.js");

// https://fetch.spec.whatwg.org/#bad-port, as in Deno's 26_fetch.js.
const BAD_PORTS = {
  __proto__: null,
  "0": true, "1": true, "7": true, "9": true, "11": true, "13": true,
  "15": true, "17": true, "19": true, "20": true, "21": true, "22": true,
  "23": true, "25": true, "37": true, "42": true, "43": true, "53": true,
  "69": true, "77": true, "79": true, "87": true, "95": true, "101": true,
  "102": true, "103": true, "104": true, "109": true, "110": true,
  "111": true, "113": true, "115": true, "117": true, "119": true,
  "123": true, "135": true, "137": true, "139": true, "143": true,
  "161": true, "179": true, "389": true, "427": true, "465": true,
  "512": true, "513": true, "514": true, "515": true, "526": true,
  "530": true, "531": true, "532": true, "540": true, "548": true,
  "554": true, "556": true, "563": true, "587": true, "601": true,
  "636": true, "989": true, "990": true, "993": true, "995": true,
  "1719": true, "1720": true, "1723": true, "2049": true, "3659": true,
  "4045": true, "4190": true, "5060": true, "5061": true, "6000": true,
  "6566": true, "6665": true, "6666": true, "6667": true, "6668": true,
  "6669": true, "6679": true, "6697": true, "10080": true,
};

/** The broker's host function, or null: this VM has no network policy. */
let transport = null;
let nextFetchId = 1;

function setTransport(fn) {
  if (transport === null) transport = fn;
}

// Ignore the result: cancelling something already finished is fine.
function cancel(id) {
  PromisePrototypeCatch(PromisePrototypeThen(transport("cancel", id)), () => {});
}

/** A byte stream over the broker's body reads. It reads ahead up to
 * BODY_READ_AHEAD bytes even when the guest isn't reading, as a browser's
 * network layer does, so a network error mid-body errors the stream (and
 * `reader.closed` rejects) without waiting for a read; backpressure stops it
 * there. Aborting the fetch's signal errors it with the abort reason (as
 * Deno's resource-backed body streams do) and cancels the broker's request. */
const BODY_READ_AHEAD = 64 * 1024;

function bodyStream(id, terminator) {
  let controller;
  const stream = new ReadableStream({
    type: "bytes",
    start(c) {
      controller = c;
    },
    async pull(c) {
      const chunk = await transport("read", id);
      if (chunk === null) {
        c.close();
        c.byobRequest?.respond(0);
      } else if (chunk.length > 0) {
        c.enqueue(chunk);
      }
    },
    cancel() {
      cancel(id);
    },
  }, { __proto__: null, highWaterMark: BODY_READ_AHEAD });
  terminator[abortSignal.add](() => {
    cancel(id);
    try {
      controller.error(terminator.reason);
    } catch {
      // Already closed or errored.
    }
  });
  return stream;
}

/** https://fetch.spec.whatwg.org/#data-url-processor, natively (Servo's
 * data-url crate, as in Deno's fetch). Any method: a data: URL's response
 * doesn't depend on it. */
function fetchDataUrl(url, req) {
  const processed = core.dataUrl(url.href);
  if (processed === null) return networkError("invalid data: URL");
  const { 0: contentType, 1: bytes } = processed;
  processUrlList(req.urlList, req.urlListProcessed);
  return {
    headerList: [["content-type", contentType]],
    status: 200,
    statusMessage: "OK",
    // Main fetch drops the body of a HEAD response.
    body: req.method === "HEAD" ? null : new InnerBody({ body: bytes, consumed: false }),
    type: "basic",
    url() {
      return this.urlList[this.urlList.length - 1] ?? null;
    },
    urlList: [...new SafeArrayIterator(req.urlListProcessed)],
  };
}

// https://w3c.github.io/webappsec-subresource-integrity/: the hash
// functions, weakest first.
const SRI_STRENGTH = { __proto__: null, sha256: 1, sha384: 2, sha512: 3 };

const isAsciiWhitespace = (c) => c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;

/** The string's tokens between runs of ASCII whitespace. (No regular
 * expressions: guest code can replace RegExp.prototype's methods.) */
function splitOnAsciiWhitespace(input) {
  const tokens = [];
  let start = -1;
  for (let i = 0; i <= input.length; i++) {
    const space = i === input.length || isAsciiWhitespace(StringPrototypeCharCodeAt(input, i));
    if (space && start !== -1) {
      ArrayPrototypePush(tokens, StringPrototypeSlice(input, start, i));
      start = -1;
    } else if (!space && start === -1) {
      start = i;
    }
  }
  return tokens;
}

/** "Parse metadata": the well-formed [algorithm, base64 digest] pairs. */
function parseIntegrity(metadata) {
  const parsed = [];
  for (const token of new SafeArrayIterator(splitOnAsciiWhitespace(metadata))) {
    const question = StringPrototypeIndexOf(token, "?"); // options: none defined
    const expression = question === -1 ? token : StringPrototypeSlice(token, 0, question);
    const dash = StringPrototypeIndexOf(expression, "-");
    if (dash === -1) continue;
    const algorithm = StringPrototypeToLowerCase(StringPrototypeSlice(expression, 0, dash));
    if (SRI_STRENGTH[algorithm] === undefined) continue;
    ArrayPrototypePush(parsed, [algorithm, StringPrototypeSlice(expression, dash + 1)]);
  }
  return parsed;
}

/** "Do bytes match metadataList": any digest of the strongest algorithm
 * listed matches (base64 or base64url, padding optional); no well-formed
 * metadata matches anything. */
function integrityMatches(bytes, metadata) {
  const parsed = parseIntegrity(metadata);
  if (parsed.length === 0) return true;
  let strongest = 0;
  for (const { 0: algorithm } of new SafeArrayIterator(parsed)) {
    if (SRI_STRENGTH[algorithm] > strongest) strongest = SRI_STRENGTH[algorithm];
  }
  for (const { 0: algorithm, 1: value } of new SafeArrayIterator(parsed)) {
    if (SRI_STRENGTH[algorithm] !== strongest) continue;
    let expected;
    try {
      // base64url's alphabet, as base64's.
      expected = forgivingBase64Decode(StringPrototypeReplaceAll(StringPrototypeReplaceAll(value, "-", "+"), "_", "/"));
    } catch {
      continue;
    }
    const actual = core.digest(algorithm, bytes);
    if (expected.length !== actual.length) continue;
    let same = true;
    for (let i = 0; i < actual.length; i++) same &&= expected[i] === actual[i];
    if (same) return true;
  }
  return false;
}

/** Stream a request body to the broker (its `write`), a chunk at a time:
 * each write resolves when the broker can take more. A chunk that isn't a
 * Uint8Array, or a stream that errors, cancels the fetch. The pipe reads
 * the stream with the streams' internal reads (guest code can't intercept
 * them), into a sink with no prototype (nothing to inject into it). */
function sendBody(id, stream) {
  const sink = new WritableStream({
    __proto__: null,
    write(chunk) {
      if (TypedArrayPrototypeGetSymbolToStringTag(chunk) !== "Uint8Array") {
        throw new TypeError("a request body stream must give Uint8Arrays");
      }
      return transport("write", id, chunk);
    },
    close() {
      return transport("write", id, null);
    },
    abort() {
      cancel(id);
    },
  });
  PromisePrototypeCatch(readableStreamPipeTo(stream, sink, false, false, false), () => cancel(id));
}

/** Fetch's "main fetch", with Subresource Integrity: a request with
 * integrity metadata waits for the whole body and checks it. */
async function mainFetch(req, terminator) {
  const response = await schemeFetch(req, terminator);
  if (!req.integrity || response.type === "error" || response.aborted) return response;
  let bytes = response.body === null ? new Uint8Array(0) : await response.body.consume();
  if (typeof bytes === "string") bytes = core.encode(bytes);
  if (!integrityMatches(bytes, req.integrity)) return networkError("the response doesn't match the request's integrity metadata");
  if (response.body !== null) response.body = new InnerBody({ body: bytes, consumed: false });
  return response;
}

async function schemeFetch(req, terminator) {
  const url = new URL(req.currentUrl());
  if ((url.protocol === "http:" || url.protocol === "https:") && url.port !== "" && BAD_PORTS[url.port] === true) {
    return networkError(`Requests to port ${url.port} are blocked`);
  }

  if (req.blobUrlEntry !== null) {
    if (req.method !== "GET") throw new TypeError("Blob URL fetch only supports GET method");
    const body = new InnerBody(req.blobUrlEntry.stream());
    terminator[abortSignal.add](() => body.error(terminator.reason));
    processUrlList(req.urlList, req.urlListProcessed);
    return {
      headerList: [
        ["content-length", String(req.blobUrlEntry.size)],
        // The blob's type, if it's a valid MIME type; otherwise none.
        ["content-type", parseMimeType(req.blobUrlEntry.type) === null ? "" : req.blobUrlEntry.type],
      ],
      status: 200,
      statusMessage: "OK",
      body,
      type: "basic",
      url() {
        return this.urlList[this.urlList.length - 1] ?? null;
      },
      urlList: [...new SafeArrayIterator(req.urlListProcessed)],
    };
  }
  if (url.protocol === "data:") return fetchDataUrl(url, req);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return networkError(`fetching ${url.protocol} URLs is not supported`);
  }
  if (transport === null) {
    throw new TypeError("fetch is not available: this isolate has no fetch policy");
  }

  // The request body: bytes, or a ReadableStream body (one with no
  // source), streamed to the broker as it's read. Bodies with a source
  // (Blob, FormData) have a known length, and are sent whole.
  let reqBody;
  let upload = null;
  if (req.body) {
    const stream = req.body.streamOrStatic;
    const body = stream.body;
    if (TypedArrayPrototypeGetSymbolToStringTag(body) === "Uint8Array") {
      reqBody = body;
    } else if (typeof body === "string") {
      reqBody = core.encode(body);
    } else if (ObjectPrototypeIsPrototypeOf(ReadableStreamPrototype, stream)) {
      if (req.body.source === null) upload = stream;
      else reqBody = await readableStreamCollectIntoUint8Array(stream);
    } else {
      throw new TypeError("Invalid body");
    }
  }
  if (terminator.aborted) return abortedNetworkError();

  const id = nextFetchId++;
  const onAbort = () => cancel(id);
  terminator[abortSignal.add](onAbort);
  let head;
  try {
    const opened = transport("open", id, {
      url: req.currentUrl(),
      method: req.method,
      headers: req.headerList,
      redirect: req.redirectMode,
      streamBody: upload !== null,
    }, reqBody);
    if (upload !== null) sendBody(id, upload);
    head = await opened;
  } catch (err) {
    if (terminator.aborted) return abortedNetworkError();
    throw new TypeError(err?.message ?? "fetch failed", { cause: err });
  }
  if (terminator.aborted) {
    cancel(id);
    return abortedNetworkError();
  }

  processUrlList(req.urlList, req.urlListProcessed);
  // The broker followed redirects: its hops after the first are new URLs.
  for (const hop of new SafeArrayIterator(ArrayPrototypeSlice(head.urlList, 1))) {
    ArrayPrototypePush(req.urlListProcessed, hop);
  }

  const response = {
    headerList: head.headers,
    status: head.status,
    body: null,
    statusMessage: head.statusText,
    type: "basic",
    url() {
      return this.urlList[this.urlList.length - 1] ?? null;
    },
    urlList: req.urlListProcessed,
  };
  if (nullBodyStatus(response.status) || req.method === "HEAD" || req.method === "CONNECT") {
    cancel(id);
  } else {
    response.body = new InnerBody(bodyStream(id, terminator));
  }
  return response;
}

function abortFetch(request, responseObject, error) {
  if (request.body !== null) {
    // Cancel the body if we haven't read it yet
    if (!request.body.streamOrStatic.locked) {
      request.body.cancel(error);
    }
  }
  if (responseObject !== null) {
    const response = toInnerResponse(responseObject);
    if (response.body !== null) response.body.error(error);
  }
  return error;
}

function fetch(input, init = undefined) {
  // 1.
  return new Promise((resolve, reject) => {
    const prefix = "Failed to execute 'fetch'";
    webidl.requiredArguments(arguments.length, 1, prefix);
    // 2.
    const requestObject = new Request(input, init);
    // 3.
    const request = toInnerRequest(requestObject);
    // 4.
    if (requestObject.signal.aborted) {
      reject(abortFetch(request, null, requestObject.signal.reason));
      return;
    }
    // 7.
    let responseObject = null;
    // 9.
    let locallyAborted = false;
    // 10.
    function onabort() {
      locallyAborted = true;
      reject(abortFetch(request, responseObject, requestObject.signal.reason));
    }
    requestObject.signal[abortSignal.add](onabort);

    if (!requestObject.headers.has("Accept")) {
      ArrayPrototypePush(request.headerList, ["Accept", "*/*"]);
    }
    if (!requestObject.headers.has("Accept-Language")) {
      ArrayPrototypePush(request.headerList, ["Accept-Language", "*"]);
    }

    // 12.
    PromisePrototypeCatch(
      PromisePrototypeThen(
        mainFetch(request, requestObject.signal),
        (response) => {
          // 12.1.
          if (locallyAborted) return;
          // 12.2.
          if (response.aborted) {
            reject(abortFetch(request, responseObject, requestObject.signal.reason));
            requestObject.signal[abortSignal.remove](onabort);
            return;
          }
          // 12.3.
          if (response.type === "error") {
            reject(new TypeError("Fetch failed: " + (response.error ?? "unknown error")));
            requestObject.signal[abortSignal.remove](onabort);
            return;
          }
          responseObject = fromInnerResponse(response, "immutable");
          resolve(responseObject);
          requestObject.signal[abortSignal.remove](onabort);
        },
      ),
      (err) => {
        reject(err);
        requestObject.signal[abortSignal.remove](onabort);
      },
    );
  });
}

return { fetch, setTransport };
})();
