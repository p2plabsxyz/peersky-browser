import WebTorrent from "webtorrent";
import path from "path";
import fs from "fs";

const downloadPath = process.argv[2] || path.join(process.env.HOME || "/tmp", "Downloads", "PeerskyTorrents");
if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath, { recursive: true });

let client = null;
const torrentModes = new Map();
const seedingStartedAt = new Map();
const previousStatus = new Map();

function send(msg) {
  try { if (process.send) process.send(msg); } catch {}
}

function clearTracking(infoHash) {
  torrentModes.delete(infoHash);
  seedingStartedAt.delete(infoHash);
  previousStatus.delete(infoHash);
}

function initClient() {
  if (client) return;
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

initClient();

function hasStatusChanged(infoHash, s) {
  const prev = previousStatus.get(infoHash);
  if (!prev) return true;
  return (
    prev.progress !== s.progress ||
    prev.uploaded !== s.uploaded ||
    prev.downloadSpeed !== s.downloadSpeed ||
    prev.uploadSpeed !== s.uploadSpeed ||
    prev.numPeers !== s.numPeers ||
    prev.done !== s.done ||
    prev.paused !== s.paused ||
    prev.mode !== s.mode ||
    prev.isSeeding !== s.isSeeding ||
    prev.seedingSince !== s.seedingSince
  );
}

function buildStatus(torrent) {
  const mode = torrentModes.get(torrent.infoHash) || "download";
  const isSeeding = mode === "seed" && torrent.done && !torrent.paused;
  if (isSeeding && !seedingStartedAt.has(torrent.infoHash)) {
    seedingStartedAt.set(torrent.infoHash, Date.now());
  }
  return {
    infoHash: torrent.infoHash,
    name: torrent.name || "Fetching metadata...",
    downloadPath,
    mode,
    isSeeding,
    seedingSince: isSeeding ? seedingStartedAt.get(torrent.infoHash) : null,
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
      ? torrent.files.map((f, i) => ({ index: i, name: f.name, path: f.path, length: f.length, downloaded: f.downloaded, progress: f.progress }))
      : [],
    magnetURI: torrent.magnetURI,
  };
}

setInterval(() => {
  if (!client || client.torrents.length === 0) return;
  const updates = [];
  for (const torrent of client.torrents) {
    if (!torrent.infoHash) continue;
    const status = buildStatus(torrent);
    if (hasStatusChanged(torrent.infoHash, status)) {
      updates.push(status);
      previousStatus.set(torrent.infoHash, status);
    }
  }
  if (updates.length > 0) send({ type: "status-update-bulk", torrents: updates });
}, 2000);

process.on("message", (msg) => {
  const { id, action, ...params } = msg;
  try {
    switch (action) {
      case "start": return handleStart(id, params);
      case "seed": return handleSeed(id, params);
      case "pause": return handlePause(id, params);
      case "unseed": return handleUnseed(id, params);
      case "resume": return handleResume(id, params);
      case "stop": return handleStop(id, params);
      case "remove": return handleRemove(id, params);
      default: send({ id, error: `Unknown action: ${action}` });
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

function attachTorrentEvents(torrent, mode) {
  torrent.on("infoHash", () => {
    torrentModes.set(torrent.infoHash, mode);
    console.log(`[BT-Worker] InfoHash resolved: ${torrent.infoHash} (${mode})`);
  });

  torrent.on("metadata", () => {
    console.log(`[BT-Worker] Metadata: ${torrent.name}, ${torrent.files.length} files, ${(torrent.length / (1024 * 1024)).toFixed(1)} MB`);
  });

  torrent.on("ready", () => {
    console.log(`[BT-Worker] Ready: ${torrent.name}`);
  });

  torrent.on("done", () => {
    const infoHash = torrent.infoHash;
    const currentMode = torrentModes.get(infoHash) || "download";
    if (currentMode === "seed") {
      if (!seedingStartedAt.has(infoHash)) seedingStartedAt.set(infoHash, Date.now());
      console.log(`[BT-Worker] Download complete: ${torrent.name}. Seeding.`);
      send({ type: "status-update", ...buildStatus(torrent) });
      return;
    }
    console.log(`[BT-Worker] Download complete: ${torrent.name}. Destroying (no seeding).`);
    send({ type: "status-update", ...buildStatus(torrent), downloadSpeed: 0, uploadSpeed: 0, numPeers: 0 });
    send({ type: "done", infoHash });
    torrent.destroy({ destroyStore: false }, () => {
      clearTracking(infoHash);
      console.log(`[BT-Worker] Torrent destroyed: ${infoHash}`);
    });
  });

  torrent.on("error", (err) => {
    console.error(`[BT-Worker] Torrent error:`, err.message);
    send({ type: "torrent-error", infoHash: torrent.infoHash, error: err.message });
  });

  torrent.on("warning", (warn) => {
    const m = typeof warn === "object" ? warn.message : warn;
    if (!m.includes("getaddrinfo")) console.warn(`[BT-Worker] Warning:`, m);
  });

  let lastLog = 0;
  torrent.on("download", () => {
    const now = Date.now();
    if (now - lastLog > 10000) {
      lastLog = now;
      console.log(
        `[BT-Worker] Progress: ${(torrent.progress * 100).toFixed(1)}%, ` +
        `${(torrent.downloaded / (1024 * 1024)).toFixed(1)} MB, ` +
        `${(torrent.downloadSpeed / 1024).toFixed(1)} KB/s, ${torrent.numPeers} peers`
      );
    }
  });
}

async function addTorrent(id, { magnetUri, announce, mode }) {
  if (!client) {
    send({ id, error: "Client not initialized" });
    return;
  }
  const hash = extractHash(magnetUri);
  console.log(`[BT-Worker] ${mode} requested. Hash: ${hash}, Trackers: ${(announce || []).length}`);

  if (hash) {
    const existing = await client.get(hash);
    if (existing && existing.infoHash) {
      torrentModes.set(existing.infoHash, mode);
      if (mode === "seed" && existing.done && !seedingStartedAt.has(existing.infoHash)) {
        seedingStartedAt.set(existing.infoHash, Date.now());
      }
      send({
        id, type: "started", infoHash: existing.infoHash,
        magnetURI: existing.magnetURI, name: existing.name, mode,
      });
      return;
    }
  }

  const torrent = client.add(magnetUri, { path: downloadPath, announce: announce || [] });
  if (hash) torrentModes.set(hash, mode);
  attachTorrentEvents(torrent, mode);

  send({ id, type: "started", infoHash: torrent.infoHash || hash || null, magnetURI: torrent.magnetURI, mode });
}

function handleStart(id, params) { return addTorrent(id, { ...params, mode: "download" }); }
function handleSeed(id, params) { return addTorrent(id, { ...params, mode: "seed" }); }

async function handlePause(id, { hash }) {
  const torrent = hash ? await client.get(hash) : client.torrents[0];
  if (!torrent) return send({ id, error: "Torrent not found" });
  torrent.pause();
  if (torrent.wires) torrent.wires.forEach((w) => w.choke());
  if (torrent.pieces) torrent.deselect(0, torrent.pieces.length - 1, 0);
  console.log(`[BT-Worker] Paused: ${torrent.infoHash}`);
  send({ id, type: "paused", infoHash: torrent.infoHash });
}

async function handleResume(id, { hash }) {
  const torrent = hash ? await client.get(hash) : client.torrents[0];
  if (!torrent) return send({ id, error: "Torrent not found" });
  torrent.resume();
  if (torrent.files) torrent.files.forEach((f) => f.select());
  if (torrent.wires) torrent.wires.forEach((w) => w.unchoke());
  console.log(`[BT-Worker] Resumed: ${torrent.infoHash}`);
  send({ id, type: "resumed", infoHash: torrent.infoHash });
}

async function handleUnseed(id, { hash }) {
  const torrent = hash ? await client.get(hash) : client.torrents[0];
  if (!torrent) return send({ id, error: "Torrent not found" });
  const infoHash = torrent.infoHash;
  clearTracking(infoHash);
  torrent.destroy({ destroyStore: false }, () => {
    console.log(`[BT-Worker] Stopped seeding: ${infoHash}`);
    send({ id, type: "unseeded", infoHash });
  });
}

async function handleStop(id, { hash }) {
  const torrent = hash ? await client.get(hash) : client.torrents[0];
  if (!torrent) return send({ id, error: "Torrent not found" });
  const snapshot = buildStatus(torrent);
  const infoHash = torrent.infoHash;
  clearTracking(infoHash);
  torrent.destroy({ destroyStore: false }, () => {
    console.log(`[BT-Worker] Stopped: ${infoHash}`);
    send({
      id, type: "stopped", ...snapshot,
      paused: true, stopped: true, isSeeding: false, seedingSince: null,
      downloadSpeed: 0, uploadSpeed: 0, numPeers: 0, timeRemaining: null,
    });
  });
}

async function handleRemove(id, { hash }) {
  const torrent = hash ? await client.get(hash) : client.torrents[0];
  if (!torrent) return send({ id, error: "Torrent not found" });
  const infoHash = torrent.infoHash;
  clearTracking(infoHash);
  torrent.destroy({ destroyStore: false }, () => {
    console.log(`[BT-Worker] Removed: ${infoHash}`);
    send({ id, type: "removed", infoHash });
  });
}

function shutdown() {
  console.log("[BT-Worker] Shutting down...");
  const forceExit = setTimeout(() => process.exit(0), 3000);
  forceExit.unref();
  if (client) client.destroy(() => { clearTimeout(forceExit); process.exit(0); });
  else { clearTimeout(forceExit); process.exit(0); }
}

process.on("SIGTERM", shutdown);
process.on("disconnect", shutdown);
