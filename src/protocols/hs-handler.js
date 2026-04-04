import Holesail from "holesail";
import http from "http";
import { PassThrough } from "stream";
import fs from "fs";
import path from "path";
import { app, safeStorage } from "electron";
import * as Y from "yjs";

const roomSessions = new Map();
const roomPorts = new Map();
let peerSequence = 0;
const EDIT_ACTIVITY_DEBOUNCE_MS = 1200;
const TYPING_STALE_MS = 2500;

// Rate limiting: track requests per IP/action
const rateLimits = new Map(); // key -> { count, resetAt }

// Debug mode - only log sensitive data in development
const DEBUG = process.env.NODE_ENV === 'development';

const MARKDOWN_IT_PATH = path.join(app.getAppPath(), "src", "pages", "p2p", "p2pmd", "lib", "markdown-it.min.js");
let markdownItScript = "";
try { markdownItScript = fs.readFileSync(MARKDOWN_IT_PATH, "utf-8"); } catch {}

const YJS_PATH = path.join(app.getAppPath(), "src", "pages", "p2p", "p2pmd", "lib", "yjs.min.js");
let yjsScript = "";
try { yjsScript = fs.readFileSync(YJS_PATH, "utf-8"); } catch {}

const FAVICON_PATH = path.join(app.getAppPath(), "src", "pages", "static", "assets", "favicon.ico");
let faviconBuffer = null;
try { faviconBuffer = fs.readFileSync(FAVICON_PATH); } catch {}

const PORTS_FILE = path.join(app.getPath("userData"), "peersky-ports.json");
const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");

function getCurrentTheme() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, "utf8");
      const parsed = JSON.parse(data);
      return parsed.theme || "dark";
    }
  } catch {}
  return "dark";
}

function loadPortsFromFile() {
  try {
    if (fs.existsSync(PORTS_FILE)) {
      const data = fs.readFileSync(PORTS_FILE, "utf8");
      const parsed = JSON.parse(data);
      Object.entries(parsed).forEach(([key, value]) => {
        // Support old format (just port number) and new format ({port, seed})
        if (typeof value === "number") {
          roomPorts.set(key, { port: value, seed: null });
        } else if (value && typeof value === "object") {
          // SECURITY: Decrypt seed if present
          const decryptedSeed = value.seed ? decryptSeed(value.seed) : null;
          roomPorts.set(key, { port: value.port, seed: decryptedSeed });
        }
      });
      console.log("[p2pmd] loaded ports from file", { count: roomPorts.size });
    }
  } catch (err) {
    console.error("[p2pmd] failed to load ports", err);
  }
}

function savePortsToFile() {
  try {
    // SECURITY: Encrypt seeds before saving
    const obj = {};
    for (const [key, value] of roomPorts.entries()) {
      obj[key] = {
        port: value.port,
        seed: value.seed ? encryptSeed(value.seed) : null
      };
    }
    fs.writeFileSync(PORTS_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (err) {
    console.error("[p2pmd] failed to save ports", err);
  }
}

loadPortsFromFile();

// SECURITY: CORS headers for local HTTP server responses
// Note: Electron custom protocols (peersky://, bt://, ipfs://, hyper://) don't send Origin headers
// Security is enforced via hostname validation (urlObj.hostname !== "p2pmd") in protocol handler
// This prevents external websites from calling hs://p2pmd APIs
function getCorsHeaders(session) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

// SECURITY: Rate limiting to prevent DoS
function checkRateLimit(key, maxRequests = 10, windowMs = 60000) {
  const now = Date.now();
  const limit = rateLimits.get(key);
  
  if (!limit || now > limit.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  
  if (limit.count >= maxRequests) {
    return false;
  }
  
  limit.count++;
  return true;
}

// SECURITY: Encrypt/decrypt seeds using Electron's safeStorage
function encryptSeed(seed) {
  if (!seed) return null;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(seed);
      return encrypted.toString('base64');
    }
  } catch (err) {
    console.error('[p2pmd] Failed to encrypt seed:', err.message);
  }
  return seed; // Fallback to plain text if encryption unavailable
}

function decryptSeed(encryptedSeed) {
  if (!encryptedSeed) return null;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buffer = Buffer.from(encryptedSeed, 'base64');
      return safeStorage.decryptString(buffer);
    }
  } catch (err) {
    console.error('[p2pmd] Failed to decrypt seed:', err.message);
  }
  return encryptedSeed; // Fallback if decryption fails
}

// SECURITY: Redact sensitive data for logging
function redactKey(key) {
  if (!key || typeof key !== 'string') return null;
  return key.length > 10 ? `${key.slice(0, 10)}...` : key;
}

function buildJsonResponse(statusCode, payload) {
  return new Response(JSON.stringify(payload), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      ...getCorsHeaders()
    }
  });
}

function buildTextResponse(statusCode, text) {
  return new Response(text, {
    status: statusCode,
    headers: {
      "Content-Type": "text/plain",
      ...getCorsHeaders()
    }
  });
}

function createSession(key = null) {
  return {
    key,
    server: null,
    host: "127.0.0.1",
    port: null,
    originalPort: null,
    sseClients: new Map(),
    sockets: new Set(),
    docState: { content: "", updatedAt: Date.now() },
    holesailServer: null,
    holesailClient: null,
    ydoc: null,
    ytext: null,
    activityLog: [],
    activitySequence: 0,
    editLogTimers: new Map(),
    peerMetaByClientId: new Map(),
    unknownPeerSequence: 0,
    unknownPeerBySource: new Map()
  };
}

function initSessionCrdt(session, initialText = "", initialYjsState = null, preserveExisting = false) {
  // Preserve Y.Doc with peer edits when preserveExisting=true
  if (preserveExisting && session.ydoc && session.ytext) {
    const existingContent = session.ytext.toString();
    if (existingContent.length > 0) {
      session.docState.content = existingContent;
      session.docState.updatedAt = Date.now();
      return;
    }
  }

  if (session.ydoc) {
    try { session.ydoc.destroy(); } catch {}
  }
  session.ydoc = new Y.Doc();
  session.ytext = session.ydoc.getText("content");

  let restoredFromYjsState = false;
  if (typeof initialYjsState === "string" && initialYjsState.length > 0) {
    try {
      const updateBytes = new Uint8Array(Buffer.from(initialYjsState, "base64"));
      Y.applyUpdate(session.ydoc, updateBytes, "initial-restore");
      restoredFromYjsState = true;
    } catch (err) {
      console.warn("[p2pmd] Failed to restore initial Yjs state, falling back to text:", err.message);
    }
  }
  if (!restoredFromYjsState && initialText) {
    session.ydoc.transact(() => session.ytext.insert(0, initialText));
  }
  session.docState.content = session.ytext.toString();
  session.docState.updatedAt = Date.now();
}

function getExistingSession(key) {
  if (!key) return null;
  return roomSessions.get(key) || null;
}

const PEER_COLORS = [
  "#0EA5E9",
  "#A855F7",
  "#22C55E",
  "#F97316",
  "#EF4444",
  "#14B8A6",
  "#EAB308",
  "#6366F1"
];

function normalizePeerRole(role) {
  if (role === "host") return "host";
  if (role === "client") return "client";
  return "viewer";
}

function sanitizePeerName(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, 32);
}

function getPeerColor(seed) {
  const source = String(seed || "peer");
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = ((hash << 5) - hash) + source.charCodeAt(i);
    hash |= 0;
  }
  return PEER_COLORS[Math.abs(hash) % PEER_COLORS.length];
}

function getPeerDisplayName(client) {
  if (!client) return "Peer";
  const sanitized = sanitizePeerName(client.name || "");
  if (sanitized) return sanitized;
  if (client.id) return `Peer #${client.id}`;
  if (client.clientId) return `Peer ${String(client.clientId).slice(0, 8)}`;
  return "Peer";
}

function getPeerCount(session) {
  let count = 0;
  for (const client of session.sseClients.values()) {
    if (client.role !== "host") count += 1;
  }
  return count;
}

