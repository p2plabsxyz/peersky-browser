/**
 * P2P chat over the Hyper swarm: room keys, feeds, SSE, and peer messaging.
 * Requires the shared Hyper SDK (and its single swarm) to be initialized first;
 * initChat(sdk) registers the chat connection handler on that swarm.
 */
import { Readable, PassThrough } from "stream";
import b4a from "b4a";

// Room key -> hypercore feed (chat message history)
const roomFeeds = {};
// Room key -> array of SSE streams for real-time updates
const roomSseClients = {};

let peers = [];
const joinedRooms = new Set();
const chatDiscoveryKeys = new Set();

/** Room keys are 32-byte hex (64 chars). Reject invalid to avoid bad feed names and topic buffers. */
function isValidRoomKey(roomKey) {
  return typeof roomKey === "string" && /^[a-f0-9]{64}$/i.test(roomKey);
}

const MAX_SENDER_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 64 * 1024; // 64KB

function sanitizeSendPayload(sender, message) {
  const s = typeof sender === "string" ? sender : String(sender ?? "");
  const m = typeof message === "string" ? message : String(message ?? "");
  if (s.length > MAX_SENDER_LENGTH) throw new Error("Sender too long");
  if (m.length > MAX_MESSAGE_LENGTH) throw new Error("Message too long");
  return { sender: s, message: m };
}

/**
 * Register chat-specific connection handling on the shared swarm.
 * Call once after the Hyper SDK is created.
 * @param {import('hyper-sdk').SDK} sdk
 */
