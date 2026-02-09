import {
  markdownInput,
  createRoomButton,
  joinForm,
  joinRoomKey,
  privateMode,
  udpMode,
  localHostInput,
  localPortInput,
  setupPage,
  editorPage,
  roomStatus,
  roomKeyLabel,
  peersCount,
  localUrlLabel,
  exportMenu,
  exportHtmlButton,
  exportPdfButton,
  disconnectButton,
  protocolSelect,
  titleInput,
  publishButton,
  clearDraftButton,
  publishList,
  fetchCidInput,
  fetchButton,

} from "./common.js";
import { initMarkdown, renderPreview, scheduleRender, showSpinner, renderMarkdown } from "./noteEditor.js";

let sendTimer = null;
let saveTimer = null;
let eventSource = null;
let lastSentContent = "";
let lastSavedContent = "";
let currentRoomUrl = null;
let currentRoomKey = null;
let hyperdriveUrl = null;
let draftDriveUrl = null;
let lastDraftPayload = null;
let didSeedContent = false;
let justCreatedRoom = false;

const ROOM_STATE_PREFIX = "p2pmd-room-";
const ROOM_CONTENT_PREFIX = "p2pmd-room-content-";
const LAST_ROOM_KEY = "p2pmd-last-room";
const LAST_ROOM_STATE = "p2pmd-last-room-state";
const DRAFT_DRIVE_NAME = "p2pmd-drafts";
const saveDelay = 2000;
let hyperSaveInFlight = false;
let draftSaveInFlight = false;

const publishCSS = `
  :root {
    color-scheme: light;
  }
  html,
  body {
    margin: 0;
    padding: 0;
    background: #ffffff;
    color: #111111;
  }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    line-height: 1.6;
    padding: 2rem;
  }
  pre, code {
    background: #f3f4f6;
    padding: 0.15rem 0.35rem;
    border-radius: 6px;
  }
  pre code {
    display: block;
    padding: 1rem;
    overflow: auto;
  }
  blockquote {
    border-left: 3px solid #d1d5db;
    padding-left: 1rem;
    color: #374151;
  }
  footer.p2pmd-footer {
    margin-top: 2rem;
    font-size: 0.9rem;
    color: #4b5563;
  }
  footer.p2pmd-footer a {
    color: inherit;
  }
`;

function fetchWithTimeout(url, options = {}, timeoutMs = 2000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  const merged = { ...options, signal: controller.signal };
  return fetch(url, merged).finally(() => clearTimeout(id));
}

