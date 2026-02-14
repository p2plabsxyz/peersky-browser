/**
 * BitTorrent Worker Process
 * Runs WebTorrent in a separate Node.js process to avoid native module crashes in Electron.
 * Communicates with the main process via IPC (process.send / process.on('message')).
 * Pushes status updates periodically so the handler can serve cached data instantly.
 */
import WebTorrent from "webtorrent";
import path from "path";
import fs from "fs";

const downloadPath = process.argv[2] || path.join(process.env.HOME || "/tmp", "Downloads", "PeerskyTorrents");

// Ensure download directory exists
if (!fs.existsSync(downloadPath)) {
  fs.mkdirSync(downloadPath, { recursive: true });
}

let client = null;

function send(msg) {
  try {
    if (process.send) process.send(msg);
  } catch (err) {
    console.error("[BT-Worker] Failed to send IPC message:", err.message);
  }
}

function initClient() {
  if (client) return;

  // TODO: For future bt:// website seeding support, add a separate seed mode with:
  // - lsd: true, natUpnp: true, natPmp: true (so peers can reach us)
  // - uploadLimit set to a reasonable cap
  // - Use client.seed(files, opts) instead of client.add()
  // - Do NOT destroy torrent on done — keep alive for seeding
  // - Expose via separate API action e.g. bt://api?api=seed
  client = new WebTorrent({
    maxConns: 55,
    uploadLimit: -1,
    lsd: false,
    natUpnp: false,
    natPmp: false,
  });

  client.on("error", (err) => {
    console.error("[BT-Worker] Client error:", err.message);
    send({ type: "client-error", error: err.message });
  });

  console.log("[BT-Worker] WebTorrent client initialized. Download path:", downloadPath);
  send({ type: "ready" });
}

// Initialize immediately
initClient();

// Track previous status to avoid redundant updates
const previousStatus = new Map();

function hasStatusChanged(infoHash, newStatus) {
  const prev = previousStatus.get(infoHash);
  if (!prev) return true;
  
  // Check if significant fields changed (ignore minor fluctuations)
  return (
    prev.progress !== newStatus.progress ||
    prev.downloadSpeed !== newStatus.downloadSpeed ||
    prev.uploadSpeed !== newStatus.uploadSpeed ||
    prev.numPeers !== newStatus.numPeers ||
    prev.done !== newStatus.done ||
    prev.paused !== newStatus.paused
  );
}

// --- Periodic status push (every 2 seconds) ---
setInterval(() => {
  if (!client || client.torrents.length === 0) return;

  const updates = [];
  
  for (const torrent of client.torrents) {
    if (!torrent.infoHash) continue;
    
    const status = {
      infoHash: torrent.infoHash,
      name: torrent.name || "Fetching metadata...",
      downloadPath,
      progress: torrent.progress,
      downloaded: torrent.downloaded,
      uploaded: torrent.uploaded,
      downloadSpeed: torrent.downloadSpeed,
      uploadSpeed: torrent.uploadSpeed,
      ratio: torrent.ratio,
      numPeers: torrent.numPeers,
      timeRemaining: torrent.timeRemaining === Infinity ? null : torrent.timeRemaining,
      done: torrent.done,
      paused: torrent.paused,
      files: torrent.files
        ? torrent.files.map((f, i) => ({
            index: i,
            name: f.name,
            path: f.path,
            length: f.length,
            downloaded: f.downloaded,
            progress: f.progress,
          }))
        : [],
      magnetURI: torrent.magnetURI,
    };
    
    // Only send if status changed
    if (hasStatusChanged(torrent.infoHash, status)) {
      updates.push(status);
      previousStatus.set(torrent.infoHash, status);
    }
  }
  
  // Send bulk update if there are changes
  if (updates.length > 0) {
    send({
      type: "status-update-bulk",
      torrents: updates
    });
  }
}, 2000);