function getPeerList(session) {
  const now = Date.now();
  return Array.from(session.sseClients.values())
    .sort((a, b) => {
      if (a.role === "host" && b.role !== "host") return -1;
      if (a.role !== "host" && b.role === "host") return 1;
      return (a.joinedAt || 0) - (b.joinedAt || 0);
    })
    .map((client) => {
      const isFreshTyping = client.isTyping === true &&
        Number.isFinite(Number(client.lastTypingAt)) &&
        (now - Number(client.lastTypingAt) <= TYPING_STALE_MS);
      if (client.isTyping && !isFreshTyping) {
        client.isTyping = false;
      }
      return {
        id: client.id,
        role: normalizePeerRole(client.role),
        clientId: client.clientId || null,
        name: getPeerDisplayName(client),
        color: client.color || getPeerColor(client.clientId || client.id),
        isTyping: isFreshTyping,
        cursorLine: Number.isFinite(Number(client.cursorLine)) ? Number(client.cursorLine) : null,
        cursorColumn: Number.isFinite(Number(client.cursorColumn)) ? Number(client.cursorColumn) : null,
        selectionStart: Number.isFinite(Number(client.selectionStart)) ? Number(client.selectionStart) : null,
        selectionEnd: Number.isFinite(Number(client.selectionEnd)) ? Number(client.selectionEnd) : null,
        joinedAt: Number.isFinite(Number(client.joinedAt)) ? Number(client.joinedAt) : Date.now(),
        updatedAt: Number.isFinite(Number(client.updatedAt)) ? Number(client.updatedAt) : Date.now(),
        lineAttributions: client.lineAttributions || null
      };
    });
}

function findClientByClientId(session, clientId) {
  if (!session || !clientId) return null;
  for (const client of session.sseClients.values()) {
    if (client.clientId === clientId) return client;
  }
  return null;
}

function addActivity(session, entry = {}) {
  if (!session) return null;
  session.activitySequence = (session.activitySequence || 0) + 1;
  const id = session.activitySequence;
  const fallbackPeerName = Number.isFinite(Number(entry.peerId)) ? `Peer #${Number(entry.peerId)}` : "Peer";
  const event = {
    id,
    type: typeof entry.type === "string" ? entry.type : "event",
    role: normalizePeerRole(entry.role || "client"),
    name: sanitizePeerName(entry.name || "") || fallbackPeerName,
    clientId: typeof entry.clientId === "string" ? entry.clientId : null,
    message: typeof entry.message === "string" ? entry.message : "",
    timestamp: Date.now()
  };
  session.activityLog.unshift(event);
  if (session.activityLog.length > 200) {
    session.activityLog.length = 200;
  }
  return event;
}

function getOrCreatePeerMeta(session, clientId, hints = {}) {
  if (!session || !clientId) return null;
  if (!session.peerMetaByClientId) session.peerMetaByClientId = new Map();
  let meta = session.peerMetaByClientId.get(clientId) || null;
  if (!meta) {
    session.unknownPeerSequence = (session.unknownPeerSequence || 0) + 1;
    meta = {
      id: session.unknownPeerSequence,
      clientId,
      role: normalizePeerRole(hints.role || "client"),
      name: "",
      lastCursorLine: null,
      lastCursorColumn: null,
      updatedAt: Date.now()
    };
    session.peerMetaByClientId.set(clientId, meta);
  }

  const hintedId = Number(hints.id);
  if (Number.isInteger(hintedId) && hintedId > 0) meta.id = hintedId;
  if (hints.role) meta.role = normalizePeerRole(hints.role);
  const sanitizedName = sanitizePeerName(hints.name || "");
  if (sanitizedName) meta.name = sanitizedName;
  if (Number.isFinite(Number(hints.cursorLine))) meta.lastCursorLine = Number(hints.cursorLine);
  if (Number.isFinite(Number(hints.cursorColumn))) meta.lastCursorColumn = Number(hints.cursorColumn);
  if (hints.lineAttributions && typeof hints.lineAttributions === "object") {
    mergeLineAttributions(meta, hints.lineAttributions, getPeerDisplayName(meta));
  }
  meta.updatedAt = Date.now();
  return meta;
}

function syncPeerMetaFromActor(session, actor) {
  if (!session || !actor || !actor.clientId) return null;
  return getOrCreatePeerMeta(session, actor.clientId, {
    id: actor.id,
    role: actor.role,
    name: actor.name,
    cursorLine: actor.cursorLine,
    cursorColumn: actor.cursorColumn,
    lineAttributions: actor.lineAttributions
  });
}

function mergeLineAttributions(target, lineAttributions, fallbackName = "") {
  if (!target || !lineAttributions || typeof lineAttributions !== "object") return;
  if (!target.lineAttributions) target.lineAttributions = {};
  const fallback = sanitizePeerName(fallbackName || "");
  for (const [line, info] of Object.entries(lineAttributions)) {
    const lineNum = Number(line);
    if (!Number.isFinite(lineNum) || lineNum < 1) continue;
    if (!info || typeof info !== "object" || typeof info.color !== "string") continue;
    const incomingName = sanitizePeerName(typeof info.name === "string" ? info.name : "");
    target.lineAttributions[String(Math.floor(lineNum))] = {
      name: incomingName || fallback,
      color: info.color
    };
  }
}

function markEditedLineAttribution(session, actor, cursorLine) {
  if (!session || !actor) return;
  const lineNum = Number(cursorLine);
  if (!Number.isFinite(lineNum) || lineNum < 1) return;
  const lineKey = String(Math.floor(lineNum));
  // Enforce one owner per line: when someone edits a line, clear that line from others.
  for (const client of session.sseClients.values()) {
    if (!client || client === actor || !client.lineAttributions) continue;
    if (Object.prototype.hasOwnProperty.call(client.lineAttributions, lineKey)) {
      delete client.lineAttributions[lineKey];
    }
  }
  if (!actor.lineAttributions) actor.lineAttributions = {};
  actor.lineAttributions[lineKey] = {
    name: getPeerDisplayName(actor),
    color: actor.color || getPeerColor(actor.clientId || actor.id)
  };
}

function getOrCreateUnknownPeerId(session, sourceKey = "") {
  if (!session) return null;
  if (!session.unknownPeerBySource) session.unknownPeerBySource = new Map();
  const normalizedSource = String(sourceKey || "unknown");
  let peerId = session.unknownPeerBySource.get(normalizedSource) || null;
  if (!Number.isFinite(Number(peerId))) {
    session.unknownPeerSequence = (session.unknownPeerSequence || 0) + 1;
    peerId = session.unknownPeerSequence;
    session.unknownPeerBySource.set(normalizedSource, peerId);
  }
  return Number(peerId);
}

function scheduleEditActivity(session, entry = {}) {
  if (!session) return;
  const clientId = typeof entry.clientId === "string" ? entry.clientId : "";
  const sourceKey = typeof entry.sourceKey === "string" ? entry.sourceKey : "";
  let hintedPeerId = Number.isFinite(Number(entry.peerId)) ? Number(entry.peerId) : null;
  if (!hintedPeerId && !clientId) {
    hintedPeerId = getOrCreateUnknownPeerId(session, sourceKey || "unknown");
  }
  const hintedCursorLine = Number.isFinite(Number(entry.cursorLine)) ? Number(entry.cursorLine) : null;
  const hintedCursorColumn = Number.isFinite(Number(entry.cursorColumn)) ? Number(entry.cursorColumn) : null;
  const hintedRole = normalizePeerRole(entry.role || "client");
  const hintedName = sanitizePeerName(entry.name || "");
  const cachedMeta = clientId
    ? getOrCreatePeerMeta(session, clientId, {
        id: hintedPeerId,
        role: hintedRole,
        name: hintedName,
        cursorLine: hintedCursorLine,
        cursorColumn: hintedCursorColumn
      })
    : null;

  const key = clientId || (hintedPeerId ? `peer-${hintedPeerId}` : `source-${sourceKey || "unknown"}`);
  if (!key) return;
  if (!session.editLogTimers) session.editLogTimers = new Map();
  const existing = session.editLogTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    session.editLogTimers.delete(key);
    const actor = clientId ? findClientByClientId(session, clientId) : null;
    const meta = actor ? syncPeerMetaFromActor(session, actor) : (cachedMeta || (clientId ? getOrCreatePeerMeta(session, clientId) : null));
    const resolvedPeerId = actor?.id || meta?.id || hintedPeerId || null;
    const resolvedName = actor
      ? getPeerDisplayName(actor)
      : (sanitizePeerName(meta?.name || hintedName) || (resolvedPeerId ? `Peer #${resolvedPeerId}` : "Peer"));
    const resolvedRole = actor?.role || meta?.role || hintedRole;
    const lineNumber = Number.isFinite(Number(entry.cursorLine))
      ? Number(entry.cursorLine)
      : (Number.isFinite(Number(actor?.cursorLine))
          ? Number(actor.cursorLine)
          : (Number.isFinite(Number(meta?.lastCursorLine)) ? Number(meta.lastCursorLine) : null));
    const columnNumber = Number.isFinite(Number(entry.cursorColumn))
      ? Number(entry.cursorColumn)
      : (Number.isFinite(Number(actor?.cursorColumn))
          ? Number(actor.cursorColumn)
          : (Number.isFinite(Number(meta?.lastCursorColumn)) ? Number(meta.lastCursorColumn) : null));
    const positionHint = (lineNumber && columnNumber)
      ? ` (line ${lineNumber}, col ${columnNumber})`
      : (lineNumber ? ` (line ${lineNumber})` : "");
    const activity = addActivity(session, {
      type: "edit",
      role: resolvedRole,
      name: resolvedName,
      peerId: resolvedPeerId,
      clientId: clientId || actor?.clientId || null,
      message: `${resolvedName} edited the document${positionHint}`
    });
    broadcastActivity(session, activity);
  }, EDIT_ACTIVITY_DEBOUNCE_MS);

  session.editLogTimers.set(key, timer);
}

