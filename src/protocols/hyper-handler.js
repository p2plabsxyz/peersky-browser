import { create as createSDK } from "hyper-sdk";
import makeHyperFetch from "hypercore-fetch";
import { Readable, PassThrough } from "stream";
import fs from "fs-extra";
import { initChat, handleChatRequest as handleChatRequestP2P } from "../pages/p2p/chat/p2p.js";

// Single SDK and swarm for the app lifecycle (hyper:// browsing + chat share the same swarm).
let sdk, fetch;

async function initializeHyperSDK(options) {
  if (sdk != null && fetch != null) return fetch;

  console.log("Initializing Hyper SDK...");

  sdk = await createSDK(options);
  fetch = makeHyperFetch({ sdk, writable: true });

  initChat(sdk);

  console.log("Hyper SDK initialized.");
  return fetch;
}

export async function createHandler(options, session) {
  await initializeHyperSDK(options);

  return async function protocolHandler(req, callback) {
    const { url, method, headers, uploadData } = req;
    const urlObj = new URL(url);
    const protocol = urlObj.protocol.replace(":", "");
    const pathname = urlObj.pathname;

    console.log(`Handling request: ${method} ${url}`);

    try {
      if (
        protocol === "hyper" &&
        (urlObj.hostname === "chat" || pathname.startsWith("/chat"))
      ) {
        await handleChatRequestP2P(req, callback, session, { getJSONBody }, sdk);
      } else {
        await handleHyperRequest(req, callback, session);
      }
    } catch (err) {
      console.error("Failed to handle Hyper request:", err);
      callback({
        statusCode: 500,
        headers: { "Content-Type": "text/plain" },
        data: Readable.from([`Error handling Hyper request: ${err.message}`]),
      });
    }
  };
}

// Handle general hyper:// requests (not chat API).
async function handleHyperRequest(req, callback, session) {
  const { url, method = "GET", headers = {}, uploadData } = req;
  const fetchFn = await initializeHyperSDK();

  let body;
  if (uploadData) {
    try {
      body = readBody(uploadData, session);
    } catch (err) {
      console.error("Error reading uploadData:", err);
      callback({
        statusCode: 400,
        headers: { "Content-Type": "text/plain" },
        data: Readable.from(["Invalid upload data"]),
      });
      return;
    }
  }

  try {
    const resp = await fetchFn(url, {
      method,
      headers,
      body,
      duplex: "half",
    });
    if (resp.body) {
      const responseStream = Readable.from(resp.body);
      console.log("Response received:", resp.status);
      callback({
        statusCode: resp.status,
        headers: Object.fromEntries(resp.headers),
        data: responseStream,
      });
    } else {
      console.warn("No response body.");
      callback({
        statusCode: resp.status,
        headers: Object.fromEntries(resp.headers),
        data: Readable.from([""]),
      });
    }
  } catch (err) {
    console.error("Failed to fetch from Hyper SDK:", err);
    callback({
      statusCode: 500,
      headers: { "Content-Type": "text/plain" },
      data: Readable.from([`Error fetching data: ${err.message}`]),
    });
  }
}

function readBody(body, session) {
  const stream = new PassThrough();
  (async () => {
    try {
      for (const data of body || []) {
        if (data.bytes) {
          stream.write(data.bytes);
        } else if (data.file) {
          const fileStream = fs.createReadStream(data.file);
          fileStream.pipe(stream, { end: false });
          await new Promise((resolve, reject) => {
            fileStream.on("end", resolve);
            fileStream.on("error", reject);
          });
        } else if (data.blobUUID) {
          const blobData = await session.getBlobData(data.blobUUID);
          stream.write(blobData);
        }
      }
      stream.end();
    } catch (err) {
      console.error("Error reading request body:", err);
      stream.emit("error", err);
    }
  })();
  return stream;
}

async function getJSONBody(uploadData, session) {
  const stream = readBody(uploadData, session);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  console.log("Request body received (JSON):", buf.toString());
  return JSON.parse(buf.toString());
}
