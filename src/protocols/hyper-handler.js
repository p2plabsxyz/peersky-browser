import { create as createSDK } from "hyper-sdk";
import makeHyperFetch from "hypercore-fetch";
import { initChat, handleChatRequest as handleChatRequestP2P } from "../pages/p2p/chat/p2p.js";
import { enforceExtensionWritePolicy } from "./request-policy.js";

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

export async function createHandler(options, securityOptions = {}) {
  const { isExtensionWriteAllowed } = securityOptions;
  await initializeHyperSDK(options);

  return async function protocolHandler(req) {
    const { url, method } = req;
    const urlObj = new URL(url);
    const protocol = urlObj.protocol.replace(":", "");
    const pathname = urlObj.pathname;

    console.log(`Handling request: ${method} ${url}`);

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