function broadcastPeers(session) {
  const count = getPeerCount(session);
  for (const client of session.sseClients.values()) {
    client.res.write(`event: peers\ndata: ${count}\n\n`);
  }
}

function broadcastPeerList(session) {
  const payload = JSON.stringify(getPeerList(session));
  for (const client of session.sseClients.values()) {
    client.res.write(`event: peerlist\ndata: ${payload}\n\n`);
  }
}

function broadcastActivity(session, activity) {
  if (!session || !activity) return;
  const payload = JSON.stringify(activity);
  for (const client of session.sseClients.values()) {
    client.res.write(`event: activity\ndata: ${payload}\n\n`);
  }
}

function broadcastUpdate(session) {
  const payload = JSON.stringify(session.docState);
  for (const client of session.sseClients.values()) {
    client.res.write(`event: update\ndata: ${payload}\n\n`);
  }
}

function broadcastYjsUpdate(session, base64Update) {
  for (const client of session.sseClients.values()) {
    client.res.write(`event: yjsupdate\ndata: ${base64Update}\n\n`);
  }
}

function applyTextDiffToYText(ytextRef, oldText, newText) {
  if (!ytextRef || oldText === newText) return;
  let prefixLen = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) prefixLen++;

  let oldSuffix = oldText.length;
  let newSuffix = newText.length;
  while (oldSuffix > prefixLen && newSuffix > prefixLen &&
         oldText[oldSuffix - 1] === newText[newSuffix - 1]) {
    oldSuffix--;
    newSuffix--;
  }

  const deleteLen = oldSuffix - prefixLen;
  const insertStr = newText.slice(prefixLen, newSuffix);
  ytextRef.doc.transact(() => {
    if (deleteLen > 0) ytextRef.delete(prefixLen, deleteLen);
    if (insertStr) ytextRef.insert(prefixLen, insertStr);
  });
}

