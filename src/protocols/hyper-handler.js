import { create as createSDK } from "hyper-sdk";
import makeHyperFetch from "hypercore-fetch";
import { Readable, PassThrough } from "stream";
import fs from "fs-extra";
import HyperDHT from "hyperdht";
import Hyperswarm from "hyperswarm";
import crypto from "hypercore-crypto";
import b4a from "b4a";
import { hyperOptions, loadKeyPair, saveKeyPair } from "./config.js";

let sdk, fetch;
let swarm = null;

// Mapping: roomKey -> hypercore feed (stores chat messages)
const roomFeeds = {};
// Mapping: roomKey -> array of SSE clients (for real-time updates)
const roomSseClients = {};

let peers = [];
// Keep track of which rooms we’ve joined in the swarm (avoid double-joining)
const joinedRooms = new Set();

function createDHT() {
  const dht = new HyperDHT({ ephemeral: false });
  dht.on("error", (err) => {
    console.error("HyperDHT error:", err);
  });
  return dht;
}

// Initialize Hyper SDK (once)
async function initializeHyperSDK(options) {
  if (sdk && fetch) return fetch;

  console.log("Initializing Hyper SDK...");

  // Load or generate the swarm keypair
  let keyPair = loadKeyPair();
  if (!keyPair) {
    keyPair = crypto.keyPair();
    saveKeyPair(keyPair);
    console.log("Generated new swarm keypair");
  } else {
    console.log("Loaded existing swarm keypair");
  }

  sdk = await createSDK(options);
  fetch = makeHyperFetch({ sdk, writable: true });
  console.log("Hyper SDK initialized.");
  return fetch;
}

// Initialize Hyperswarm with the keypair from hyperOptions and a custom DHT.
async function initializeSwarm() {
  if (swarm) return;

  const keyPair = hyperOptions.keyPair;
  const dht = createDHT();

  swarm = new Hyperswarm({
    keyPair,
    dht,
    firewall: (remotePublicKey, details) => false,
  });

  swarm.on("error", (err) => {
    console.error("Hyperswarm error:", err);
  });

  // On new peer connections:
  swarm.on("connection", (connection, info) => {
    const shortID = connection.remotePublicKey
      ? b4a.toString(connection.remotePublicKey, "hex").substr(0, 6)
      : "peer";

    if (info.discoveryKey) {
      const discKey = b4a.toString(info.discoveryKey, "hex");
      console.log(`New peer [${shortID}] connected, discKey: ${discKey}`);
    } else {
      console.log(`New peer [${shortID}] connected (no discKey).`);
    }

    connection.on("error", (err) => {
      console.error(`Peer [${shortID}] connection error:`, err);
    });

    peers.push({ connection, shortID });
    console.log(`Peers connected: ${peers.length}`);
    broadcastPeerCount();

    // Replicate all known feeds on this connection.
    for (const feed of Object.values(roomFeeds)) {
      feed.replicate(connection);
    }

    connection.on("data", (rawData) => {
      let msg;
      try {
        msg = JSON.parse(rawData.toString());
      } catch {
        msg = {
          sender: shortID,
          message: rawData.toString(),
          timestamp: Date.now(),
        };
      }
      msg.sender = shortID;
      if (!msg.timestamp) msg.timestamp = Date.now();
      console.log(`Peer [${shortID}] =>`, msg);
      if (msg.roomKey && roomFeeds[msg.roomKey]) {
        appendMessageToFeed(msg.roomKey, {
          sender: msg.sender,
          message: msg.message,
          timestamp: msg.timestamp,
        }).catch((err) => {
          console.error("Error appending peer msg to feed:", err);
        });
      }
    });

    connection.on("close", () => {
      peers = peers.filter((p) => p.connection !== connection);
      console.log(`Peer [${shortID}] disconnected. Peers: ${peers.length}`);
      broadcastPeerCount();
    });
  });
}

