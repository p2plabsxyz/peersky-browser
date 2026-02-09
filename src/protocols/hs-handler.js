import Holesail from "holesail";
import http from "http";
import { Readable, PassThrough } from "stream";
import fs from "fs";
import path from "path";
import { app } from "electron";

const roomSessions = new Map();
const roomPorts = new Map();
let peerSequence = 0;

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
          roomPorts.set(key, { port: value.port, seed: value.seed || null });
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
    const obj = Object.fromEntries(roomPorts);
    fs.writeFileSync(PORTS_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (err) {
    console.error("[p2pmd] failed to save ports", err);
  }
}

loadPortsFromFile();

function sendJson(callback, statusCode, payload) {
  callback({
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    data: Readable.from([Buffer.from(JSON.stringify(payload))])
  });
}

function sendText(callback, statusCode, text) {
  callback({
    statusCode,
    headers: {
      "Content-Type": "text/plain",
      "Access-Control-Allow-Origin": "*"
    },
    data: Readable.from([Buffer.from(text)])
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
    holesailClient: null
  };
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

function broadcastUpdate(session) {
  const payload = JSON.stringify(session.docState);
  for (const client of session.sseClients.values()) {
    client.res.write(`event: update\ndata: ${payload}\n\n`);
  }
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
  <script type="module">
    const editor = document.getElementById('editor');
    const preview = document.getElementById('preview');
    const toggleButton = document.getElementById('toggle-preview');
    let renderer = null;
    let sendTimer = null;
    let lastContent = '';
    let isPreviewMode = false;

    async function loadMarkdownIt() {
      try {
        const module = await import('https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/+esm');
        renderer = module.default({ html: false, linkify: true, breaks: true });
      } catch {
        renderer = null;
      }
    }

    function render() {
      const value = editor.value || '';
      if (isPreviewMode && renderer) {
        preview.innerHTML = renderer.render(value);
      } else if (isPreviewMode) {
        preview.textContent = value;
      }
    }

    function scheduleSend() {
      if (sendTimer) clearTimeout(sendTimer);
      sendTimer = setTimeout(async () => {
        const content = editor.value || '';
        if (content === lastContent) return;
        lastContent = content;
        await fetch('/doc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
        });
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
      if (!isPreviewMode) {
        render();
      }
      scheduleSend();
    });

    toggleButton.addEventListener('click', togglePreview);

    await loadMarkdownIt();
    const initial = await fetch('/doc');
    if (initial.ok) {
      const data = await initial.json();
      if (data && typeof data.content === "string") {
        editor.value = data.content;
        lastContent = data.content;
      }
    }

    let source = null;
    let reconnectTimer = null;

    function connectSSE() {
      if (source) { try { source.close(); } catch {} }
      source = new EventSource('/events');
      source.addEventListener('update', (event) => {
        try {
          const data = JSON.parse(event.data || '{}');
          if (typeof data.content === "string" && data.content !== editor.value) {
            editor.value = data.content;
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
      try {
        const res = await fetch('/doc');
        if (res.ok) {
          const data = await res.json();
          if (data && typeof data.content === 'string') {
            editor.value = data.content;
            lastContent = data.content;
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
        broadcastUpdate(session);
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
    res.write(`event: update\ndata: ${JSON.stringify(session.docState)}\n\n`);
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
      stream.emit("error", err);
    }
  })();
  return stream;
}

async function getJSONBody(uploadData, session) {
  if (!uploadData || uploadData.length === 0) {
    return {};
  }
  const stream = readBody(uploadData, session);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  try {
    return JSON.parse(buf.toString() || "{}");
  } catch {
    return {};
  }
}

export async function createHandler(session) {
  return async function protocolHandler(req, callback) {
    const { url, method, uploadData } = req;
    const urlObj = new URL(url);
    const action = urlObj.searchParams.get("action");

    if (urlObj.hostname !== "p2pmd") {
      sendText(callback, 404, "Unknown hs target");
      return;
    }

    if (method === "POST" && action === "create") {
      const body = await getJSONBody(uploadData, session);
      const secure = parseBoolean(body.secure, false);
      const udp = parseBoolean(body.udp, false);
      const host = normalizeHost(body.host);
      const port = normalizePort(body.port);
      console.log("[p2pmd] create request", { secure, udp, host, port });

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
      console.log("[p2pmd] holesail server ready");
      console.log("  Connection string for mobile:", roomKey);
      console.log("  DHT key:", holesailServer.info?.key);
      console.log("  Server info:", JSON.stringify(holesailServer.info, null, 2));
      console.log("  Stored on DHT: { host: '127.0.0.1', port:", boundPort, ", udp:", udp, "}");
      sessionState.key = roomKey;
      sessionState.holesailServer = holesailServer;
      // Extract seed from holesail-server so we can recreate with the same key later
      const serverSeed = holesailServer.dht?.seed ? holesailServer.dht.seed.toString("hex") : null;
      if (roomKey) {
        roomSessions.set(roomKey, sessionState);
        // Save port + seed now that we have the key
        roomPorts.set(roomKey, { port: boundPort, seed: serverSeed });
        savePortsToFile();
        console.log("[p2pmd] saved port+seed for room after create", { key: roomKey, port: boundPort, hasSeed: !!serverSeed });
      }
      console.log("[p2pmd] create ready", { key: roomKey, host: boundHost, port: boundPort, holesailInfo: holesailServer.info });

      const responseHost = getResponseHost(sessionState);
      sendJson(callback, 200, {
        key: roomKey,
        localHost: responseHost,
        localPort: boundPort,
        localUrl: `http://${responseHost}:${boundPort}`,
        secure,
        udp
      });
      return;
    }

    if (method === "POST" && action === "rehost") {
      const body = await getJSONBody(uploadData, session);
      const key = body.key || "";
      if (!key) {
        sendJson(callback, 400, { error: "Missing key" });
        return;
      }
      const parsedKey = Holesail.urlParser(key);
      const secure = body.secure === undefined ? parsedKey.secure === true : parseBoolean(body.secure, true);
      const udp = parseBoolean(body.udp, false);
      const host = normalizeHost(body.host);
      const port = normalizePort(body.port);
      const initialContent = typeof body.initialContent === "string" ? body.initialContent : "";
      console.log("[p2pmd] rehost request", { key, secure, udp, host, port, hasInitialContent: initialContent.length > 0 });

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
      
      // Pass 127.0.0.1 to holesail so clients connect to localhost
      // Holesail forwards tunnel traffic to this address, and stores it on DHT for clients
      const holesailServer = new Holesail({
        server: true,
        secure,
        udp,
        host: "127.0.0.1",
        port: boundPort,
        key,
        log: 1
      });
      await holesailServer.ready();
      const roomKey = holesailServer.info?.url || key;
      console.log("[p2pmd] rehost server ready - connection string:", roomKey);
      if (roomKey !== key) {
        roomSessions.delete(key);
      }
      sessionState.key = roomKey;
      sessionState.holesailServer = holesailServer;
      roomSessions.set(roomKey, sessionState);
      // Save seed for rehosted rooms so auto-rehost works after disconnect
      const serverSeed = holesailServer.dht?.seed ? holesailServer.dht.seed.toString("hex") : null;
      if (roomKey) {
        roomPorts.set(roomKey, { port: boundPort, seed: serverSeed });
        savePortsToFile();
      }
      console.log("[p2pmd] rehost ready", { key: roomKey, host: boundHost, port: boundPort, holesailInfo: holesailServer.info });

      const responseHost = getResponseHost(sessionState);
      sendJson(callback, 200, {
        key: roomKey,
        localHost: responseHost,
        localPort: boundPort,
        localUrl: `http://${responseHost}:${boundPort}`,
        secure,
        udp
      });
      return;
    }

    if (method === "POST" && action === "resume") {
      const body = await getJSONBody(uploadData, session);
      const key = body.key || "";
      const sessionState = key ? getExistingSession(key) : (roomSessions.size === 1 ? Array.from(roomSessions.values())[0] : null);
      if (!sessionState || !sessionState.server) {
        sendJson(callback, 404, { error: "No active room" });
        return;
      }
      const responseHost = getResponseHost(sessionState);
      sendJson(callback, 200, {
        key: sessionState.key,
        localHost: responseHost,
        localPort: sessionState.port,
        localUrl: `http://${responseHost}:${sessionState.port}`,
        secure: sessionState.holesailServer?.info?.secure,
        udp: sessionState.holesailServer?.info?.udp
      });
      return;
    }

    if (method === "POST" && action === "join") {
      const body = await getJSONBody(uploadData, session);
      const key = body.key || "";
      if (!key) {
        sendJson(callback, 400, { error: "Missing key" });
        return;
      }

      const parsedKey = Holesail.urlParser(key);
      const secure = body.secure === undefined ? null : parseBoolean(body.secure, true);
      const udp = body.udp === undefined ? null : parseBoolean(body.udp, false);
      const hostValue = typeof body.host === "string" ? body.host : "";
      const extractedPort = extractPort(hostValue);
      const portInput = normalizePort(body.port);
      const host = hostValue ? normalizeHost(hostValue) : null;
      const port = portInput || extractedPort || null;
      console.log("[p2pmd] join request", { key, secure, udp, host, port, bodyPort: body.port, portInput, extractedPort });

      // If this room already has a running holesail server, don't destroy it.
      // This happens when the page reloads after creating a room.
      let sessionState = getExistingSession(key);
      if (sessionState?.holesailServer && sessionState.server) {
        const responseHost = getResponseHost(sessionState);
        const localUrl = `http://${responseHost}:${sessionState.port}`;
        console.log("[p2pmd] join: server already running, returning existing info", { key, localUrl });
        sendJson(callback, 200, {
          key,
          localHost: responseHost,
          localPort: sessionState.port,
          localUrl
        });
        return;
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
        holesailServer.seed = savedEntry.seed;
        await holesailServer.ready();
        const rehostedKey = holesailServer.info?.url || key;
        if (rehostedKey !== key) {
          roomSessions.delete(key);
        }
        sessionState.key = rehostedKey;
        sessionState.holesailServer = holesailServer;
        roomSessions.set(rehostedKey, sessionState);
        console.log("[p2pmd] join: auto-rehosted existing room", { key: rehostedKey, port: boundPort, seedMatch: rehostedKey === key });
        const responseHost = getResponseHost(sessionState);
        sendJson(callback, 200, {
          key: sessionState.key,
          localHost: responseHost,
          localPort: boundPort,
          localUrl: `http://${responseHost}:${boundPort}`,
          secure: resolvedSecure,
          udp: resolvedUdp
        });
        return;
      }

      if (sessionState) {
        await stopHolesailServer(sessionState);
        await stopHolesailClient(sessionState);
        await stopDocServer(sessionState);
      } else {
        sessionState = createSession(key);
        roomSessions.set(key, sessionState);
      }
      const finalHost = host || "127.0.0.1";
      const { host: boundHost, port: boundPort } = await ensureDocServer(sessionState, finalHost, port, secure);
      
      // Pass 127.0.0.1 to holesail so it creates a local proxy on localhost
      const clientOptions = {
        client: true,
        key
      };
      if (secure !== null) clientOptions.secure = secure;
      if (udp !== null) clientOptions.udp = udp;
      clientOptions.host = "127.0.0.1";
      clientOptions.port = boundPort;
      clientOptions.log = 1;
      console.log("[p2pmd] join creating client", { clientOptions });
      const holesailClient = new Holesail(clientOptions);
      sessionState.holesailClient = holesailClient;
      await holesailClient.ready();
      console.log("[p2pmd] join client ready");
      console.log("  Client info:", JSON.stringify(holesailClient.info, null, 2));

      await new Promise(resolve => setTimeout(resolve, 500));

      const responseHost = getResponseHost(sessionState);
      const localUrl = `http://${responseHost}:${boundPort}`;
      console.log("[p2pmd] join ready", { key, localUrl, host: responseHost, port: boundPort });
      
      sendJson(callback, 200, {
        key,
        localHost: responseHost,
        localPort: boundPort,
        localUrl
      });
      return;
    }

    if (method === "POST" && action === "close") {
      const body = await getJSONBody(uploadData, session);
      const key = body.key || "";
      if (key) {
        const sessionState = getExistingSession(key);
        if (!sessionState) {
          sendJson(callback, 404, { error: "Room not found" });
          return;
        }
        await stopHolesailClient(sessionState);
        await stopHolesailServer(sessionState);
        await stopDocServer(sessionState);
        roomSessions.delete(key);
        sendJson(callback, 200, { ok: true });
        return;
      }
      for (const sessionState of roomSessions.values()) {
        await stopHolesailClient(sessionState);
        await stopHolesailServer(sessionState);
        await stopDocServer(sessionState);
      }
      roomSessions.clear();
      sendJson(callback, 200, { ok: true });
      return;
    }

    sendJson(callback, 404, { error: "Unknown action" });
  };
}