function handleDocRequest(req, res, session) {
  const url = new URL(req.url, `http://${session.host}:${session.port}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (url.pathname === "/lib/markdown-it.min.js" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/javascript",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=86400"
    });
    res.end(markdownItScript);
    return;
  }

  if (url.pathname === "/lib/yjs.min.js" && req.method === "GET") {
    if (!yjsScript) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/javascript",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=86400"
    });
    res.end(yjsScript);
    return;
  }

  if (url.pathname === "/favicon.ico" && req.method === "GET") {
    if (faviconBuffer) {
      res.writeHead(200, {
        "Content-Type": "image/x-icon",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400"
      });
      res.end(faviconBuffer);
    } else {
      res.writeHead(404);
      res.end();
    }
    return;
  }

  if ((url.pathname === "/" || url.pathname === "/index.html") && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache"
    });
    res.end(`<!DOCTYPE html>
<html lang="en" data-theme="${getCurrentTheme()}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <title>p2pmd</title>
  <style>
    @import url("browser://theme/index.css");
    html { 
      color-scheme: light dark;
      background: var(--browser-theme-background, #ffffff); 
      color: var(--browser-theme-text-color, #111111); 
    }
    body { 
      font-family: var(--browser-theme-font-family, system-ui, -apple-system, sans-serif); 
      margin: 0; 
      padding: 16px; 
      background: var(--browser-theme-background, #ffffff); 
      color: var(--browser-theme-text-color, #111111); 
      height: 100vh; 
      box-sizing: border-box; 
    }
    * {
      scrollbar-width: thin;
      scrollbar-color: rgba(128,128,128,0.4) transparent;
    }
    *::-webkit-scrollbar { width: 6px; }
    *::-webkit-scrollbar-track { background: transparent; }
    *::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.4); border-radius: 3px; }
    #editor { 
      width: 100%; 
      height: calc(100vh - 80px); 
      border: none; 
      background: transparent; 
      color: var(--browser-theme-text-color, #111111); 
      font-size: 1rem; 
      resize: none; 
      outline: none; 
    }
    #preview { 
      display: none; 
      width: 100%; 
      height: calc(100vh - 80px); 
      overflow: auto; 
    }
    #controls { 
      position: fixed; 
      bottom: 16px; 
      left: 16px; 
      right: 16px; 
      text-align: center; 
    }
    button { 
      background: var(--peersky-nav-background, #f3f4f6); 
      color: var(--peersky-nav-button-color, #111111); 
      border: 1px solid var(--browser-theme-primary-highlight, #d1d5db); 
      padding: 4px 12px; 
      border-radius: 4px; 
      cursor: pointer; 
      font-size: 0.9rem; 
    }
    button:hover { 
      background: var(--peersky-nav-button-hover, #e5e7eb); 
    }
    html[data-theme="dark"] { 
      background: var(--browser-theme-background, #0b0b0b); 
      color: var(--browser-theme-text-color, #f3f4f6); 
    }
    html[data-theme="dark"] body { 
      background: var(--browser-theme-background, #0b0b0b); 
      color: var(--browser-theme-text-color, #f3f4f6); 
    }
    html[data-theme="dark"] #editor { 
      color: var(--browser-theme-text-color, #f3f4f6); 
    }
    html[data-theme="dark"] button { 
      background: var(--peersky-nav-background, #1f2937); 
      color: var(--peersky-nav-button-color, #f3f4f6); 
      border-color: var(--browser-theme-primary-highlight, #374151); 
    }
    html[data-theme="dark"] button:hover { 
      background: var(--peersky-nav-button-hover, #374151); 
    }
  </style>
</head>
<body>
  <textarea id="editor" placeholder="Write Markdown here..."></textarea>
  <div id="preview"></div>
  <div id="controls">
    <button id="toggle-preview">👁️</button>
  </div>
  <script src="/lib/markdown-it.min.js"></script>
  <script src="/lib/yjs.min.js"></script>
  <script type="module">
    const editor = document.getElementById('editor');
    const preview = document.getElementById('preview');
    const toggleButton = document.getElementById('toggle-preview');
    let renderer = null;
    let sendTimer = null;
    let lastContent = '';
    let isPreviewMode = false;
    let ydoc = null;
    let ytext = null;
    let prevText = '';
    let pendingUpdate = null;
    let sendUpdateTimer = null;
    let flushRetryTimer = null;
    let isApplyingRemote = false;
    const MAX_PENDING_UPDATE_BYTES = 2 * 1024 * 1024;
    const Y_ORIGIN_REMOTE = 'remote-sse';
    const Y_ORIGIN_LOCAL_INPUT = 'local-input';
    const localClientId = (window.crypto && typeof window.crypto.randomUUID === 'function')
      ? window.crypto.randomUUID()
      : ('inline-' + Math.random().toString(36).slice(2, 10));
    const localLineAttributions = {};
    const PEER_COLORS = ['#0EA5E9', '#A855F7', '#22C55E', '#F97316', '#EF4444', '#14B8A6', '#EAB308', '#6366F1'];

    function bytesToBase64(bytes) {
      let bin = '';
      for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }
    function base64ToBytes(b64) {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    }
    function applyTextDiff(ytextRef, oldText, newText, origin = null) {
      if (!ytextRef || oldText === newText) return;
      let pre = 0;
      const minLen = Math.min(oldText.length, newText.length);
      while (pre < minLen && oldText[pre] === newText[pre]) pre++;
      let oldSuf = oldText.length, newSuf = newText.length;
      while (oldSuf > pre && newSuf > pre && oldText[oldSuf-1] === newText[newSuf-1]) { oldSuf--; newSuf--; }
      const delLen = oldSuf - pre;
      const ins = newText.slice(pre, newSuf);
      ytextRef.doc.transact(() => {
        if (delLen > 0) ytextRef.delete(pre, delLen);
        if (ins)        ytextRef.insert(pre, ins);
      }, origin);
    }
    function getCursorMeta() {
      const start = Number.isFinite(editor.selectionStart) ? editor.selectionStart : 0;
      const safeStart = Math.max(0, Math.min(start, (editor.value || '').length));
      const before = (editor.value || '').slice(0, safeStart);
      const lines = before.split('\\n');
      return {
        cursorLine: lines.length,
        cursorColumn: (lines[lines.length - 1] || '').length + 1
      };
    }
    function getLocalColor() {
      const source = String(localClientId || 'peer');
      let hash = 0;
      for (let i = 0; i < source.length; i++) {
        hash = ((hash << 5) - hash) + source.charCodeAt(i);
        hash |= 0;
      }
      return PEER_COLORS[Math.abs(hash) % PEER_COLORS.length];
    }
    function noteCurrentLineAttribution() {
      const cursor = getCursorMeta();
      const line = Number(cursor.cursorLine);
      if (!Number.isFinite(line) || line < 1) return;
      localLineAttributions[String(Math.floor(line))] = {
        name: '',
        color: getLocalColor()
      };
    }
    function getLineAttributionsPayload(cursor) {
      const entries = Object.entries(localLineAttributions);
      if (entries.length > 0) {
        const normalized = {};
        for (const [line, info] of entries) {
          const lineNum = Number(line);
          if (!Number.isFinite(lineNum) || lineNum < 1) continue;
          if (!info || typeof info !== 'object' || typeof info.color !== 'string') continue;
          normalized[String(Math.floor(lineNum))] = {
            name: typeof info.name === 'string' ? info.name : '',
            color: info.color
          };
        }
        if (Object.keys(normalized).length > 0) return normalized;
      }
      return undefined;
    }
    async function flushUpdate() {
      if (!pendingUpdate) return;
      const toSend = pendingUpdate; pendingUpdate = null;
      try {
        const cursor = getCursorMeta();
        const lineAttributions = getLineAttributionsPayload(cursor);
        const res = await fetch('/doc/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            update: bytesToBase64(toSend),
            clientId: localClientId,
            cursorLine: cursor.cursorLine,
            cursorColumn: cursor.cursorColumn,
            lineAttributions
          })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        if (flushRetryTimer) { clearTimeout(flushRetryTimer); flushRetryTimer = null; }
      } catch {
        let merged = pendingUpdate
          ? window.Y.mergeUpdates([toSend, pendingUpdate])
          : toSend;
        if (merged.byteLength > MAX_PENDING_UPDATE_BYTES && ydoc) {
          try { merged = window.Y.encodeStateAsUpdate(ydoc); } catch {}
        }
        if (merged.byteLength > MAX_PENDING_UPDATE_BYTES) {
          pendingUpdate = null;
          console.warn('[p2pmd] inline editor: dropping oversized pending CRDT update buffer');
        } else {
          pendingUpdate = merged;
        }
        if (!flushRetryTimer && pendingUpdate) {
          flushRetryTimer = setTimeout(() => {
            flushRetryTimer = null;
            flushUpdate();
          }, 1200);
        }
      }
    }

    function render() {
      const value = editor.value || '';
      if (isPreviewMode && renderer) preview.innerHTML = renderer.render(value);
      else if (isPreviewMode) preview.textContent = value;
    }

    function scheduleSend() {
      if (sendTimer) clearTimeout(sendTimer);
      sendTimer = setTimeout(async () => {
        const content = editor.value || '';
        if (content === lastContent) return;
        lastContent = content;
        try {
          const cursor = getCursorMeta();
          const lineAttributions = getLineAttributionsPayload(cursor);
          await fetch('/doc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content,
              clientId: localClientId,
              cursorLine: cursor.cursorLine,
              cursorColumn: cursor.cursorColumn,
              lineAttributions
            })
          });
        } catch {}
      }, 200);
    }

    function togglePreview() {
      isPreviewMode = !isPreviewMode;
      if (isPreviewMode) {
        editor.style.display = 'none';
        preview.style.display = 'block';
        toggleButton.textContent = '✏️';
        render();
      } else {
        editor.style.display = 'block';
        preview.style.display = 'none';
        toggleButton.textContent = '👁️';
      }
    }

    editor.addEventListener('input', () => {
      noteCurrentLineAttribution();
      if (!isPreviewMode) render();
      if (ydoc && ytext) {
        const newText = editor.value;
        const oldText = ytext.toString();
        if (newText === oldText) {
          prevText = oldText;
          return;
        }
        applyTextDiff(ytext, oldText, newText, Y_ORIGIN_LOCAL_INPUT);
        prevText = newText;
      } else {
        scheduleSend();
      }
    });
    toggleButton.addEventListener('click', togglePreview);

    try { renderer = window.markdownit({ html: false, linkify: true, breaks: true }); } catch {}

    const initRes = await fetch('/doc');
    if (initRes.ok) {
      const data = await initRes.json();
      if (data && typeof data.content === 'string') {
        editor.value = data.content;
        prevText = data.content;
        lastContent = data.content;
      }
    }

    if (window.Y) {
      ydoc = new window.Y.Doc();
      ytext = ydoc.getText('content');
      try {
        const yjsRes = await fetch('/doc/yjsstate');
        if (yjsRes.ok) {
          const yjsData = await yjsRes.json();
          if (typeof yjsData.yjsState === 'string') {
            window.Y.applyUpdate(ydoc, base64ToBytes(yjsData.yjsState), Y_ORIGIN_REMOTE);
            const ytContent = ytext.toString();
            if (ytContent) { editor.value = ytContent; prevText = ytContent; lastContent = ytContent; }
          }
        }
      } catch {}
      if (!prevText && editor.value) {
        ydoc.transact(() => ytext.insert(0, editor.value));
      }
      ydoc.on('update', (upd, origin) => {
        if (origin === Y_ORIGIN_REMOTE) return;
        if (isApplyingRemote) return;
        pendingUpdate = pendingUpdate ? window.Y.mergeUpdates([pendingUpdate, upd]) : upd;
        if (sendUpdateTimer) clearTimeout(sendUpdateTimer);
        sendUpdateTimer = setTimeout(flushUpdate, 100);
      });
      ytext.observe((event) => {
        const newContent = ytext.toString();
        // Keep local diff baseline aligned with CRDT text.
        prevText = newContent;
        if (newContent === editor.value) return;
        // Keep caret stable while applying remote inserts/deletes.
        let s = editor.selectionStart ?? 0, e = editor.selectionEnd ?? 0, pos = 0;
        for (const d of event.changes.delta) {
          if (d.retain) { pos += d.retain; }
          else if (d.insert) { const l = typeof d.insert === 'string' ? d.insert.length : 0; if (pos<s) s+=l; if (pos<e) e+=l; pos+=l; }
          else if (d.delete) { const l = d.delete; if (pos<s) s-=Math.min(l,s-pos); if (pos<e) e-=Math.min(l,e-pos); }
        }
        editor.value = newContent;
        editor.setSelectionRange(Math.max(0,Math.min(s,newContent.length)), Math.max(0,Math.min(e,newContent.length)));
        lastContent = newContent;
        render();
      });
    }

    let source = null;
    let reconnectTimer = null;
    function connectSSE() {
      if (source) { try { source.close(); } catch {} }
      source = new EventSource('/events?role=client&clientId=' + encodeURIComponent(localClientId));
      source.onopen = () => {
        if (pendingUpdate) flushUpdate();
      };
      source.addEventListener('yjsupdate', (event) => {
        if (!ydoc) return;
        try {
          isApplyingRemote = true;
          window.Y.applyUpdate(ydoc, base64ToBytes(event.data), Y_ORIGIN_REMOTE);
          prevText = ytext.toString();
          lastContent = prevText;
        } catch {} finally { isApplyingRemote = false; }
      });
      source.addEventListener('update', (event) => {
        if (ydoc) return;
        try {
          const data = JSON.parse(event.data || '{}');
          if (typeof data.content === 'string' && data.content !== editor.value) {
            editor.value = data.content;
            prevText = data.content;
            lastContent = data.content;
            render();
          }
        } catch {}
      });
      source.onerror = () => {
        source.close();
        scheduleReconnect();
      };
    }
    async function reconnect() {
      // Keep local state and let Yjs sync re-converge on reconnect
      connectSSE();
    }
    function scheduleReconnect() {
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnect();
      }, 3000);
    }
    connectSSE();
  </script>
</body>
</html>`);
    return;
  }

  if (url.pathname === "/doc" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache"
    });
    res.end(JSON.stringify(session.docState));
    return;
  }

  if (url.pathname === "/doc/yjsstate" && req.method === "GET") {
    if (!session.ydoc) {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache"
      });
      res.end(JSON.stringify({ yjsState: null }));
      return;
    }
    const stateBytes = Y.encodeStateAsUpdate(session.ydoc);
    const stateBase64 = Buffer.from(stateBytes).toString("base64");
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache"
    });
    res.end(JSON.stringify({ yjsState: stateBase64 }));
    return;
  }

  if (url.pathname === "/doc/update" && req.method === "POST") {
    if (!session.ydoc) {
      res.writeHead(503, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: false, error: "No Y.Doc on this node (client-only session)" }));
      return;
    }
    let body = "";
    const MAX_UPDATE_SIZE = 1 * 1024 * 1024;
    let overflow = false;
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > MAX_UPDATE_SIZE) {
        overflow = true;
        res.writeHead(413, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: "Update too large" }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (overflow) return;
      try {
        const requestSourceKey = `${req.socket?.remoteAddress || "local"}|${req.headers["user-agent"] || "ua"}`;
        const parsed = JSON.parse(body || "{}");
        const base64 = typeof parsed.update === "string" ? parsed.update : null;
        const fullText = typeof parsed.fullText === "string" ? parsed.fullText : null;
        const clientId = typeof parsed.clientId === "string" ? parsed.clientId : "";
        const providedName = sanitizePeerName(parsed.name || "");
        const cursorLine = Number.isFinite(Number(parsed.cursorLine)) ? Number(parsed.cursorLine) : null;
        const cursorColumn = Number.isFinite(Number(parsed.cursorColumn)) ? Number(parsed.cursorColumn) : null;
        const selectionStart = Number.isFinite(Number(parsed.selectionStart)) ? Number(parsed.selectionStart) : null;
        const selectionEnd = Number.isFinite(Number(parsed.selectionEnd)) ? Number(parsed.selectionEnd) : null;
        const actor = clientId ? findClientByClientId(session, clientId) : null;
        if (actor) {
          if (providedName) actor.name = providedName;
          if (cursorLine !== null) actor.cursorLine = cursorLine;
          if (cursorColumn !== null) actor.cursorColumn = cursorColumn;
          if (selectionStart !== null) actor.selectionStart = selectionStart;
          if (selectionEnd !== null) actor.selectionEnd = selectionEnd;
          mergeLineAttributions(actor, parsed.lineAttributions, getPeerDisplayName(actor));
          markEditedLineAttribution(session, actor, cursorLine !== null ? cursorLine : actor.cursorLine);
          actor.isTyping = true;
          actor.lastTypingAt = Date.now();
          actor.updatedAt = actor.lastTypingAt;
          syncPeerMetaFromActor(session, actor);
          broadcastPeerList(session);
        } else if (clientId) {
          const peerMeta = getOrCreatePeerMeta(session, clientId, {
            role: "client",
            name: providedName,
            cursorLine,
            cursorColumn
          });
          // Merge line attributions even for peers without SSE connection yet
          if (peerMeta && parsed.lineAttributions) {
            if (!peerMeta.lineAttributions) peerMeta.lineAttributions = {};
            mergeLineAttributions(peerMeta, parsed.lineAttributions, getPeerDisplayName(peerMeta));
          }
        }
        if (!base64) {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: false, error: "Missing update field" }));
          return;
        }
        let updateBytes;
        try {
          updateBytes = new Uint8Array(Buffer.from(base64, "base64"));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: false, error: "Invalid base64" }));
          return;
        }

        let beforeContent = session.ytext.toString();
        let applied = false;
        let usedTextFallback = false;
        try {
          Y.applyUpdate(session.ydoc, updateBytes, "client-update");
          applied = true;
        } catch (applyErr) {
          console.warn("[p2pmd] /doc/update: Y.applyUpdate rejected payload:", applyErr.message);
          // Fallback path: if client sends full text, reconcile using text diff.
          if (typeof fullText === "string") {
            try {
              applyTextDiffToYText(session.ytext, beforeContent, fullText);
              usedTextFallback = true;
              applied = true;
            } catch (fallbackErr) {
              console.warn("[p2pmd] /doc/update fallback failed:", fallbackErr.message);
              res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
              res.end(JSON.stringify({ ok: false, error: "Invalid Yjs update payload" }));
              return;
            }
          } else {
            res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ ok: false, error: "Invalid Yjs update payload" }));
            return;
          }
        }
        let afterContent = session.ytext.toString();

        const contentChanged = beforeContent !== afterContent;
        session.docState.content = afterContent;
        session.docState.updatedAt = Date.now();

        // Broadcast canonical server state after any content change so
        // reconnecting/diverged clients can re-converge safely.
        if (usedTextFallback || contentChanged) {
          const stateBytes = Y.encodeStateAsUpdate(session.ydoc);
          const stateBase64 = Buffer.from(stateBytes).toString("base64");
          broadcastYjsUpdate(session, stateBase64);
          scheduleEditActivity(session, {
            clientId,
            peerId: actor?.id || null,
            role: actor?.role || "client",
            name: actor ? getPeerDisplayName(actor) : providedName,
            cursorLine: cursorLine !== null ? cursorLine : actor?.cursorLine,
            cursorColumn: cursorColumn !== null ? cursorColumn : actor?.cursorColumn,
            sourceKey: requestSourceKey
          });
        }
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error("[p2pmd] /doc/update error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: "Internal error" }));
      }
    });
    return;
  }

  if (url.pathname === "/doc" && req.method === "POST") {
    let body = "";
    const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
    let overflow = false;
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > MAX_BODY_SIZE) {
        overflow = true;
        res.writeHead(413, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: "Document too large" }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (overflow) return;
      try {
        const requestSourceKey = `${req.socket?.remoteAddress || "local"}|${req.headers["user-agent"] || "ua"}`;
        const parsed = JSON.parse(body || "{}");
        const content = typeof parsed.content === "string" ? parsed.content : "";
        const clientId = typeof parsed.clientId === "string" ? parsed.clientId : "";
        const providedName = sanitizePeerName(parsed.name || "");
        const cursorLine = Number.isFinite(Number(parsed.cursorLine)) ? Number(parsed.cursorLine) : null;
        const cursorColumn = Number.isFinite(Number(parsed.cursorColumn)) ? Number(parsed.cursorColumn) : null;
        const selectionStart = Number.isFinite(Number(parsed.selectionStart)) ? Number(parsed.selectionStart) : null;
        const selectionEnd = Number.isFinite(Number(parsed.selectionEnd)) ? Number(parsed.selectionEnd) : null;
        const actor = clientId ? findClientByClientId(session, clientId) : null;
        if (actor) {
          if (providedName) actor.name = providedName;
          if (cursorLine !== null) actor.cursorLine = cursorLine;
          if (cursorColumn !== null) actor.cursorColumn = cursorColumn;
          if (selectionStart !== null) actor.selectionStart = selectionStart;
          if (selectionEnd !== null) actor.selectionEnd = selectionEnd;
          mergeLineAttributions(actor, parsed.lineAttributions, getPeerDisplayName(actor));
          markEditedLineAttribution(session, actor, cursorLine !== null ? cursorLine : actor.cursorLine);
          actor.isTyping = true;
          actor.lastTypingAt = Date.now();
          actor.updatedAt = actor.lastTypingAt;
          syncPeerMetaFromActor(session, actor);
          broadcastPeerList(session);
        } else if (clientId) {
          const peerMeta = getOrCreatePeerMeta(session, clientId, {
            role: "client",
            name: providedName,
            cursorLine,
            cursorColumn
          });
          // Merge line attributions even for peers without SSE connection yet
          if (peerMeta && parsed.lineAttributions) {
            if (!peerMeta.lineAttributions) peerMeta.lineAttributions = {};
            mergeLineAttributions(peerMeta, parsed.lineAttributions, getPeerDisplayName(peerMeta));
          }
        }
        const beforeContent = session.ydoc && session.ytext ? session.ytext.toString() : session.docState.content;
        session.docState.content = content;
        session.docState.updatedAt = Date.now();
        if (session.ydoc && session.ytext) {
          const current = session.ytext.toString();
          if (current !== content) {
            let deltaUpdate = null;
            const onUpdate = (update) => {
              deltaUpdate = deltaUpdate ? Y.mergeUpdates([deltaUpdate, update]) : update;
            };
            session.ydoc.on("update", onUpdate);
            try {
              applyTextDiffToYText(session.ytext, current, content);
            } finally {
              session.ydoc.off("update", onUpdate);
            }
            if (deltaUpdate) {
              const updateBase64 = Buffer.from(deltaUpdate).toString("base64");
              broadcastYjsUpdate(session, updateBase64);
            }
          }
        } else {
          broadcastUpdate(session);
        }
        if (beforeContent !== content) {
          scheduleEditActivity(session, {
            clientId,
            peerId: actor?.id || null,
            role: actor?.role || "client",
            name: actor ? getPeerDisplayName(actor) : providedName,
            cursorLine: cursorLine !== null ? cursorLine : actor?.cursorLine,
            cursorColumn: cursorColumn !== null ? cursorColumn : actor?.cursorColumn,
            sourceKey: requestSourceKey
          });
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache"
        });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        });
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }

  if (url.pathname === "/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });
    const role = normalizePeerRole(url.searchParams.get("role") || "client");
    const name = sanitizePeerName(url.searchParams.get("name") || "");
    const rawClientId = typeof url.searchParams.get("clientId") === "string" ? url.searchParams.get("clientId") : "";
    const clientId = rawClientId ? rawClientId.slice(0, 128) : `peer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const existing = clientId ? findClientByClientId(session, clientId) : null;
    if (existing?.res && existing.res !== res) {
      try { existing.res.end(); } catch {}
      session.sseClients.delete(existing.res);
    }
    const peerMeta = clientId
      ? getOrCreatePeerMeta(session, clientId, { role, name })
      : null;
    const peerId = Number.isFinite(Number(peerMeta?.id))
      ? Number(peerMeta.id)
      : ++peerSequence;
    const resolvedRole = normalizePeerRole(peerMeta?.role || role || "client");
    const resolvedName = sanitizePeerName(peerMeta?.name || name || "");
    const peerState = {
      res,
      id: peerId,
      role: resolvedRole,
      name: resolvedName,
      clientId,
      color: getPeerColor(clientId || peerId),
      isTyping: false,
      cursorLine: null,
      cursorColumn: null,
      selectionStart: null,
      selectionEnd: null,
      joinedAt: Date.now(),
      updatedAt: Date.now(),
      lastTypingAt: 0,
      lastEditAt: 0,
      // Preserve lineAttributions from peerMeta if available (fixes host reconnection bug)
      lineAttributions: peerMeta?.lineAttributions || {}
    };
    session.sseClients.set(res, peerState);
    syncPeerMetaFromActor(session, peerState);
    const currentPeerCount = getPeerCount(session);
    console.log(`[p2pmd] SSE connected: peerId=${peerId}, role=${resolvedRole}, totalClients=${session.sseClients.size}, peerCount=${currentPeerCount}`);
    
    res.write(`event: peers\ndata: ${currentPeerCount}\n\n`);
    res.write(`event: peerlist\ndata: ${JSON.stringify(getPeerList(session))}\n\n`);
    if (Array.isArray(session.activityLog) && session.activityLog.length > 0) {
      res.write(`event: activity\ndata: ${JSON.stringify(session.activityLog.slice(0, 100))}\n\n`);
    }
    if (session.ydoc) {
      const stateBytes = Y.encodeStateAsUpdate(session.ydoc);
      const stateBase64 = Buffer.from(stateBytes).toString("base64");
      res.write(`event: yjsupdate\ndata: ${stateBase64}\n\n`);
    } else {
      res.write(`event: update\ndata: ${JSON.stringify(session.docState)}\n\n`);
    }
    const joinActivity = addActivity(session, {
      type: "join",
      role: resolvedRole,
      name: getPeerDisplayName(peerState),
      clientId,
      message: `${getPeerDisplayName(peerState)} joined as ${resolvedRole}`
    });
    broadcastPeers(session);
    broadcastPeerList(session);
    broadcastActivity(session, joinActivity);
    if (!session.keepaliveInterval) {
      session.keepaliveInterval = setInterval(() => {
        for (const client of session.sseClients.values()) {
          try { client.res.write(":keepalive\n\n"); } catch {}
        }
      }, 20000);
    }
    req.on("close", () => {
      const departingPeer = session.sseClients.get(res);
      session.sseClients.delete(res);
      if (session.sseClients.size === 0 && session.keepaliveInterval) {
        clearInterval(session.keepaliveInterval);
        session.keepaliveInterval = null;
      }
      if (departingPeer) {
        const leaveActivity = addActivity(session, {
          type: "leave",
          role: departingPeer.role,
          name: getPeerDisplayName(departingPeer),
          clientId: departingPeer.clientId || null,
          message: `${getPeerDisplayName(departingPeer)} left the room`
        });
        broadcastActivity(session, leaveActivity);
      }
      broadcastPeers(session);
      broadcastPeerList(session);
    });
    return;
  }

  if (url.pathname === "/status" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache"
    });
    res.end(JSON.stringify({
      peers: getPeerCount(session),
      peerList: getPeerList(session),
      activityCount: Array.isArray(session.activityLog) ? session.activityLog.length : 0
    }));
    return;
  }

  if (url.pathname === "/activity" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache"
    });
    res.end(JSON.stringify({
      activity: Array.isArray(session.activityLog) ? session.activityLog.slice(0, 150) : []
    }));
    return;
  }

  if (url.pathname === "/presence" && req.method === "POST") {
    let body = "";
    let overflow = false;
    const MAX_BODY_SIZE = 32 * 1024;
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > MAX_BODY_SIZE) {
        overflow = true;
        res.writeHead(413, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: "Presence payload too large" }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (overflow) return;
      try {
        const parsed = JSON.parse(body || "{}");
        const clientId = typeof parsed.clientId === "string" ? parsed.clientId : "";
        const nextName = sanitizePeerName(parsed.name || "");
        const actor = findClientByClientId(session, clientId);
        const peerMeta = clientId
          ? getOrCreatePeerMeta(session, clientId, {
              role: parsed.role || "client",
              name: nextName,
              cursorLine: parsed.cursorLine,
              cursorColumn: parsed.cursorColumn,
              lineAttributions: parsed.lineAttributions
            })
          : null;
        if (!actor && !peerMeta) {
          res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: false, error: "Peer not found" }));
          return;
        }
        if (actor && nextName) actor.name = nextName;
        if (actor) actor.role = normalizePeerRole(parsed.role || actor.role || "client");
        const nextTyping = parsed.isTyping === true;
        if (actor) {
          mergeLineAttributions(actor, parsed.lineAttributions, getPeerDisplayName(actor));
          actor.isTyping = nextTyping;
          if (nextTyping) {
            actor.lastTypingAt = Date.now();
          }
          actor.cursorLine = Number.isFinite(Number(parsed.cursorLine)) ? Number(parsed.cursorLine) : null;
          actor.cursorColumn = Number.isFinite(Number(parsed.cursorColumn)) ? Number(parsed.cursorColumn) : null;
          actor.selectionStart = Number.isFinite(Number(parsed.selectionStart)) ? Number(parsed.selectionStart) : null;
          actor.selectionEnd = Number.isFinite(Number(parsed.selectionEnd)) ? Number(parsed.selectionEnd) : null;
          actor.updatedAt = Date.now();
          syncPeerMetaFromActor(session, actor);
        }

        broadcastPeerList(session);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: false, error: "Invalid payload" }));
      }
    });
    return;
  }

  res.writeHead(404, {
    "Content-Type": "text/plain",
    "Access-Control-Allow-Origin": "*"
  });
  res.end("Not found");
}