async function pingServerStatus(localUrl, attempts = 5) {
  let retries = attempts;
  while (retries > 0) {
    try {
      const res = await fetchWithTimeout(`${localUrl}/status`, {}, 1500);
      if (res.ok) return true;
    } catch {}
    retries--;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

function safeLocalStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function safeLocalStorageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

const urlParams = new URLSearchParams(window.location.search);
const paramProtocol = urlParams.get("protocol");
const storedProtocol = safeLocalStorageGet("lastProtocol");
const initialProtocol = paramProtocol || storedProtocol || "hyper";
if (protocolSelect) {
  protocolSelect.value = initialProtocol;
}

function hasMeaningfulContent(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function saveRoomDraft(roomKey, content) {
  if (!roomKey) return;
  const payload = typeof content === "string" ? content : "";
  safeLocalStorageSet(`${ROOM_CONTENT_PREFIX}${roomKey}`, payload);
}

function loadRoomDraft(roomKey) {
  if (!roomKey) return "";
  return safeLocalStorageGet(`${ROOM_CONTENT_PREFIX}${roomKey}`) || "";
}

function getDraftFileName(roomKey) {
  if (!roomKey) return null;
  const safeKey = roomKey.replace(/[^a-z0-9]+/gi, "_");
  return `${safeKey}.json`;
}

async function getDraftDriveUrl() {
  if (!draftDriveUrl) {
    const cached = safeLocalStorageGet("p2pmd:draftDriveUrl");
    if (cached) {
      draftDriveUrl = cached;
      return draftDriveUrl;
    }
    const response = await fetchWithTimeout(
      `hyper://localhost/?key=${encodeURIComponent(DRAFT_DRIVE_NAME)}`,
      { method: "POST" },
      2000
    );
    if (!response.ok) {
      throw new Error(`Failed to generate Hyperdrive key: ${response.statusText}`);
    }
    draftDriveUrl = await response.text();
    safeLocalStorageSet("p2pmd:draftDriveUrl", draftDriveUrl);
  }
  return draftDriveUrl;
}

function buildDraftPayload(content) {
  const payload = {
    content: typeof content === "string" ? content : "",
    updatedAt: Date.now(),
    roomKey: currentRoomKey || null
  };
  if (titleInput) payload.title = titleInput.value;
  if (protocolSelect) payload.protocol = protocolSelect.value;
  return payload;
}

async function writeDraft(payload, roomKey) {
  const driveUrl = await getDraftDriveUrl();
  const fileName = getDraftFileName(roomKey);
  if (!driveUrl || !fileName) return;
  const url = `${driveUrl}${fileName}`;
  const response = await fetchWithTimeout(
    url,
    {
      method: "PUT",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" }
    },
    2000
  );
  if (!response.ok) {
    throw new Error(`Failed to save draft: ${response.statusText}`);
  }
}

async function saveDraft({ force = false } = {}) {
  if (!currentRoomKey) return;
  if (draftSaveInFlight && !force) return;
  try {
    const payload = buildDraftPayload(markdownInput.value || "");
    const serialized = JSON.stringify(payload);
    if (!force && serialized === lastDraftPayload) {
      return;
    }
    draftSaveInFlight = true;
    lastDraftPayload = serialized;
    await writeDraft(payload, currentRoomKey);
  } catch (error) {
    console.error("[saveDraft] Error saving draft:", error);
  } finally {
    draftSaveInFlight = false;
  }
}

async function loadDraftFromHyperdrive(roomKey) {
  let retries = 3;
  while (retries > 0) {
    try {
      const driveUrl = await getDraftDriveUrl();
      const fileName = getDraftFileName(roomKey);
      if (!driveUrl || !fileName) return "";
      const url = `${driveUrl}${fileName}`;
      const response = await fetchWithTimeout(url, {}, 3000);
      if (!response.ok) {
        if (response.status === 404) {
          return "";
        }
        retries--;
        if (retries > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        return "";
      }
      const data = await response.json();
      if (!data || data.isCleared) return "";
      if (typeof data.title === "string" && titleInput) {
        titleInput.value = data.title;
      }
      if (typeof data.protocol === "string" && protocolSelect && !paramProtocol) {
        protocolSelect.value = data.protocol;
        safeLocalStorageSet("lastProtocol", data.protocol);
        toggleTitleInput();
        updateSelectorURL();
      }
      if (typeof data.content === "string") {
        lastDraftPayload = JSON.stringify(data);
        return data.content;
      }
      return "";
    } catch (error) {
      console.error("[loadDraft] Error loading draft:", error);
      retries--;
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        return "";
      }
    }
  }
  return "";
}

async function clearDraft() {
  if (!currentRoomKey) return;
  const fileName = getDraftFileName(currentRoomKey);
  try {
    const driveUrl = await getDraftDriveUrl();
    const url = `${driveUrl}${fileName}`;
    const response = await fetchWithTimeout(url, { method: "DELETE" }, 2000);
    if (response.ok || response.status === 404) {
      return;
    }
  } catch (error) {
    console.error("[clearDraft] Error deleting draft:", error);
  }
  try {
    const payload = { isCleared: true, clearedAt: Date.now(), roomKey: currentRoomKey };
    lastDraftPayload = JSON.stringify(payload);
    await writeDraft(payload, currentRoomKey);
  } catch (error) {
    console.error("[clearDraft] Error saving cleared draft:", error);
  }
}

function normalizeHost(value) {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    if (trimmed.includes("://")) {
      const parsed = new URL(trimmed);
      return parsed.hostname || "";
    }
  } catch {}
  if (trimmed.includes("/")) {
    return trimmed.split("/")[0] || "";
  }
  if (trimmed.includes(":")) {
    return trimmed.split(":")[0] || "";
  }
  return trimmed;
}

function normalizePort(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
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

function parseLocalUrl(value) {
  if (!value || typeof value !== "string") return { host: null, port: null };
  const trimmed = value.trim();
  if (!trimmed) return { host: null, port: null };
  try {
    const parsed = new URL(trimmed);
    return {
      host: parsed.hostname || null,
      port: normalizePort(parsed.port, null)
    };
  } catch {}
  if (trimmed.includes(":")) {
    const [host, port] = trimmed.split(":");
    return { host: host || null, port: normalizePort(port, null) };
  }
  return { host: trimmed, port: null };
}

function normalizeRoomKey(key) {
  if (!key || typeof key !== "string") return "";
  return key.trim();
}

function getRoomKeyValue(key) {
  const trimmed = normalizeRoomKey(key);
  if (!trimmed) return "";
  return trimmed.startsWith("hs://") ? trimmed.slice(5) : trimmed;
}

function validateRoomKey(key) {
  const baseKey = getRoomKeyValue(key);
  if (baseKey.length < 32) {
    alert("Error: ID must be at least 32-bytes long");
    return false;
  }
  return true;
}

function getRoomKeyCandidates(key) {
  const trimmed = normalizeRoomKey(key);
  if (!trimmed) return [];
  const candidates = new Set([trimmed]);
  if (trimmed.startsWith("hs://")) {
    candidates.add(trimmed.slice(5));
  } else {
    candidates.add(`hs://${trimmed}`);
  }
  return Array.from(candidates).filter(Boolean);
}

function isSameRoomKey(a, b) {
  if (!a || !b) return false;
  const setA = new Set(getRoomKeyCandidates(a));
  for (const candidate of getRoomKeyCandidates(b)) {
    if (setA.has(candidate)) return true;
  }
  return false;
}

function updateRoomUrl(state) {
  const params = new URLSearchParams(window.location.search);
  if (state?.key) {
    params.set("roomKey", normalizeRoomKey(state.key));
    if (state.localUrl) params.set("localUrl", state.localUrl);
    if (typeof state.secure === "boolean") params.set("secure", String(state.secure));
    if (typeof state.udp === "boolean") params.set("udp", String(state.udp));
    if (state.host) params.set("host", state.host);
    if (state.port) params.set("port", String(state.port));
  } else {
    params.delete("roomKey");
    params.delete("localUrl");
    params.delete("secure");
    params.delete("udp");
    params.delete("host");
    params.delete("port");
  }
  const base = window.location.pathname + window.location.hash;
  const query = params.toString();
  const nextUrl = query ? `${base}?${query}` : base;
  history.replaceState(null, "", nextUrl);
}

function readRoomStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const key = normalizeRoomKey(params.get("roomKey") || "");
  if (!key) return null;
  return {
    key,
    localUrl: params.get("localUrl") || "",
    secure: params.get("secure") === "true",
    udp: params.get("udp") === "true",
    host: params.get("host") || "",
    port: normalizePort(params.get("port"), null)
  };
}

function readRoomStateFromStorage(key) {
  const candidates = getRoomKeyCandidates(key);
  if (candidates.length === 0) return null;
  for (const candidate of candidates) {
    const raw = safeLocalStorageGet(`${ROOM_STATE_PREFIX}${candidate}`);
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch {
      continue;
    }
  }
  return null;
}

function readLastRoomState() {
  const raw = safeLocalStorageGet(LAST_ROOM_STATE);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeRoomState(state) {
  if (!state || typeof state !== "object") return null;
  const normalized = { ...state };
  if (normalized.hosted === undefined && typeof normalized.isHosted === "boolean") {
    normalized.hosted = normalized.isHosted;
  }
  if (normalized.creator === undefined && normalized.hosted === true) {
    normalized.creator = true;
  }
  return normalized;
}

function resolveRoomState(key) {
  const stored = normalizeRoomState(readRoomStateFromStorage(key));
  if (stored) return stored;
  const last = normalizeRoomState(readLastRoomState());
  if (last?.key && isSameRoomKey(last.key, key)) return last;
  return null;
}

function persistRoomState(state) {
  if (!state?.key) return;
  const normalized = normalizeRoomState(state);
  if (!normalized) return;
  const payload = JSON.stringify(normalized);
  const candidates = getRoomKeyCandidates(normalized.key);
  for (const candidate of candidates) {
    safeLocalStorageSet(`${ROOM_STATE_PREFIX}${candidate}`, payload);
  }
  safeLocalStorageSet(LAST_ROOM_KEY, normalizeRoomKey(normalized.key));
  safeLocalStorageSet(LAST_ROOM_STATE, payload);
}

export function scheduleSend() {
  if (!currentRoomUrl) return;
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = setTimeout(async () => {
    const content = markdownInput.value;
    if (content === lastSentContent) return;
    lastSentContent = content;
    try {
      await fetch(`${currentRoomUrl}/doc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content })
      });
    } catch {
      updatePeers(0);
    } finally {
      scheduleDraftSave();
    }
  }, 200);
}

async function postContentNow() {
  if (!currentRoomUrl) return;
  const content = markdownInput.value;
  lastSentContent = content;
  try {
    await fetch(`${currentRoomUrl}/doc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    scheduleDraftSave();
  } catch {
    updatePeers(0);
  }
}

async function getRoomStorageUrl(roomKey) {
  if (!roomKey) return null;
  if (!hyperdriveUrl) {
    try {
      const cached = safeLocalStorageGet("p2pmd:hyperdriveUrl");
      if (cached) {
        hyperdriveUrl = cached;
      } else {
        const response = await fetchWithTimeout(
          `hyper://localhost/?key=${encodeURIComponent("p2pmd")}`,
          { method: "POST" },
          2000
        );
        if (!response.ok) {
          throw new Error(`Failed to generate Hyperdrive key: ${response.statusText}`);
        }
        hyperdriveUrl = await response.text();
        safeLocalStorageSet("p2pmd:hyperdriveUrl", hyperdriveUrl);
      }
    } catch {
      return null;
    }
  }
  const base = hyperdriveUrl.endsWith("/") ? hyperdriveUrl : `${hyperdriveUrl}/`;
  const safeKey = roomKey.replace(/[^a-z0-9]+/gi, "_");
  return `${base}rooms/${safeKey}.md`;
}

async function loadRoomFromHyperdrive(roomKey) {
  try {
    const url = await getRoomStorageUrl(roomKey);
    if (!url) return "";
    const response = await fetchWithTimeout(url, {}, 2000);
    if (!response.ok) return "";
    return await response.text();
  } catch {
    return "";
  }
}

async function saveRoomToHyperdrive(roomKey, content) {
  if (hyperSaveInFlight) return;
  try {
    const url = await getRoomStorageUrl(roomKey);
    if (!url) return;
    const payload = typeof content === "string" ? content : "";
    if (payload === lastSavedContent) return;
    hyperSaveInFlight = true;
    const file = new File([payload], "document.md", { type: "text/markdown" });
    const response = await fetchWithTimeout(
      url,
      {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "text/markdown" }
      },
      5000
    );
    if (response.ok) {
      lastSavedContent = payload;
    }
  } catch {} finally {
    hyperSaveInFlight = false;
  }
}

export function scheduleDraftSave() {
  if (!currentRoomKey) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const payload = markdownInput.value || "";
    saveRoomDraft(currentRoomKey, payload);
    saveRoomToHyperdrive(currentRoomKey, payload);
    saveDraft();
  }, saveDelay);
}

function updatePeers(count) {
  peersCount.textContent = Number.isFinite(count) ? String(count) : "0";
}

function updateRoomStatus({ key, localUrl }) {
  roomKeyLabel.textContent = key || "";
  localUrlLabel.textContent = localUrl || "";
  if (localUrl) {
    localUrlLabel.href = localUrl;
  } else {
    localUrlLabel.removeAttribute("href");
  }
  roomStatus.classList.remove("hidden");
  setView("editor");
}

async function connectToRoom(localUrl, role = "client") {
  currentRoomUrl = localUrl;
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  let hasRoomSnapshot = false;
  let snapshotContent = "";
  let serverHadMeaningful = false;
  let usedFallback = false;
  didSeedContent = false;
  
  await pingServerStatus(localUrl, 5);
  
  let retries = 5;
  while (retries > 0) {
    try {
      const response = await fetchWithTimeout(`${localUrl}/doc`, {}, 3000);
      if (response.ok) {
        const data = await response.json();
        if (typeof data.content === "string") {
          snapshotContent = data.content;
          hasRoomSnapshot = hasMeaningfulContent(snapshotContent);
          serverHadMeaningful = hasRoomSnapshot;
        }
        break;
      }
    } catch (err) {
      retries--;
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        updatePeers(0);
      }
    }
  }

  if (!hasRoomSnapshot && currentRoomKey) {
    const roomKey = currentRoomKey;
    const draftContent = await loadDraftFromHyperdrive(roomKey);
    let fallbackContent = draftContent;
    if (!hasMeaningfulContent(fallbackContent)) {
      fallbackContent = await loadRoomFromHyperdrive(roomKey);
    }
    if (!hasMeaningfulContent(fallbackContent)) {
      fallbackContent = loadRoomDraft(roomKey);
    }
    if (hasMeaningfulContent(fallbackContent)) {
      snapshotContent = fallbackContent;
      hasRoomSnapshot = true;
      usedFallback = true;
    }
  }

  if (snapshotContent !== markdownInput.value) {
    markdownInput.value = snapshotContent;
    renderPreview();
    if (hasRoomSnapshot && (!serverHadMeaningful || role === "host")) {
      await postContentNow();
      didSeedContent = true;
    }
  }

  try {
    eventSource = new EventSource(`${localUrl}/events?role=${encodeURIComponent(role)}`);
    eventSource.addEventListener("update", (event) => {
      try {
        const data = JSON.parse(event.data || "{}");
        const incoming = typeof data.content === "string" ? data.content : "";
        const incomingMeaningful = hasMeaningfulContent(incoming);
        const localMeaningful = hasMeaningfulContent(markdownInput.value);
        if (incomingMeaningful && incoming !== markdownInput.value) {
          markdownInput.value = incoming;
          renderPreview();
          scheduleDraftSave();
        } else if (!incomingMeaningful && usedFallback && localMeaningful && !didSeedContent) {
          postContentNow().then(() => {
            didSeedContent = true;
          });
        }
      } catch {}
    });
    eventSource.addEventListener("peers", (event) => {
      updatePeers(Number(event.data));
    });
    eventSource.onerror = () => {
      updatePeers(0);
    };
  } catch {
    updatePeers(0);
  }
}

async function createRoom() {
  const host = normalizeHost(localHostInput.value);
  const port = normalizePort(localPortInput.value, null);
  const payload = {
    secure: privateMode.checked,
    udp: udpMode.checked,
    host,
    port
  };
  console.log("[p2pmd] create payload", payload);
  resetNetworkSettingsOnCreate();
  showSpinner(true);
  try {
    const response = await fetch("hs://p2pmd?action=create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data.localUrl) {
      throw new Error(data.error || "Failed to create room");
    }
    currentRoomKey = data.key || null;
    currentRoomUrl = data.localUrl;
    justCreatedRoom = true;
    updateRoomStatus({ key: data.key, localUrl: data.localUrl });
    const state = {
      key: data.key,
      localUrl: data.localUrl,
      secure: data.secure,
      udp: data.udp,
      host: data.localHost,
      port: data.localPort,
      hosted: true,
      creator: true
    };
    persistRoomState(state);
    updateRoomUrl(state);
    // Don't call joinRoom - server is already running from create action
    // Just connect to SSE and post initial content
    await connectToRoom(data.localUrl, "host");
    await postContentNow();
    scheduleDraftSave();
    // Clear flag after a short delay to allow auto-join on real page reloads
    setTimeout(() => { justCreatedRoom = false; }, 2000);
  } catch (error) {
    alert(error.message || "Failed to create room");
  } finally {
    showSpinner(false);
  }
}

async function joinRoomWithOptions(key, options) {
  const payload = {
    key,
    secure: options.secure,
    udp: options.udp
  };
  if (options.host) payload.host = options.host;
  if (options.port !== null && options.port !== undefined) payload.port = options.port;
  const response = await fetch("hs://p2pmd?action=join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || !data.localUrl) {
    throw new Error(data.error || "Failed to join room");
  }
  return data;
}

async function rehostRoom(key, state) {
  let initialContent = "";
  try {
    initialContent = await loadDraftFromHyperdrive(key);
    if (!hasMeaningfulContent(initialContent)) {
      initialContent = await loadRoomFromHyperdrive(key);
    }
    if (!hasMeaningfulContent(initialContent)) {
      initialContent = loadRoomDraft(key);
    }
  } catch {}

  const payload = {
    key,
    secure: state.secure,
    udp: state.udp,
    initialContent
  };
  
  // Only include host if it's not empty
  const normalizedHost = state.host ? normalizeHost(state.host) : "";
  if (normalizedHost && normalizedHost !== "") {
    payload.host = normalizedHost;
  }
  
  if (state.port !== null && state.port !== undefined) {
    payload.port = state.port;
  }
  const response = await fetch("hs://p2pmd?action=rehost", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || !data.localUrl) {
    throw new Error(data.error || "Failed to rehost room");
  }
  return data;
}

function buildJoinOptions(state) {
  const urlParts = parseLocalUrl(state.localUrl);
  
  // Get normalized hosts, filtering out empty strings
  const stateHost = state.host ? normalizeHost(state.host) : null;
  const urlHost = urlParts.host ? normalizeHost(urlParts.host) : null;
  const inputHost = normalizeHost(localHostInput.value);
  
  // Use the first non-empty host, or undefined if all are empty
  const host = (stateHost && stateHost !== "") ? stateHost :
               (urlHost && urlHost !== "") ? urlHost :
               (inputHost && inputHost !== "") ? inputHost :
               undefined;
  
  const extractedPort = extractPort(localHostInput.value);
  
  let port = null;
  if (state.port !== null && state.port !== undefined && state.port > 0) {
    port = state.port;
  } else if (urlParts.port) {
    port = urlParts.port;
  } else if (localPortInput.value) {
    port = normalizePort(localPortInput.value, extractedPort || null);
  }
  
  console.log("[p2pmd] buildJoinOptions", { 
    statePort: state.port, 
    urlPartsPort: urlParts.port, 
    finalPort: port, 
    host,
    state 
  });
  
  // Only include host if it's not empty
  const options = {
    secure: typeof state.secure === "boolean" ? state.secure : undefined,
    udp: typeof state.udp === "boolean" ? state.udp : undefined
  };
  
  if (host) {
    options.host = host;
  }
  
  if (port !== null && port !== undefined) {
    options.port = port;
  }
  
  return options;
}

async function joinRoom(key, state = {}) {
  showSpinner(true);
  const storedState = resolveRoomState(key) || {};
  // Merge stored state with passed state so hosted/creator flags from storage
  // are preserved even when the URL state doesn't include them (e.g. on restart)
  const resolvedState = { ...storedState, ...(state || {}) };
  console.log("[p2pmd] joinRoom", { key, storedState, resolvedState });
  const baseOptions = buildJoinOptions(resolvedState);
  const attempts = [baseOptions];
  let lastError = null;
  try {
    const shouldRehost = Boolean(resolvedState.hosted || resolvedState.isHosted || resolvedState.creator);
    if (shouldRehost) {
      try {
        const data = await rehostRoom(key, resolvedState);
        currentRoomKey = data.key || key;
        updateRoomStatus({ key, localUrl: data.localUrl });
        const nextState = {
          key,
          localUrl: data.localUrl,
          secure: typeof data.secure === "boolean" ? data.secure : resolvedState.secure,
          udp: typeof data.udp === "boolean" ? data.udp : resolvedState.udp,
          host: data.localHost || resolvedState.host,
          port: data.localPort || resolvedState.port,
          hosted: true,
          creator: true
        };
        localHostInput.value = nextState.host || "";
        localPortInput.value = nextState.port || "";
        if (typeof nextState.secure === "boolean") privateMode.checked = nextState.secure;
        if (typeof nextState.udp === "boolean") udpMode.checked = nextState.udp;
        persistRoomState(nextState);
        updateRoomUrl(nextState);
        await connectToRoom(data.localUrl, "host");
        scheduleDraftSave();
        return;
      } catch (error) {
        console.error("[p2pmd] rehost failed", error);
        lastError = error;
      }
    }
    for (const options of attempts) {
      try {
        const data = await joinRoomWithOptions(key, options);
        currentRoomKey = data.key || key;
        updateRoomStatus({ key, localUrl: data.localUrl });
        const nextState = {
          key,
          localUrl: data.localUrl,
          secure: typeof data.secure === "boolean" ? data.secure : options.secure,
          udp: typeof data.udp === "boolean" ? data.udp : options.udp,
          host: data.localHost || options.host,
          port: data.localPort || options.port,
          hosted: false,
          creator: Boolean(resolvedState.creator || resolvedState.hosted || resolvedState.isHosted)
        };
        localHostInput.value = nextState.host || "";
        localPortInput.value = nextState.port || "";
        if (typeof nextState.secure === "boolean") privateMode.checked = nextState.secure;
        if (typeof nextState.udp === "boolean") udpMode.checked = nextState.udp;
        persistRoomState(nextState);
        updateRoomUrl(nextState);
        await connectToRoom(data.localUrl, "client");
        scheduleDraftSave();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Failed to join room");
  } catch (error) {
    alert(error.message || "Failed to join room");
  } finally {
    showSpinner(false);
  }
}

async function disconnectRoom() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  const key = currentRoomKey;
  if (key) {
    try {
      await fetch("hs://p2pmd?action=close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key })
      });
    } catch {}
  }
  currentRoomUrl = null;
  currentRoomKey = null;
  updatePeers(0);
  roomStatus.classList.add("hidden");
  updateRoomUrl(null);
  setView("setup");
}

function toggleTitleInput() {
  if (protocolSelect.value === "hyper") {
    titleInput.classList.remove("hidden");
    titleInput.setAttribute("required", "");
  } else {
    titleInput.classList.add("hidden");
    titleInput.removeAttribute("required");
  }
}

function updateSelectorURL() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  if (view === "setup") {
    params.delete("protocol");
  } else {
    params.set("protocol", protocolSelect.value);
  }
  const base = window.location.pathname + window.location.hash;
  const query = params.toString();
  const nextUrl = query ? `${base}?${query}` : base;
  history.replaceState(null, "", nextUrl);
}

async function getOrCreateHyperdrive() {
  if (!hyperdriveUrl) {
    const name = "p2pmd";
    try {
      const response = await fetch(`hyper://localhost/?key=${encodeURIComponent(name)}`, { method: "POST" });
      console.log(`[getOrCreateHyperdrive] Response status: ${response.status}, ok: ${response.ok}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[getOrCreateHyperdrive] Error response: ${errorText}`);
        throw new Error(`Failed to generate Hyperdrive key: ${response.statusText}`);
      }
      hyperdriveUrl = await response.text();
      console.log(`[getOrCreateHyperdrive] Hyperdrive URL: ${hyperdriveUrl}`);
      if (!hyperdriveUrl || !hyperdriveUrl.startsWith("hyper://")) {
        throw new Error(`Invalid hyperdrive URL received: ${hyperdriveUrl}`);
      }
    } catch (error) {
      console.error("[getOrCreateHyperdrive] Error generating Hyperdrive key:", error);
      throw error;
    }
  }
  return hyperdriveUrl;
}

