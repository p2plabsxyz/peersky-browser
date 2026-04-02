import {
  markdownInput,
  markdownPreview,
  slidesPreview,
  viewSlidesButton,
  fullPreviewButton,
  createRoomButton,
  joinForm,
  joinRoomKey,
  displayNameInput,
  privateMode,
  udpMode,
  localHostInput,
  localPortInput,
  setupPage,
  editorPage,
  roomStatus,
  roomKeyLabel,
  roomRoleBadge,
  copyRoomKey,
  peersCount,
  peersLink,
  localUrlLabel,
  exportMenu,
  exportHtmlButton,
  exportPdfButton,
  exportSlidesButton,
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
import { initToolbar } from "./toolbar.js";
import { initCursorOverlay, updateCursorOverlay, destroyCursorOverlay,
         setLocalColor, updateLineAuthors } from "./cursorOverlay.js";






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
let justCreatedRoom = false;

let ydoc = null;
let ytext = null;
let pendingUpdate = null;
let sendUpdateTimer = null;
let flushRetryTimer = null;
let flushRetryCount = 0;
const MAX_FLUSH_RETRIES = 10;
let prevText = "";
let isApplyingRemote = false;
let savedYjsState = null; // Save Yjs CRDT state (not just text) for proper merge on reconnect
let currentRole = null;
let reconnectTimer = null;
let isRecoveringYjsState = false;
const MAX_PENDING_UPDATE_BYTES = 2 * 1024 * 1024;
const Y_ORIGIN_REMOTE = "remote-sse";

const ROOM_STATE_PREFIX = "p2pmd-room-";
const ROOM_CONTENT_PREFIX = "p2pmd-room-content-";
const PEER_STATUS_PREFIX = "p2pmd-peer-status-";
const PEER_ACTIVITY_PREFIX = "p2pmd-peer-activity-";
const ACTIVE_ROOM_STATUS_KEY = "p2pmd-active-room";
const LAST_ROOM_KEY = "p2pmd-last-room";
const LAST_ROOM_STATE = "p2pmd-last-room-state";
const DISPLAY_NAME_KEY = "p2pmd-display-name";
const CLIENT_ID_KEY = "p2pmd-client-id";
const DRAFT_DRIVE_NAME = "p2pmd-drafts";
const MAX_ACTIVITY_ITEMS = 150;
const PRESENCE_THROTTLE_MS = 220;
const TYPING_IDLE_MS = 1200;
const PEER_COLOR_SATURATION = 70;
const PEER_FALLBACK_NAME_LEN = 8;
const saveDelay = 2000;
let hyperSaveInFlight = false;
let draftSaveInFlight = false;
const draftSnapshotCache = new Map();
let currentPeerList = [];
let peerActivityLog = [];
let presenceSendTimer = null;
let typingResetTimer = null;
let isLocalTyping = false;
let lastPresencePayload = "";

const publishCSS = `
  @font-face {
    font-family: 'FontWithASyntaxHighlighter';
    src: url('browser://theme/fonts/FontWithASyntaxHighlighter-Regular.woff2') format('woff2');
  }
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
    background: #2d2d2d;
    color: #f8f8f2;
    font-weight: 1000;
    padding: 0.15rem 0.35rem;
    border-radius: 6px;
    font-family: 'FontWithASyntaxHighlighter', monospace;
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

function buildRandomClientId() {
  try {
    if (window.crypto?.randomUUID) {
      return window.crypto.randomUUID();
    }
  } catch {}
  return `client-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function getOrCreateClientId() {
  const existing = safeLocalStorageGet(CLIENT_ID_KEY);
  if (existing && typeof existing === "string") return existing;
  const next = buildRandomClientId();
  safeLocalStorageSet(CLIENT_ID_KEY, next);
  return next;
}

function normalizeDisplayName(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, 32);
}

function getDisplayName() {
  const fromInput = normalizeDisplayName(displayNameInput?.value || "");
  if (fromInput) return fromInput;
  return normalizeDisplayName(safeLocalStorageGet(DISPLAY_NAME_KEY) || "");
}

function saveDisplayName(value) {
  const next = normalizeDisplayName(value);
  if (displayNameInput && displayNameInput.value !== next) {
    displayNameInput.value = next;
  }
  if (next) safeLocalStorageSet(DISPLAY_NAME_KEY, next);
  else safeLocalStorageRemove(DISPLAY_NAME_KEY);
}

function truncateIdentifier(value, size = 10) {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.length <= size) return trimmed;
  return `${trimmed.slice(0, size)}...`;
}

function getCursorDetails(text, offset) {
  const safeText = typeof text === "string" ? text : "";
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.min(offset, safeText.length)) : 0;
  const prefix = safeText.slice(0, safeOffset);
  const lines = prefix.split("\n");
  return {
    offset: safeOffset,
    line: lines.length,
    column: (lines[lines.length - 1] || "").length + 1
  };
}

const localClientId = getOrCreateClientId();

const urlParams = new URLSearchParams(window.location.search);
const paramProtocol = urlParams.get("protocol");
const storedProtocol = safeLocalStorageGet("lastProtocol");
const initialProtocol = paramProtocol || storedProtocol || "hyper";
if (protocolSelect) {
  protocolSelect.value = initialProtocol;
}
if (displayNameInput) {
  const storedName = normalizeDisplayName(safeLocalStorageGet(DISPLAY_NAME_KEY) || "");
  if (storedName) displayNameInput.value = storedName;
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
  if (ydoc && window.Y) {
    try {
      payload.yjsState = bytesToBase64(window.Y.encodeStateAsUpdate(ydoc));
    } catch {}
  }
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
          draftSnapshotCache.delete(roomKey);
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
      if (!data || data.isCleared) {
        draftSnapshotCache.delete(roomKey);
        return "";
      }
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
        draftSnapshotCache.set(roomKey, {
          content: data.content,
          updatedAt: Number.isFinite(Number(data.updatedAt)) ? Number(data.updatedAt) : 0,
          yjsState: typeof data.yjsState === "string" ? data.yjsState : null
        });
        lastDraftPayload = JSON.stringify(data);
        return data.content;
      }
      draftSnapshotCache.delete(roomKey);
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
  if (!normalized.savedAt) normalized.savedAt = Date.now();
  const payload = JSON.stringify(normalized);
  const candidates = getRoomKeyCandidates(normalized.key);
  for (const candidate of candidates) {
    safeLocalStorageSet(`${ROOM_STATE_PREFIX}${candidate}`, payload);
  }
}

export function scheduleSend() {
  if (!currentRoomUrl) return;

  // Track line authorship using the current cursor line before sending updates.
  _attributeCurrentLine();
  // Render local marks immediately without waiting for SSE.
  updateLineAuthors(_roomLineAttributions);

  if (!ydoc || !ytext) {
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = setTimeout(async () => {
      const content = markdownInput.value;
      if (content === lastSentContent) return;
      lastSentContent = content;
      try {
        await fetch(`${currentRoomUrl}/doc`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            clientId: localClientId,
            role: currentRole || "client",
            name: getDisplayName(),
            ...getCurrentCursorPayload(),
            lineAttributions: getLineAttributionsPayload()
          })
        });
        schedulePresenceSend();
      } catch {
        updatePeers(0);
      } finally {
        scheduleDraftSave();
      }
    }, 200);
    return;
  }
  if (sendTimer) {
    clearTimeout(sendTimer);
    sendTimer = null;
  }
  const newText = markdownInput.value;
  const oldText = ytext ? ytext.toString() : prevText;
  if (newText === oldText) {
    prevText = oldText;
    return;
  }
  applyTextDiff(ytext, oldText, newText);
  prevText = newText;
}


function _attributeCurrentLine() {
  try {
    const text = markdownInput.value || "";
    const offset = markdownInput.selectionStart ?? 0;
    const before = text.slice(0, Math.min(offset, text.length));
    let line = 1;
    for (const ch of before) if (ch === "\n") line++;

    const name  = getDisplayName() || truncateIdentifier(localClientId, PEER_FALLBACK_NAME_LEN);
    const color = currentPeerList.find((p) => p.clientId === localClientId)?.color || _localFallbackColor();
    if (!color) return;
    _localLineAttributions[String(line)] = { name, color };
    _roomLineAttributions[String(line)] = { name, color };
  } catch {}
}