export function initChat(sdk) {
  sdk.swarm.on("connection", (connection, info) => {
    const shortID = connection.remotePublicKey
      ? b4a.toString(connection.remotePublicKey, "hex").substr(0, 6)
      : "peer";

    const hasChatTopic =
      info.topics &&
      info.topics.length > 0 &&
      info.topics.some((t) => chatDiscoveryKeys.has(b4a.toString(t, "hex")));
    const isServerConnection = !info.topics || info.topics.length === 0;
    const isChatConnection =
      hasChatTopic || (isServerConnection && chatDiscoveryKeys.size > 0);

    if (!isChatConnection) {
      connection.on("error", (err) => {
        console.error(`Peer [${shortID}] (replication) connection error:`, err);
      });
      return;
    }

    console.log(`New chat peer [${shortID}] connected`);

    connection.on("error", (err) => {
      console.error(`Peer [${shortID}] connection error:`, err);
    });

    // Replace any existing peer with the same key (e.g. after the other side restarted)
    const keyHex =
      connection.remotePublicKey &&
      b4a.toString(connection.remotePublicKey, "hex");
    if (keyHex) {
      peers = peers.filter(
        (p) =>
          !p.connection.remotePublicKey ||
          b4a.toString(p.connection.remotePublicKey, "hex") !== keyHex
      );
    }
    peers.push({ connection, shortID });
    console.log(`Peers connected: ${peers.length}`);
    broadcastPeerCount();

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
      if (msg.roomKey && roomFeeds[msg.roomKey]) {
        console.log(`Peer [${shortID}] =>`, msg);
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

function pruneDestroyedPeers() {
  const before = peers.length;
  peers = peers.filter((p) => !p.connection.destroyed);
  if (peers.length !== before) {
    console.log(`Pruned ${before - peers.length} dead peer(s). Peers: ${peers.length}`);
    return true;
  }
  return false;
}

function broadcastPeerCount() {
  if (pruneDestroyedPeers()) {
    // already logged in pruneDestroyedPeers
  }
  const cnt = peers.length;
  console.log(`Broadcasting peer count: ${cnt}`);
  for (const streams of Object.values(roomSseClients)) {
    for (const s of streams) {
      s.write(`event: peersCount\ndata: ${cnt}\n\n`);
    }
  }
}

function sendMessageToPeers(data) {
  const toRemove = [];
  for (let i = 0; i < peers.length; i++) {
    const { connection } = peers[i];
    if (connection.destroyed) {
      toRemove.push(i);
      continue;
    }
    try {
      connection.write(data);
    } catch (err) {
      console.error("Peer write failed, removing:", err?.message || err);
      toRemove.push(i);
    }
  }
  if (toRemove.length > 0) {
    peers = peers.filter((_, i) => !toRemove.includes(i));
    broadcastPeerCount();
  }
  console.log(`Broadcasting message to ${peers.length} peers`);
}

async function appendMessageToFeed(roomKey, { sender, message, timestamp }) {
  const feed = roomFeeds[roomKey];
  if (!feed) {
    throw new Error(`Feed not initialized for room ${roomKey}`);
  }
  await feed.append({
    sender,
    message,
    timestamp: timestamp || Date.now(),
  });
}

function generateChatRoom() {
  const randomBuf = Buffer.alloc(32);
  globalThis.crypto.getRandomValues(randomBuf);
  return b4a.toString(randomBuf, "hex");
}

async function joinChatRoom(sdk, roomKey) {
  let feed = roomFeeds[roomKey];
  if (!feed) {
    feed = sdk.corestore.get({
      name: "chat-" + roomKey,
      valueEncoding: "json",
    });
    await feed.ready();
    roomFeeds[roomKey] = feed;

    feed.on("append", async () => {
      const idx = feed.length - 1;
      const msg = await feed.get(idx);
      const sseArray = roomSseClients[roomKey] || [];
      for (const s of sseArray) {
        s.write(`data: ${JSON.stringify(msg)}\n\n`);
      }
    });
  }

  if (!joinedRooms.has(roomKey)) {
    joinedRooms.add(roomKey);
    chatDiscoveryKeys.add(roomKey);
    const topicBuf = b4a.from(roomKey, "hex");
    sdk.join(topicBuf, { client: true, server: true });
    await sdk.swarm.flush();
    console.log(`Joined swarm for room: ${roomKey}`);
  } else {
    console.log(`Already joined swarm for room: ${roomKey}`);
  }
}

/**
 * Handle hyper://chat requests (create-key, join, send, receive/SSE).
 * @param {object} req - Protocol request (url, method, uploadData)
 * @param {function} callback - (response) => void
 * @param {object} session - Electron session (for getBlobData if needed)
 * @param {object} deps - { getJSONBody(req.uploadData, session) => Promise<object> }
 * @param {import('hyper-sdk').SDK} sdk - Hyper SDK (for joinChatRoom / room feeds)
 */
export async function handleChatRequest(req, callback, session, deps, sdk) {
  const { url, method, uploadData } = req;
  const urlObj = new URL(url);
  const action = urlObj.searchParams.get("action");
  const roomKey = urlObj.searchParams.get("roomKey");
  const { getJSONBody } = deps;

  console.log(`Chat request: ${method} ${url}`);

  try {
    if (method === "POST" && action === "create-key") {
      const newRoomKey = generateChatRoom();
      console.log("Generated new chat room key:", newRoomKey);
      callback({
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        data: Readable.from([
          Buffer.from(JSON.stringify({ roomKey: newRoomKey })),
        ]),
      });
    } else if (method === "POST" && action === "join") {
      if (!roomKey) throw new Error("Missing roomKey in join request");
      if (!isValidRoomKey(roomKey)) throw new Error("Invalid roomKey format");
      console.log("Joining chat room:", roomKey);
      await joinChatRoom(sdk, roomKey);
      callback({
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        data: Readable.from([
          Buffer.from(JSON.stringify({ message: "Joined chat room" })),
        ]),
      });
    } else if (method === "POST" && action === "send") {
      if (!roomKey) throw new Error("Missing roomKey in send request");
      if (!isValidRoomKey(roomKey)) throw new Error("Invalid roomKey format");
      const raw = await getJSONBody(uploadData, session);
      const { sender, message } = sanitizeSendPayload(raw.sender, raw.message);
      console.log(`Sending message [${sender}]: ${message}`);

      await appendMessageToFeed(roomKey, {
        sender,
        message,
        timestamp: Date.now(),
      });

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
      if (!roomKey) throw new Error("Missing roomKey in receive request");
      if (!isValidRoomKey(roomKey)) throw new Error("Invalid roomKey format");
      console.log("Setting up SSE for room:", roomKey);

      const feed = roomFeeds[roomKey];
      if (!feed) throw new Error("Feed not initialized for this room");

      const stream = new PassThrough();

      for (let i = 0; i < feed.length; i++) {
        const msg = await feed.get(i);
        stream.write(`data: ${JSON.stringify(msg)}\n\n`);
      }

      const keepAlive = setInterval(() => {
        stream.write(":\n\n");
      }, 15000);

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