function buildPublishHtml(markdown) {
  const rendered = renderMarkdown(markdown || "");
  const footer = `<footer class="p2pmd-footer">Made by <a href="https://github.com/p2plabsxyz/p2pmd" target="_blank" rel="noopener noreferrer">p2pmd</a> and published with <a href="https://peersky.p2plabs.xyz/" target="_blank" rel="noopener noreferrer">PeerSky</a>.</footer>`;
  return `<!DOCTYPE html>
<html lang="en" style="background:#ffffff;color:#111111">
<head>
  <meta charset="utf-8">
  <title>p2pmd document</title>
  <style>${publishCSS}</style>
</head>
<body style="background:#ffffff;color:#111111">
  ${rendered}
  ${footer}
</body>
</html>`;
}

function normalizeFileBase(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "p2pmd-document";
  const normalized = trimmed
    .replace(/^hs:\/\//i, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || "p2pmd-document";
}

function getExportFileName(extension) {
  const title = titleInput?.value?.trim() || "";
  const base = title || currentRoomKey || "p2pmd-document";
  return `${normalizeFileBase(base)}.${extension}`;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportAsHtml() {
  const html = buildPublishHtml(markdownInput.value);
  const fileName = getExportFileName("html");
  const blob = new Blob([html], { type: "text/html" });
  triggerDownload(blob, fileName);
  if (exportMenu?.open) exportMenu.open = false;
}

function exportToPdf() {
  const html = buildPublishHtml(markdownInput.value);
  const fileName = getExportFileName("pdf");
  if (window.peersky?.printToPdf) {
    window.peersky.printToPdf(html, fileName).finally(() => {
      if (exportMenu?.open) exportMenu.open = false;
    });
    return;
  }
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const printWindow = window.open(url, "_blank");
  if (!printWindow) {
    const frame = document.createElement("iframe");
    frame.style.position = "fixed";
    frame.style.left = "-10000px";
    frame.style.top = "0";
    frame.style.width = "1200px";
    frame.style.height = "1600px";
    frame.style.border = "0";
    frame.style.pointerEvents = "none";
    let cleanupCalled = false;
    const cleanup = () => {
      if (cleanupCalled) return;
      cleanupCalled = true;
      frame.remove();
      URL.revokeObjectURL(url);
      if (exportMenu?.open) exportMenu.open = false;
    };
    frame.onload = () => {
      setTimeout(() => {
        try {
          const win = frame.contentWindow;
          win?.addEventListener("afterprint", cleanup);
          win?.focus();
          win?.print();
        } catch {}
      }, 200);
    };
    document.body.appendChild(frame);
    const frameDoc = frame.contentWindow?.document;
    if (!frameDoc) {
      cleanup();
      return;
    }
    frameDoc.open();
    frameDoc.write(html);
    frameDoc.close();
    if (exportMenu?.open) exportMenu.open = false;
    setTimeout(cleanup, 4000);
    return;
  }
  const cleanup = () => {
    URL.revokeObjectURL(url);
    try {
      printWindow.close();
    } catch {}
    if (exportMenu?.open) exportMenu.open = false;
  };
  printWindow.addEventListener("load", () => {
    setTimeout(() => {
      try {
        printWindow.addEventListener("afterprint", cleanup);
        printWindow.focus();
        printWindow.print();
      } catch {
        cleanup();
      }
    }, 200);
  });
}

function addPublishUrl(url) {
  const listItem = document.createElement("li");
  const link = document.createElement("a");
  link.href = url;
  link.textContent = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";

  const copyContainer = document.createElement("span");
  copyContainer.textContent = "⊕";
  copyContainer.onclick = async function () {
    let success = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        success = true;
      } else {
        throw new Error("Clipboard API unavailable");
      }
    } catch (err) {
      console.warn("Clipboard API failed, attempting fallback...", err);
      const textArea = document.createElement("textarea");
      textArea.value = url;
      textArea.style.position = "fixed";
      textArea.style.left = "-9999px";
      document.body.appendChild(textArea);
      textArea.select();
      try {
        success = document.execCommand("copy");
      } catch (e) {
        console.error("Fallback copy failed:", e);
      }
      document.body.removeChild(textArea);
    }

    if (success) {
      copyContainer.textContent = " Copied!";
      setTimeout(() => {
        copyContainer.textContent = "⊕";
      }, 1000);
    }
  };
  listItem.append(link, copyContainer);
  publishList.appendChild(listItem);
}

