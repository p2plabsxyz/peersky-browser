import { fork } from "child_process";
import path from "path";
import { createLogger } from '../logger.js';
import { fileURLToPath } from "url";
import fs from "fs-extra";
import { app } from "electron";
import { generateTorrentUI } from "./bt/torrentPage.js";
import settingsManager from "../settings-manager.js";
import { ipcMain } from "electron";
import parseTorrent from "parse-torrent";
import mime from "mime-types";
import { randomBytes } from "crypto";

const log = createLogger('protocols:bt');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let worker = null;
let workerReady = false;
const pendingRequests = new Map();
let requestId = 0;

// Cached status from worker push updates (no IPC round-trip needed for status)
const statusCache = new Map();
const uiApiTokens = new Map();
const UI_API_TOKEN_TTL_MS = 30 * 60 * 1000;
const UI_API_TOKEN_MAX = 1000;

// Persist all torrent states (active, paused, completed) so they survive restarts
let torrentStateCachePath = null;
function getTorrentStateCachePath() {
  if (!torrentStateCachePath) {
    torrentStateCachePath = path.join(app.getPath("userData"), "bt-state.json");
  }
  return torrentStateCachePath;
}

function loadTorrentStateCache() {
  try {
    const cachePath = getTorrentStateCachePath();
    if (fs.existsSync(cachePath)) {
      const data = fs.readJsonSync(cachePath);
      for (const [hash, status] of Object.entries(data)) {
        statusCache.set(hash, status);
      }
      log.info(`[BT] Loaded ${Object.keys(data).length} torrent(s) from state cache`);
    }
  } catch (err) {
    log.error("[BT] Failed to load torrent state cache:", err.message);
  }
}

function saveTorrentState(infoHash, status) {
  try {
    const cachePath = getTorrentStateCachePath();
    const data = fs.existsSync(cachePath) ? fs.readJsonSync(cachePath) : {};
    data[infoHash] = status;
    fs.writeJsonSync(cachePath, data, { spaces: 2 });
  } catch (err) {
    log.error("[BT] Failed to save torrent state:", err.message);
  }
}

function removeTorrentState(infoHash) {
  try {
    const cachePath = getTorrentStateCachePath();
    if (fs.existsSync(cachePath)) {
      const data = fs.readJsonSync(cachePath);
      delete data[infoHash];
      fs.writeJsonSync(cachePath, data, { spaces: 2 });
    }
  } catch (err) {
    log.error("[BT] Failed to remove torrent state:", err.message);
  }
}

// Load persisted torrent states on module init

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

function createUiApiToken() {
  pruneUiApiTokens();
  if (uiApiTokens.size >= UI_API_TOKEN_MAX) {
    const oldestToken = uiApiTokens.keys().next().value;
    if (oldestToken) uiApiTokens.delete(oldestToken);
  }
  const token = randomBytes(24).toString("hex");
  uiApiTokens.set(token, Date.now() + UI_API_TOKEN_TTL_MS);
  return token;
}

function pruneUiApiTokens() {
  const now = Date.now();
  for (const [token, expiresAt] of uiApiTokens.entries()) {
    if (expiresAt <= now) {
      uiApiTokens.delete(token);
    }
  }
}

function isValidUiApiToken(token) {
  if (!token) return false;
  const expiresAt = uiApiTokens.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    uiApiTokens.delete(token);
    return false;
  }
  return true;
}