async function stopDocServer(session) {
  if (!session?.server) return;
  if (session.editLogTimers && session.editLogTimers.size > 0) {
    for (const timer of session.editLogTimers.values()) {
      clearTimeout(timer);
    }
    session.editLogTimers.clear();
  }
  if (session.keepaliveInterval) {
    clearInterval(session.keepaliveInterval);
    session.keepaliveInterval = null;
  }
  for (const client of session.sseClients.values()) {
    try {
      client.res.end();
    } catch {}
  }
  session.sseClients.clear();
  for (const socket of session.sockets) {
    try {
      socket.destroy();
    } catch {}
  }
  session.sockets.clear();
  await new Promise((resolve) => {
    session.server.close(() => {
      resolve();
    });
  });
  session.server = null;
  session.port = null;
}

async function ensureDocServer(session, host, port, secure) {
  // Bind HTTP server to 127.0.0.1
  // Holesail server forwards tunnel traffic to this same address locally
  // DHT stores host: "127.0.0.1" so mobile clients create their proxy on localhost
  const nextHost = "127.0.0.1";
  
  if (session.server && session.host === nextHost && (port === null || session.port === port)) {
    return { host: session.host, port: session.port };
  }
  if (session.server) {
    await stopDocServer(session);
  }
  session.host = nextHost;
  const savedEntry = session.key ? roomPorts.get(session.key) : null;
  const savedPort = savedEntry?.port || null;
  const requestedPort = port || session.originalPort || savedPort || 0;
  console.log("[p2pmd] ensureDocServer", { key: session.key, port, originalPort: session.originalPort, savedPort, requestedPort });
  session.server = http.createServer((req, res) => handleDocRequest(req, res, session));
  session.server.on("connection", (socket) => {
    session.sockets.add(socket);
    socket.on("close", () => session.sockets.delete(socket));
  });
  let retries = 3;
  let lastError = null;
  while (retries > 0) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          session.server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          session.server.off("error", onError);
          resolve();
        };
        session.server.once("error", onError);
        session.server.once("listening", onListening);
        session.server.listen(requestedPort, session.host);
      });
      const address = session.server.address();
      session.port = address.port;
      if (!session.originalPort) {
        session.originalPort = session.port;
      }
      if (session.key && !roomPorts.has(session.key)) {
        roomPorts.set(session.key, { port: session.port, seed: null });
        savePortsToFile();
        console.log("[p2pmd] saved port for room", { key: session.key, port: session.port });
      }
      return { host: session.host, port: session.port };
    } catch (err) {
      lastError = err;
      retries--;
      if (retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  session.server = null;
  throw lastError || new Error("Failed to bind server after retries");
}

async function stopHolesailServer(session) {
  if (!session?.holesailServer) return;
  try {
    await session.holesailServer.close();
  } catch {}
  session.holesailServer = null;
}

async function stopHolesailClient(session) {
  if (!session?.holesailClient) return;
  try {
    await session.holesailClient.close();
  } catch {}
  session.holesailClient = null;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    return value === "true" || value === "1";
  }
  return fallback;
}