function addPublishError(name, text) {
  console.log(`[addPublishError] Error in ${name}: ${text}`);
  const listItem = document.createElement("li");
  listItem.className = "log";
  listItem.textContent = `Error in ${name}: ${text}`;
  publishList.appendChild(listItem);
}

async function publishDocument() {
  console.log("[p2pmd] publish start", { protocol: protocolSelect.value });
  const protocol = protocolSelect.value;
  let fileName = "index.html";
  if (protocol === "hyper") {
    const title = titleInput.value.trim();
    if (!title) {
      alert("Please enter a title for your document.");
      return;
    }
    fileName = `${title.replace(/\s+/g, "-").toLowerCase()}.html`;
  }

  showSpinner(true);
  try {
    const html = buildPublishHtml(markdownInput.value);
    const blob = new Blob([html], { type: "text/html" });
    const file = new File([blob], fileName, { type: "text/html" });
    await uploadFile(file);
  } catch (error) {
    alert(error.message || "Failed to publish");
  } finally {
    showSpinner(false);
  }
}

async function uploadFile(file) {
  const protocol = protocolSelect.value;
  console.log(`[uploadFile] Uploading ${file.name}, protocol: ${protocol}`);

  let url;
  if (protocol === "hyper") {
    const hyperdriveUrl = await getOrCreateHyperdrive();
    url = `${hyperdriveUrl}${encodeURIComponent(file.name)}`;
    console.log(`[uploadFile] Hyper URL: ${url}`);
  } else {
    url = `ipfs://bafyaabakaieac/${encodeURIComponent(file.name)}`;
    console.log(`[uploadFile] IPFS URL: ${url}`);
  }

  try {
    const response = await fetchWithTimeout(url, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type || "text/html" }
    }, 15000);

    console.log(`[uploadFile] Response status: ${response.status}, ok: ${response.ok}`);
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[uploadFile] Error uploading ${file.name}: ${errorText}`);
      addPublishError(file.name, errorText);
      return;
    }

    const finalUrl = protocol === "hyper" ? url : response.headers.get("Location");
    if (finalUrl) {
      addPublishUrl(finalUrl);
    }
  } catch (error) {
    console.error(`[uploadFile] Error uploading ${file.name}:`, error);
    addPublishError(file.name, error.message);
  }
}

function extractMarkdownFromHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  
  // Helper function to convert HTML elements to markdown
  function htmlToMarkdown(element) {
    if (!element) return "";
    
    let result = "";
    
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toLowerCase();
        
        switch (tag) {
          case "h1":
            result += `# ${node.textContent.trim()}\n\n`;
            break;
          case "h2":
            result += `## ${node.textContent.trim()}\n\n`;
            break;
          case "h3":
            result += `### ${node.textContent.trim()}\n\n`;
            break;
          case "h4":
            result += `#### ${node.textContent.trim()}\n\n`;
            break;
          case "h5":
            result += `##### ${node.textContent.trim()}\n\n`;
            break;
          case "h6":
            result += `###### ${node.textContent.trim()}\n\n`;
            break;
          case "p":
            result += `${htmlToMarkdown(node)}\n\n`;
            break;
          case "strong":
          case "b":
            result += `**${node.textContent.trim()}**`;
            break;
          case "em":
          case "i":
            result += `*${node.textContent.trim()}*`;
            break;
          case "code":
            // Check if it's inside a pre tag (code block)
            if (node.parentElement?.tagName.toLowerCase() === "pre") {
              result += `\`\`\`\n${node.textContent}\n\`\`\`\n\n`;
            } else {
              result += `\`${node.textContent}\``;
            }
            break;
          case "pre":
            // Check if it has a code child
            const codeChild = node.querySelector("code");
            if (codeChild) {
              result += `\`\`\`\n${codeChild.textContent}\n\`\`\`\n\n`;
            } else {
              result += `\`\`\`\n${node.textContent}\n\`\`\`\n\n`;
            }
            break;
          case "ul":
            for (const li of node.querySelectorAll(":scope > li")) {
              result += `- ${htmlToMarkdown(li).trim()}\n`;
            }
            result += "\n";
            break;
          case "ol":
            let index = 1;
            for (const li of node.querySelectorAll(":scope > li")) {
              result += `${index}. ${htmlToMarkdown(li).trim()}\n`;
              index++;
            }
            result += "\n";
            break;
          case "li":
            // Already handled in ul/ol
            result += htmlToMarkdown(node);
            break;
          case "a":
            const href = node.getAttribute("href");
            const text = node.textContent.trim();
            if (href && text) {
              result += `[${text}](${href})`;
            } else {
              result += text;
            }
            break;
          case "img":
            const src = node.getAttribute("src");
            const alt = node.getAttribute("alt") || "";
            if (src) {
              result += `![${alt}](${src})`;
            }
            break;
          case "blockquote":
            const lines = htmlToMarkdown(node).trim().split("\n");
            result += lines.map(line => `> ${line}`).join("\n") + "\n\n";
            break;
          case "hr":
            result += "---\n\n";
            break;
          case "br":
            result += "\n";
            break;
          case "table":
            // Basic table support
            const rows = node.querySelectorAll("tr");
            if (rows.length > 0) {
              for (let i = 0; i < rows.length; i++) {
                const cells = rows[i].querySelectorAll("td, th");
                const cellTexts = Array.from(cells).map(cell => cell.textContent.trim());
                result += `| ${cellTexts.join(" | ")} |\n`;
                
                // Add separator after header row
                if (i === 0 && rows[i].querySelector("th")) {
                  result += `| ${cellTexts.map(() => "---").join(" | ")} |\n`;
                }
              }
              result += "\n";
            }
            break;
          case "footer":
            // Skip footer elements (like the p2pmd footer)
            if (node.classList.contains("p2pmd-footer")) {
              break;
            }
            // Fall through for other footers
          default:
            // For other elements, just process their children
            result += htmlToMarkdown(node);
        }
      }
    }
    
    return result;
  }
  
  // First check if the body contains our rendered markdown structure
  const body = doc.body;
  if (body) {
    // Remove the p2pmd footer if present
    const footer = body.querySelector("footer.p2pmd-footer");
    if (footer) {
      footer.remove();
    }
    
    // Convert the HTML back to markdown
    const markdown = htmlToMarkdown(body).trim();
    if (markdown) return markdown;
  }
  
  // Fallback to plain text extraction if conversion fails
  return doc.body?.textContent?.trim() || "";
}

