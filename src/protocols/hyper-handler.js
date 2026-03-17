import { Readable } from "stream";
import { create as createSDK } from "hyper-sdk";
import makeHyperFetch from "hypercore-fetch";
import { initChat, handleChatRequest as handleChatRequestP2P } from "../pages/p2p/chat/p2p.js";
import { enforceExtensionWritePolicy } from "./request-policy.js";

// Single SDK and swarm for the app lifecycle (hyper:// browsing + chat share the same swarm).
let sdk, fetch;

// keep chunks smaller to avoid oversized blocks.
const MAX_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

function isWebReadableStream(body) {
  return body && typeof body.getReader === "function";
}

function isAsyncIterable(body) {
  return body && typeof body[Symbol.asyncIterator] === "function";
}

async function* readWebStream(stream) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    if (reader.releaseLock) reader.releaseLock();
  }
}

async function* chunkAsyncIterable(iterable, chunkSize) {
  for await (const chunk of iterable) {
    if (chunk == null) continue;
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : Buffer.from(chunk);
    for (let offset = 0; offset < buf.length; offset += chunkSize) {
      yield buf.subarray(offset, offset + chunkSize);
    }
  }
}

function getChunkedBody(req) {
  const body = req.body;
  if (!body) return body;

  const contentType = req.headers?.get?.("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    return body;
  }

  const iterable = isWebReadableStream(body)
    ? readWebStream(body)
    : isAsyncIterable(body)
      ? body
      : null;

  if (!iterable) {
    if (Buffer.isBuffer(body)) {
      return Readable.from(chunkAsyncIterable([body], MAX_UPLOAD_CHUNK_BYTES));
    }
    if (body instanceof Uint8Array) {
      const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
      return Readable.from(chunkAsyncIterable([buf], MAX_UPLOAD_CHUNK_BYTES));
    }
    if (body instanceof ArrayBuffer) {
      return Readable.from(
        chunkAsyncIterable([Buffer.from(body)], MAX_UPLOAD_CHUNK_BYTES)
      );
    }
    if (typeof body === "string") {
      return Readable.from(
        chunkAsyncIterable([Buffer.from(body)], MAX_UPLOAD_CHUNK_BYTES)
      );
    }
    return body;
  }
  return Readable.from(chunkAsyncIterable(iterable, MAX_UPLOAD_CHUNK_BYTES));
}

async function initializeHyperSDK(options) {
  if (sdk != null && fetch != null) return fetch;

  console.log("Initializing Hyper SDK...");

  sdk = await createSDK(options);
  fetch = makeHyperFetch({ sdk, writable: true });

  initChat(sdk);

  console.log("Hyper SDK initialized.");
  return fetch;
}

export async function createHandler(options, securityOptions = {}) {
  const { isExtensionWriteAllowed } = securityOptions;
  await initializeHyperSDK(options);

  return async function protocolHandler(req) {
    const { url, method } = req;
    const urlObj = new URL(url);
    const protocol = urlObj.protocol.replace(":", "");
    const pathname = urlObj.pathname;

    console.log(`Handling request: ${method} ${url}`);

    // Intercept Hyperdrive key generation/retrieval
    if (method === 'POST' && urlObj.searchParams.has('key')) {
      const keyName = urlObj.searchParams.get('key');
      try {
        const fetchFn = await initializeHyperSDK();
        const resp = await fetchFn(url, {
          method,
          headers: req.headers,
          body: getChunkedBody(req),
          duplex: "half",
        });
        if (resp.status === 200) {
          const buffer = await resp.arrayBuffer();
          const driveKeyStr = Buffer.from(buffer).toString();
          console.log("Extracted raw key response:", driveKeyStr);

          const match = driveKeyStr.match(/([0-9a-zA-Z]{52,64})/);
          if (match) {
            const driveKey = match[1];
            const timestamp = Date.now();
            const existingEntry = hyperCache.find(entry => entry.key === driveKey);
            if (!existingEntry) {
              hyperCache.push({
                name: keyName || "Drive",
                key: driveKey,
                timestamp: timestamp,
                type: 'drive'
              });
              saveHyperCache();
              console.log(`Logged Hyperdrive to cache: ${keyName} (${driveKey})`);
            } else {
              existingEntry.timestamp = timestamp;
              if (keyName && (existingEntry.name === "Drive" || !existingEntry.name)) {
                existingEntry.name = keyName;
              }
              saveHyperCache();
              console.log(`Updated Hyperdrive in cache: ${keyName} (${driveKey})`);
            }
          }
          return new Response(buffer, {
            status: resp.status,
            headers: Object.fromEntries(resp.headers),
          });
        }
        return resp;
      } catch (err) {
        console.error("Error handling Hyperdrive key request:", err);
        return new Response(`Error handling Hyperdrive key request: ${err.message}`, {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        });
      }
    }

    try {
      const denied = await enforceExtensionWritePolicy({
        request: req,
        scheme: "hyper",
        isExtensionWriteAllowed,
      });
      if (denied) return denied;

      if (
        protocol === "hyper" &&
        (urlObj.hostname === "chat" || pathname.startsWith("/chat"))
      ) {
        return await handleChatRequestP2P(req, sdk);
      } else {
        return await handleHyperRequest(req);
      }
    } catch (err) {
      console.error("Failed to handle Hyper request:", err);
      return new Response(`Error handling Hyper request: ${err.message}`, {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  };
}

// Handle general hyper:// requests (not chat API).
async function handleHyperRequest(req) {
  const { url, method = "GET", headers } = req;
  const fetchFn = await initializeHyperSDK();
  const upperMethod = method.toUpperCase();
  const hasBody = upperMethod !== "GET" && upperMethod !== "HEAD";

  try {
    const resp = await fetchFn(url, {
      method,
      headers,
      body: hasBody ? getChunkedBody(req) : undefined,
      ...(hasBody ? { duplex: "half" } : {}),
    });

    console.log("Response received:", resp.status);
    return resp;
  } catch (err) {
    console.error("Failed to fetch from Hyper SDK:", err);
    return new Response(`Error fetching data: ${err.message}`, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
}