async function initializeWorker() {
  if (worker) return;

  loadTorrentStateCache();

  const downloadPath = path.join(app.getPath("downloads"), "PeerskyTorrents");
  await fs.ensureDir(downloadPath);

  log.info("[BT] Forking WebTorrent worker process...");
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
      log.info("[BT] Worker process ready");
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
    log.error("[BT] Worker error:", err);
  });

  worker.on("exit", (code) => {
    log.info(`[BT] Worker exited with code ${code}`);
    worker = null;
    workerReady = false;
    
    // Save all active torrents to disk before clearing cache
    // Mark them as paused so they show resume button on restart
    try {
      const cachePath = getTorrentStateCachePath();
      const data = fs.existsSync(cachePath) ? fs.readJsonSync(cachePath) : {};
      for (const [hash, status] of statusCache.entries()) {
        if (!status.done) {
          data[hash] = { ...status, paused: true };
        }
      }
      fs.writeJsonSync(cachePath, data, { spaces: 2 });
      log.info(`[BT] Saved ${Object.keys(data).length} torrent state(s) on worker exit`);
    } catch (err) {
      log.error("[BT] Failed to save torrent states on exit:", err.message);
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

  log.info("[BT] Worker initialized. Download path:", downloadPath);
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
    log.info(`[BT] Handling request: ${request.method} ${rawUrl}`);

    try {
      // Determine protocol from the raw URL
      let protocol, infoHash, magnetUri, queryParams, requestedTorrentPath = "";

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
        if (urlObj.hostname) {
          infoHash = urlObj.hostname;
          requestedTorrentPath = urlObj.pathname.replace(/^\/+/, "");
        } else {
          const fullPath = urlObj.pathname.replace(/^\/+/, "");
          const slashIndex = fullPath.indexOf("/");
          if (slashIndex >= 0) {
            infoHash = fullPath.slice(0, slashIndex);
            requestedTorrentPath = fullPath.slice(slashIndex + 1);
          } else {
            infoHash = fullPath;
          }
        }
      }

      infoHash = await normalizeInfoHash(infoHash);

      const action = queryParams.get("action");

      // Handle API requests
      if (action === "api") {
        const api = queryParams.get("api");
        return await handleAPI(api, queryParams, infoHash, request);
      }

      // Serve bt://<infohash>/<path> directly from downloaded torrent files when available.
      if (protocol !== "magnet" && requestedTorrentPath) {
        return await serveTorrentFile(infoHash, requestedTorrentPath);
      }

      // Serve UI page (imported from bt/torrentPage.js)
      if (protocol === "magnet") {
        magnetUri = magnetUri || rawUrl;
      } else {
        magnetUri = `magnet:?xt=urn:btih:${infoHash}`;
      }

      const displayName = queryParams.get("dn") || null;
      const currentTheme = settingsManager.settings.theme || "dark";
      const apiToken = createUiApiToken();
      const html = generateTorrentUI(magnetUri, infoHash, protocol, displayName, currentTheme, apiToken);
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });

    } catch (err) {
      log.error("[BT] Failed to handle request:", err);
      return new Response(`Error: ${err.message}`, {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  };
}

export function setupBittorrentIpc() {
  ipcMain.handle('resolve-torrent-file', async (event, filePath) => {
    try {
      if (!filePath || typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.torrent')) {
        throw new Error('Invalid .torrent file path');
      }

      const buffer = await fs.readFile(filePath);
      const parsed = await parseTorrent(buffer);

      if (!parsed || !parsed.infoHash) {
        throw new Error('Could not extract infoHash from file');
      }

      // Build magnet URI with trackers from the .torrent file
      let magnetUri = `magnet:?xt=urn:btih:${parsed.infoHash}`;
      
      // Add display name if available
      if (parsed.name) {
        magnetUri += `&dn=${encodeURIComponent(parsed.name)}`;
      }
      
      // Add tracker URLs from the .torrent file — this is what makes it fast
      if (parsed.announce && parsed.announce.length > 0) {
        const trackers = parsed.announce.map(tr => `&tr=${encodeURIComponent(tr)}`).join('');
        magnetUri += trackers;
      }

      return magnetUri;
    } catch (err) {
      log.error('[BT] IPC Error resolving torrent:', err.message);
      return null;
    }
  });
}


async function handleAPI(api, queryParams, infoHash, request) {
  const rawHash = queryParams.get("hash") || infoHash;
  const hash = await normalizeInfoHash(rawHash);
  const token = request.headers?.get("x-bt-token") || queryParams.get("token");
  log.info(`[BT] API call: ${api}, hash: ${hash}`);

  // Security: validate request is from BitTorrent protocol
  // Custom protocols don't send Origin/Referer headers in Electron, so check request.url
  const requestUrl = request.url || '';
  const isBTRequest = requestUrl.startsWith('bt://') || requestUrl.startsWith('bittorrent://') || requestUrl.startsWith('magnet:');
  
  if (!isBTRequest) {
    log.warn(`[BT] API blocked: request not from BitTorrent protocol - url: ${requestUrl}`);
    return jsonResponse({ error: 'Forbidden: API only accessible from BitTorrent protocol' }, 403);
  }

  // Security: mutations require POST method
  const mutationActions = ['start', 'seed', 'pause', 'resume', 'remove'];
  const isMutation = mutationActions.includes(api);
  if (isMutation && request.method !== 'POST') {
    return jsonResponse({ error: `${api} requires POST method` }, 405, { allowCors: false });
  }
  if (isMutation && !isValidUiApiToken(token)) {
    return jsonResponse({ error: "Forbidden: invalid API token" }, 403, { allowCors: false });
  }

  try {
    if (api === "start") {
      const magnetUri = queryParams.get("magnet");
      return await startTorrent(magnetUri, { allowCors: !isMutation });
    } else if (api === "seed") {
      const magnetUri = queryParams.get("magnet");
      return await seedTorrent(magnetUri, hash, { allowCors: !isMutation });
    } else if (api === "status") {
      // Serve from cache instantly — no IPC round-trip
      return getCachedStatus(hash);
    } else if (api === "list") {
      // Return all cached torrents for manager pages.
      return getCachedTorrentList();
    } else if (api === "token") {
      // Allow internal manager pages to run mutation APIs.
      return jsonResponse({ token: createUiApiToken() });
    } else if (api === "pause") {
      return await pauseResumeTorrent("pause", hash, { allowCors: !isMutation });
    } else if (api === "resume") {
      return await pauseResumeTorrent("resume", hash, { allowCors: !isMutation });
    } else if (api === "remove") {
      return await removeTorrent(hash, { allowCors: !isMutation });
    } else {
      return jsonResponse({ error: "Unknown API action" }, 400);
    }
  } catch (err) {
    log.error("[BT] API error:", err);
    return jsonResponse({ error: err.message }, 500);
  }
}

function jsonResponse(data, status = 200, { allowCors = true } = {}) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (allowCors) {
    headers["Access-Control-Allow-Origin"] = "*";
    headers["Access-Control-Allow-Methods"] = "GET, POST";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }
  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}