async function fetchMarkdownFromDweb() {
  const value = fetchCidInput.value.trim();
  if (!value) {
    alert("Please enter an IPFS or Hyper URL.");
    return;
  }
  showSpinner(true);
  try {
    const response = await fetch(value);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || "Failed to fetch document");
    }
    const contentType = response.headers.get("content-type") || "";
    let text = "";
    if (contentType.includes("application/json")) {
      const data = await response.json();
      if (typeof data?.content === "string") {
        text = data.content;
      } else {
        text = JSON.stringify(data, null, 2);
      }
    } else {
      text = await response.text();
    }
    const shouldParseHtml =
      contentType.includes("text/html") ||
      text.trim().startsWith("<!DOCTYPE") ||
      text.trim().startsWith("<html");
    const resolvedText = shouldParseHtml ? extractMarkdownFromHtml(text) : text;
    markdownInput.value = resolvedText || "";
    renderPreview();
    scheduleSend();
    scheduleDraftSave();
  } catch (error) {
    alert(error.message || "Failed to fetch document");
  } finally {
    showSpinner(false);
  }
}

function getViewParam() {
  const params = new URLSearchParams(window.location.search);
  return params.get("view");
}

function setView(view) {
  const params = new URLSearchParams(window.location.search);
  if (view === "setup") {
    params.set("view", "setup");
    params.delete("protocol");
  } else {
    params.delete("view");
    if (protocolSelect) {
      params.set("protocol", protocolSelect.value);
    }
  }
  const base = window.location.pathname + window.location.hash;
  const query = params.toString();
  const nextUrl = query ? `${base}?${query}` : base;
  history.replaceState(null, "", nextUrl);
  if (setupPage) setupPage.classList.toggle("hidden", view !== "setup");
  if (editorPage) editorPage.classList.toggle("hidden", view === "setup");
}

