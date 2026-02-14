import { fork } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs-extra";
import { app } from "electron";
import { generateTorrentUI } from "./bt/torrentPage.js";
import settingsManager from "../settings-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let worker = null;
let workerReady = false;
const pendingRequests = new Map();
let requestId = 0;

// Cached status from worker push updates (no IPC round-trip needed for status)
const statusCache = new Map();

// Persist all torrent states (active, paused, completed) so they survive restarts
const torrentStateCachePath = path.join(app.getPath("userData"), "bt-state.json");

function loadTorrentStateCache() {
  try {
    if (fs.existsSync(torrentStateCachePath)) {
      const data = fs.readJsonSync(torrentStateCachePath);
      for (const [hash, status] of Object.entries(data)) {
        statusCache.set(hash, status);
      }
      console.log(`[BT] Loaded ${Object.keys(data).length} torrent(s) from state cache`);
    }
  } catch (err) {
    console.error("[BT] Failed to load torrent state cache:", err.message);
  }
}

function saveTorrentState(infoHash, status) {
  try {
    const data = fs.existsSync(torrentStateCachePath) ? fs.readJsonSync(torrentStateCachePath) : {};
    data[infoHash] = status;
    fs.writeJsonSync(torrentStateCachePath, data, { spaces: 2 });
  } catch (err) {
    console.error("[BT] Failed to save torrent state:", err.message);
  }
}

function removeTorrentState(infoHash) {
  try {
    if (fs.existsSync(torrentStateCachePath)) {
      const data = fs.readJsonSync(torrentStateCachePath);
      delete data[infoHash];
      fs.writeJsonSync(torrentStateCachePath, data, { spaces: 2 });
    }
  } catch (err) {
    console.error("[BT] Failed to remove torrent state:", err.message);
  }
}

// Load persisted torrent states on module init
loadTorrentStateCache();

const DEFAULT_TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.webtorrent.dev",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.tracker.cl:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
];

async function initializeWorker() {
  if (worker) return;

  const downloadPath = path.join(app.getPath("downloads"), "PeerskyTorrents");
  await fs.ensureDir(downloadPath);

  console.log("[BT] Forking WebTorrent worker process...");
  worker = fork(path.join(__dirname, "bt", "worker.js"), [downloadPath], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });

  // Forward worker stdout/stderr to main process console
  worker.stdout.on("data", (data) => {
    process.stdout.write(data);
  });
  worker.stderr.on("data", (data) => {
    process.stderr.write(data);
  });

  worker.on("message", (msg) => {
    if (msg.type === "ready") {
      console.log("[BT] Worker process ready");
      workerReady = true;
      return;
    }

    // Cache status updates from worker push
    if (msg.type === "status-update" && msg.infoHash) {
      statusCache.set(msg.infoHash, msg);
      return;
    }

    // Cache bulk status updates (multiple torrents in one message)
    if (msg.type === "status-update-bulk" && msg.torrents) {
      msg.torrents.forEach(status => {
        if (status.infoHash) {
          statusCache.set(status.infoHash, { ...status, type: "status-update" });
        }
      });
      return;
    }

    // Cache done events — torrent is already destroyed in worker
    if (msg.type === "done" && msg.infoHash) {
      const cached = statusCache.get(msg.infoHash);
      if (cached) {
        cached.done = true;
        cached.downloadSpeed = 0;
        cached.uploadSpeed = 0;
        // Persist completed status to disk so it survives restarts
        saveTorrentState(msg.infoHash, cached);
      }
      return;
    }

    // Clean up cache on torrent removal
    if (msg.type === "removed" && msg.infoHash) {
      statusCache.delete(msg.infoHash);
      removeTorrentState(msg.infoHash);
    }

    // Resolve pending request if this message has an id
    if (msg.id && pendingRequests.has(msg.id)) {
      const resolve = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      resolve(msg);
    }
  });

  worker.on("error", (err) => {
    console.error("[BT] Worker error:", err);
  });

  worker.on("exit", (code) => {
    console.log(`[BT] Worker exited with code ${code}`);
    worker = null;
    workerReady = false;
    
    // Save all active torrents to disk before clearing cache
    // Mark them as paused so they show resume button on restart
    try {
      const data = fs.existsSync(torrentStateCachePath) ? fs.readJsonSync(torrentStateCachePath) : {};
      for (const [hash, status] of statusCache.entries()) {
        if (!status.done) {
          data[hash] = { ...status, paused: true };
        }
      }
      fs.writeJsonSync(torrentStateCachePath, data, { spaces: 2 });
      console.log(`[BT] Saved ${Object.keys(data).length} torrent state(s) on worker exit`);
    } catch (err) {
      console.error("[BT] Failed to save torrent states on exit:", err.message);
    }
    
    statusCache.clear();
    pendingRequests.clear();
    // Reload persisted torrent states so they survive worker restarts
    loadTorrentStateCache();
  });

  // Wait for worker to be ready (max 10s)
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (workerReady) {
        clearInterval(check);
        resolve();
      }
    }, 100);
    setTimeout(() => {
      clearInterval(check);
      resolve();
    }, 10000);
  });

  console.log("[BT] Worker initialized. Download path:", downloadPath);
}

