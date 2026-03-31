const PEER_STATUS_PREFIX = "p2pmd-peer-status-";
const PEER_ACTIVITY_PREFIX = "p2pmd-peer-activity-";
const ACTIVE_ROOM_STATUS_KEY = "p2pmd-active-room";
const CLIENT_ID_KEY = "p2pmd-client-id";

const roomKeyLabel = document.getElementById("roomKey");
const localUrlLabel = document.getElementById("localUrl");
const localRoleLabel = document.getElementById("localRole");
const statsEl = document.getElementById("stats");
const peerListEl = document.getElementById("peerList");
const editingListEl = document.getElementById("editingList");
const activityListEl = document.getElementById("activityList");

const query = new URLSearchParams(window.location.search);
const state = {
  roomKey: query.get("roomKey") || "",
  localUrl: query.get("localUrl") || "",
  role: query.get("role") || "client",
  clientId: query.get("clientId") || safeGet(CLIENT_ID_KEY) || "",
  peers: [],
  activity: []
};

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeRole(role) {
  if (role === "host") return "host";
  if (role === "client") return "client";
  return "viewer";
}

function normalizePeer(peer) {
  if (!peer || typeof peer !== "object") return null;
  const role = normalizeRole(peer.role);
  const clientId = typeof peer.clientId === "string" ? peer.clientId : "";
  const id = Number.isFinite(Number(peer.id)) ? Number(peer.id) : null;
  const baseName = typeof peer.name === "string" && peer.name.trim() ? peer.name.trim() : (id ? `Peer #${id}` : "Peer");
  return {
    id,
    role,
    clientId,
    name: baseName,
    color: typeof peer.color === "string" && peer.color ? peer.color : "#64748B",
    isTyping: peer.isTyping === true,
    cursorLine: Number.isFinite(Number(peer.cursorLine)) ? Number(peer.cursorLine) : null,
    cursorColumn: Number.isFinite(Number(peer.cursorColumn)) ? Number(peer.cursorColumn) : null,
    updatedAt: Number.isFinite(Number(peer.updatedAt)) ? Number(peer.updatedAt) : Date.now()
  };
}

function normalizeActivity(activity) {
  if (!activity || typeof activity !== "object") return null;
  return {
    id: Number.isFinite(Number(activity.id)) ? Number(activity.id) : Date.now(),
    type: typeof activity.type === "string" ? activity.type : "event",
    role: normalizeRole(activity.role),
    name: typeof activity.name === "string" && activity.name.trim() ? activity.name.trim() : "Peer",
    clientId: typeof activity.clientId === "string" ? activity.clientId : "",
    message: typeof activity.message === "string" && activity.message.trim() ? activity.message.trim() : "Activity updated",
    timestamp: Number.isFinite(Number(activity.timestamp)) ? Number(activity.timestamp) : Date.now()
  };
}

function statusStorageKey(roomKey) {
  return `${PEER_STATUS_PREFIX}${roomKey}`;
}

function activityStorageKey(roomKey) {
  return `${PEER_ACTIVITY_PREFIX}${roomKey}`;
}

function hydrateFromStorage() {
  const activeRoom = parseJson(safeGet(ACTIVE_ROOM_STATUS_KEY), null);
  if (!state.roomKey && activeRoom?.roomKey) state.roomKey = activeRoom.roomKey;
  if (!state.localUrl && activeRoom?.localUrl) state.localUrl = activeRoom.localUrl;
  if (!query.get("role") && activeRoom?.role) state.role = activeRoom.role;
  if (!state.clientId && activeRoom?.clientId) state.clientId = activeRoom.clientId;

  if (!state.roomKey) return;
  const cachedStatus = parseJson(safeGet(statusStorageKey(state.roomKey)), null);
  if (Array.isArray(cachedStatus?.peers)) {
    state.peers = cachedStatus.peers.map(normalizePeer).filter(Boolean);
  }
  const cachedActivity = parseJson(safeGet(activityStorageKey(state.roomKey)), null);
  if (Array.isArray(cachedActivity?.activity)) {
    state.activity = cachedActivity.activity.map(normalizeActivity).filter(Boolean);
  }
}

function persistSnapshot() {
  if (!state.roomKey) return;
  safeSet(statusStorageKey(state.roomKey), JSON.stringify({
    roomKey: state.roomKey,
    localUrl: state.localUrl,
    role: state.role,
    clientId: state.clientId,
    peers: state.peers,
    updatedAt: Date.now()
  }));
  safeSet(activityStorageKey(state.roomKey), JSON.stringify({
    roomKey: state.roomKey,
    localUrl: state.localUrl,
    role: state.role,
    clientId: state.clientId,
    activity: state.activity,
    updatedAt: Date.now()
  }));
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return "";
  }
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function appendEmpty(container, text) {
  const item = document.createElement("div");
  item.className = "empty";
  item.textContent = text;
  container.appendChild(item);
}

function createRoleBadge(role) {
  const badge = document.createElement("span");
  badge.className = `role-badge ${normalizeRole(role)}`;
  badge.textContent = normalizeRole(role);
  return badge;
}