// Local peer's accumulated line attributions, sent via /presence.
let _localLineAttributions = {};
// Room-level accumulated line attributions, preserved even after peers disconnect.
let _roomLineAttributions = {};

function _localFallbackColor() {
  if (!localClientId) return "#888";
  let h = 0;
  for (let i = 0; i < localClientId.length; i++)
    h = (h * 31 + localClientId.charCodeAt(i)) & 0xffff;
  return `hsl(${h % 360},${PEER_COLOR_SATURATION}%,55%)`;
}

function mergeLineAttributionsIntoRoom(value) {
  if (!value || typeof value !== "object") return;
  for (const [line, info] of Object.entries(value)) {
    const lineNum = Number(line);
    if (!Number.isFinite(lineNum) || lineNum < 1) continue;
    if (!info || typeof info !== "object" || typeof info.color !== "string") continue;
    _roomLineAttributions[String(Math.floor(lineNum))] = {
      name: typeof info.name === "string" ? info.name : "",
      color: info.color
    };
  }
}

function refreshLocalLineAttribution() {
  _attributeCurrentLine();
  updateLineAuthors(_roomLineAttributions);
}



function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function applyTextDiff(ytextRef, oldText, newText, origin = null) {
  if (!ytextRef || oldText === newText) return;
  // Trim unchanged edges so we emit one minimal delete/insert change.
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
    if (insertStr)     ytextRef.insert(prefixLen, insertStr);
  }, origin);
}

function getCurrentCursorPayload() {
  const start = Number.isFinite(markdownInput.selectionStart) ? markdownInput.selectionStart : 0;
  const end = Number.isFinite(markdownInput.selectionEnd) ? markdownInput.selectionEnd : start;
  const startPos = getCursorDetails(markdownInput.value || "", start);
  const endPos = getCursorDetails(markdownInput.value || "", end);
  return {
    selectionStart: startPos.offset,
    selectionEnd: endPos.offset,
    cursorLine: startPos.line,
    cursorColumn: startPos.column
  };
}

function buildPresencePayload() {
  const cursor = getCurrentCursorPayload();
  return {
    clientId: localClientId,
    role: currentRole || "client",
    name: getDisplayName(),
    ...cursor,
    isTyping: isLocalTyping
  };
}

function getLineAttributionsPayload() {
  const cursor = getCurrentCursorPayload();
  const line = Number(cursor.cursorLine);
  if (!Number.isFinite(line) || line < 1) return undefined;
  const name = getDisplayName() || truncateIdentifier(localClientId, PEER_FALLBACK_NAME_LEN);
  const color = currentPeerList.find((p) => p.clientId === localClientId)?.color || _localFallbackColor();
  if (!color) return undefined;
  return {
    [String(Math.floor(line))]: { name, color }
  };
}

function scheduleTypingReset() {
  if (typingResetTimer) clearTimeout(typingResetTimer);
  typingResetTimer = setTimeout(() => {
    isLocalTyping = false;
    sendPresenceNow();
  }, TYPING_IDLE_MS);
}