function resetNetworkSettingsOnCreate() {
  privateMode.checked = false;
  udpMode.checked = false;
  localHostInput.value = "127.0.0.1";
  localPortInput.value = "";
}

createRoomButton.addEventListener("click", createRoom);
joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const key = normalizeRoomKey(joinRoomKey.value);
  if (!key) {
    alert("Please enter a valid hs:// key.");
    return;
  }
  if (!validateRoomKey(key)) {
    return;
  }
  const storedState = resolveRoomState(key) || {};
  if (storedState.host) localHostInput.value = storedState.host;
  if (storedState.port) localPortInput.value = storedState.port;
  if (typeof storedState.secure === "boolean") privateMode.checked = storedState.secure;
  if (typeof storedState.udp === "boolean") udpMode.checked = storedState.udp;
  joinRoom(key, storedState);
});
disconnectButton.addEventListener("click", disconnectRoom);

markdownInput.addEventListener("input", () => {
  scheduleRender();
  scheduleSend();
  scheduleDraftSave();
});

markdownInput.addEventListener("dragover", (e) => {
  const hasFiles = e.dataTransfer?.types?.includes("Files");
  if (!hasFiles) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

function compressImage(file) {
  const SKIP_TYPES = ["image/gif", "image/svg+xml"];
  if (SKIP_TYPES.includes(file.type)) return Promise.resolve(file);
  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const MAX_W = 1920;
      let { width, height } = img;
      if (width <= MAX_W && file.size < 500 * 1024) {
        resolve(file);
        return;
      }
      if (width > MAX_W) {
        height = Math.round(height * (MAX_W / width));
        width = MAX_W;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      const outType = file.type === "image/png" ? "image/webp" : (file.type || "image/jpeg");
      canvas.toBlob(
        (blob) => {
          if (blob && blob.size < file.size) {
            const ext = outType === "image/webp" ? ".webp" : (file.name.match(/\.[^.]+$/)?.[0] || ".jpg");
            const newName = file.name.replace(/\.[^.]+$/, ext);
            resolve(new File([blob], newName, { type: outType }));
          } else {
            resolve(file);
          }
        },
        outType,
        0.8
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(file);
    };
    img.src = objectUrl;
  });
}

markdownInput.addEventListener("drop", async (e) => {
  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;
  const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
  if (imageFiles.length === 0) return;
  e.preventDefault();

  for (const file of imageFiles) {
    const uid = `uploading-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const placeholder = `![Uploading ${file.name}...](${uid})`;
    const cursorPos = markdownInput.selectionStart;
    const before = markdownInput.value.substring(0, cursorPos);
    const after = markdownInput.value.substring(markdownInput.selectionEnd);
    markdownInput.value = before + placeholder + after;
    markdownInput.selectionStart = markdownInput.selectionEnd = cursorPos + placeholder.length;
    renderPreview();

    try {
      const compressed = await compressImage(file);
      const formData = new FormData();
      formData.append("file", compressed, compressed.name);
      const response = await fetch("ipfs://bafyaabakaieac/", {
        method: "PUT",
        body: formData,
      });
      if (!response.ok) throw new Error("IPFS upload failed");
      const ipfsUrl = (response.headers.get("Location") || "").trim();
      if (!ipfsUrl) throw new Error("No IPFS URL returned");
      let gatewayUrl = ipfsUrl.replace(/^ipfs:\/\//, "https://dweb.link/ipfs/");
      if (gatewayUrl.endsWith("/") || !gatewayUrl.match(/\/[^/]+\.[a-z0-9]+$/i)) {
        if (!gatewayUrl.endsWith("/")) gatewayUrl += "/";
        gatewayUrl += encodeURIComponent(compressed.name);
      }
      const altText = file.name.replace(/\.[^.]+$/, "");
      markdownInput.value = markdownInput.value.replace(placeholder, `![${altText}](${gatewayUrl})`);
    } catch (err) {
      console.error("[p2pmd] Image upload failed:", err);
      markdownInput.value = markdownInput.value.replace(placeholder, `![Upload failed: ${file.name}]()`);
    }

    renderPreview();
    scheduleSend();
    scheduleDraftSave();
  }
});

if (titleInput) {
  titleInput.addEventListener("input", () => {
    scheduleDraftSave();
  });
}

protocolSelect.addEventListener("change", () => {
  toggleTitleInput();
  safeLocalStorageSet("lastProtocol", protocolSelect.value);
  updateSelectorURL();
  scheduleDraftSave();
});
publishButton.addEventListener("click", publishDocument);
exportHtmlButton.addEventListener("click", exportAsHtml);
exportPdfButton.addEventListener("click", exportToPdf);
if (clearDraftButton) {
  clearDraftButton.addEventListener("click", async () => {
    markdownInput.value = "";
    if (titleInput) titleInput.value = "";
    renderPreview();
    lastDraftPayload = null;
    lastSavedContent = "";
    if (currentRoomKey) {
      saveRoomDraft(currentRoomKey, "");
      safeLocalStorageRemove(`${ROOM_CONTENT_PREFIX}${currentRoomKey}`);
    }
    await clearDraft();
    await postContentNow();
  });
}
fetchButton.addEventListener("click", fetchMarkdownFromDweb);

toggleTitleInput();
updateSelectorURL();
initMarkdown();

(async () => {
  const viewParam = getViewParam();
  const stateFromUrl = readRoomStateFromUrl();
  const lastKey = safeLocalStorageGet(LAST_ROOM_KEY);
  
  let stateFromStorage = null;
  if (stateFromUrl?.key) {
    stateFromStorage = resolveRoomState(stateFromUrl.key);
  } else if (lastKey) {
    stateFromStorage = resolveRoomState(lastKey);
  }
  
  const state = stateFromUrl || stateFromStorage;
  if (viewParam === "setup") {
    setView("setup");
    return;
  }
  if (!state?.key) {
    setView("setup");
    return;
  }
  if (!validateRoomKey(state.key)) {
    setView("setup");
    return;
  }
  
  // If we just created this room, don't rejoin - server is already running
  if (justCreatedRoom && currentRoomKey === state.key) {
    console.log("[p2pmd] Just created room, skipping auto-join");
    setView("editor");
    return;
  }
  
  // If we're already connected to this room, don't rejoin - just restore the UI state
  if (currentRoomKey === state.key && currentRoomUrl) {
    console.log("[p2pmd] Already connected to room, skipping auto-join");
    setView("editor");
    joinRoomKey.value = state.key;
    if (state.host) localHostInput.value = state.host;
    if (state.port) localPortInput.value = state.port;
    if (typeof state.secure === "boolean") privateMode.checked = state.secure;
    if (typeof state.udp === "boolean") udpMode.checked = state.udp;
    updateRoomStatus({ key: state.key, localUrl: state.localUrl });
    return;
  }
  
  setView("editor");
  joinRoomKey.value = state.key;
  if (state.host) localHostInput.value = state.host;
  if (state.port) localPortInput.value = state.port;
  if (typeof state.secure === "boolean") privateMode.checked = state.secure;
  if (typeof state.udp === "boolean") udpMode.checked = state.udp;
  await joinRoom(state.key, state);
})();
