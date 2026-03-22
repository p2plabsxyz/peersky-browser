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
    ytext: null
  };
}
function initSessionCrdt(session, initialText = "") {
  if (session.ydoc) {
    try { session.ydoc.destroy(); } catch {}
  }
  session.ydoc = new Y.Doc();
  session.ytext = session.ydoc.getText("content");
  if (initialText) {
    session.ydoc.transact(() => session.ytext.insert(0, initialText));
  }
}

function getExistingSession(key) {
  if (!key) return null;
  return roomSessions.get(key) || null;
}

function getPeerCount(session) {
  let count = 0;
  for (const client of session.sseClients.values()) {
    if (client.role !== "host") count += 1;
  }
  return count;
}

function getPeerList(session) {
  return Array.from(session.sseClients.values())
    .filter((client) => client.role !== "host")
    .map((client) => ({
      id: client.id,
      role: client.role
    }));
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
    let isPreviewMode = false;
    let ydoc = null;
    let ytext = null;
    let prevText = '';
    let pendingUpdate = null;
    let sendUpdateTimer = null;
    let isApplyingRemote = false;
    const MAX_PENDING_UPDATE_BYTES = 2 * 1024 * 1024;

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
    function applyTextDiff(ytextRef, oldText, newText) {
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
      });
    }
    async function flushUpdate() {
      if (!pendingUpdate) return;
      const toSend = pendingUpdate; pendingUpdate = null;
      try {
        const res = await fetch('/doc/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ update: bytesToBase64(toSend) })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
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
      }
    }

    function render() {
      const value = editor.value || '';
      if (isPreviewMode && renderer) preview.innerHTML = renderer.render(value);
      else if (isPreviewMode) preview.textContent = value;
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
      if (!isPreviewMode) render();
      if (ydoc && ytext) {
        const newText = editor.value;
        applyTextDiff(ytext, prevText, newText);
        prevText = newText;
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
            window.Y.applyUpdate(ydoc, base64ToBytes(yjsData.yjsState));
            const ytContent = ytext.toString();
            if (ytContent) { editor.value = ytContent; prevText = ytContent; }
          }
        }
      } catch {}
      if (!prevText && editor.value) {
        ydoc.transact(() => ytext.insert(0, editor.value));
      }
      ydoc.on('update', (upd) => {
        if (isApplyingRemote) return;
        pendingUpdate = pendingUpdate ? window.Y.mergeUpdates([pendingUpdate, upd]) : upd;
        if (sendUpdateTimer) clearTimeout(sendUpdateTimer);
        sendUpdateTimer = setTimeout(flushUpdate, 50);
      });
      ytext.observe((event) => {
        const newContent = ytext.toString();
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
        prevText = newContent;
        render();
      });
    }

    let source = null;
    let reconnectTimer = null;
    function connectSSE() {
      if (source) { try { source.close(); } catch {} }
      source = new EventSource('/events');
      source.addEventListener('yjsupdate', (event) => {
        if (!ydoc) return;
        try {
          isApplyingRemote = true;
          window.Y.applyUpdate(ydoc, base64ToBytes(event.data));
          prevText = ytext.toString();
        } catch {} finally { isApplyingRemote = false; }
      });
      source.onerror = () => {
        source.close();
        scheduleReconnect();
      };
    }
    async function reconnect() {
      try {
        const res = await fetch('/doc');
        if (res.ok) {
          const data = await res.json();
          if (data && typeof data.content === 'string') {
            editor.value = data.content;
            prevText = data.content;
            render();
          }
          connectSSE();
          return;
        }
      } catch {}
      scheduleReconnect();
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
        const parsed = JSON.parse(body || "{}");
        const base64 = typeof parsed.update === "string" ? parsed.update : null;
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
      
        try {
          Y.applyUpdate(session.ydoc, updateBytes);
        } catch (applyErr) {
          console.warn("[p2pmd] /doc/update: Y.applyUpdate rejected payload:", applyErr.message);
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ok: false, error: "Invalid Yjs update payload" }));
          return;
        }
        session.docState.content = session.ytext.toString();
        session.docState.updatedAt = Date.now();
        broadcastYjsUpdate(session, base64);
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
        const parsed = JSON.parse(body || "{}");
        const content = typeof parsed.content === "string" ? parsed.content : "";
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
    const role = url.searchParams.get("role") || "client";
    const peerId = ++peerSequence;
    session.sseClients.set(res, { res, id: peerId, role });
    const currentPeerCount = getPeerCount(session);
    console.log(`[p2pmd] SSE connected: peerId=${peerId}, role=${role}, totalClients=${session.sseClients.size}, peerCount=${currentPeerCount}`);
    
    res.write(`event: peers\ndata: ${currentPeerCount}\n\n`);
    res.write(`event: peerlist\ndata: ${JSON.stringify(getPeerList(session))}\n\n`);
    if (session.ydoc) {
      const stateBytes = Y.encodeStateAsUpdate(session.ydoc);
      const stateBase64 = Buffer.from(stateBytes).toString("base64");
      res.write(`event: yjsupdate\ndata: ${stateBase64}\n\n`);
    }
    broadcastPeers(session);
    broadcastPeerList(session);
    if (!session.keepaliveInterval) {
      session.keepaliveInterval = setInterval(() => {
        for (const client of session.sseClients.values()) {
          try { client.res.write(":keepalive\n\n"); } catch {}
        }
      }, 20000);
    }
    req.on("close", () => {
      session.sseClients.delete(res);
      if (session.sseClients.size === 0 && session.keepaliveInterval) {
        clearInterval(session.keepaliveInterval);
        session.keepaliveInterval = null;
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
    res.end(JSON.stringify({ peers: getPeerCount(session), peerList: getPeerList(session) }));
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
      console.log("[p2pmd] rehost request", { key: redactKey(key), port, hasInitialContent: initialContent.length > 0 });

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
      initSessionCrdt(sessionState, sessionState.docState.content);
      
      // Pass 127.0.0.1 to holesail so clients connect to localhost
      // Holesail forwards tunnel traffic to this address, and stores it on DHT for clients
      // IMPORTANT: Do NOT pass `key` to Holesail - it derives seed=SHA256(key), producing a
      // different DHT keypair/identity so clients can't find the rehostted server.
      // Instead, restore the original seed so the same keypair (and thus same room URL) is used.
      const savedReHostEntry = roomPorts.get(key);
      const holesailServer = new Holesail({
        server: true,
        secure,
        udp,
        host: "127.0.0.1",
        port: boundPort,
        ...(savedReHostEntry?.seed ? {} : { key }),
        log: 1
      });
      if (savedReHostEntry?.seed) {
        holesailServer.seed = Buffer.from(savedReHostEntry.seed, 'hex');
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
      if (savedEntry?.seed && !sessionState?.holesailServer && !sessionState?.holesailClient) {
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
        // Convert hex string seed to Buffer (seed is stored as hex after decryption)
        holesailServer.seed = Buffer.from(savedEntry.seed, 'hex');
        await holesailServer.ready();
        const rehostedKey = holesailServer.info?.url || key;
        if (rehostedKey !== key) {
          roomSessions.delete(key);
        }
        sessionState.key = rehostedKey;
        sessionState.holesailServer = holesailServer;
        roomSessions.set(rehostedKey, sessionState);
        initSessionCrdt(sessionState, sessionState.docState.content);
        console.log("[p2pmd] join: auto-rehosted existing room", { key: redactKey(rehostedKey), port: boundPort });
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