// --- IPC Command Handler ---
process.on("message", (msg) => {
  const { id, action, ...params } = msg;

  try {
    switch (action) {
      case "start":
        handleStart(id, params);
        break;
      case "pause":
        handlePause(id, params);
        break;
      case "resume":
        handleResume(id, params);
        break;
      case "remove":
        handleRemove(id, params);
        break;
      default:
        send({ id, error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error("[BT-Worker] Error handling message:", err);
    send({ id, error: err.message });
  }
});

function extractHash(uri) {
  const match = uri.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return match ? match[1].toLowerCase() : null;
}

async function handleStart(id, { magnetUri, announce }) {
  if (!client) {
    send({ id, error: "Client not initialized" });
    return;
  }

  // Extract infoHash and check by hash, not by full URI
  const hash = extractHash(magnetUri);
  console.log(`[BT-Worker] Start requested. Hash: ${hash}, Announce: ${(announce || []).length} trackers`);

  if (hash) {
    const existing = await client.get(hash);
    if (existing && existing.infoHash) {
      console.log("[BT-Worker] Torrent already active:", existing.infoHash, existing.name || "no name yet");
      send({
        id,
        type: "started",
        infoHash: existing.infoHash,
        magnetURI: existing.magnetURI,
        name: existing.name,
      });
      return;
    }
  }

  console.log("[BT-Worker] Adding torrent to client...");
  const torrent = client.add(magnetUri, {
    path: downloadPath,
    announce: announce || [],
  });

  torrent.on("infoHash", () => {
    console.log(`[BT-Worker] InfoHash resolved: ${torrent.infoHash}`);
  });

  torrent.on("metadata", () => {
    console.log(`[BT-Worker] Metadata: ${torrent.name}, ${torrent.files.length} files, ${(torrent.length / (1024 * 1024)).toFixed(1)} MB`);
  });

  torrent.on("ready", () => {
    console.log(`[BT-Worker] Ready: ${torrent.name}`);
  });

  torrent.on("done", () => {
    console.log(`[BT-Worker] Download complete: ${torrent.name}. Destroying torrent to prevent seeding.`);
    const infoHash = torrent.infoHash;
    // Send final status with all file info before destroying
    send({
      type: "status-update",
      infoHash,
      name: torrent.name,
      downloadPath,
      progress: 1,
      downloaded: torrent.downloaded,
      uploaded: torrent.uploaded,
      downloadSpeed: 0,
      uploadSpeed: 0,
      ratio: torrent.ratio,
      numPeers: 0,
      timeRemaining: 0,
      done: true,
      paused: false,
      files: torrent.files
        ? torrent.files.map((f, i) => ({
            index: i,
            name: f.name,
            path: f.path,
            length: f.length,
            downloaded: f.downloaded,
            progress: f.progress,
          }))
        : [],
      magnetURI: torrent.magnetURI,
    });
    send({ type: "done", infoHash });
    // Destroy immediately — keeps files on disk, stops all connections
    // TODO: Skip destroy when in seed mode (future bt:// website hosting)
    torrent.destroy({ destroyStore: false }, () => {
      console.log(`[BT-Worker] Torrent destroyed (no seeding): ${infoHash}`);
    });
  });

  torrent.on("error", (err) => {
    console.error(`[BT-Worker] Torrent error:`, err.message);
    send({ type: "torrent-error", infoHash: torrent.infoHash, error: err.message });
  });

  torrent.on("warning", (warn) => {
    const msg = typeof warn === "object" ? warn.message : warn;
    // Only log non-DNS warnings to reduce noise
    if (!msg.includes("getaddrinfo")) {
      console.warn(`[BT-Worker] Warning:`, msg);
    }
  });

  // Periodic progress logging (every 10s to reduce noise)
  let lastLogTime = 0;
  torrent.on("download", () => {
    const now = Date.now();
    if (now - lastLogTime > 10000) {
      lastLogTime = now;
      console.log(
        `[BT-Worker] Progress: ${(torrent.progress * 100).toFixed(1)}%, ` +
        `${(torrent.downloaded / (1024 * 1024)).toFixed(1)} MB, ` +
        `${(torrent.downloadSpeed / 1024).toFixed(1)} KB/s, ` +
        `${torrent.numPeers} peers`
      );
    }
  });

  // Send initial response
  send({
    id,
    type: "started",
    infoHash: torrent.infoHash || hash || null,
    magnetURI: torrent.magnetURI,
  });
}

async function handlePause(id, { hash }) {
  const torrent = hash ? await client.get(hash) : client.torrents[0];
  if (!torrent) {
    send({ id, error: "Torrent not found" });
    return;
  }
  // torrent.pause() only stops new peer connections per WebTorrent docs,
  // so we also choke all wires and deselect pieces to stop active transfers.
  torrent.pause();
  if (torrent.wires) {
    torrent.wires.forEach((wire) => wire.choke());
  }
  torrent.deselect(0, torrent.pieces.length - 1, 0);
  console.log(`[BT-Worker] Paused torrent: ${torrent.infoHash}`);
  send({ id, type: "paused", infoHash: torrent.infoHash });
}

async function handleResume(id, { hash }) {
  const torrent = hash ? await client.get(hash) : client.torrents[0];
  if (!torrent) {
    send({ id, error: "Torrent not found" });
    return;
  }
  torrent.resume();
  // Re-select all files and unchoke wires to restart transfers
  if (torrent.files) {
    torrent.files.forEach((file) => file.select());
  }
  if (torrent.wires) {
    torrent.wires.forEach((wire) => wire.unchoke());
  }
  console.log(`[BT-Worker] Resumed torrent: ${torrent.infoHash}`);
  send({ id, type: "resumed", infoHash: torrent.infoHash });
}

async function handleRemove(id, { hash }) {
  const torrent = hash ? await client.get(hash) : client.torrents[0];
  if (!torrent) {
    send({ id, error: "Torrent not found" });
    return;
  }
  const infoHash = torrent.infoHash;
  torrent.destroy({ destroyStore: false }, () => {
    console.log(`[BT-Worker] Removed torrent: ${infoHash}`);
    send({ id, type: "removed", infoHash });
  });
}

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[BT-Worker] SIGTERM received, shutting down...");
  if (client) {
    client.destroy(() => {
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});

process.on("disconnect", () => {
  console.log("[BT-Worker] Parent disconnected, shutting down...");
  if (client) {
    client.destroy(() => {
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});
