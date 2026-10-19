// The spec fetch() (WHATWG Fetch: "fetch" and "main fetch") for VMs with
// the web platform, over isolane's network broker instead of a network
// stack. Adapted from Deno's ext/fetch/26_fetch.js (MIT; see
// deno/LICENSE.md): Request, Response, Headers, and bodies are Deno's
// vendored classes, unchanged; this file replaces only the part that talks
// to the network, which here is a host function handed over by the
// prelude (ts/capabilities.ts). The broker sends each request, follows
// redirects (each hop checked against the isolate's fetch policy), and streams
// the response body: open(id, meta, body) → status and headers, then
// read(id) → the next bytes (null at the end), cancel(id) to abort.
//
// Differences from Deno's fetch: request bodies are buffered (a streamed
// request body is read to the end before sending); blob: and data: URLs are
// fetched here, other non-HTTP(S) schemes are network errors; no HTTP
// client options, telemetry, or inspector events.
(function () {
const { core, primordials } = __bootstrap;
const {
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  NumberParseInt,
  ObjectPrototypeIsPrototypeOf,
  Promise,
  PromisePrototypeCatch,
  PromisePrototypeThen,
  RegExpPrototypeExec,
  SafeArrayIterator,
  StringFromCharCode,
  StringPrototypeCharCodeAt,
  StringPrototypeIndexOf,
  StringPrototypeSlice,
  StringPrototypeTrim,
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

/** A byte stream over the broker's body reads, pulled as the guest reads.
 * Aborting the fetch's signal errors it with the abort reason (as Deno's
 * resource-backed body streams do) and cancels the broker's request. */
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
  });
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

/** Percent-decode an ASCII string to bytes (URL's percent-decode). */
function percentDecode(input) {
  const out = new Uint8Array(input.length);
  let n = 0;
  for (let i = 0; i < input.length; i++) {
    const c = StringPrototypeCharCodeAt(input, i);
    if (c === 0x25 && i + 2 < input.length && RegExpPrototypeExec(/^[0-9a-fA-F]{2}$/, StringPrototypeSlice(input, i + 1, i + 3)) !== null) {
      out[n++] = NumberParseInt(StringPrototypeSlice(input, i + 1, i + 3), 16);
      i += 2;
    } else {
      out[n++] = c & 0xff;
    }
  }
  return new Uint8Array(out.buffer, 0, n);
}

/** https://fetch.spec.whatwg.org/#data-url-processor (the MIME type is
 * passed through as written, without the spec's full parsing). */
function fetchDataUrl(url, req) {
  if (req.method !== "GET") return networkError("data: URLs only support GET");
  const href = url.href;
  const comma = StringPrototypeIndexOf(href, ",");
  if (comma === -1) return networkError("invalid data: URL");
  let mime = StringPrototypeTrim(StringPrototypeSlice(href, 5, comma));
  let bytes = percentDecode(StringPrototypeSlice(href, comma + 1));
  const base64 = RegExpPrototypeExec(/;\s*base64$/i, mime);
  if (base64 !== null) {
    mime = StringPrototypeSlice(mime, 0, base64.index);
    let text = "";
    for (let i = 0; i < bytes.length; i++) text += StringFromCharCode(bytes[i]);
    try {
      bytes = forgivingBase64Decode(text);
    } catch {
      return networkError("invalid data: URL");
    }
  }
  if (mime === "" || mime[0] === ";") mime = "text/plain" + (mime === "" ? ";charset=US-ASCII" : mime);
  processUrlList(req.urlList, req.urlListProcessed);
  return {
    headerList: [["content-type", mime]],
    status: 200,
    statusMessage: "OK",
    body: new InnerBody({ body: bytes, consumed: false }),
    type: "basic",
    url() {
      return this.urlList[this.urlList.length - 1] ?? null;
    },
    urlList: [...new SafeArrayIterator(req.urlListProcessed)],
  };
}

async function mainFetch(req, terminator) {
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
        ["content-type", req.blobUrlEntry.type],
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

  // The request body, buffered.
  let reqBody;
  if (req.body) {
    const stream = req.body.streamOrStatic;
    const body = stream.body;
    if (TypedArrayPrototypeGetSymbolToStringTag(body) === "Uint8Array") {
      reqBody = body;
    } else if (typeof body === "string") {
      reqBody = core.encode(body);
    } else if (ObjectPrototypeIsPrototypeOf(ReadableStreamPrototype, stream)) {
      reqBody = await readableStreamCollectIntoUint8Array(stream);
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
    head = await transport("open", id, {
      url: req.currentUrl(),
      method: req.method,
      headers: req.headerList,
      redirect: req.redirectMode,
    }, reqBody);
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