async function startTorrent(magnetUri, responseOptions = {}) {
  try {
    // Decode the magnet URI
    const decoded = decodeURIComponent(magnetUri);
    const hash = extractInfoHash(decoded);
    log.info(`[BT] startTorrent: hash=${hash}`);

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
      return jsonResponse({ error: result.error }, 400, responseOptions);
    }

    return jsonResponse({
      success: true,
      infoHash: result.infoHash || hash,
      magnetURI: decoded,
    }, 200, responseOptions);
  } catch (err) {
    log.error("[BT] startTorrent error:", err);
    return jsonResponse({ error: err.message }, 500, responseOptions);
  }
}

async function seedTorrent(magnetUri, hash, responseOptions = {}) {
  try {
    let decoded = null;
    if (magnetUri) {
      decoded = decodeURIComponent(magnetUri);
    } else if (hash) {
      const cached = statusCache.get(hash);
      if (cached?.magnetURI) {
        decoded = cached.magnetURI;
      }
    }

    if (!decoded) {
      return jsonResponse({ error: "seed requires magnet or hash with cached magnetURI" }, 400, responseOptions);
    }

    // Merge all trackers from the magnet + defaults
    let allTrackers = [...DEFAULT_TRACKERS];
    try {
      const url = new URL(decoded);
      const magnetTrackers = url.searchParams.getAll("tr");
      allTrackers = [...new Set([...magnetTrackers, ...DEFAULT_TRACKERS])];
    } catch (e) { /* ignore parse errors */ }

    const result = await sendCommand("seed", {
      magnetUri: decoded,
      announce: allTrackers,
    });

    if (result.error) {
      if (result.error.includes("Unknown action: seed")) {
        return jsonResponse({ error: "Seed mode is not available yet in worker" }, 501, responseOptions);
      }
      return jsonResponse({ error: result.error }, 400, responseOptions);
    }

    return jsonResponse({
      success: true,
      infoHash: result.infoHash || extractInfoHash(decoded),
      magnetURI: decoded,
      mode: "seed",
    }, 200, responseOptions);
  } catch (err) {
    log.error("[BT] seedTorrent error:", err);
    return jsonResponse({ error: err.message }, 500, responseOptions);
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

function getCachedTorrentList() {
  const torrents = Array.from(statusCache.values())
    .map((cached) => {
      const { type: _t, ...data } = cached;
      return data;
    })
    .sort((a, b) => {
      const nameA = (a.name || "").toLowerCase();
      const nameB = (b.name || "").toLowerCase();
      if (nameA !== nameB) return nameA.localeCompare(nameB);
      return (a.infoHash || "").localeCompare(b.infoHash || "");
    });

  return jsonResponse({ torrents });
}

async function pauseResumeTorrent(action, hash, responseOptions = {}) {
  try {
    const result = await sendCommand(action, { hash });
    if (result.error) {
      // Resume failed — torrent may not be in worker after restart
      if (action === "resume") {
        const cached = statusCache.get(hash);
        if (cached && cached.magnetURI) {
          log.info(`[BT] Torrent not in worker, re-starting from cache: ${hash}`);
          removeTorrentState(hash);
          statusCache.delete(hash);
          if (cached.mode === "seed") {
          return await seedTorrent(encodeURIComponent(cached.magnetURI), hash, responseOptions);
          }
          return await startTorrent(encodeURIComponent(cached.magnetURI), responseOptions);
        }
      }
      return jsonResponse({ error: result.error }, 404, responseOptions);
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
    return jsonResponse({ success: true, paused: action === "pause" }, 200, responseOptions);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, responseOptions);
  }
}

async function removeTorrent(hash, responseOptions = {}) {
  try {
    const result = await sendCommand("remove", { hash });
    if (result.error) return jsonResponse({ error: result.error }, 404, responseOptions);
    return jsonResponse({ success: true, removed: true }, 200, responseOptions);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, responseOptions);
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
    log.warn('[BT] Failed to extract infoHash:', err.message);
    return null;
  }
}

function normalizeTorrentPath(input) {
  if (!input) return "";
  let decoded = input;
  try {
    decoded = decodeURIComponent(input);
  } catch (err) {
    // Keep raw input if decode fails; we'll still normalize separators.
  }
  const normalized = path.posix.normalize(decoded.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (normalized.startsWith("..")) return null;
  return normalized;
}

async function normalizeInfoHash(rawHash) {
  if (!rawHash || typeof rawHash !== "string") return rawHash;
  const trimmed = rawHash.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = await parseTorrent(`magnet:?xt=urn:btih:${trimmed}`);
    if (parsed && parsed.infoHash) {
      return parsed.infoHash.toLowerCase();
    }
  } catch (_err) {
    // Fallback for plain hex values parse-torrent doesn't accept in this context.
  }
  if (/^[a-fA-F0-9]{40}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

async function serveTorrentFile(infoHash, requestedPath) {
  const cached = statusCache.get(infoHash);
  if (!cached) {
    return new Response("Torrent not found. Start or resume it first.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const relativePath = normalizeTorrentPath(requestedPath);
  if (!relativePath) {
    return new Response("Invalid torrent file path", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const files = Array.isArray(cached.files) ? cached.files : [];
  const match = files.find((f) => normalizeTorrentPath(f.path) === relativePath);
  if (!match) {
    return new Response(`File not found in torrent: ${relativePath}`, {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const basePath = path.resolve(cached.downloadPath || path.join(app.getPath("downloads"), "PeerskyTorrents"));
  const filePath = path.resolve(basePath, match.path);
  if (filePath !== basePath && !filePath.startsWith(`${basePath}${path.sep}`)) {
    return new Response("Forbidden path", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (!(await fs.pathExists(filePath))) {
    return new Response(`File not available on disk yet: ${relativePath}`, {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const stream = fs.createReadStream(filePath);
  const contentType = mime.lookup(filePath) || "application/octet-stream";
  const withCharset = String(contentType).startsWith("text/") ? `${contentType}; charset=utf-8` : contentType;

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": withCharset },
  });
}