// Main exported function to handle the `hyper://` protocol.
export async function createHandler(options, session) {
  await initializeHyperSDK(options);
  await initializeSwarm();

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
        await handleChatRequest(req, callback, session);
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

// Handle all chat‐related endpoints (create room, join room, send/receive messages, etc).
async function handleChatRequest(req, callback, session) {
  const { url, method, uploadData } = req;
  const urlObj = new URL(url);
  const action = urlObj.searchParams.get("action");
  const roomKey = urlObj.searchParams.get("roomKey");

  console.log(`Chat request: ${method} ${url}`);

  try {
    if (method === "POST" && action === "create-key") {
      // Create a brand-new random roomKey
      const newRoomKey = await generateChatRoom();
      console.log("Generated new chat room key:", newRoomKey);
      callback({
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        data: Readable.from([
          Buffer.from(JSON.stringify({ roomKey: newRoomKey })),
        ]),
      });
    } else if (method === "POST" && action === "join") {
      // Join an existing room
      if (!roomKey) throw new Error("Missing roomKey in join request");
      console.log("Joining chat room:", roomKey);
      await joinChatRoom(roomKey);
      callback({
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        data: Readable.from([
          Buffer.from(JSON.stringify({ message: "Joined chat room" })),
        ]),
      });
    } else if (method === "POST" && action === "send") {
      // Send a message
      if (!roomKey) throw new Error("Missing roomKey in send request");
      const { sender, message } = await getJSONBody(uploadData, session);
      console.log(`Sending message [${sender}]: ${message}`);

      // Append to feed
      await appendMessageToFeed(roomKey, {
        sender,
        message,
        timestamp: Date.now(),
      });

      // Broadcast to peers
      const data = JSON.stringify({
        sender,
        message,
        timestamp: Date.now(),
        roomKey,
      });
      sendMessageToPeers(data);

      callback({
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        data: Readable.from([
          Buffer.from(JSON.stringify({ message: "Message sent" })),
        ]),
      });
    } else if (method === "GET" && action === "receive") {
      // SSE for receiving messages in real-time
      if (!roomKey) throw new Error("Missing roomKey in receive request");
      console.log("Setting up SSE for room:", roomKey);

      const feed = roomFeeds[roomKey];
      if (!feed) throw new Error("Feed not initialized for this room");

      const stream = new PassThrough();
      session.messageStream = stream; // keep reference

      // Replay the entire feed so the client sees the full history
      for (let i = 0; i < feed.length; i++) {
        const msg = await feed.get(i);
        stream.write(`data: ${JSON.stringify(msg)}\n\n`);
      }

      // Keep the SSE connection alive
      const keepAlive = setInterval(() => {
        stream.write(":\n\n");
      }, 15000);

      // Track SSE client
      if (!roomSseClients[roomKey]) {
        roomSseClients[roomKey] = [];
      }
      roomSseClients[roomKey].push(stream);

      stream.on("close", () => {
        clearInterval(keepAlive);
        roomSseClients[roomKey] = roomSseClients[roomKey].filter(
          (s) => s !== stream
        );
      });

      callback({
        statusCode: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
        data: stream,
      });
    } else {
      // Unknown action
      callback({
        statusCode: 400,
        headers: { "Content-Type": "text/plain" },
        data: Readable.from(["Invalid chat action"]),
      });
    }
  } catch (err) {
    console.error("Error in handleChatRequest:", err);
    callback({
      statusCode: 500,
      headers: { "Content-Type": "text/plain" },
      data: Readable.from([`Error in chat request: ${err.message}`]),
    });
  }
}

// Handle general hyper:// requests not related to “chat” API routes.
async function handleHyperRequest(req, callback, session) {
  const { url, method = "GET", headers = {}, uploadData } = req;
  const fetchFn = await initializeHyperSDK(); // ensure sdk/fetch is initted

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

// Helper: read the upload body (files, bytes, or blobs) into a stream.
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

// Helper: read JSON body from a request.
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

// Broadcast updated peer count to all SSE clients (in all rooms).
function broadcastPeerCount() {
  const cnt = peers.length;
  console.log(`Broadcasting peer count: ${cnt}`);
  for (const streams of Object.values(roomSseClients)) {
    for (const s of streams) {
      s.write(`event: peersCount\ndata: ${cnt}\n\n`);
    }
  }
}

// Send a raw data string to all currently connected peers (swarm connections).
function sendMessageToPeers(data) {
  console.log(`Broadcasting message to ${peers.length} peers`);
  for (const { connection } of peers) {
    // If the connection is still open, write data
    if (!connection.destroyed) {
      connection.write(data);
    }
  }
}

// Append a message object to the feed for a given roomKey.
async function appendMessageToFeed(roomKey, { sender, message, timestamp }) {
  const feed = roomFeeds[roomKey];
  if (!feed) {
    throw new Error(`Feed not initialized for room ${roomKey}`);
  }
  const obj = {
    sender,
    message,
    timestamp: timestamp || Date.now(),
  };
  await feed.append(obj);
}

// Create a brand-new random 32-byte hex “roomKey”.
async function generateChatRoom() {
  const buf = crypto.randomBytes(32);
  return b4a.toString(buf, "hex");
}

// Join a chat room: create/load the feed, join the swarm topic, etc.
async function joinChatRoom(roomKey) {
  // 1) Load the feed deterministically using the room key via the 'name' option.
  let feed = roomFeeds[roomKey];
  if (!feed) {
    feed = sdk.corestore.get({
      name: "chat-" + roomKey, // Use a deterministic name so every device gets the same feed.
      valueEncoding: "json",
    });
    await feed.ready();
    roomFeeds[roomKey] = feed;

    // 2) When new entries are appended to this feed, broadcast them via SSE.
    feed.on("append", async () => {
      const idx = feed.length - 1;
      const msg = await feed.get(idx);
      const sseArray = roomSseClients[roomKey] || [];
      for (const s of sseArray) {
        s.write(`data: ${JSON.stringify(msg)}\n\n`);
      }
    });
  }

  // 3) Join the swarm (only once per room)
  if (!joinedRooms.has(roomKey)) {
    joinedRooms.add(roomKey);
    const topicBuf = b4a.from(roomKey, "hex");
    swarm.join(topicBuf, { client: true, server: true });
    await swarm.flush();
    console.log(`Joined swarm for room: ${roomKey}`);
  } else {
    console.log(`Already joined swarm for room: ${roomKey}`);
  }
}