function normalizeHost(value) {
  if (!value || typeof value !== "string") return "127.0.0.1";
  const trimmed = value.trim();
  if (!trimmed) return "127.0.0.1";
  try {
    if (trimmed.includes("://")) {
      const parsed = new URL(trimmed);
      return parsed.hostname || "127.0.0.1";
    }
  } catch {}
  if (trimmed.includes("/")) {
    return trimmed.split("/")[0] || "127.0.0.1";
  }
  if (trimmed.includes(":")) {
    return trimmed.split(":")[0] || "127.0.0.1";
  }
  return trimmed;
}

function normalizePort(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function extractPort(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    if (trimmed.includes("://")) {
      const parsed = new URL(trimmed);
      if (parsed.port) return Number(parsed.port);
    }
  } catch {}
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":");
    const port = Number(parts[1]);
    return Number.isFinite(port) ? port : null;
  }
  return null;
}

function getResponseHost(session) {
  // Holesail creates a P2P tunnel that makes peers appear on the same local network
  // Clients should ALWAYS connect to localhost, regardless of secure/public mode
  // The holesail library handles the tunneling transparently
  return "127.0.0.1";
}

export async function createHandler() {
  return async function protocolHandler(req) {
    const { url, method } = req;
    const urlObj = new URL(url);
    const action = urlObj.searchParams.get("action");

    if (urlObj.hostname !== "p2pmd") {
      return buildTextResponse(404, "Unknown hs target");
    }

    if (method === "POST" && action === "create") {
      // SECURITY: Rate limit room creation (5 per minute)
      if (!checkRateLimit('create', 5, 60000)) {
        return buildJsonResponse(429, { error: "Too many requests. Please wait before creating another room." });
      }

      const body = await req.json();
      const secure = parseBoolean(body.secure, false);
      const udp = parseBoolean(body.udp, false);
      const host = normalizeHost(body.host);
      const port = normalizePort(body.port);
      if (DEBUG) {
        console.log("[p2pmd] create request", { secure, udp, host, port });
      }

      const sessionState = createSession();
      const { host: boundHost, port: boundPort } = await ensureDocServer(sessionState, host, port, secure);
      await stopHolesailServer(sessionState);
      // Pass 127.0.0.1 to holesail so clients connect to localhost
      // Holesail forwards tunnel traffic to this address, and stores it on DHT for clients
      const holesailServer = new Holesail({
        server: true,
        secure,
        udp,
        host: "127.0.0.1",
        port: boundPort,
        log: 1
      });
      await holesailServer.ready();
      const roomKey = holesailServer.info?.url || null;
      // SECURITY: Redact sensitive data in logs
      console.log("[p2pmd] holesail server ready", { key: redactKey(roomKey), port: boundPort });
      if (DEBUG) {
        console.log("  Connection string:", roomKey);
        console.log("  DHT key:", holesailServer.info?.key);
      }
      sessionState.key = roomKey;
      sessionState.holesailServer = holesailServer;
      initSessionCrdt(sessionState);
      // Extract seed from holesail-server so we can recreate with the same key later
      const serverSeed = holesailServer.dht?.seed ? holesailServer.dht.seed.toString("hex") : null;
      if (roomKey) {
        roomSessions.set(roomKey, sessionState);
        // Save port + seed now that we have the key (seed will be encrypted)
        roomPorts.set(roomKey, { port: boundPort, seed: serverSeed });
        savePortsToFile();
        console.log("[p2pmd] saved port+seed for room", { key: redactKey(roomKey), port: boundPort });
      }
      console.log("[p2pmd] create ready", { key: redactKey(roomKey), port: boundPort });

      const responseHost = getResponseHost(sessionState);
      return buildJsonResponse(200, {
        key: roomKey,
        localHost: responseHost,
        localPort: boundPort,
        localUrl: `http://${responseHost}:${boundPort}`,
        secure,
        udp
      });
    }

    if (method === "POST" && action === "rehost") {
      // SECURITY: Rate limit rehost (10 per minute)
      if (!checkRateLimit('rehost', 10, 60000)) {
        return buildJsonResponse(429, { error: "Too many requests. Please wait before rehosting." });
      }

      const body = await req.json();
      const key = body.key || "";
      if (!key) {
        return buildJsonResponse(400, { error: "Missing key" });
      }
      const parsedKey = Holesail.urlParser(key);
      const secure = body.secure === undefined ? parsedKey.secure === true : parseBoolean(body.secure, true);
      const udp = parseBoolean(body.udp, false);
      const host = normalizeHost(body.host);
      const port = normalizePort(body.port);
      const initialContent = typeof body.initialContent === "string" ? body.initialContent : "";
      const initialYjsState = typeof body.initialYjsState === "string" ? body.initialYjsState : null;

      let sessionState = getExistingSession(key);
      if (sessionState) {
        await stopHolesailServer(sessionState);
        await stopHolesailClient(sessionState);
        await stopDocServer(sessionState);
      } else {
        sessionState = createSession(key);
        roomSessions.set(key, sessionState);
      }
      const { host: boundHost, port: boundPort } = await ensureDocServer(sessionState, host, port, secure);
      
      if (initialContent) {
        sessionState.docState.content = initialContent;
        sessionState.docState.updatedAt = Date.now();
      }
      // Keep Y.Doc with peer edits if it exists
      initSessionCrdt(sessionState, sessionState.docState.content, initialYjsState, true);
      
      // Use localhost for holesail and restore original seed for same room URL
      const savedReHostEntry = roomPorts.get(key) || null;
      const savedSeedBuffer = savedReHostEntry?.seed ? Buffer.from(savedReHostEntry.seed, 'hex') : null;
      const holesailServer = new Holesail({
        server: true,
        secure,
        udp,
        host: "127.0.0.1",
        port: boundPort,
        ...(savedSeedBuffer ? {} : { key }),
        log: 1
      });
      if (savedSeedBuffer) {
        holesailServer.seed = savedSeedBuffer;
      }
      await holesailServer.ready();
      const roomKey = holesailServer.info?.url || key;
      console.log("[p2pmd] rehost server ready", { key: redactKey(roomKey), port: boundPort });
      if (roomKey !== key) {
        roomSessions.delete(key);
      }
      sessionState.key = roomKey;
      sessionState.holesailServer = holesailServer;
      roomSessions.set(roomKey, sessionState);
      // Save seed for rehosted rooms so auto-rehost works after disconnect (will be encrypted)
      const serverSeed = holesailServer.dht?.seed ? holesailServer.dht.seed.toString("hex") : null;
      if (roomKey) {
        roomPorts.set(roomKey, { port: boundPort, seed: serverSeed });
        savePortsToFile();
      }
      console.log("[p2pmd] rehost ready", { key: redactKey(roomKey), port: boundPort });

      const responseHost = getResponseHost(sessionState);
      return buildJsonResponse( 200, {
        key: roomKey,
        localHost: responseHost,
        localPort: boundPort,
        localUrl: `http://${responseHost}:${boundPort}`,
        secure,
        udp
      });
    }

    if (method === "POST" && action === "resume") {
      const body = await req.json();
      const key = body.key || "";
      const sessionState = key ? getExistingSession(key) : (roomSessions.size === 1 ? Array.from(roomSessions.values())[0] : null);
      if (!sessionState || !sessionState.server) {
        return buildJsonResponse(404, { error: "No active room" });
      }
      const responseHost = getResponseHost(sessionState);
      return buildJsonResponse( 200, {
        key: sessionState.key,
        localHost: responseHost,
        localPort: sessionState.port,
        localUrl: `http://${responseHost}:${sessionState.port}`,
        secure: sessionState.holesailServer?.info?.secure,
        udp: sessionState.holesailServer?.info?.udp
      });
    }

    if (method === "POST" && action === "join") {
      const body = await req.json();
      const key = body.key || "";
      if (!key) {
        return buildJsonResponse(400, { error: "Missing key" });
      }

      const parsedKey = Holesail.urlParser(key);
      const secure = body.secure === undefined ? null : parseBoolean(body.secure, true);
      const udp = body.udp === undefined ? null : parseBoolean(body.udp, false);
      const hostValue = typeof body.host === "string" ? body.host : "";
      const extractedPort = extractPort(hostValue);
      const portInput = normalizePort(body.port);
      const host = hostValue ? normalizeHost(hostValue) : null;
      const keyPort = parsedKey?.port || null;
      const port = keyPort || extractedPort || portInput || null;
      console.log("[p2pmd] join request", { key: redactKey(key), port });

      // If this room already has a running holesail server, don't destroy it.
      // This happens when the page reloads after creating a room.
      let sessionState = getExistingSession(key);
      if (sessionState?.holesailServer && sessionState.server) {
        const responseHost = getResponseHost(sessionState);
        const localUrl = `http://${responseHost}:${sessionState.port}`;
        console.log("[p2pmd] join: server already running", { key: redactKey(key), port: sessionState.port });
        return buildJsonResponse(200, {
          key,
          localHost: responseHost,
          localPort: sessionState.port,
          localUrl
        });
      }

      // If this device has a saved port+seed for this room (creator), automatically rehost on the same port with the same seed
      const savedEntry = roomPorts.get(key) || null;
      const resolvedSecure = secure === null ? (parsedKey.secure === true) : secure;
      const resolvedUdp = udp === null ? parseBoolean(parsedKey.udp, false) : udp;
      const savedSeedBuffer = savedEntry?.seed ? Buffer.from(savedEntry.seed, 'hex') : null;
      if (savedSeedBuffer && !sessionState?.holesailServer && !sessionState?.holesailClient) {
        if (!sessionState) {
          sessionState = createSession(key);
          roomSessions.set(key, sessionState);
        } else {
          await stopHolesailServer(sessionState);
          await stopHolesailClient(sessionState);
          await stopDocServer(sessionState);
        }
        const { host: boundHost, port: boundPort } = await ensureDocServer(sessionState, "127.0.0.1", savedEntry.port, resolvedSecure);
        // Create Holesail server WITHOUT key, then inject the saved seed before ready()
        // This makes Holesail generate the exact same keypair → same key → same connection string
        const holesailServer = new Holesail({
          server: true,
          secure: resolvedSecure,
          udp: resolvedUdp,
          host: "127.0.0.1",
          port: boundPort,
          log: 1
        });
        holesailServer.seed = savedSeedBuffer;
        await holesailServer.ready();
        const rehostedKey = holesailServer.info?.url || key;
        if (rehostedKey !== key) {
          roomSessions.delete(key);
        }
        sessionState.key = rehostedKey;
        sessionState.holesailServer = holesailServer;
        roomSessions.set(rehostedKey, sessionState);
        // Keep Y.Doc with peer edits if it exists
        initSessionCrdt(sessionState, sessionState.docState.content, null, true);
        const responseHost = getResponseHost(sessionState);
        return buildJsonResponse(200, {
          key: sessionState.key,
          localHost: responseHost,
          localPort: boundPort,
          localUrl: `http://${responseHost}:${boundPort}`,
          secure: resolvedSecure,
          udp: resolvedUdp
        });
      }

      if (sessionState) {
        await stopHolesailServer(sessionState);
        await stopHolesailClient(sessionState);
        await stopDocServer(sessionState);
      } else {
        sessionState = createSession(key);
        roomSessions.set(key, sessionState);
      }

      // For a pure client join, do NOT start a local doc server. Just create a Holesail client
      // and let it bind the local proxy port. If the user provided a port, honor it; otherwise
      // allow Holesail to choose (which typically mirrors the server's port).
      const requestedPort = port || savedEntry?.port || null;
      const finalHost = host || "127.0.0.1";
      const clientOptions = {
        client: true,
        key,
        host: finalHost,
        log: 1
      };
      if (secure !== null) clientOptions.secure = secure;
      if (udp !== null) clientOptions.udp = udp;
      if (requestedPort) clientOptions.port = requestedPort;
      if (DEBUG) {
        console.log("[p2pmd] join creating client", { port: requestedPort });
      }
      const holesailClient = new Holesail(clientOptions);
      sessionState.holesailClient = holesailClient;
      await holesailClient.ready();
      const boundPort = holesailClient.info?.port || requestedPort || 0;
      sessionState.port = boundPort;
      console.log("[p2pmd] join client ready", { port: boundPort });
      if (DEBUG) {
        console.log("  Client info:", JSON.stringify(holesailClient.info, null, 2));
      }

      await new Promise(resolve => setTimeout(resolve, 500));

      const responseHost = getResponseHost(sessionState);
      const localUrl = `http://${responseHost}:${boundPort}`;
      console.log("[p2pmd] join ready", { key: redactKey(key), port: boundPort });
      
      return buildJsonResponse(200, {
        key,
        localHost: responseHost,
        localPort: boundPort,
        localUrl
      });
    }

    if (method === "POST" && action === "close") {
      const body = await req.json();
      const key = body.key || "";
      if (key) {
        const sessionState = getExistingSession(key);
        if (!sessionState) {
          return buildJsonResponse(404, { error: "Room not found" });
        }
        await stopHolesailClient(sessionState);
        await stopHolesailServer(sessionState);
        await stopDocServer(sessionState);
        roomSessions.delete(key);
        return buildJsonResponse(200, { ok: true });
      }
      for (const sessionState of roomSessions.values()) {
        await stopHolesailClient(sessionState);
        await stopHolesailServer(sessionState);
        await stopDocServer(sessionState);
      }
      roomSessions.clear();
      return buildJsonResponse(200, { ok: true });
    }

    return buildJsonResponse(404, { error: "Unknown action" });
  };
}