function sendCommand(action, params = {}) {
  return new Promise((resolve, reject) => {
    if (!worker) {
      return reject(new Error("Worker not initialized"));
    }
    const id = ++requestId;
    pendingRequests.set(id, resolve);
    worker.send({ id, action, ...params });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        resolve({ error: "Request timed out" });
      }
    }, 30000);
  });
}

export async function createHandler() {
  await initializeWorker();

  return async function protocolHandler(request) {
    const rawUrl = request.url;
    console.log(`[BT] Handling request: ${request.method} ${rawUrl}`);

    try {
      // Determine protocol from the raw URL
      let protocol, infoHash, magnetUri, queryParams;

      if (rawUrl.startsWith("magnet:")) {
        protocol = "magnet";
        infoHash = extractInfoHash(rawUrl);
        magnetUri = rawUrl;
        // Parse query params manually for magnet URLs
        const qIndex = rawUrl.indexOf("?");
        queryParams = qIndex >= 0 ? new URLSearchParams(rawUrl.slice(qIndex)) : new URLSearchParams();
      } else {
        // bt:// or bittorrent://
        const urlObj = new URL(rawUrl);
        protocol = urlObj.protocol.replace(":", "");
        queryParams = urlObj.searchParams;
        infoHash = urlObj.hostname || urlObj.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
      }

      const action = queryParams.get("action");

      // Handle API requests
      if (action === "api") {
        const api = queryParams.get("api");
        return await handleAPI(api, queryParams, infoHash, request);
      }

      // TODO: Support file path resolution for website hosting
      // e.g. bt://{INFO_HASH}/index.html should serve the file from the torrent
      // This would enable hosting websites on BitTorrent (like https://gitlab.com/ivi.eco/akoopa)
      // Implementation: parse pathname, seed torrent if needed, serve requested file

      // Serve UI page (imported from bt/torrentPage.js)
      if (protocol === "magnet") {
        magnetUri = magnetUri || rawUrl;
      } else {
        magnetUri = `magnet:?xt=urn:btih:${infoHash}`;
      }

      const displayName = queryParams.get("dn") || null;
      const currentTheme = settingsManager.settings.theme || "dark";
      const html = generateTorrentUI(magnetUri, infoHash, protocol, displayName, currentTheme);
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });

    } catch (err) {
      console.error("[BT] Failed to handle request:", err);
      return new Response(`Error: ${err.message}`, {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  };
}

async function handleAPI(api, queryParams, infoHash, request) {
  const hash = queryParams.get("hash") || infoHash;
  console.log(`[BT] API call: ${api}, hash: ${hash}`);

  // Security: validate request is from BitTorrent protocol
  // Custom protocols don't send Origin/Referer headers in Electron, so check request.url
  const requestUrl = request.url || '';
  const isBTRequest = requestUrl.startsWith('bt://') || requestUrl.startsWith('bittorrent://') || requestUrl.startsWith('magnet:');
  
  if (!isBTRequest) {
    console.warn(`[BT] API blocked: request not from BitTorrent protocol - url: ${requestUrl}`);
    return jsonResponse({ error: 'Forbidden: API only accessible from BitTorrent protocol' }, 403);
  }

  // Security: mutations require POST method
  const mutationActions = ['start', 'pause', 'resume', 'remove'];
  if (mutationActions.includes(api) && request.method !== 'POST') {
    return jsonResponse({ error: `${api} requires POST method` }, 405);
  }

  try {
    if (api === "start") {
      const magnetUri = queryParams.get("magnet");
      return await startTorrent(magnetUri);
    } else if (api === "status") {
      // Serve from cache instantly — no IPC round-trip
      return getCachedStatus(hash);
    } else if (api === "pause") {
      return await pauseResumeTorrent("pause", hash);
    } else if (api === "resume") {
      return await pauseResumeTorrent("resume", hash);
    } else if (api === "remove") {
      return await removeTorrent(hash);
    } else {
      return jsonResponse({ error: "Unknown API action" }, 400);
    }
  } catch (err) {
    console.error("[BT] API error:", err);
    return jsonResponse({ error: err.message }, 500);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

async function startTorrent(magnetUri) {
  try {
    // Decode the magnet URI
    const decoded = decodeURIComponent(magnetUri);
    const hash = extractInfoHash(decoded);
    console.log(`[BT] startTorrent: hash=${hash}`);

    // Merge all trackers from the magnet + defaults
    let allTrackers = [...DEFAULT_TRACKERS];
    try {
      const url = new URL(decoded);
      const magnetTrackers = url.searchParams.getAll("tr");
      allTrackers = [...new Set([...magnetTrackers, ...DEFAULT_TRACKERS])];
    } catch (e) { /* ignore parse errors */ }

    // Send to worker process
    const result = await sendCommand("start", {
      magnetUri: decoded,
      announce: allTrackers,
    });

    if (result.error) {
      return jsonResponse({ error: result.error }, 400);
    }

    return jsonResponse({
      success: true,
      infoHash: result.infoHash || hash,
      magnetURI: decoded,
    });
  } catch (err) {
    console.error("[BT] startTorrent error:", err);
    return jsonResponse({ error: err.message }, 500);
  }
}

function getCachedStatus(hash) {
  if (!hash) {
    // Return first available torrent status
    if (statusCache.size > 0) {
      const first = statusCache.values().next().value;
      const { type: _t, ...data } = first;
      return jsonResponse(data);
    }
    return jsonResponse({ error: "No active torrents" }, 404);
  }

  const cached = statusCache.get(hash);
  if (cached) {
    const { type: _t, ...data } = cached;
    return jsonResponse(data);
  }

  return jsonResponse({ error: "Torrent not found in cache" }, 404);
}

async function pauseResumeTorrent(action, hash) {
  try {
    const result = await sendCommand(action, { hash });
    if (result.error) {
      // Resume failed — torrent may not be in worker after restart
      if (action === "resume") {
        const cached = statusCache.get(hash);
        if (cached && cached.magnetURI) {
          console.log(`[BT] Torrent not in worker, re-starting from cache: ${hash}`);
          removeTorrentState(hash);
          statusCache.delete(hash);
          return await startTorrent(encodeURIComponent(cached.magnetURI));
        }
      }
      return jsonResponse({ error: result.error }, 404);
    }
    // Persist paused status so it survives restarts
    if (action === "pause") {
      const cached = statusCache.get(hash);
      if (cached) {
        cached.paused = true;
        saveTorrentState(hash, cached);
      }
    } else if (action === "resume") {
      removeTorrentState(hash);
    }
    return jsonResponse({ success: true, paused: action === "pause" });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

async function removeTorrent(hash) {
  try {
    const result = await sendCommand("remove", { hash });
    if (result.error) return jsonResponse({ error: result.error }, 404);
    return jsonResponse({ success: true, removed: true });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

function extractInfoHash(magnetUrl) {
  try {
    // First try to decode the URL to handle URL-encoded parameters
    const decodedUrl = decodeURIComponent(magnetUrl);
    
    // Extract using regex
    const match = decodedUrl.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
    if (match) {
      return match[1].toLowerCase();
    }
    
    // If that fails, try to parse as URL
    const url = new URL(decodedUrl);
    const xt = url.searchParams.get('xt');
    if (xt) {
      const btihMatch = xt.match(/^urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})$/i);
      if (btihMatch) {
        return btihMatch[1].toLowerCase();
      }
    }
    
    return null;
  } catch (err) {
    console.warn('[BT] Failed to extract infoHash:', err.message);
    return null;
  }
}