async function sendPresenceNow(force = false) {
  if (!currentRoomUrl) return;
  const payload = buildPresencePayload();
  const serialized = JSON.stringify(payload);
  if (!force && serialized === lastPresencePayload) return;
  lastPresencePayload = serialized;
  try {
    await fetch(`${currentRoomUrl}/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serialized
    });
  } catch {}
}

function schedulePresenceSend(force = false) {
  if (presenceSendTimer) clearTimeout(presenceSendTimer);
  presenceSendTimer = setTimeout(() => {
    presenceSendTimer = null;
    sendPresenceNow(force);
  }, force ? 0 : PRESENCE_THROTTLE_MS);
}

async function flushYjsUpdate() {
  if (!pendingUpdate || !currentRoomUrl) return;

  const toSend = pendingUpdate;
  pendingUpdate = null;

  try {
    const res = await fetch(`${currentRoomUrl}/doc/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        update: bytesToBase64(toSend),
        clientId: localClientId,
        role: currentRole || "client",
        name: getDisplayName(),
        ...getCurrentCursorPayload(),
        lineAttributions: getLineAttributionsPayload()
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Success - reset retry counter
    flushRetryCount = 0;
    if (flushRetryTimer) {
      clearTimeout(flushRetryTimer);
      flushRetryTimer = null;
    }
  } catch (err) {
    console.warn("[p2pmd] Failed to send Yjs update:", err);

    // Keep unsent changes across transient failures; cap memory growth.
    let merged = pendingUpdate
      ? window.Y.mergeUpdates([toSend, pendingUpdate])
      : toSend;
    if (merged.byteLength > MAX_PENDING_UPDATE_BYTES && ydoc) {
      try {
        merged = window.Y.encodeStateAsUpdate(ydoc);
      } catch {}
    }
    if (merged.byteLength > MAX_PENDING_UPDATE_BYTES) {
      console.warn("[p2pmd] Dropping oversized pending CRDT update buffer");
      pendingUpdate = null;
      flushRetryCount = 0;
    } else {
      pendingUpdate = merged;
    }

    // Retry with exponential backoff, up to MAX_FLUSH_RETRIES
    if (!flushRetryTimer && pendingUpdate && flushRetryCount < MAX_FLUSH_RETRIES) {
      flushRetryCount++;
      const delay = Math.min(1200 * Math.pow(1.5, flushRetryCount - 1), 10000);
      flushRetryTimer = setTimeout(() => {
        flushRetryTimer = null;
        flushYjsUpdate();
      }, delay);
    } else if (flushRetryCount >= MAX_FLUSH_RETRIES) {
      console.error("[p2pmd] Max flush retries reached, dropping pending update");
      pendingUpdate = null;
      flushRetryCount = 0;
    }
    updatePeers(0);
  }
}

function destroyYjs(skipSave = false) {
  if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
  if (sendUpdateTimer) { clearTimeout(sendUpdateTimer); sendUpdateTimer = null; }
  if (flushRetryTimer) { clearTimeout(flushRetryTimer); flushRetryTimer = null; }
  if (presenceSendTimer) { clearTimeout(presenceSendTimer); presenceSendTimer = null; }
  if (typingResetTimer) { clearTimeout(typingResetTimer); typingResetTimer = null; }
  isLocalTyping = false;
  lastPresencePayload = "";

  // Save CRDT state before destroying for proper reconnect merge
  if (!skipSave && !savedYjsState && ydoc && window.Y) {
    try {
      const stateUpdate = window.Y.encodeStateAsUpdate(ydoc);
      // Limit saved state size to prevent memory issues
      if (stateUpdate.byteLength < MAX_PENDING_UPDATE_BYTES) {
        savedYjsState = bytesToBase64(stateUpdate);
      }
    } catch (e) {
      console.warn("[p2pmd] Failed to save Yjs state:", e);
    }
  }

  pendingUpdate = null;
  if (ydoc) { try { ydoc.destroy(); } catch {} ydoc = null; }
  ytext = null;
  prevText = "";
  isApplyingRemote = false;
  _localLineAttributions = {};
  _roomLineAttributions = {};
  destroyCursorOverlay();
}





async function postContentNow() {
  if (!currentRoomUrl) return;
  const content = markdownInput.value;
  lastSentContent = content;
  try {
    await fetch(`${currentRoomUrl}/doc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        clientId: localClientId,
        role: currentRole || "client",
        name: getDisplayName(),
        ...getCurrentCursorPayload(),
        lineAttributions: getLineAttributionsPayload()
      })
    });
    schedulePresenceSend(true);
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
    const snapshot = await loadRoomSnapshotFromHyperdrive(roomKey);
    return snapshot.found ? snapshot.content : "";
  } catch {
    return "";
  }
}

async function loadRoomSnapshotFromHyperdrive(roomKey) {
  try {
    const url = await getRoomStorageUrl(roomKey);
    if (!url) return { found: false, content: "" };
    const response = await fetchWithTimeout(url, {}, 2000);
    if (!response.ok) return { found: false, content: "" };
    const content = await response.text();
    return { found: true, content: typeof content === "string" ? content : "" };
  } catch {
    return { found: false, content: "" };
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
  const safeCount = Number.isFinite(count) ? Math.max(0, count) : 0;
  peersCount.textContent = String(safeCount);
  if (peersLink) {
    const total = Array.isArray(currentPeerList) ? currentPeerList.length : 0;
    peersLink.title = total > 0 ? `${safeCount} remote peers, ${total} total participants` : `${safeCount} remote peers`;
  }
}

function normalizePeerRole(role) {
  if (role === "host") return "host";
  if (role === "client") return "client";
  return "viewer";
}

function normalizePeerName(name, fallback) {
  const normalized = normalizeDisplayName(name);
  return normalized || fallback;
}

function normalizePeerList(peerList) {
  if (!Array.isArray(peerList)) return [];
  return peerList
    .map((peer) => {
      if (!peer || typeof peer !== "object") return null;
      const role = normalizePeerRole(peer.role);
      const id = Number.isFinite(Number(peer.id)) ? Number(peer.id) : null;
      const clientId = typeof peer.clientId === "string" ? peer.clientId : "";
      const fallbackName = id ? `Peer #${id}` : `Peer ${truncateIdentifier(clientId || "unknown", PEER_FALLBACK_NAME_LEN)}`;
      return {
        id,
        role,
        clientId,
        color: typeof peer.color === "string" ? peer.color : "",
        name: normalizePeerName(peer.name, fallbackName),
        isTyping: peer.isTyping === true,
        cursorLine: Number.isFinite(Number(peer.cursorLine)) ? Number(peer.cursorLine) : null,
        cursorColumn: Number.isFinite(Number(peer.cursorColumn)) ? Number(peer.cursorColumn) : null,
        lineAttributions: normalizeLineAttributions(peer.lineAttributions),
        updatedAt: Number.isFinite(Number(peer.updatedAt)) ? Number(peer.updatedAt) : Date.now(),
        joinedAt: Number.isFinite(Number(peer.joinedAt)) ? Number(peer.joinedAt) : Date.now()
      };
    })
    .filter(Boolean);
}

function normalizeLineAttributions(value) {
  if (!value || typeof value !== "object") return null;
  const normalized = {};
  for (const [line, info] of Object.entries(value)) {
    const lineNum = Number(line);
    if (!Number.isFinite(lineNum) || lineNum < 1) continue;
    if (!info || typeof info !== "object" || typeof info.color !== "string") continue;
    normalized[String(Math.floor(lineNum))] = {
      name: typeof info.name === "string" ? info.name : "",
      color: info.color
    };
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function buildPeersPageHref(key = currentRoomKey, localUrl = currentRoomUrl) {
  const params = new URLSearchParams();
  if (key) params.set("roomKey", key);
  if (localUrl) params.set("localUrl", localUrl);
  if (currentRole) params.set("role", currentRole);
  params.set("clientId", localClientId);
  const query = params.toString();
  return query ? `./peers.html?${query}` : "./peers.html";
}

function updatePeersLink(key = currentRoomKey, localUrl = currentRoomUrl) {
  if (!peersLink) return;
  peersLink.href = buildPeersPageHref(key, localUrl);
}

function setRoleBadge(role = currentRole) {
  if (!roomRoleBadge) return;
  const normalizedRole = normalizePeerRole(role || "client");
  roomRoleBadge.textContent = normalizedRole;
  roomRoleBadge.classList.remove("host", "client", "viewer", "hidden");
  roomRoleBadge.classList.add(normalizedRole);
}

function getPeerStatusStorageKey(roomKey) {
  return `${PEER_STATUS_PREFIX}${roomKey}`;
}

function getPeerActivityStorageKey(roomKey) {
  return `${PEER_ACTIVITY_PREFIX}${roomKey}`;
}

function persistPeerStatusSnapshot() {
  if (!currentRoomKey) return;
  const payload = {
    roomKey: currentRoomKey,
    localUrl: currentRoomUrl,
    role: currentRole,
    clientId: localClientId,
    peers: currentPeerList,
    updatedAt: Date.now()
  };
  const serialized = JSON.stringify(payload);
  safeLocalStorageSet(getPeerStatusStorageKey(currentRoomKey), serialized);
  safeLocalStorageSet(ACTIVE_ROOM_STATUS_KEY, serialized);
}

function persistPeerActivitySnapshot() {
  if (!currentRoomKey) return;
  const payload = {
    roomKey: currentRoomKey,
    localUrl: currentRoomUrl,
    role: currentRole,
    clientId: localClientId,
    activity: peerActivityLog,
    updatedAt: Date.now()
  };
  safeLocalStorageSet(getPeerActivityStorageKey(currentRoomKey), JSON.stringify(payload));
}

function setPeerList(peerList) {
  currentPeerList = normalizePeerList(peerList);
  for (const peer of currentPeerList) {
    mergeLineAttributionsIntoRoom(peer.lineAttributions);
  }
  persistPeerStatusSnapshot();
  if (peersCount.textContent === "0") {
    let estimatedRemote = currentPeerList.length;
    if (currentPeerList.some((peer) => peer.clientId && peer.clientId === localClientId)) {
      estimatedRemote -= 1;
    }
    if (estimatedRemote > 0) {
      updatePeers(estimatedRemote);
    }
  }
  updateCursorOverlay(currentPeerList);
  updateLineAuthors(_roomLineAttributions);

  const self = currentPeerList.find((p) => p.clientId === localClientId);
  if (self?.color) setLocalColor(self.color);
}



function addPeerActivity(entry) {
  if (!entry || typeof entry !== "object") return;
  const item = {
    id: Number.isFinite(Number(entry.id)) ? Number(entry.id) : Date.now(),
    type: typeof entry.type === "string" ? entry.type : "event",
    message: typeof entry.message === "string" ? entry.message : "",
    role: normalizePeerRole(entry.role || "client"),
    name: normalizePeerName(entry.name, "Peer"),
    clientId: typeof entry.clientId === "string" ? entry.clientId : "",
    timestamp: Number.isFinite(Number(entry.timestamp)) ? Number(entry.timestamp) : Date.now()
  };
  const dedupeKey = `${item.id}:${item.type}:${item.clientId}:${item.timestamp}`;
  if (peerActivityLog.some((log) => `${log.id}:${log.type}:${log.clientId}:${log.timestamp}` === dedupeKey)) {
    return;
  }
  peerActivityLog.unshift(item);
  if (peerActivityLog.length > MAX_ACTIVITY_ITEMS) {
    peerActivityLog.length = MAX_ACTIVITY_ITEMS;
  }
  persistPeerActivitySnapshot();
}

function updateRoomStatus({ key, localUrl }) {
  roomKeyLabel.textContent = key || "";
  localUrlLabel.textContent = localUrl || "";
  if (localUrl) {
    localUrlLabel.href = localUrl;
  } else {
    localUrlLabel.removeAttribute("href");
  }
  updatePeersLink(key, localUrl);
  setRoleBadge(currentRole || "client");
  safeLocalStorageSet(ACTIVE_ROOM_STATUS_KEY, JSON.stringify({
    roomKey: key || null,
    localUrl: localUrl || null,
    role: currentRole || null,
    clientId: localClientId,
    updatedAt: Date.now()
  }));
  roomStatus.classList.remove("hidden");
  setView("editor");
}

async function recoverYjsStateFromServer() {
  if (isRecoveringYjsState || !currentRoomUrl || !ydoc || !window.Y) return;
  isRecoveringYjsState = true;
  try {
    const response = await fetchWithTimeout(`${currentRoomUrl}/doc/yjsstate`, {}, 3000);
    if (!response.ok) return;
    const data = await response.json();
    if (typeof data.yjsState !== "string") return;
    try {
      isApplyingRemote = true;
      window.Y.applyUpdate(ydoc, base64ToBytes(data.yjsState), Y_ORIGIN_REMOTE);
      const recovered = ytext ? ytext.toString() : "";
      prevText = recovered;
      if (recovered !== markdownInput.value) {
        markdownInput.value = recovered;
        renderPreview();
        scheduleDraftSave();
      }
    } finally {
      isApplyingRemote = false;
    }
  } catch {} finally {
    isRecoveringYjsState = false;
  }
}

function connectSseChannel(localUrl, role) {
  if (!localUrl) return;
  if (eventSource) {
    try { eventSource.close(); } catch {}
    eventSource = null;
  }

  try {
    const sseParams = new URLSearchParams();
    sseParams.set("role", normalizePeerRole(role || "client"));
    sseParams.set("clientId", localClientId);
    const displayName = getDisplayName();
    if (displayName) sseParams.set("name", displayName);
    eventSource = new EventSource(`${localUrl}/events?${sseParams.toString()}`);

    eventSource.addEventListener("yjsupdate", (event) => {
      if (!ydoc) return;
      try {
        isApplyingRemote = true;
        window.Y.applyUpdate(ydoc, base64ToBytes(event.data), Y_ORIGIN_REMOTE);
        prevText = ytext.toString();
      } catch (e) {
        console.warn("[p2pmd] Failed to apply yjsupdate:", e);
        recoverYjsStateFromServer();
      } finally {
        isApplyingRemote = false;
      }
    });

    eventSource.addEventListener("update", (event) => {
      if (ydoc) return;
      try {
        const data = JSON.parse(event.data || "{}");
        const incoming = typeof data.content === "string" ? data.content : "";
        if (incoming === markdownInput.value) return;
        const isFocused = document.activeElement === markdownInput;
        const start = markdownInput.selectionStart;
        const end = markdownInput.selectionEnd;
        markdownInput.value = incoming;
        lastSentContent = incoming;
        if (isFocused && start !== null && end !== null) {
          const newStart = Math.min(start, incoming.length);
          const newEnd = Math.min(end, incoming.length);
          markdownInput.setSelectionRange(newStart, newEnd);
        }
        renderPreview();
        scheduleDraftSave();
      } catch {}
    });

    eventSource.addEventListener("peerlist", (event) => {
      try {
        const nextPeerList = JSON.parse(event.data || "[]");
        setPeerList(nextPeerList);
      } catch {}
    });

    eventSource.addEventListener("activity", (event) => {
      try {
        const payload = JSON.parse(event.data || "{}");
        if (Array.isArray(payload)) {
          payload.slice().reverse().forEach((item) => addPeerActivity(item));
          return;
        }
        addPeerActivity(payload);
      } catch {}
    });

    eventSource.addEventListener("peers", (event) => {
      let nextCount = Number(event.data);
      if (!Number.isFinite(nextCount)) {
        try {
          const payload = JSON.parse(event.data || "{}");
          if (Number.isFinite(Number(payload?.count))) {
            nextCount = Number(payload.count);
          } else if (Number.isFinite(Number(payload?.peers))) {
            nextCount = Number(payload.peers);
          }
        } catch {}
      }
      updatePeers(Number.isFinite(nextCount) ? nextCount : 0);
    });

    eventSource.onopen = () => {
      if (pendingUpdate) flushYjsUpdate();
      sendPresenceNow(true);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    eventSource.onerror = () => {
      updatePeers(0);
      setPeerList([]);
      if (eventSource) {
        try { eventSource.close(); } catch {}
        eventSource = null;
      }
      // Reconnect SSE without destroying Y.Doc (preserves local state)
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!currentRoomUrl) return;
        connectSseChannel(currentRoomUrl, currentRole || role || "client");
        if (pendingUpdate) flushYjsUpdate();
      }, 2000);
    };
  } catch {
    updatePeers(0);
  }
}

async function connectToRoom(localUrl, role = "client") {
  currentRoomUrl = localUrl;
  currentRole = normalizePeerRole(role || "client");
  currentPeerList = [];
  peerActivityLog = [];
  updatePeers(0);
  updatePeersLink(currentRoomKey, localUrl);
  setRoleBadge(currentRole);
  persistPeerStatusSnapshot();
  persistPeerActivitySnapshot();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  destroyYjs();

  let hasRoomSnapshot = false;
  let snapshotContent = "";
  let serverHadMeaningful = false;
  let yjsStateBase64 = null;
  
  const serverReady = await pingServerStatus(localUrl, 5);
  if (!serverReady) {
    console.warn("[p2pmd] Server not responding, continuing anyway...");
  }

  try {
    const statusRes = await fetchWithTimeout(`${localUrl}/status`, {}, 2000);
    if (statusRes.ok) {
      const statusData = await statusRes.json();
      if (Array.isArray(statusData?.peerList)) {
        setPeerList(statusData.peerList);
      }
      if (Number.isFinite(Number(statusData?.peers))) {
        updatePeers(Number(statusData.peers));
      }
    }
  } catch {}

  try {
    const activityRes = await fetchWithTimeout(`${localUrl}/activity`, {}, 2000);
    if (activityRes.ok) {
      const activityData = await activityRes.json();
      if (Array.isArray(activityData?.activity)) {
        for (const event of activityData.activity.slice().reverse()) {
          addPeerActivity(event);
        }
      }
    }
  } catch {}
  
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

  try {
    const yjsRes = await fetchWithTimeout(`${localUrl}/doc/yjsstate`, {}, 3000);
    if (yjsRes.ok) {
      const yjsData = await yjsRes.json();
      if (typeof yjsData.yjsState === "string") {
        yjsStateBase64 = yjsData.yjsState;
      }
    }
  } catch (e) {
    console.warn("[p2pmd] Failed to fetch /doc/yjsstate:", e);
  }

  if (!hasRoomSnapshot && !yjsStateBase64 && currentRoomKey) {
    const roomKey = currentRoomKey;
    let draftSnapshot = null;
    // Prefer shared room storage first (cross-device), then personal draft.
    const roomSnapshot = await loadRoomSnapshotFromHyperdrive(roomKey);
    let fallbackContent = roomSnapshot.content;
    let fallbackSource = "room";
    if (!roomSnapshot.found) {
      fallbackContent = await loadDraftFromHyperdrive(roomKey);
      fallbackSource = "draft";
      draftSnapshot = draftSnapshotCache.get(roomKey) || null;
    }
    if (!roomSnapshot.found && !hasMeaningfulContent(fallbackContent)) {
      fallbackContent = loadRoomDraft(roomKey);
      fallbackSource = "local-draft";
    }
    if (roomSnapshot.found || hasMeaningfulContent(fallbackContent)) {
      snapshotContent = fallbackContent;
      hasRoomSnapshot = true;
      if (!yjsStateBase64 && fallbackSource === "draft" && draftSnapshot?.yjsState) {
        yjsStateBase64 = draftSnapshot.yjsState;
      }
    }
  }

  if (snapshotContent !== markdownInput.value) {
    markdownInput.value = snapshotContent;
    renderPreview();
    if (hasRoomSnapshot && (!serverHadMeaningful || role === "host")) {
      await postContentNow();
    }
  }

  if (window.Y) {
    ydoc = new window.Y.Doc();
    ytext = ydoc.getText("content");

    if (yjsStateBase64) {
      try {
        window.Y.applyUpdate(ydoc, base64ToBytes(yjsStateBase64), Y_ORIGIN_REMOTE);
      } catch (e) {
        console.warn("[p2pmd] Failed to apply Yjs state:", e);
      }
      const ytextContent = ytext.toString();
      if (ytextContent && ytextContent !== markdownInput.value) {
        markdownInput.value = ytextContent;
        renderPreview();
      }
    } else if (snapshotContent) {
      ydoc.transact(() => ytext.insert(0, snapshotContent));
    }

    prevText = ytext.toString();

    // Set up update listener before local modifications
    ydoc.on("update", (update, origin) => {
      if (origin === Y_ORIGIN_REMOTE) return;
      if (isApplyingRemote) return;
      if (pendingUpdate) {
        pendingUpdate = window.Y.mergeUpdates([pendingUpdate, update]);
      } else {
        pendingUpdate = update;
      }
      if (sendUpdateTimer) clearTimeout(sendUpdateTimer);
      sendUpdateTimer = setTimeout(flushYjsUpdate, 100);
    });

    // Apply saved state, then server state - Yjs auto-merges
    if (savedYjsState) {
      try {
        window.Y.applyUpdate(ydoc, base64ToBytes(savedYjsState), Y_ORIGIN_REMOTE);
      } catch (e) {
        console.warn("[p2pmd] Failed to apply saved Yjs state:", e);
      }
    }

    // If server has state, apply it - Yjs auto-merges with our saved state
    if (yjsStateBase64) {
      try {
        window.Y.applyUpdate(ydoc, base64ToBytes(yjsStateBase64), Y_ORIGIN_REMOTE);
        const mergedContent = ytext.toString();
        if (mergedContent !== markdownInput.value) {
          markdownInput.value = mergedContent;
          renderPreview();
        }
        prevText = mergedContent;
      } catch (e) {
        console.warn("[p2pmd] Failed to apply server Yjs state:", e);
      }
    }

    savedYjsState = null;

    ytext.observe((event) => {
      const newContent = ytext.toString();
      // Keep baseline aligned to authoritative CRDT text
      prevText = newContent;
      if (newContent === markdownInput.value) return;

      // Rebase local selection against Yjs delta so remote edits don't jump cursor.
      let s = markdownInput.selectionStart ?? 0;
      let e = markdownInput.selectionEnd ?? 0;
      let pos = 0;
      for (const d of event.changes.delta) {
        if (d.retain) {
          pos += d.retain;
        } else if (d.insert) {
          const len = typeof d.insert === "string" ? d.insert.length : 0;
          if (pos < s) s += len;
          if (pos < e) e += len;
          pos += len;
        } else if (d.delete) {
          const len = d.delete;
          if (pos < s) s -= Math.min(len, s - pos);
          if (pos < e) e -= Math.min(len, e - pos);
        }
      }

      markdownInput.value = newContent;
      markdownInput.setSelectionRange(
        Math.max(0, Math.min(s, newContent.length)),
        Math.max(0, Math.min(e, newContent.length))
      );
      renderPreview();
      scheduleDraftSave();
    });
  } else {
    console.error("[p2pmd] Yjs failed to load; collaborative sync is unavailable.");
  }

  connectSseChannel(localUrl, role);
  initCursorOverlay(markdownInput, localClientId);

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
  let initialYjsState = null;
  let initialSource = "none";
  try {
    const roomSnapshot = await loadRoomSnapshotFromHyperdrive(key);
    // Prefer draft snapshot with Yjs state to preserve CRDT history across rehost.
    const draftContent = await loadDraftFromHyperdrive(key);
    const draftSnapshot = draftSnapshotCache.get(key) || null;
    if (draftSnapshot?.yjsState) {
      initialContent = draftSnapshot.content ?? draftContent ?? "";
      initialYjsState = draftSnapshot.yjsState;
      initialSource = "draft-yjs";
    } else if (roomSnapshot.found) {
      // Shared room file exists (even if empty) and should be treated as authoritative.
      initialContent = roomSnapshot.content;
      initialSource = "room";
    } else {
      // Fallback to personal draft only if shared room snapshot does not exist.
      if (hasMeaningfulContent(draftContent)) {
        initialContent = draftContent;
        initialSource = "draft";
      }
      if (!hasMeaningfulContent(initialContent)) {
        initialContent = loadRoomDraft(key);
        initialSource = "local-draft";
      }
    }
  } catch {}

  const payload = {
    key,
    secure: state.secure,
    udp: state.udp,
    initialContent
  };
  if (initialYjsState) {
    payload.initialYjsState = initialYjsState;
  }
  
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
  
  // Build join options from state
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
  const disconnectKey = currentRoomKey;
  const disconnectContent = markdownInput.value || "";

  if (disconnectKey) {
    saveRoomDraft(disconnectKey, disconnectContent);
  }

  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
  if (sendUpdateTimer) { clearTimeout(sendUpdateTimer); sendUpdateTimer = null; }
  if (flushRetryTimer) { clearTimeout(flushRetryTimer); flushRetryTimer = null; }
  if (presenceSendTimer) { clearTimeout(presenceSendTimer); presenceSendTimer = null; }
  if (typingResetTimer) { clearTimeout(typingResetTimer); typingResetTimer = null; }
  isLocalTyping = false;
  lastPresencePayload = "";

  if (pendingUpdate && currentRoomUrl) {
    try { await flushYjsUpdate(); } catch {}
  }
  if (currentRoomUrl) {
    try { await postContentNow(); } catch {}
  }
  if (disconnectKey) {
    await Promise.allSettled([
      saveRoomToHyperdrive(disconnectKey, disconnectContent),
      saveDraft({ force: true })
    ]);
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  currentRole = null;

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  destroyYjs();

  // Clear saved state since user explicitly disconnected
  savedYjsState = null;

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
  currentPeerList = [];
  peerActivityLog = [];
  updatePeers(0);
  updatePeersLink();
  safeLocalStorageRemove(ACTIVE_ROOM_STATUS_KEY);
  if (roomRoleBadge) {
    roomRoleBadge.classList.add("hidden");
    roomRoleBadge.classList.remove("host", "client", "viewer");
  }
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
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[getOrCreateHyperdrive] Error response: ${errorText}`);
        throw new Error(`Failed to generate Hyperdrive key: ${response.statusText}`);
      }
      hyperdriveUrl = await response.text();
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

function buildSlidesHtml(markdown) {
  // Match slide delimiters: --- surrounded by blank lines OR <!-- slide --> comment
  const slideDelimiters = /\n\n---\n\n|^---\n\n|\n\n---$|^<!-- slide -->$/gm;
  const slides = markdown.split(slideDelimiters)
    .map(slide => slide.trim())
    .filter(slide => slide.length > 0);
  
  const slidesHtml = slides.map((slideContent, index) => {
    const rendered = renderMarkdown(slideContent);
    return `<div class="slide${index === 0 ? ' active' : ''}">${rendered}</div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Presentation Slides</title>
  <style>
    @font-face {
      font-family: 'FontWithASyntaxHighlighter';
      src: url('browser://theme/fonts/FontWithASyntaxHighlighter-Regular.woff2') format('woff2');
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #ffffff; color: #1a1a1a; overflow: hidden; height: 100vh; width: 100vw; display: flex; flex-direction: column; }
    #slides-container { position: relative; flex: 1; width: 100%; display: flex; align-items: center; justify-content: center; }
    #slides-footer { padding: 0.75rem; text-align: center; font-size: 0.85rem; color: rgba(0, 0, 0, 0.4); background: transparent; }
    #slides-footer a { color: rgba(0, 0, 0, 0.5); text-decoration: none; }
    #slides-footer a:hover { color: rgba(0, 0, 0, 0.7); text-decoration: underline; }
    .slide { display: none; width: 90%; max-width: 1200px; height: 85%; padding: 4rem; background: #fff; color: #1a1a1a; overflow-y: auto; animation: slideIn 0.3s ease-out; text-align: center; flex-direction: column; align-items: center; justify-content: center; }
    .slide.active { display: flex; }
    .slide > * { max-width: 100%; }
    @keyframes slideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
    .slide h1 { font-size: 4rem; margin-bottom: 2rem; color: #1a1a1a; text-align: center; }
    .slide h2 { font-size: 3rem; margin: 2rem 0 1.5rem; color: #333; text-align: center; }
    .slide h3 { font-size: 2.2rem; margin: 1.5rem 0 1rem; color: #444; text-align: center; }
    .slide h4 { font-size: 1.8rem; margin: 1.2rem 0 0.8rem; color: #555; text-align: center; }
    .slide h5 { font-size: 1.5rem; margin: 1rem 0 0.6rem; color: #666; text-align: center; }
    .slide h6 { font-size: 1.3rem; margin: 0.8rem 0 0.5rem; color: #777; text-align: center; }
    .slide p { font-size: 1.5rem; line-height: 2; margin-bottom: 1.2rem; color: #333; text-align: center; }
    .slide ul, .slide ol { font-size: 1.5rem; line-height: 2; margin: 0 auto 1.2rem; margin-bottom: 1.2rem; display: inline-block; text-align: left; }
    .slide li { margin-bottom: 0.8rem; }
    .slide pre { background: #2d2d2d; color: #f8f8f2; padding: 1.5rem; border-radius: 6px; overflow-x: auto; margin: 1.5rem auto; font-size: 1.2rem; max-width: 90%; text-align: left; }
    .slide code { font-family: 'FontWithASyntaxHighlighter', monospace; background: #2d2d2d; color: #f8f8f2; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 1.1rem; }
    .slide pre code { background: transparent; padding: 0; }
    .slide blockquote { border-left: 4px solid #0066cc; padding-left: 1.5rem; margin: 1.5rem auto; font-style: italic; color: #555; max-width: 80%; text-align: left; display: inline-block; }
    .slide img { max-width: 90%; max-height: 60vh; width: auto; height: auto; border-radius: 6px; margin: 1.5rem auto; display: block; object-fit: contain; }
    .slide a { color: #0066cc; text-decoration: none; }
    .slide a:hover { text-decoration: underline; }
    .nav-arrow { position: fixed; top: 50%; transform: translateY(-50%); background: rgba(0,0,0,0.1); border: none; color: #333; font-size: 3rem; width: 80px; height: 80px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: opacity 0.5s ease, transform 0.3s ease, background 0.3s ease; z-index: 100; opacity: 1; }
    .nav-arrow.hidden { opacity: 0; pointer-events: none; }
    .nav-arrow:hover { background: rgba(0,0,0,0.2); transform: translateY(-50%) scale(1.1); }
    .nav-arrow:active { transform: translateY(-50%) scale(0.95); }
    .nav-arrow.disabled { opacity: 0.3; cursor: not-allowed; }
    .nav-arrow.disabled:hover { background: rgba(0,0,0,0.1); transform: translateY(-50%) scale(1); }
    #prev-arrow { left: 2rem; }
    #next-arrow { right: 2rem; }
    #progress-bar { position: fixed; bottom: 0; left: 0; height: 4px; background: #0066cc; transition: width 0.3s ease; z-index: 101; }
    #slide-counter { position: fixed; bottom: 1rem; right: 2rem; background: rgba(0,0,0,0.1); color: #333; padding: 0.5rem 1rem; border-radius: 20px; font-size: 0.9rem; z-index: 100; transition: opacity 0.5s ease; }
    #slide-counter.hidden { opacity: 0; }
    @media (max-width: 768px) { .slide { width: 95%; height: 90%; padding: 2rem; } .slide h1 { font-size: 2rem; } .slide h2 { font-size: 1.6rem; } .slide p, .slide ul, .slide ol { font-size: 1.1rem; } .nav-arrow { width: 60px; height: 60px; font-size: 2rem; } #prev-arrow { left: 1rem; } #next-arrow { right: 1rem; } }
  </style>
</head>
<body>
  <div id="slides-container">${slidesHtml}</div>
  <div id="slides-footer">
    Made by <a href="https://github.com/p2plabsxyz/p2pmd" target="_blank" rel="noopener noreferrer">p2pmd</a> in <a href="https://peersky.p2plabs.xyz/" target="_blank" rel="noopener noreferrer">PeerSky</a>
  </div>
  <button id="prev-arrow" class="nav-arrow" aria-label="Previous slide">â€¹</button>
  <button id="next-arrow" class="nav-arrow" aria-label="Next slide">â€º</button>
  <div id="progress-bar"></div>
  <div id="slide-counter"></div>
  <script>
    let currentSlide = 0;
    const slides = document.querySelectorAll('.slide');
    const totalSlides = slides.length;
    function updateUI() {
      const progress = ((currentSlide + 1) / totalSlides) * 100;
      document.getElementById('progress-bar').style.width = progress + '%';
      document.getElementById('slide-counter').textContent = (currentSlide + 1) + ' / ' + totalSlides;
      const prevBtn = document.getElementById('prev-arrow');
      const nextBtn = document.getElementById('next-arrow');
      prevBtn.classList.toggle('disabled', currentSlide === 0);
      nextBtn.classList.toggle('disabled', currentSlide === totalSlides - 1);
    }
    function showSlide(index) {
      if (index < 0 || index >= totalSlides) return;
      slides[currentSlide].classList.remove('active');
      currentSlide = index;
      slides[currentSlide].classList.add('active');
      updateUI();
    }
    function nextSlide() { if (currentSlide < totalSlides - 1) showSlide(currentSlide + 1); }
    function prevSlide() { if (currentSlide > 0) showSlide(currentSlide - 1); }
    document.getElementById('prev-arrow').addEventListener('click', prevSlide);
    document.getElementById('next-arrow').addEventListener('click', nextSlide);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') prevSlide();
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); nextSlide(); }
      else if (e.key === 'Home') showSlide(0);
      else if (e.key === 'End') showSlide(totalSlides - 1);
    });
    document.getElementById('slides-container').addEventListener('click', (e) => {
      const clickX = e.clientX;
      const windowWidth = window.innerWidth;
      if (clickX < windowWidth / 2) prevSlide(); else nextSlide();
    });
    let hideTimeout;
    function showControls() {
      document.getElementById('prev-arrow').classList.remove('hidden');
      document.getElementById('next-arrow').classList.remove('hidden');
      document.getElementById('slide-counter').classList.remove('hidden');
      clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => {
        document.getElementById('prev-arrow').classList.add('hidden');
        document.getElementById('next-arrow').classList.add('hidden');
        document.getElementById('slide-counter').classList.add('hidden');
      }, 2000);
    }
    document.addEventListener('mousemove', showControls);
    document.addEventListener('keydown', showControls);
    showControls();
    updateUI();
  </script>
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
  const markdown = markdownInput.value;
  const html = isSlideMode ? buildSlidesHtml(markdown) : buildPublishHtml(markdown);
  const fileName = getExportFileName("html");
  const blob = new Blob([html], { type: "text/html" });
  triggerDownload(blob, fileName);
  if (exportMenu?.open) exportMenu.open = false;
}

function exportAsSlides() {
  const markdown = markdownInput.value;
  const slidesHtml = buildSlidesHtml(markdown);
  const fileName = getExportFileName("slides.html");
  const blob = new Blob([slidesHtml], { type: "text/html" });
  triggerDownload(blob, fileName);
  if (exportMenu?.open) exportMenu.open = false;
}

let currentSlideIndex = 0;
let slidesData = [];
let isSlideMode = false;

function autoRenderSlides() {
  const markdown = markdownInput.value;
  // Match slide delimiters: --- surrounded by blank lines OR <!-- slide --> comment
  const slideDelimiters = /\n\n---\n\n|^---\n\n|\n\n---$|^<!-- slide -->$/gm;
  slidesData = markdown.split(slideDelimiters)
    .map(slide => slide.trim())
    .filter(slide => slide.length > 0);
  
  if (slidesData.length === 0) return;
  
  isSlideMode = true;
  window.isSlideMode = true;
  currentSlideIndex = 0;
  
  markdownPreview.classList.add('hidden');
  slidesPreview.classList.remove('hidden');
  viewSlidesButton.style.background = 'var(--browser-theme-secondary-highlight)';
  fullPreviewButton.classList.remove('hidden');
  
  renderInlineSlides();
}

function viewAsSlides() {
  const markdown = markdownInput.value;
  // Match slide delimiters: --- surrounded by blank lines OR <!-- slide --> comment
  const slideDelimiters = /\n\n---\n\n|^---\n\n|\n\n---$|^<!-- slide -->$/gm;
  const hasSlideDelimiters = slideDelimiters.test(markdown);
  
  if (!hasSlideDelimiters) {
    const skipConfirmation = markdown.trim().length === 0;
    insertSlidesTemplate(skipConfirmation);
    return;
  }
  
  // Re-create regex for split (test() consumed it)
  const splitDelimiters = /\n\n---\n\n|^---\n\n|\n\n---$|^<!-- slide -->$/gm;
  slidesData = markdown.split(splitDelimiters)
    .map(slide => slide.trim())
    .filter(slide => slide.length > 0);
  
  isSlideMode = true;
  window.isSlideMode = true;
  currentSlideIndex = 0;
  
  markdownPreview.classList.add('hidden');
  slidesPreview.classList.remove('hidden');
  viewSlidesButton.style.background = 'var(--browser-theme-secondary-highlight)';
  fullPreviewButton.classList.remove('hidden');
  
  renderInlineSlides();
}

function exitSlideMode() {
  isSlideMode = false;
  window.isSlideMode = false;
  markdownPreview.classList.remove('hidden');
  slidesPreview.classList.add('hidden');
  viewSlidesButton.style.background = '';
  fullPreviewButton.classList.add('hidden');
}

function renderInlineSlides() {
  if (!isSlideMode || slidesData.length === 0) return;
  
  const slidesHtml = slidesData.map((slideContent, index) => {
    const rendered = renderMarkdown(slideContent);
    return `<div class="slide${index === currentSlideIndex ? ' active' : ''}">${rendered}</div>`;
  }).join('\n');
  
  slidesPreview.innerHTML = `
    <div class="slides-content">
      ${slidesHtml}
      <button id="slides-prev" class="slides-nav" aria-label="Previous slide">â€¹</button>
      <button id="slides-next" class="slides-nav" aria-label="Next slide">â€º</button>
      <div id="slides-progress"></div>
      <div id="slides-counter"></div>
    </div>
    <div class="slides-footer">
      Made by <a href="https://github.com/p2plabsxyz/peersky-browser/tree/main/src/pages/p2p/p2pmd" target="_blank" rel="noopener noreferrer">p2pmd</a> with <a href="https://peersky.xyz" target="_blank" rel="noopener noreferrer">PeerSky</a>
    </div>
  `;
  
  updateInlineSlidesUI();
  attachInlineSlidesListeners();
}

function updateInlineSlidesUI() {
  const progress = ((currentSlideIndex + 1) / slidesData.length) * 100;
  const progressBar = document.getElementById('slides-progress');
  const counter = document.getElementById('slides-counter');
  const prevBtn = document.getElementById('slides-prev');
  const nextBtn = document.getElementById('slides-next');
  
  if (progressBar) progressBar.style.width = progress + '%';
  if (counter) counter.textContent = (currentSlideIndex + 1) + ' / ' + slidesData.length;
  
  if (prevBtn) {
    if (currentSlideIndex === 0) {
      prevBtn.classList.add('disabled');
    } else {
      prevBtn.classList.remove('disabled');
    }
  }
  
  if (nextBtn) {
    if (currentSlideIndex === slidesData.length - 1) {
      nextBtn.classList.add('disabled');
    } else {
      nextBtn.classList.remove('disabled');
    }
  }
}

function showInlineSlide(index) {
  if (index < 0 || index >= slidesData.length) return;
  
  const slides = slidesPreview.querySelectorAll('.slide');
  if (slides[currentSlideIndex]) slides[currentSlideIndex].classList.remove('active');
  currentSlideIndex = index;
  if (slides[currentSlideIndex]) slides[currentSlideIndex].classList.add('active');
  updateInlineSlidesUI();
}

function nextInlineSlide() {
  if (currentSlideIndex < slidesData.length - 1) {
    showInlineSlide(currentSlideIndex + 1);
  }
}

function prevInlineSlide() {
  if (currentSlideIndex > 0) {
    showInlineSlide(currentSlideIndex - 1);
  }
}

function attachInlineSlidesListeners() {
  const prevBtn = document.getElementById('slides-prev');
  const nextBtn = document.getElementById('slides-next');
  
  if (prevBtn) prevBtn.addEventListener('click', prevInlineSlide);
  if (nextBtn) nextBtn.addEventListener('click', nextInlineSlide);
}

function insertSlidesTemplate(skipConfirmation = false) {
  const template = `# Welcome to Your Presentation

Your first slide content goes here

<!-- Speaker notes: Introduce yourself and the topic -->

---

# Slide 2: Key Points

- Point 1
- Point 2
- Point 3

<!-- Speaker notes: Elaborate on each point -->

---

# Slide 3: More Content

Add your content here

<!-- Speaker notes: Add additional context -->

---

# Thank You!

Any questions?

<!-- Speaker notes: Open floor for Q&A -->`;
  
  if (!skipConfirmation && markdownInput.value.trim().length > 0) {
    const confirmed = confirm("This will clear your notes and give you a slides template. Continue?");
    if (!confirmed) return false;
  }
  
  markdownInput.value = template;
  renderPreview();
  
  setTimeout(() => {
    autoRenderSlides();
  }, 100);
  
  return true;
}

function getCursorSlideIndex() {
  const cursorPos = markdownInput.selectionStart;
  const textBeforeCursor = markdownInput.value.substring(0, cursorPos);
  const slideDelimiters = /^---$|^<!-- slide -->$/gm;
  const matches = textBeforeCursor.match(slideDelimiters);
  return matches ? matches.length : 0;
}

function openFullPreview() {
  const markdown = markdownInput.value;
  const slidesHtml = buildSlidesHtml(markdown);
  const blob = new Blob([slidesHtml], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const slidesWindow = window.open(url, "_blank");
  if (!slidesWindow) {
    alert("Please allow pop-ups to view slides in full screen");
  }
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
  copyContainer.textContent = "âŠ•";
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
        copyContainer.textContent = "âŠ•";
      }, 1000);
    }
  };
  listItem.append(link, copyContainer);
  publishList.appendChild(listItem);
}

function addPublishError(name, text) {
  const listItem = document.createElement("li");
  listItem.className = "log";
  listItem.textContent = `Error in ${name}: ${text}`;
  publishList.appendChild(listItem);
}

async function publishDocument() {
  const markdown = markdownInput.value;
  if (!markdown.trim()) {
    alert("Cannot publish empty document");
    return;
  }
  const protocol = protocolSelect.value;
  const slideDelimiters = /^---$|^<!-- slide -->$/gm;
  const hasSlides = slideDelimiters.test(markdown);
  const useSlides = isSlideMode && hasSlides;
  const html = useSlides ? buildSlidesHtml(markdown) : buildPublishHtml(markdown);
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

  let url;
  if (protocol === "hyper") {
    const hyperdriveUrl = await getOrCreateHyperdrive();
    url = `${hyperdriveUrl}${encodeURIComponent(file.name)}`;
  } else {
    url = `ipfs://bafyaabakaieac/${encodeURIComponent(file.name)}?peerskyOrigin=${encodeURIComponent(window.location.href)}`;
  }

  try {
    const response = await fetchWithTimeout(url, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type || "text/html" }
    }, 15000);

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

function extractMarkdownFromSlidesHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const slidesContainer = doc.getElementById('slides-container');
  
  if (!slidesContainer) return null;
  
  const slides = slidesContainer.querySelectorAll('.slide');
  if (slides.length === 0) return null;
  
  const slideContents = [];
  slides.forEach(slide => {
    // Get the inner HTML and convert back to markdown
    const slideMarkdown = htmlToMarkdownContent(slide);
    if (slideMarkdown.trim()) {
      slideContents.push(slideMarkdown.trim());
    }
  });
  
  return slideContents.join('\n\n---\n\n');
}

function htmlToMarkdownContent(element) {
  let result = "";
  
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.trim();
      if (text) result += text + "\n";
    } else if (node.nodeType === Node.COMMENT_NODE) {
      // Preserve HTML comments (speaker notes)
      const comment = node.textContent.trim();
      if (comment) {
        result += `<!-- ${comment} -->\n\n`;
      }
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
          // Check if paragraph contains only inline elements or text
          const pContent = extractInlineContent(node);
          if (pContent.trim()) {
            result += `${pContent}\n\n`;
          }
          break;
        case "ul":
          for (const li of node.querySelectorAll(":scope > li")) {
            result += `- ${li.textContent.trim()}\n`;
          }
          result += "\n";
          break;
        case "ol":
          let index = 1;
          for (const li of node.querySelectorAll(":scope > li")) {
            result += `${index}. ${li.textContent.trim()}\n`;
            index++;
          }
          result += "\n";
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
            result += `![${alt}](${src})\n\n`;
          }
          break;
        case "pre":
          const codeChild = node.querySelector("code");
          if (codeChild) {
            result += `\`\`\`\n${codeChild.textContent}\n\`\`\`\n\n`;
          } else {
            result += `\`\`\`\n${node.textContent}\n\`\`\`\n\n`;
          }
          break;
        case "code":
          if (node.parentElement?.tagName.toLowerCase() !== "pre") {
            result += `\`${node.textContent}\``;
          }
          break;
        case "blockquote":
          const lines = node.textContent.trim().split("\n");
          result += lines.map(line => `> ${line}`).join("\n") + "\n\n";
          break;
        case "strong":
        case "b":
          result += `**${node.textContent.trim()}**`;
          break;
        case "em":
        case "i":
          result += `*${node.textContent.trim()}*`;
          break;
        case "br":
          result += "\n";
          break;
        default:
          result += htmlToMarkdownContent(node);
      }
    }
  }
  
  return result;
}

function extractInlineContent(element) {
  let result = "";
  
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      
      switch (tag) {
        case "strong":
        case "b":
          result += `**${node.textContent.trim()}**`;
          break;
        case "em":
        case "i":
          result += `*${node.textContent.trim()}*`;
          break;
        case "code":
          result += `\`${node.textContent}\``;
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
        case "br":
          result += "\n";
          break;
        default:
          result += extractInlineContent(node);
      }
    }
  }
  
  return result;
}

function extractMarkdownFromHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  
  // First check if this is a slides HTML
  const slidesMarkdown = extractMarkdownFromSlidesHtml(html);
  if (slidesMarkdown) {
    return slidesMarkdown;
  }
  
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

createRoomButton.addEventListener("click", () => {
  saveDisplayName(displayNameInput?.value || "");
  createRoom();
});
joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveDisplayName(displayNameInput?.value || "");
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

if (displayNameInput) {
  displayNameInput.addEventListener("change", () => {
    saveDisplayName(displayNameInput.value);
  });
  displayNameInput.addEventListener("blur", () => {
    saveDisplayName(displayNameInput.value);
  });
}

if (copyRoomKey) {
  copyRoomKey.style.cursor = "pointer";
  copyRoomKey.addEventListener("click", async () => {
    const key = roomKeyLabel.textContent;
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      copyRoomKey.textContent = "Copied!";
      setTimeout(() => { copyRoomKey.textContent = "âŠ•"; }, 1000);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = key;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      copyRoomKey.textContent = "Copied!";
      setTimeout(() => { copyRoomKey.textContent = "âŠ•"; }, 1000);
    }
  });
}

markdownInput.addEventListener("input", () => {
  isLocalTyping = true;
  scheduleTypingReset();
  scheduleRender();
  scheduleSend();
  scheduleDraftSave();
  schedulePresenceSend();
});

markdownInput.addEventListener("click", () => {
  refreshLocalLineAttribution();
  schedulePresenceSend();
});

markdownInput.addEventListener("keyup", () => {
  refreshLocalLineAttribution();
  schedulePresenceSend();
});

markdownInput.addEventListener("select", () => {
  refreshLocalLineAttribution();
  schedulePresenceSend();
});

markdownInput.addEventListener("focus", () => {
  refreshLocalLineAttribution();
  schedulePresenceSend(true);
});

markdownInput.addEventListener("blur", () => {
  isLocalTyping = false;
  schedulePresenceSend(true);
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
      const response = await fetch(`ipfs://bafyaabakaieac/?peerskyOrigin=${encodeURIComponent(window.location.href)}`, {
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
exportSlidesButton.addEventListener("click", exportAsSlides);
window.autoRenderSlides = autoRenderSlides;
window.exitSlideMode = exitSlideMode;
window.isSlideMode = false;

Object.defineProperty(window, 'isSlideMode', {
  get: () => isSlideMode,
  set: (value) => { isSlideMode = value; }
});

viewSlidesButton.addEventListener("click", () => {
  if (isSlideMode) {
    exitSlideMode();
    renderPreview();
  } else {
    viewAsSlides();
  }
});

markdownInput.addEventListener('click', () => {
  if (isSlideMode) {
    const slideIndex = getCursorSlideIndex();
    if (slideIndex !== currentSlideIndex && slideIndex < slidesData.length) {
      showInlineSlide(slideIndex);
    }
  }
});

markdownInput.addEventListener('keyup', () => {
  if (isSlideMode) {
    const slideIndex = getCursorSlideIndex();
    if (slideIndex !== currentSlideIndex && slideIndex < slidesData.length) {
      showInlineSlide(slideIndex);
    }
  }
});
fullPreviewButton.addEventListener("click", openFullPreview);

document.addEventListener("keydown", (e) => {
  if (!isSlideMode) return;
  
  // Only navigate slides if focus is NOT on the markdown editor
  const isFocusedOnEditor = document.activeElement === markdownInput;
  if (isFocusedOnEditor) return;
  
  if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    e.preventDefault();
    prevInlineSlide();
  } else if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === " ") {
    e.preventDefault();
    nextInlineSlide();
  } else if (e.key === "Escape") {
    exitSlideMode();
  } else if (e.key === "Home") {
    e.preventDefault();
    showInlineSlide(0);
  } else if (e.key === "End") {
    e.preventDefault();
    showInlineSlide(slidesData.length - 1);
  }
});
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
initToolbar();

async function loadRecentRooms() {
  const historyList = document.getElementById('room-history-list');
  if (!historyList) return;
  
  try {
    // Read room states from localStorage, deduplicate by canonical key
    const seen = new Map();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(ROOM_STATE_PREFIX)) {
        try {
          const raw = localStorage.getItem(key);
          const state = JSON.parse(raw);
          if (state?.key && validateRoomKey(state.key)) {
            const canonical = state.key;
            const existing = seen.get(canonical);
            if (!existing || (state.savedAt || 0) > (existing.savedAt || 0)) {
              seen.set(canonical, { roomKey: canonical, savedAt: state.savedAt || 0 });
            }
          }
        } catch {
          // Skip invalid entries
        }
      }
    }
    
    const rooms = Array.from(seen.values())
      .sort((a, b) => b.savedAt - a.savedAt);
    
    if (rooms.length === 0) {
      historyList.innerHTML = '<div class="no-rooms">No past rooms</div>';
      return;
    }
    
    // Show last 5 rooms
    const recentRooms = rooms.slice(0, 5);
    
    historyList.innerHTML = recentRooms.map(({ roomKey }) => {
      const displayKey = roomKey.replace('hs://', '').substring(0, 20) + '...';
      return `<a href="#" data-room-key="${roomKey}" title="${roomKey}">${displayKey}</a>`;
    }).join('');
    
    historyList.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const roomKey = link.getAttribute('data-room-key');
        joinRoomKey.value = roomKey;
        joinForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
    });
  } catch (error) {
    console.error('[loadRecentRooms] Error:', error);
    historyList.innerHTML = '<div class="no-rooms">No past rooms</div>';
  }
}

(async () => {
  const viewParam = getViewParam();
  const stateFromUrl = readRoomStateFromUrl();
  
  if (viewParam === "setup" || !stateFromUrl?.key) {
    await loadRecentRooms();
  }
  
  const state = stateFromUrl;
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
    setView("editor");
    return;
  }
  
  // If we're already connected to this room, don't rejoin - just restore the UI state
  if (currentRoomKey === state.key && currentRoomUrl) {
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