function createPeerCard(peer) {
  const card = document.createElement("article");
  card.className = "peer-card";

  const head = document.createElement("div");
  head.className = "peer-head";

  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.style.backgroundColor = peer.color;
  avatar.textContent = (peer.name || "P").charAt(0).toUpperCase();
  head.appendChild(avatar);

  const name = document.createElement("strong");
  const isSelf = peer.clientId && state.clientId && peer.clientId === state.clientId;
  name.textContent = isSelf ? `${peer.name} (You)` : peer.name;
  head.appendChild(name);
  head.appendChild(createRoleBadge(peer.role));
  card.appendChild(head);

  const line = document.createElement("div");
  line.className = "muted";
  if (peer.cursorLine && peer.cursorColumn) {
    line.textContent = peer.isTyping
      ? `Editing line ${peer.cursorLine}, col ${peer.cursorColumn}`
      : `Cursor at line ${peer.cursorLine}, col ${peer.cursorColumn}`;
  } else {
    line.textContent = peer.isTyping ? "Editing..." : "Idle";
  }
  card.appendChild(line);

  const updated = document.createElement("div");
  updated.className = "muted";
  updated.textContent = `Updated ${formatTime(peer.updatedAt)}`;
  card.appendChild(updated);

  return card;
}

function renderStats() {
  const total = state.peers.length;
  const hosts = state.peers.filter((peer) => peer.role === "host").length;
  const clients = state.peers.filter((peer) => peer.role === "client").length;
  const editing = state.peers.filter((peer) => peer.isTyping).length;
  statsEl.textContent = "";
  [
    `Total: ${total}`,
    `Hosts: ${hosts}`,
    `Clients: ${clients}`,
    `Editing now: ${editing}`
  ].forEach((label) => {
    const item = document.createElement("span");
    item.textContent = label;
    statsEl.appendChild(item);
  });
}

function renderPeers() {
  clearChildren(peerListEl);
  if (state.peers.length === 0) {
    appendEmpty(peerListEl, "No connected peers yet.");
    return;
  }
  state.peers.forEach((peer) => {
    peerListEl.appendChild(createPeerCard(peer));
  });
}

function renderEditingPeers() {
  clearChildren(editingListEl);
  const editingPeers = state.peers.filter((peer) => peer.isTyping);
  if (editingPeers.length === 0) {
    appendEmpty(editingListEl, "Nobody is actively editing right now.");
    return;
  }
  editingPeers.forEach((peer) => {
    editingListEl.appendChild(createPeerCard(peer));
  });
}

function renderActivity() {
  clearChildren(activityListEl);
  if (state.activity.length === 0) {
    appendEmpty(activityListEl, "No activity yet.");
    return;
  }
  state.activity
    .slice()
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 120)
    .forEach((entry) => {
      const row = document.createElement("li");
      row.className = "activity-item";
      const title = document.createElement("div");
      title.textContent = entry.message || `${entry.name} (${entry.type})`;
      const meta = document.createElement("div");
      meta.className = "muted";
      meta.textContent = `${entry.name} • ${entry.type} • ${formatTime(entry.timestamp)}`;
      row.appendChild(title);
      row.appendChild(meta);
      activityListEl.appendChild(row);
    });
}

function renderMeta() {
  roomKeyLabel.textContent = state.roomKey || "-";
  localRoleLabel.textContent = normalizeRole(state.role || "client");
  localRoleLabel.classList.remove("host", "client", "viewer");
  localRoleLabel.classList.add(normalizeRole(state.role || "client"));
  if (state.localUrl) {
    localUrlLabel.textContent = state.localUrl;
    localUrlLabel.href = state.localUrl;
  } else {
    localUrlLabel.textContent = "(not connected)";
    localUrlLabel.removeAttribute("href");
  }
}

function renderAll() {
  renderMeta();
  renderStats();
  renderPeers();
  renderEditingPeers();
  renderActivity();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function refreshFromServer() {
  if (!state.localUrl) return false;
  try {
    const results = await Promise.allSettled([
      fetchJson(`${state.localUrl}/status`),
      fetchJson(`${state.localUrl}/activity`)
    ]);
    const statusResult = results[0].status === "fulfilled" ? results[0].value : null;
    const activityResult = results[1].status === "fulfilled" ? results[1].value : null;
    if (Array.isArray(statusResult?.peerList)) {
      state.peers = statusResult.peerList.map(normalizePeer).filter(Boolean);
    }
    if (Array.isArray(activityResult?.activity)) {
      state.activity = activityResult.activity.map(normalizeActivity).filter(Boolean);
    }
    if (!statusResult && !activityResult) {
      return false;
    }
    persistSnapshot();
    return true;
  } catch {
    return false;
  }
}

async function tick() {
  if (document.hidden) return;
  hydrateFromStorage();
  const updated = await refreshFromServer();
  if (!updated) {
    hydrateFromStorage();
  }
  renderAll();
}

tick();
setInterval(tick, 2000);
window.addEventListener("focus", tick);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) tick();
});
