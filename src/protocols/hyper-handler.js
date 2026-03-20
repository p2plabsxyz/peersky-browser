import { create as createSDK } from "hyper-sdk";
import makeHyperFetch from "hypercore-fetch";
import { initChat, handleChatRequest as handleChatRequestP2P } from "../pages/p2p/chat/p2p.js";
import { hyperCache, saveHyperCache } from "./config.js";

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

export async function createHandler(options) {
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
          body: req.body,
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
    console.log(`[handleHyperRequest] Fetching: ${method} ${url}`);
    const resp = await fetchFn(url, {
      method,
      headers,
      body: hasBody ? req.body : undefined,
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
