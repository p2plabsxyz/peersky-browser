import { PRE_JOINED_ROOM_KEY } from "./rooms.js";

const API = "hyper://chat";

const S = {
  profile: null,
  rooms: {},
  peerProfiles: {},
  onlinePeers: new Set(),
  activeRoom: null,
  messages: {},
  reactions: {},
  settings: { sounds: true, notifications: true },
  pendingDMs: {},
};

const REACT_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

let globalES = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let lastSseTime = 0;
let sseHealthTimer = null;
let ctxTarget = null;
let audioCtx;
let replyTarget = null;
let mentionIdx = -1;
let _dmiRoomKey = null;
let driveUrl = null;
let draftDriveUrl = null;
let pendingAvatar = null;
let pendingRoomAvatar = null;
let creatingRoom = false;
let messageSearchQuery = "";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(s) { return s.replace(/[&<>"']/g, (c) => ESC[c]); }

function peerIdEq(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function formatTime(ts) {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return "now";
  if (d < 3600) return Math.floor(d / 60) + "m";
  if (d < 86400) return Math.floor(d / 3600) + "h";
  if (d < 604800) return Math.floor(d / 86400) + "d";
  const dt = new Date(ts);
  return dt.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatDate(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
}

function dateLabelFor(ts) {
  const d = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = (today - msgDay) / 86400000;
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function displayNameFromHyperPath(url) {
  try {
    const u = url.replace(/\/+$/, "");
    const seg = u.split("/").pop() || "";
    const m = seg.match(/^\d+-(.+)$/);
    if (!m) return seg || url;
    const raw = m[1].replace(/_/g, " ");
    try { return decodeURIComponent(raw); } catch { return raw; }
  } catch {
    return url;
  }
}

function formatFileSize(bytes) {
  if (bytes == null || bytes < 0 || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function isHyperFileUrl(url) {
  return /^hyper:\/\//i.test(url) && !isImageFile(url) && !isVideoFile(url);
}

function sanitizeDownloadFilename(name) {
  return (name || "download").replace(/[/\\?%*:|"<>]/g, "_").slice(0, 200) || "download";
}

async function downloadHyperFile(url, filename) {
  const safe = sanitizeDownloadFilename(filename || displayNameFromHyperPath(url));
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const blob = await resp.blob();
    if (typeof window.showSaveFilePicker === "function") {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: safe });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (pickErr) {
        if (pickErr?.name === "AbortError") return;
        console.warn("[chat] Save dialog unavailable, using download link:", pickErr);
      }
    }
    const obj = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = obj;
    a.download = safe;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(obj), 2500);
  } catch (err) {
    console.error("[chat] Download:", err);
    alert("Could not download this file. Use Open (name or icon) to open it in a new tab.");
  }
}

function fileAttachHtml(url, fileNameOpt, fileSizeOpt) {
  const name = fileNameOpt || displayNameFromHyperPath(url);
  const sizeLbl = formatFileSize(fileSizeOpt);
  const escU = esc(url);
  const escN = esc(name);
  return `<div class="msg-file-attach" data-file-url="${escU}">
    <div class="msg-file-attach-open" role="link" tabindex="0" aria-label="Open file in new tab">
      <div class="msg-file-attach-icon"><img class="msg-file-attach-icon-img" src="./assets/svg/p2p.svg" alt="" width="36" height="36" /></div>
      <div class="msg-file-attach-info">
        <span class="msg-file-attach-name">${escN}</span>
        ${sizeLbl ? `<span class="msg-file-attach-size">${esc(sizeLbl)}</span>` : ""}
      </div>
    </div>
    <button type="button" class="msg-file-attach-dl-btn" aria-label="Download file" data-file-url="${escU}" data-file-name="${escN}">
      <img class="msg-file-attach-dl-icon" src="./assets/svg/download.svg" alt="" width="20" height="20" />
    </button>
  </div>`;
}

let emojiKeywordsJsonPromise = null;
const RECENT_EMOJI_KEY = "peerchat-recent-emojis";
const RECENT_EMOJI_MAX = 24;
function getRecentEmojis() {
  try { return JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY) || "[]"); } catch { return []; }
}
function saveRecentEmojis(arr) {
  try { localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(arr)); } catch {}
}
let _recentSectionEl = null;
let _recentGridEl = null;
function renderRecentSection() {
  if (!_recentSectionEl || !_recentGridEl) return;
  const recents = getRecentEmojis();
  _recentSectionEl.style.display = recents.length ? "" : "none";
  _recentGridEl.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const ch of recents) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "emoji-cell"; b.textContent = ch;
    b.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      trackRecentEmoji(ch);
      insertAtCaret($("message-input"), ch);
      closeEmojiPanel();
    });
    frag.appendChild(b);
  }
  _recentGridEl.appendChild(frag);
}
function trackRecentEmoji(ch) {
  let arr = getRecentEmojis().filter((e) => e !== ch);
  arr.unshift(ch);
  if (arr.length > RECENT_EMOJI_MAX) arr = arr.slice(0, RECENT_EMOJI_MAX);
  saveRecentEmojis(arr);
  renderRecentSection();
}

function insertAtCaret(textarea, text) {
  if (!textarea) return;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const v = textarea.value;
  textarea.value = v.slice(0, start) + text + v.slice(end);
  const pos = start + text.length;
  textarea.setSelectionRange(pos, pos);
  textarea.focus();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function closeEmojiPanel() {
  const panel = $("emoji-panel");
  if (!panel) return;
  panel.classList.remove("open");
  panel.setAttribute("aria-hidden", "true");
}

function loadEmojiKeywords() {
  if (!emojiKeywordsJsonPromise) {
    emojiKeywordsJsonPromise = fetch("./lib/emojilib-emoji-en-US.json").then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  return emojiKeywordsJsonPromise;
}

async function initEmojiPanel() {
  const panel = $("emoji-panel");
  if (!panel || panel.dataset.ready) return;
  const raw = await loadEmojiKeywords();
  const byEmoji = Object.create(null);
  for (const k of Object.keys(raw)) {
    if (Array.isArray(raw[k])) byEmoji[k] = raw[k];
  }
  const all = Object.keys(byEmoji);
  panel.replaceChildren();

  const search = document.createElement("input");
  search.type = "search";
  search.className = "emoji-search";
  search.placeholder = "Search keywords…";
  search.autocomplete = "off";
  search.spellcheck = false;

  const recentSection = document.createElement("div");
  const recentLabel = document.createElement("div");
  recentLabel.className = "emoji-section-label";
  recentLabel.textContent = "Recent";
  const recentGrid = document.createElement("div");
  recentGrid.className = "emoji-grid";
  recentSection.appendChild(recentLabel);
  recentSection.appendChild(recentGrid);
  _recentSectionEl = recentSection;
  _recentGridEl = recentGrid;

  const allLabel = document.createElement("div");
  allLabel.className = "emoji-section-label";
  allLabel.textContent = "Emoji";

  const grid = document.createElement("div");
  grid.className = "emoji-grid";

  function pickMatches(q) {
    if (!q) return all;
    return all.filter((emo) => {
      const kws = byEmoji[emo];
      for (let i = 0; i < kws.length; i++) {
        const kw = kws[i];
        if (typeof kw === "string" && kw.includes(q)) return true;
      }
      return false;
    });
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    recentSection.style.display = q ? "none" : "";
    allLabel.style.display = q ? "none" : "";
    const list = pickMatches(q);
    grid.replaceChildren();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < list.length; i++) {
      const ch = list[i];
      const b = document.createElement("button");
      b.type = "button";
      b.className = "emoji-cell";
      b.textContent = ch;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        trackRecentEmoji(ch);
        insertAtCaret($("message-input"), ch);
        closeEmojiPanel();
      });
      frag.appendChild(b);
    }
    grid.appendChild(frag);
  }

  search.addEventListener("input", render);
  search.addEventListener("click", (e) => e.stopPropagation());
  panel.appendChild(search);
  panel.appendChild(recentSection);
  panel.appendChild(allLabel);
  panel.appendChild(grid);
  renderRecentSection();
  render();
  panel.dataset.ready = "1";
}

async function toggleEmojiPanel() {
  const panel = $("emoji-panel");
  if (!panel) return;
  if (panel.classList.contains("open")) {
    closeEmojiPanel();
    return;
  }
  panel.classList.add("open");
  panel.setAttribute("aria-hidden", "false");
  if (!panel.dataset.ready) {
    panel.replaceChildren();
    const p = document.createElement("p");
    p.className = "emoji-load-msg muted small";
    p.textContent = "Loading…";
    panel.appendChild(p);
  }
  try {
    await initEmojiPanel();
    panel.querySelector(".emoji-search")?.focus();
  } catch (err) {
    console.error("[chat] emojilib:", err);
    panel.replaceChildren();
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = "Could not load emoji keywords.";
    panel.appendChild(p);
  }
}

function linkify(text, msg) {
  if (!text) return "";
  const trimmed = text.trim();
  if (/^hyper:\/\//i.test(trimmed) && !/\s/.test(trimmed) && isHyperFileUrl(trimmed)) {
    return fileAttachHtml(trimmed, msg?.fileName, msg?.fileSize);
  }
  const re = /\b(https?|hyper|ipfs|ipns):\/\/[^\s<>"']+/gi;
  const parts = [];
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(esc(text.slice(last, m.index)));
    const url = m[0];
    if (isImageFile(url)) {
      parts.push(`<img class="msg-file-img" src="${esc(url)}" alt="image" loading="lazy" />`);
    } else if (isVideoFile(url)) {
      parts.push(`<video class="msg-file-img" src="${esc(url)}" controls preload="metadata"></video>`);
    } else if (isHyperFileUrl(url)) {
      parts.push(fileAttachHtml(url, null, null));
    } else {
      parts.push(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`);
    }
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(esc(text.slice(last)));
  let html = parts.join("");
  html = html.replace(/@(\w+)/g, '<span class="mention" data-mention="$1">@$1</span>');
  return html.replace(/\n/g, "<br>");
}

const MAX_DATA_IMAGE_URL_LEN = 1_500_000;
function safeAvatarUrl(u) {
  if (u == null || typeof u !== "string") return "";
  const t = u.trim();
  if (!t.startsWith("data:image/") || t.length > MAX_DATA_IMAGE_URL_LEN) return "";
  return t;
}

function chatMessageRenders(m) {
  if (!m) return false;
  if (m.type === "reaction") return false;
  if (m.type === "system") {
    return typeof m.text === "string" && m.text.trim().length > 0;
  }
  const text = typeof m.message === "string" ? m.message : "";
  if (text.trim().length > 0) return true;
  if (m.fileName) return true;
  const t = text.trim();
  return !!(t && /^hyper:\/\//i.test(t) && isHyperFileUrl(t));
}

function processReactionEntry(roomKey, msg) {
  if (!msg.msgId || !msg.sender) return;
  if (!S.reactions[roomKey]) S.reactions[roomKey] = {};
  if (!S.reactions[roomKey][msg.msgId]) S.reactions[roomKey][msg.msgId] = {};
  const byUser = S.reactions[roomKey][msg.msgId];
  if (byUser[msg.sender] && byUser[msg.sender].ts > (msg.timestamp || 0)) return;
  if (!msg.emoji) { delete byUser[msg.sender]; } else {
    byUser[msg.sender] = { emoji: msg.emoji, username: msg.senderName || msg.sender, ts: msg.timestamp || 0 };
  }
}

function extractReactions(roomKey, rawMsgs) {
  S.reactions[roomKey] = {};
  const chat = [];
  for (const m of rawMsgs) {
    if (m.type === "reaction") processReactionEntry(roomKey, m);
    else if (chatMessageRenders(m)) chat.push(m);
  }
  return chat;
}

function getReactionSummary(roomKey, msgId) {
  const byUser = S.reactions[roomKey]?.[msgId];
  if (!byUser) return [];
  const grouped = {};
  for (const [peerId, { emoji, username }] of Object.entries(byUser)) {
    if (!emoji) continue;
    if (!grouped[emoji]) grouped[emoji] = [];
    grouped[emoji].push({ peerId, username });
  }
  return Object.entries(grouped).map(([emoji, users]) => ({ emoji, users, count: users.length }));
}

function renderReactionBubbles(roomKey, msgId) {
  const summary = getReactionSummary(roomKey, msgId);
  const frag = document.createDocumentFragment();
  for (const { emoji, users, count } of summary) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "reaction-bubble";
    const isMine = users.some(u => u.peerId === S.profile?.id);
    if (isMine) b.classList.add("reaction-mine");
    b.textContent = `${emoji} ${count}`;
    b.title = users.map(u => u.username).join(", ");
    b.addEventListener("click", (e) => { e.stopPropagation(); sendReaction(roomKey, msgId, emoji); });
    frag.appendChild(b);
  }
  return frag;
}

function updateReactionBubblesFor(msgId) {
  const rk = S.activeRoom;
  if (!rk) return;
  const el = document.querySelector(`[data-msg-id="${CSS.escape(String(msgId))}"]`);
  if (!el) return;
  let row = el.querySelector(".msg-reactions");
  if (!row) {
    row = document.createElement("div");
    row.className = "msg-reactions";
    const timeEl = el.querySelector(".msg-time");
    if (timeEl) el.insertBefore(row, timeEl);
    else el.appendChild(row);
  }
  row.replaceChildren(renderReactionBubbles(rk, msgId));
  row.style.display = row.childNodes.length ? "" : "none";
}

async function sendReaction(roomKey, msgId, emoji) {
  const existing = S.reactions[roomKey]?.[msgId]?.[S.profile?.id];
  const finalEmoji = (existing?.emoji === emoji) ? "" : emoji;
  try {
    await api("react", { roomKey, body: { msgId, emoji: finalEmoji } });
    if (finalEmoji) playSound("pop");
  } catch (err) { console.error("[chat] react:", err); }
}

let _activeReactPicker = null;
function closeReactPicker() {
  if (_activeReactPicker) { _activeReactPicker.remove(); _activeReactPicker = null; }
}
function showReactPicker(anchor, roomKey, msgId) {
  closeReactPicker();
  const picker = document.createElement("div");
  picker.className = "react-picker";
  for (const em of REACT_EMOJIS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "react-picker-btn";
    b.textContent = em;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeReactPicker();
      sendReaction(roomKey, msgId, em);
    });
    picker.appendChild(b);
  }
  document.body.appendChild(picker);
  _activeReactPicker = picker;
  const rect = anchor.getBoundingClientRect();
  picker.style.top = (rect.top - picker.offsetHeight - 4) + "px";
  picker.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - picker.offsetWidth - 4)) + "px";
  const dismiss = (ev) => {
    if (!picker.contains(ev.target)) { closeReactPicker(); document.removeEventListener("click", dismiss, true); }
  };
  setTimeout(() => document.addEventListener("click", dismiss, true), 0);
}

const _blobUrlCache = new Map();
const _blobToDataCache = new Map();
function dataToBlobUrl(dataUrl) {
  if (_blobUrlCache.has(dataUrl)) return _blobUrlCache.get(dataUrl);
  try {
    const [hdr, b64] = dataUrl.split(",");
    const mime = hdr.match(/:(.*?);/)?.[1] || "image/jpeg";
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([arr], { type: mime }));
    _blobUrlCache.set(dataUrl, url);
    _blobToDataCache.set(url, dataUrl);
    return url;
  } catch { return dataUrl; }
}

function avatar(name, sz, customUrl) {
  const safe = safeAvatarUrl(customUrl);
  if (safe) return dataToBlobUrl(safe);
  return typeof LetterAvatar !== "undefined"
    ? LetterAvatar.generate(name || "?", sz || 40)
    : "";
}

function resizeImage(file, maxPx = 369) {
  return new Promise((resolve, reject) => {
    if (file.size > 1024 * 1024) { reject(new Error("Image must be under 1 MB")); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        const s = Math.min(maxPx / Math.max(img.width, img.height), 1);
        c.width = img.width * s; c.height = img.height * s;
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function getDriveUrl() {
  if (driveUrl) return driveUrl;
  try {
    const resp = await fetch("hyper://localhost/?key=peerchat", { method: "POST" });
    if (resp.ok) {
      const text = await resp.text();
      const match = text.match(/(hyper:\/\/[a-f0-9]+\/)/);
      driveUrl = match ? match[1] : text.trim();
      if (!driveUrl.endsWith("/")) driveUrl += "/";
      return driveUrl;
    }
  } catch (e) { console.error("Drive init error:", e); }
  return null;
}

async function getDraftDriveUrl() {
  if (draftDriveUrl) return draftDriveUrl;
  try {
    const resp = await fetch("hyper://localhost/?key=peerchat-rooms", { method: "POST" });
    if (resp.ok) {
      const text = await resp.text();
      const match = text.match(/(hyper:\/\/[a-f0-9]+\/)/);
      draftDriveUrl = match ? match[1] : text.trim();
      if (!draftDriveUrl.endsWith("/")) draftDriveUrl += "/";
      return draftDriveUrl;
    }
  } catch (e) { console.error("Draft drive init error:", e); }
  return null;
}

async function saveDrafts() {
  try {
    const base = await getDraftDriveUrl();
    if (!base) return;
    for (const [rk, room] of Object.entries(S.rooms)) {
      const payload = {
        roomKey: rk,
        name: room.name || "",
        bio: room.bio || "",
        avatar: room.avatar || null,
        createdAt: room.createdAt || null,
        createdBy: room.createdBy || "",
        createdByName: room.createdByName || "",
        savedAt: Date.now(),
      };
      await fetch(`${base}${rk}.json`, {
        method: "PUT",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      }).catch(() => {});
    }
  } catch (e) { console.error("saveDrafts error:", e); }
}

function isImageFile(name) { return /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(name); }
function isVideoFile(name) { return /\.(mp4|webm|mov|ogg)$/i.test(name); }

function updateTabTitle() {
  let total = 0;
  for (const r of Object.values(S.rooms)) total += (r.unreadCount || 0);
  document.title = total > 0 ? `(${total}) PeerChat` : "PeerChat";
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return fallbackCopy(text);
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0;left:-9999px";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch {}
  document.body.removeChild(ta);
  return Promise.resolve();
}

const _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const _audioBuffers = {};

function initAudio() {
  if (_audioCtx.state === "suspended") _audioCtx.resume();
  ["send", "receive", "notification", "pop"].forEach(file => {
    if (_audioBuffers[file]) return;
    fetch(`./assets/sound/${file}.mp3`)
      .then(r => r.arrayBuffer())
      .then(buf => _audioCtx.decodeAudioData(buf))
      .then(decoded => { _audioBuffers[file] = decoded; })
      .catch(err => console.warn("Sound preload failed:", file, err));
  });
}

function playSound(type) {
  if (type === "send" || type === "receive" || type === "pop") {
    if (!S.settings.sounds) return;
  } else {
    if (!S.settings.notifications) return;
  }
  const room = S.rooms[S.activeRoom];
  if (room?.isMuted && type !== "mention" && type !== "send") return;
  const fileMap = { send: "send", receive: "receive", message: "notification", mention: "notification", pop: "pop" };
  const file = fileMap[type] || "receive";
  if (_audioCtx.state === "suspended") _audioCtx.resume();
  const play = (buf) => {
    try {
      const src = _audioCtx.createBufferSource();
      const gain = _audioCtx.createGain();
      gain.gain.value = 0.5;
      src.buffer = buf;
      src.connect(gain);
      gain.connect(_audioCtx.destination);
      src.start(0);
    } catch (e) { console.warn("playSound error:", e); }
  };
  if (_audioBuffers[file]) {
    play(_audioBuffers[file]);
  } else {
    fetch(`./assets/sound/${file}.mp3`)
      .then(r => r.arrayBuffer())
      .then(buf => _audioCtx.decodeAudioData(buf))
      .then(decoded => { _audioBuffers[file] = decoded; play(decoded); })
      .catch((err) => {
        console.warn("playSound decode failed, trying <audio>:", file, err);
        const a = new Audio(`./assets/sound/${file}.mp3`);
        a.volume = 0.42;
        a.play().catch(() => {});
      });
  }
}

async function api(action, opts = {}) {
  const qs = opts.roomKey ? `?action=${action}&roomKey=${opts.roomKey}` : `?action=${action}`;
  const init = {};
  if (opts.body) {
    init.method = "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  } else if (opts.post) {
    init.method = "POST";
  }
  const res = await fetch(`${API}${qs}`, init);
  if (!res.ok) throw new Error(`${action}: ${res.statusText}`);
  return res.json();
}

function hideBoot() {
  $("boot-screen")?.setAttribute("hidden", "");
}

async function init() {
  try {
    const profile = await api("get-profile");
    hideBoot();
    if (!profile.username) { showOnboarding(); return; }
    S.profile = profile;
    S.settings.notifications = profile.notifications ?? true;
    await loadRooms();
    showApp();
    connectGlobalSSE();
    getDriveUrl().catch(() => {});
    getDraftDriveUrl().then(() => saveDrafts()).catch(() => {});
  } catch (err) {
    console.error("Init error:", err);
    hideBoot();
    showOnboarding();
  }
}

async function loadRooms() {
  const data = await api("get-rooms");
  S.rooms = {};
  S.peerProfiles = data.peerProfiles || {};
  S.onlinePeers = new Set(data.onlinePeers || []);
  S.pendingDMs = data.pendingDMs || {};
  for (const r of data.rooms) S.rooms[r.roomKey] = r;
}

function showOnboarding() {
  $("onboarding")?.removeAttribute("hidden");
  $("app")?.setAttribute("hidden", "");
}

$("onboard-submit")?.addEventListener("click", async () => {
  initAudio();
  const username = $("onboard-username").value.trim();
  if (!username) { alert("Username required."); return; }
  try {
    const { profile } = await api("save-profile", { body: { username, bio: $("onboard-bio").value.trim() } });
    S.profile = profile;
    S.settings.sounds = true;
    S.settings.notifications = profile.notifications ?? true;
    if (PRE_JOINED_ROOM_KEY && !/^0+$/.test(PRE_JOINED_ROOM_KEY)) {
      await api("join", { roomKey: PRE_JOINED_ROOM_KEY, post: true }).catch(() => {});
    }
    await loadRooms();
    showApp();
    connectGlobalSSE();
  } catch (err) { alert(err.message); }
});

function showApp() {
  $("onboarding")?.setAttribute("hidden", "");
  $("app")?.removeAttribute("hidden");
  $("sidebar-avatar").src = avatar(S.profile.username, 32, S.profile.avatar);
  $("sidebar-username").textContent = S.profile.username;
  renderRoomList();
  initAudio();
  resizeMessageField();
  if (S.activeRoom && S.rooms[S.activeRoom]) {
    openRoom(S.activeRoom);
  }
}

function resizeMessageField() {
  const el = $("message-input");
  if (!el || el.tagName !== "TEXTAREA") return;
  const maxPx = 140;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, maxPx) + "px";
  el.style.overflowY = el.scrollHeight > maxPx ? "auto" : "hidden";
}

function roomMatchesSidebarQuery(r, q) {
  if (!q) return true;
  const name = (r.name || "").toLowerCase();
  const key = (r.roomKey || "").toLowerCase();
  const lm = r.lastMessage;
  const tail = lm
    ? `${lm.senderName || lm.sender || ""} ${lm.message || ""}`.toLowerCase()
    : "";
  return name.includes(q) || key.includes(q) || tail.includes(q);
}

function renderRoomList() {
  const list = $("room-list");
  list.innerHTML = "";
  const q = ($("room-search")?.value || "").trim().toLowerCase();
  const sorted = Object.values(S.rooms).sort((a, b) => {
    if (a.isPinned && !b.isPinned) return -1;
    if (!a.isPinned && b.isPinned) return 1;
    return (b.lastMessage?.timestamp || b.createdAt || 0) - (a.lastMessage?.timestamp || a.createdAt || 0);
  });
  const rows = q ? sorted.filter((r) => roomMatchesSidebarQuery(r, q)) : sorted;
  for (const r of rows) list.appendChild(makeRoomEl(r));
  updateTabTitle();
}

function resetMessageSearch() {
  messageSearchQuery = "";
  const inp = $("message-search");
  const panel = $("chat-message-search-panel");
  const btn = $("chat-search-btn");
  if (inp) inp.value = "";
  if (panel) panel.hidden = true;
  if (btn) btn.classList.remove("active");
}

function closeMessageSearchPanel() {
  const hadFilter = messageSearchQuery.trim() !== "";
  resetMessageSearch();
  if (hadFilter && S.activeRoom) renderMessages(S.activeRoom);
}

function openMessageSearchPanel() {
  const panel = $("chat-message-search-panel");
  const btn = $("chat-search-btn");
  const inp = $("message-search");
  if (!panel || !btn) return;
  panel.hidden = false;
  btn.classList.add("active");
  messageSearchQuery = inp?.value || "";
  queueMicrotask(() => inp?.focus());
  if (S.activeRoom) renderMessages(S.activeRoom);
}

function toggleMessageSearchPanel() {
  const panel = $("chat-message-search-panel");
  if (!panel) return;
  if (panel.hidden) openMessageSearchPanel();
  else closeMessageSearchPanel();
}

function makeRoomEl(r) {
  const el = document.createElement("div");
  el.className = "room-item" + (S.activeRoom === r.roomKey ? " active" : "");
  el.dataset.key = r.roomKey;

  const preview = r.lastMessage
    ? `${r.lastMessage.senderName || r.lastMessage.sender}: ${r.lastMessage.message}`
    : "No messages yet";

  el.innerHTML = `
    <img class="room-avatar" src="${esc(avatar(r.name, 36, r.avatar))}" />
    <div class="room-info">
      <span class="room-name">${esc(r.name || r.roomKey.slice(0, 8) + "...")}</span>
      <span class="room-preview">${esc(preview.slice(0, 60))}</span>
    </div>
    <div class="room-meta">
      ${r.isMuted ? '<img src="./assets/svg/mute.svg" class="room-icon" alt="Muted" title="Muted" />' : ""}
      ${r.isPinned ? '<img src="./assets/svg/pin.svg" class="room-icon" alt="Pinned" title="Pinned" />' : ""}
      ${r.lastMessage ? `<span class="room-time">${formatTime(r.lastMessage.timestamp)}</span>` : ""}
      ${r.unreadCount > 0 ? `<span class="badge">${r.unreadMentions > 0 ? "@" : ""}${r.unreadCount}</span>` : ""}
    </div>
    <button class="room-dots" title="Options">&#8942;</button>
  `;

  el.querySelector(".room-dots").addEventListener("click", (e) => {
    e.stopPropagation();
    showCtxMenu(e, r.roomKey);
  });
  el.addEventListener("click", () => openRoom(r.roomKey));
  return el;
}

function refreshRoomHeader(key) {
  let tries = 0;
  const poll = setInterval(async () => {
    if (tries++ >= 20 || S.activeRoom !== key) { clearInterval(poll); return; }
    try {
      await loadRooms();
      const room = S.rooms[key];
      if (room && room.name && room.name !== key.slice(0, 8) + "...") {
        renderRoomList();
        $("chat-room-name").textContent = room.name;
        $("chat-room-avatar").src = avatar(room.name, 32, room.avatar);
        clearInterval(poll);
      }
    } catch {}
  }, 1500);
}

function applyDMComposerGate(roomKey) {
  if (S.activeRoom !== roomKey) return;
  const room = S.rooms[roomKey];
  const messageInput = $("message-input");
  const sendBtn = $("send-btn");
  if (!room || !messageInput || !sendBtn) return;
  if (room.isDM && (S.pendingDMs?.[roomKey] || room.pendingAcceptance)) {
    messageInput.disabled = true;
    messageInput.placeholder = "Waiting for the other peer to accept your message request...";
    sendBtn.disabled = true;
  } else {
    messageInput.disabled = false;
    messageInput.placeholder = "Type a message…";
    sendBtn.disabled = false;
    queueMicrotask(() => messageInput?.focus());
  }
}

async function openRoom(roomKey) {
  S.activeRoom = roomKey;
  const room = S.rooms[roomKey];
  if (!room) return;

  resetMessageSearch();

  // Capture unread state before clearing for "New Messages" divider
  const hasUnread = (room.unreadCount || 0) > 0;
  const lastReadTs = hasUnread ? (room.lastReadTs || 0) : 0;

  $("chat-empty").style.display = "none";
  $("chat-active").style.display = "flex";
  $("chat-room-avatar").src = avatar(room.name, 32, room.avatar);
  $("chat-room-name").textContent = room.name || roomKey.slice(0, 8) + "...";
  const _initCount = roomOnlineCount(roomKey);
  $("chat-room-peers").textContent = `${_initCount} peer${_initCount !== 1 ? "s" : ""}`;
  $("messages").innerHTML = "";

  applyDMComposerGate(roomKey);

  room.unreadCount = 0;
  room.unreadMentions = 0;
  renderRoomList();
  updateTabTitle();

  await api("set-active", { roomKey, post: true });
  await api("mark-read", { roomKey, post: true });

  try {
    const { messages } = await api("get-history", { roomKey });
    const merged = mergeWithHistory(S.messages[roomKey], messages || []);
    S.messages[roomKey] = extractReactions(roomKey, merged);
    renderMessages(roomKey, true, lastReadTs);

    const _roomNow = S.rooms[roomKey];
    if (_roomNow?.name && _roomNow.name !== roomKey.slice(0, 8) + "...") {
      $("chat-room-name").textContent = _roomNow.name;
      $("chat-room-avatar").src = avatar(_roomNow.name, 32, _roomNow.avatar);
    }
    applyDMComposerGate(roomKey);

    let retries = 0;
    const syncCheck = setInterval(async () => {
      if (S.activeRoom !== roomKey || !S.rooms[roomKey] || retries++ >= 20) { clearInterval(syncCheck); return; }
      try {
        const _r = S.rooms[roomKey];
        const headerName = $("chat-room-name")?.textContent || "";
        const isPlaceholder = !_r?.name || _r.name === roomKey.slice(0, 8) + "...";
        if (isPlaceholder || headerName === roomKey.slice(0, 8) + "...") {
          const { rooms } = await api("get-rooms");
          const fresh = rooms.find(r => r.roomKey === roomKey);
          if (fresh?.name && fresh.name !== roomKey.slice(0, 8) + "...") {
            Object.assign(S.rooms[roomKey], fresh);
            $("chat-room-name").textContent = fresh.name;
            $("chat-room-avatar").src = avatar(fresh.name, 32, fresh.avatar);
            renderRoomList();
            applyDMComposerGate(roomKey);
          }
        } else if (headerName !== _r.name) {
          $("chat-room-name").textContent = _r.name;
          $("chat-room-avatar").src = avatar(_r.name, 32, _r.avatar);
        }
        const { messages: freshMsgs } = await api("get-history", { roomKey });
        const bufLen = (S.messages[roomKey] || []).length;
        const msgContainer = $("messages");
        const domCount = msgContainer ? msgContainer.querySelectorAll(".message, .system-msg").length : 0;
        if (freshMsgs && (freshMsgs.length > bufLen || (bufLen > 0 && domCount < bufLen))) {
          S.messages[roomKey] = extractReactions(roomKey, mergeWithHistory(S.messages[roomKey], freshMsgs));
          renderMessages(roomKey, false);
        }
      } catch {}
    }, 3000);
  } catch (err) {
    console.error("History load error:", err);
    S.messages[roomKey] = extractReactions(roomKey, mergeWithHistory(S.messages[roomKey], []));
  }
}

function messageMatchesSearch(m, q) {
  if (!q) return true;
  if (m.type === "system") return (m.text || "").toLowerCase().includes(q);
  return (m.message || "").toLowerCase().includes(q);
}

function renderMessages(roomKey, scrollToBottom = true, lastReadTs = 0) {
  const container = $("messages");
  const savedScroll = container.scrollTop;
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  container.innerHTML = "";
  const dz = document.createElement("div");
  dz.id = "dropzone";
  dz.className = "dropzone";
  dz.style.display = "none";
  dz.textContent = "Drop file here";
  container.appendChild(dz);
  const q = messageSearchQuery.trim().toLowerCase();
  let msgs = S.messages[roomKey] || [];
  if (q) msgs = msgs.filter((m) => messageMatchesSearch(m, q));
  let lastDateLabel = "";
  let unreadDividerInserted = false;
  for (const m of msgs) {
    if (m.type === "system") {
      if (!chatMessageRenders(m)) continue;
      const el = document.createElement("div");
      el.className = "system-msg";
      el.textContent = m.text;
      container.appendChild(el);
      continue;
    }
    if (!chatMessageRenders(m)) continue;
    if (!unreadDividerInserted && lastReadTs && m.timestamp && m.timestamp > lastReadTs) {
      const divider = document.createElement("div");
      divider.className = "unread-divider";
      divider.id = "unread-divider";
      divider.textContent = "New Messages";
      container.appendChild(divider);
      unreadDividerInserted = true;
    }
    const label = dateLabelFor(m.timestamp);
    if (label !== lastDateLabel) {
      lastDateLabel = label;
      const sep = document.createElement("div");
      sep.className = "date-separator";
      sep.textContent = label;
      container.appendChild(sep);
    }
    container.appendChild(makeMsgEl(m));
  }
  if (scrollToBottom) {
    const divider = document.getElementById("unread-divider");
    if (divider) {
      requestAnimationFrame(() => { divider.scrollIntoView({ block: "start" }); });
    } else {
      requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
    }
  } else if (wasAtBottom) {
    requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
  } else {
    requestAnimationFrame(() => { container.scrollTop = savedScroll; });
  }
}

function mergeWithHistory(existing, incoming) {
  const incomingIds = new Set((incoming || []).filter(m => m.id).map(m => m.id));
  const extra = (existing || []).filter(m => m.id && !incomingIds.has(m.id));
  const combined = [...(incoming || []), ...extra];
  combined.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return combined;
}

function roomOnlineCount(roomKey) {
  const room = S.rooms[roomKey];
  if (!room) return 0;
  if (room.isDM) return (room.dmWith && S.onlinePeers.has(room.dmWith)) ? 1 : 0;
  return Object.keys(room.members || {}).filter(id => S.onlinePeers.has(id)).length;
}

function updateRoomPeerCount(roomKey) {
  if (roomKey !== S.activeRoom) return;
  const c = roomOnlineCount(roomKey);
  $("chat-room-peers").textContent = `${c} peer${c !== 1 ? "s" : ""}`;
}

function makeMsgEl(msg) {
  const self = msg.sender === S.profile?.id;
  const el = document.createElement("div");
  el.className = `message ${self ? "msg-right" : "msg-left"}`;
  el.dataset.msgId = msg.id || "";

  const displayName = self ? "You" : (S.peerProfiles[msg.sender]?.username || msg.senderName || msg.sender);

  if (!self) {
    const hdr = document.createElement("div");
    hdr.className = "msg-header";
    const peerAvatar = S.peerProfiles[msg.sender]?.avatar || null;
    hdr.innerHTML = `<img class="msg-avatar" src="${esc(avatar(displayName, 20, peerAvatar))}" /><span class="msg-sender">${esc(displayName)}</span>`;
    hdr.addEventListener("click", () => showUserInfo(msg.sender, displayName));
    el.appendChild(hdr);
  }

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  if (msg.replyTo) {
    const quote = document.createElement("div");
    quote.className = "msg-reply-quote";
    quote.innerHTML = `<div class="reply-author">${esc(msg.replyTo.sn || msg.replyTo.sender || "")}</div>${esc((msg.replyTo.text || "").slice(0, 120)).replace(/\n/g, "<br>")}`;
    quote.addEventListener("click", () => scrollToMsg(msg.replyTo.id));
    bubble.appendChild(quote);
  }

  const textNode = document.createElement("span");
  textNode.className = "msg-bubble-body";
  textNode.innerHTML = linkify(msg.message, msg);
  bubble.appendChild(textNode);

  const reactTrigger = document.createElement("button");
  reactTrigger.type = "button";
  reactTrigger.className = "msg-react-trigger";
  reactTrigger.innerHTML = `<img src="./assets/svg/smile.svg" alt="" width="16" height="16" />`;
  reactTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    showReactPicker(reactTrigger, S.activeRoom, msg.id);
  });
  bubble.appendChild(reactTrigger);
  el.appendChild(bubble);

  const rk = S.activeRoom;
  const summary = getReactionSummary(rk, msg.id);
  if (summary.length) {
    const row = document.createElement("div");
    row.className = "msg-reactions";
    row.appendChild(renderReactionBubbles(rk, msg.id));
    el.appendChild(row);
  }

  const time = document.createElement("div");
  time.className = "msg-time";
  time.textContent = formatTime(msg.timestamp);
  el.appendChild(time);

  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showMsgMenu(e, msg);
  });

  el.addEventListener("dblclick", (e) => {
    if (e.target.closest("a, .msg-file-attach-open, .msg-file-attach-dl-btn, .msg-reply-quote, img, video, button, .msg-react-trigger, .reaction-bubble")) return;
    setReply(msg);
  });

  return el;
}

function scrollToMsg(id) {
  if (id == null || id === "") return;
  const target = document.querySelector(`[data-msg-id="${CSS.escape(String(id))}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.style.outline = "2px solid var(--accent)";
  setTimeout(() => { target.style.outline = ""; }, 1500);
}

function showMsgMenu(e, msg) {
  const menu = $("msg-menu");
  menu.style.top = e.clientY + "px";
  menu.style.left = e.clientX + "px";
  menu.classList.add("open");
  menu._msg = msg;
}

$("msg-menu")?.addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  const menu = $("msg-menu");
  const msg = menu._msg;
  menu.classList.remove("open");
  if (!action || !msg) return;
  if (action === "reply") setReply(msg);
  if (action === "copy-msg") copyText(msg.message);
  if (action === "info") showMsgInfo(e, msg);
});

function showMsgInfo(e, msg) {
  let popup = $("msg-info-popup");
  if (!popup) {
    popup = document.createElement("div");
    popup.id = "msg-info-popup";
    popup.className = "msg-info-popup";
    document.body.appendChild(popup);
  }
  const d = new Date(msg.timestamp);
  const sender = msg.sender === S.profile?.id ? "You" : (msg.senderName || msg.sender);
  popup.innerHTML = `<strong>${esc(sender)}</strong><br>Sent: ${d.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" })} at ${d.toLocaleTimeString()}`;
  popup.style.top = e.clientY + "px";
  popup.style.left = e.clientX + "px";
  popup.style.display = "block";
  setTimeout(() => { popup.style.display = "none"; }, 4000);
  const dismiss = () => { popup.style.display = "none"; document.removeEventListener("click", dismiss); };
  setTimeout(() => document.addEventListener("click", dismiss), 100);
}

function setReply(msg) {
  const name = msg.sender === S.profile?.id ? "You" : (msg.senderName || msg.sender);
  replyTarget = { id: msg.id, sender: msg.sender, sn: name, text: msg.message };
  $("reply-preview").innerHTML = `<span class="reply-author">${esc(name)}</span>${esc(msg.message.slice(0, 100))}`;
  $("reply-bar").style.display = "flex";
  $("message-input").focus();
}

$("reply-cancel")?.addEventListener("click", () => {
  replyTarget = null;
  $("reply-bar").style.display = "none";
});

function appendSystemMsg(roomKey, text) {
  if (!S.messages[roomKey]) S.messages[roomKey] = [];
  S.messages[roomKey].push({ type: "system", text, id: `sys-${Date.now()}-${Math.random().toString(36).slice(2)}`, timestamp: Date.now() });
  if (roomKey !== S.activeRoom) return;
  if (messageSearchQuery.trim()) {
    renderMessages(roomKey);
    return;
  }
  const container = $("messages");
  const el = document.createElement("div");
  el.className = "system-msg";
  el.textContent = text;
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  container.appendChild(el);
  if (atBottom) container.scrollTop = container.scrollHeight;
}

function appendMessage(roomKey, msg) {
  if (!chatMessageRenders(msg)) return false;
  if (!S.messages[roomKey]) S.messages[roomKey] = [];
  if (S.messages[roomKey].some((m) => m.id && m.id === msg.id)) return false;
  S.messages[roomKey].push(msg);

  if (roomKey === S.activeRoom) {
    if (messageSearchQuery.trim()) {
      renderMessages(roomKey);
      return true;
    }
    const container = $("messages");
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    let el;
    if (msg.type === "system") {
      el = document.createElement("div");
      el.className = "system-msg";
      el.textContent = msg.text;
    } else {
      el = makeMsgEl(msg);
      el.classList.add("msg-animate");
    }
    container.appendChild(el);
    if (atBottom) container.scrollTop = container.scrollHeight;
  }
  return true;
}

function patchRoomsForPeer(peerId, username, bio, peerAvatar, restrictKeys) {
  const fillMember = (room) => {
    if (!room.members) room.members = {};
    room.members[peerId] = {
      ...(room.members[peerId] || {}),
      username, bio, avatar: peerAvatar,
      joinedAt: room.members[peerId]?.joinedAt || Date.now(),
    };
  };
  const fillDM = (room) => {
    room.name = username;
    room.bio = bio || "";
    room.avatar = peerAvatar;
  };
  if (restrictKeys?.length) {
    for (const rk of restrictKeys) {
      const room = S.rooms[rk];
      if (!room) continue;
      fillMember(room);
      if (room.isDM && peerIdEq(room.dmWith, peerId)) fillDM(room);
    }
    return;
  }
  for (const room of Object.values(S.rooms)) {
    if (room.members?.[peerId]) fillMember(room);
    if (room.isDM && peerIdEq(room.dmWith, peerId)) fillDM(room);
  }
}

function refreshActiveChatForPeer(peerId, username, peerAvatar) {
  if (!S.activeRoom) return;
  const activeRoom = S.rooms[S.activeRoom];
  if (activeRoom?.isDM && peerIdEq(activeRoom.dmWith, peerId)) {
    $("chat-room-name").textContent = username;
    $("chat-room-avatar").src = avatar(username, 32, peerAvatar);
  }
  const msgs = S.messages[S.activeRoom];
  if (!msgs?.length) return;
  let changed = false;
  for (const m of msgs) {
    if (peerIdEq(m.sender, peerId)) { m.senderName = username; changed = true; }
  }
  if (changed) renderMessages(S.activeRoom, false);
}

async function refreshActiveRoom() {
  try {
    await loadRooms();
    renderRoomList();
    if (S.activeRoom) {
      const room = S.rooms[S.activeRoom];
      if (room) {
        $("chat-room-name").textContent = room.name || S.activeRoom.slice(0, 8) + "...";
        $("chat-room-avatar").src = avatar(room.name, 32, room.avatar);
      }
      const { messages: fresh } = await api("get-history", { roomKey: S.activeRoom });
      const _existing = S.messages[S.activeRoom] || [];
      if (fresh && fresh.length > _existing.length) {
        S.messages[S.activeRoom] = extractReactions(S.activeRoom, mergeWithHistory(_existing, fresh));
        renderMessages(S.activeRoom, false);
      }
      updateRoomPeerCount(S.activeRoom);
    }
  } catch {}
}

function connectGlobalSSE() {
  if (globalES) globalES.close();
  if (sseHealthTimer) { clearInterval(sseHealthTimer); sseHealthTimer = null; }
  reconnectDelay = 1000;
  lastSseTime = Date.now();

  const es = new EventSource(`${API}?action=receive-all`);
  globalES = es;

  const touch = () => { lastSseTime = Date.now(); };

  es.addEventListener("heartbeat", touch);

  es.addEventListener("identity", (ev) => {
    touch();
    try {
      const { id } = JSON.parse(ev.data);
      if (S.profile) S.profile.id = id;
    } catch {}
  });

  es.addEventListener("message", (ev) => {
    touch();
    try {
      const msg = JSON.parse(ev.data);
      const rk = msg.roomKey;
      if (!rk) return;
      if (msg.type === "reaction") {
        processReactionEntry(rk, msg);
        if (rk === S.activeRoom) updateReactionBubblesFor(msg.msgId);
        const room = S.rooms[rk];
        if (room && msg.sender !== S.profile?.id) {
          const reactName = S.peerProfiles[msg.sender]?.username || msg.senderName || msg.sender;
          if (msg.emoji) {
            room.lastMessage = {
              sender: msg.sender, senderName: reactName,
              message: `reacted ${msg.emoji}`, timestamp: msg.timestamp,
            };
          }
          if (rk !== S.activeRoom) {
            room.unreadCount = (room.unreadCount || 0) + 1;
            if (!room.isMuted) playSound("message");
          } else {
            if (!room.isMuted) playSound("pop");
          }
          renderRoomList();
          updateTabTitle();
        } else if (room && msg.sender === S.profile?.id && msg.emoji) {
          room.lastMessage = {
            sender: msg.sender, senderName: "You",
            message: `reacted ${msg.emoji}`, timestamp: msg.timestamp,
          };
          renderRoomList();
        }
        return;
      }
      if (!appendMessage(rk, msg)) return;

      const room = S.rooms[rk];
      if (!room) return;
      const isSystem = msg.type === "system";
      if (room.isDM && room.pendingAcceptance && room.dmWith && msg.sender && !isSystem &&
          peerIdEq(msg.sender, room.dmWith)) {
        room.pendingAcceptance = false;
        delete S.pendingDMs?.[rk];
        applyDMComposerGate(rk);
      }
      const msgText = typeof msg.message === "string" ? msg.message : "";
      if (!isSystem && msgText) {
        room.lastMessage = {
          sender: msg.sender,
          senderName: msg.senderName,
          message: msgText.slice(0, 120),
          timestamp: msg.timestamp,
        };
      }

      if (!isSystem && msg.sender !== S.profile?.id) {
        if (rk !== S.activeRoom) {
          room.unreadCount = (room.unreadCount || 0) + 1;
          if (msgText && isMentioned(msgText)) {
            room.unreadMentions = (room.unreadMentions || 0) + 1;
            playSound("mention");
          } else if (!room.isMuted) {
            playSound("message");
          }
        } else {
          if (msgText && isMentioned(msgText) && !room.isMuted) {
            playSound("mention");
          } else if (!room.isMuted) {
            playSound("receive");
          }
        }
      }
      renderRoomList();
      updateTabTitle();
    } catch {}
  });

  es.addEventListener("peersCount", (ev) => {
    touch();
    try { JSON.parse(ev.data); } catch {}
    updateRoomPeerCount(S.activeRoom);
  });

  es.addEventListener("room-update", (ev) => {
    touch();
    try {
      const data = JSON.parse(ev.data);
      if (!S.rooms[data.roomKey]) {
        S.rooms[data.roomKey] = {
          roomKey: data.roomKey, members: {},
          name: data.name || data.roomKey.slice(0, 8) + "...",
          bio: data.bio ?? "",
          avatar: data.avatar ?? null,
          isDM: !!data.isDM,
          dmWith: data.dmWith ?? null,
          pendingAcceptance: !!data.pendingAcceptance,
          isPinned: !!data.isPinned,
          isMuted: !!data.isMuted,
          unreadCount: data.unreadCount ?? 0, unreadMentions: data.unreadMentions ?? 0,
        };
      }
      const room = S.rooms[data.roomKey];
      if (data.name) room.name = data.name;
      if (data.bio !== undefined) room.bio = data.bio;
      if (data.avatar !== undefined) room.avatar = data.avatar;
      if (data.isDM !== undefined) room.isDM = data.isDM;
      if (data.dmWith !== undefined) room.dmWith = data.dmWith;
      if (data.pendingAcceptance !== undefined) room.pendingAcceptance = !!data.pendingAcceptance;
      if (data.isPinned !== undefined) room.isPinned = !!data.isPinned;
      if (data.isMuted !== undefined) room.isMuted = !!data.isMuted;
      if (data.createdBy) room.createdBy = data.createdBy;
      if (data.createdByName) room.createdByName = data.createdByName;
      if (data.lastMessage) room.lastMessage = data.lastMessage;
      if (data.unreadCount !== undefined && data.roomKey !== S.activeRoom) room.unreadCount = data.unreadCount;
      if (data.unreadMentions !== undefined && data.roomKey !== S.activeRoom) room.unreadMentions = data.unreadMentions;
      renderRoomList();
      if (data.roomKey === S.activeRoom) {
        $("chat-room-name").textContent = room.name;
        $("chat-room-avatar").src = avatar(room.name, 32, room.avatar);
        applyDMComposerGate(data.roomKey);
      }
    } catch {}
  });

  es.addEventListener("online-peers", (ev) => {
    touch();
    try {
      const { peers: ids } = JSON.parse(ev.data);
      S.onlinePeers = new Set(ids || []);
      loadRooms().then(() => {
        renderRoomList();
        updateRoomPeerCount(S.activeRoom);
      }).catch(() => {});
    } catch {}
  });

  es.addEventListener("peer-status", (ev) => {
    touch();
    try {
      const { peerId, isOnline } = JSON.parse(ev.data);
      if (isOnline) {
        S.onlinePeers.add(peerId);
      } else {
        S.onlinePeers.delete(peerId);
      }
      updateRoomPeerCount(S.activeRoom);
      renderRoomList();
    } catch {}
  });

  es.addEventListener("member-update", (ev) => {
    touch();
    try {
      const data = JSON.parse(ev.data);
      const { peerId, username, bio, isOnline } = data;
      const peerAvatar = data.avatar || null;
      const peerRooms = Array.isArray(data.rooms) ? data.rooms : null;
      S.peerProfiles[peerId] = { username, bio, avatar: peerAvatar, updatedAt: Date.now() };
      if (isOnline) S.onlinePeers.add(peerId);
      patchRoomsForPeer(peerId, username, bio, peerAvatar, peerRooms);
      refreshActiveChatForPeer(peerId, username, peerAvatar);
      updateRoomPeerCount(S.activeRoom);
      renderRoomList();
    } catch {}
  });

  es.addEventListener("member-leave", (ev) => {
    touch();
    try {
      const { roomKey, peerId } = JSON.parse(ev.data);
      const room = S.rooms[roomKey];
      if (room?.members?.[peerId]) delete room.members[peerId];
      updateRoomPeerCount(roomKey);
      renderRoomList();
    } catch {}
  });

  es.addEventListener("profile-update", (ev) => {
    touch();
    try {
      const { peerId, username, bio, avatar: profileAvatar } = JSON.parse(ev.data);
      const peerAvatar = profileAvatar || null;
      S.peerProfiles[peerId] = { username, bio, avatar: peerAvatar, updatedAt: Date.now() };
      patchRoomsForPeer(peerId, username, bio, peerAvatar, null);
      refreshActiveChatForPeer(peerId, username, peerAvatar);
      updateRoomPeerCount(S.activeRoom);
      renderRoomList();
    } catch {}
  });

  es.addEventListener("sync-complete", async () => {
    touch();
    await refreshActiveRoom();
  });

  es.addEventListener("dm-invite", (ev) => {
    touch();
    try {
      const { roomKey, fromId, fromUsername, fromAvatar, fromBio } = JSON.parse(ev.data);
      if (S.rooms[roomKey]) return;
      if (!S.pendingDMs) S.pendingDMs = {};
      S.pendingDMs[roomKey] = { fromId, fromUsername, fromAvatar, fromBio };
      $("dmi-avatar").src = avatar(fromUsername, 64, fromAvatar);
      $("dmi-name").textContent = fromUsername || fromId;
      $("dmi-bio").textContent = fromBio || "";
      _dmiRoomKey = roomKey;
      openModal("dm-invite-modal");
    } catch {}
  });

  es.addEventListener("dm-accepted", (ev) => {
    touch();
    try {
      const { roomKey, fromId, fromUsername, fromAvatar, fromBio } = JSON.parse(ev.data);
      const room = S.rooms[roomKey];
      if (room?.isDM) {
        if (fromUsername) room.name = fromUsername;
        room.avatar = fromAvatar || null;
        room.bio = fromBio || "";
        room.pendingAcceptance = false;
        delete S.pendingDMs?.[roomKey];
        renderRoomList();
        if (roomKey === S.activeRoom) {
          $("chat-room-name").textContent = room.name;
          $('chat-room-avatar').src = avatar(room.name, 32, room.avatar);
          applyDMComposerGate(roomKey);
        }
      }
    } catch {}
  });

  es.addEventListener("dm-rejected", (ev) => {
    touch();
    try {
      const { roomKey, fromUsername } = JSON.parse(ev.data);
      if (S.settings.notifications) {
        try { new Notification(`${fromUsername || "Peer"} declined your message request`); } catch {}
      }
    } catch {}
  });

  sseHealthTimer = setInterval(() => {
    if (Date.now() - lastSseTime > 20_000) {
      console.warn("[chat] SSE stale, reconnecting...");
      es.close();
      connectGlobalSSE();
    }
  }, 5_000);

  es.onopen = () => {
    reconnectDelay = 1000;
    lastSseTime = Date.now();
    refreshActiveRoom();
  };
  es.onerror = () => { es.close(); scheduleReconnect(); };

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectGlobalSSE();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  }
}

function isMentioned(message) {
  if (!S.profile?.username) return false;
  return message.includes("@" + S.profile.username);
}

$('create-room-btn')?.addEventListener('click', () => {
  $("new-room-avatar-preview").src = avatar('?', 64);
  pendingRoomAvatar = null;
  $("new-room-link").value = "";
  openModal('create-room-modal');
  queueMicrotask(() => $("new-room-name")?.focus());
});
$("create-room-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (creatingRoom) return;
  const name = $("new-room-name").value.trim();
  if (!name) { alert("Room name required."); return; }
  const confirmBtn = $("create-room-confirm");
  creatingRoom = true;
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = "Creating…"; }
  try {
    const body = { name, bio: $("new-room-bio").value.trim(), link: $("new-room-link").value.trim() };
    if (pendingRoomAvatar) body.avatar = pendingRoomAvatar;
    const { roomKey } = await api("create-key", { body });
    await api("join", { roomKey, post: true });
    await loadRooms();
    renderRoomList();
    closeAllModals();
    openRoom(roomKey);
    $("new-room-name").value = "";
    $("new-room-bio").value = "";
    $("new-room-link").value = "";
    pendingRoomAvatar = null;
    saveDrafts().catch(() => {});
  } catch (err) { alert(err.message); }
  finally {
    creatingRoom = false;
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = "Create"; }
  }
});

$('join-room-btn')?.addEventListener('click', () => { openModal('join-room-modal'); queueMicrotask(() => $('join-room-key')?.focus()); });
$("join-room-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("join-room-key").value.trim();
  if (!/^[a-f0-9]{64}$/i.test(key)) { alert("Invalid room key."); return; }
  try {
    await api("join", { roomKey: key, post: true });
    await loadRooms();
    renderRoomList();
    closeAllModals();
    openRoom(key);
    $("join-room-key").value = "";
    refreshRoomHeader(key);
    saveDrafts().catch(() => {});
  } catch (err) { alert(err.message); }
});

$("message-input")?.addEventListener("focus", initAudio, { once: true });

$("message-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("message-input");
  const msg = input.value.trim();
  if (!msg || !S.activeRoom) return;
  input.value = "";
  resizeMessageField();
  const body = { message: msg };
  if (replyTarget) { body.replyTo = replyTarget; replyTarget = null; $("reply-bar").style.display = "none"; }
  try {
    const resp = await api("send", { roomKey: S.activeRoom, body });
    if (resp.sent) appendMessage(S.activeRoom, resp.sent);
    playSound("send");
  } catch (err) { console.error("Send failed:", err); }
});

function buildMentionPopup() {
  const input = $("message-input");
  const popup = $("mention-popup");
  const val = input.value;
  const cursor = input.selectionStart;
  const before = val.slice(0, cursor);
  const atIdx = before.lastIndexOf("@");

  if (atIdx === -1 || (atIdx > 0 && /\S/.test(before[atIdx - 1]))) {
    popup.classList.remove("open"); mentionIdx = -1; return;
  }

  const query = before.slice(atIdx + 1).toLowerCase();
  const room = S.rooms[S.activeRoom];
  if (!room) { popup.classList.remove("open"); mentionIdx = -1; return; }

  const candidates = Object.entries(room.members || {})
    .map(([id, m]) => ({ id, username: m.username || id }))
    .filter((m) => m.id !== S.profile?.id && m.username.toLowerCase().startsWith(query));

  if (candidates.length === 0) { popup.classList.remove("open"); mentionIdx = -1; return; }

  popup.innerHTML = "";
  popup._candidates = candidates.slice(0, 6);
  mentionIdx = 0;
  for (let i = 0; i < popup._candidates.length; i++) {
    const m = popup._candidates[i];
    const item = document.createElement("div");
    item.className = "mention-item" + (i === 0 ? " active" : "");
    const isOn = S.onlinePeers.has(m.id);
    const mentionAvatar = S.peerProfiles[m.id]?.avatar || null;
    item.innerHTML = `<img src="${esc(avatar(m.username, 20, mentionAvatar))}" /><span>${esc(m.username)}</span><span class="online-dot ${isOn ? "online" : "offline"}"></span>`;
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      insertMention(m);
    });
    popup.appendChild(item);
  }
  popup.classList.add("open");
}

function insertMention(m) {
  const input = $("message-input");
  const popup = $("mention-popup");
  const val = input.value;
  const cursor = input.selectionStart;
  const before = val.slice(0, cursor);
  const atIdx = before.lastIndexOf("@");
  const newVal = val.slice(0, atIdx) + "@" + m.username + " " + val.slice(cursor);
  input.value = newVal;
  input.selectionStart = input.selectionEnd = atIdx + m.username.length + 2;
  popup.classList.remove("open"); mentionIdx = -1;
  input.focus();
  resizeMessageField();
}

$("message-input")?.addEventListener("input", () => {
  buildMentionPopup();
  resizeMessageField();
});

$("message-input")?.addEventListener("keydown", (e) => {
  const popup = $("mention-popup");
  const popupOpen = popup.classList.contains("open") && popup._candidates?.length;

  if (popupOpen) {
    const items = popup.querySelectorAll(".mention-item");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[mentionIdx]?.classList.remove("active");
      mentionIdx = (mentionIdx + 1) % items.length;
      items[mentionIdx]?.classList.add("active");
      items[mentionIdx]?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      items[mentionIdx]?.classList.remove("active");
      mentionIdx = (mentionIdx - 1 + items.length) % items.length;
      items[mentionIdx]?.classList.add("active");
      items[mentionIdx]?.scrollIntoView({ block: "nearest" });
      return;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      if (mentionIdx >= 0 && mentionIdx < popup._candidates.length) {
        insertMention(popup._candidates[mentionIdx]);
      }
      return;
    }
    if (e.key === "Escape") {
      popup.classList.remove("open"); mentionIdx = -1;
      return;
    }
  }

  if (e.key === "Escape") {
    popup.classList.remove("open"); mentionIdx = -1;
    return;
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("message-form")?.requestSubmit();
  }
});

$("message-input")?.addEventListener("blur", () => {
  setTimeout(() => { $("mention-popup")?.classList.remove("open"); mentionIdx = -1; }, 150);
});

$("chat-header-main")?.addEventListener("click", () => {
  if (!S.activeRoom) return;
  const room = S.rooms[S.activeRoom];
  if (!room) return;
  $("ri-avatar").src = avatar(room.name, 64, room.avatar);
  $("ri-name").textContent = room.name;
  $("ri-bio").textContent = room.bio || "No description";
  const linkRow = $("ri-link-row");
  const linkEl = $("ri-link");
  const roomLink = room.link || "";
  const safeLink = /^https?:\/\//i.test(roomLink) ? roomLink : "";
  if (!room.isDM && safeLink) {
    linkEl.href = safeLink;
    linkEl.textContent = safeLink;
    linkRow.style.display = "";
  } else {
    linkRow.style.display = "none";
  }
  $("ri-creator").textContent = room.createdByName || room.createdBy || "Unknown";
  $("ri-date").textContent = formatDate(room.createdAt);

  const memberList = $('ri-member-list');
  memberList.innerHTML = "";
  if (room.isDM && room.dmWith) {
    const dmId = room.dmWith;
    const dmProfile = S.peerProfiles[dmId] || {};
    const dmName = dmProfile.username || room.name || dmId;
    const dmAv = dmProfile.avatar || room.avatar || null;
    const isOn = S.onlinePeers.has(dmId);
    const row = document.createElement("div");
    row.className = "member-row";
    row.innerHTML = `<img src="${esc(avatar(dmName, 22, dmAv))}" /><span>${esc(dmName)}</span><span class="online-dot ${isOn ? "online" : "offline"}"></span>`;
    row.style.cursor = "pointer";
    row.addEventListener("click", () => { closeAllModals(); showUserInfo(dmId, dmName); });
    memberList.appendChild(row);
  } else {
    const members = room.members || {};
    for (const [id, m] of Object.entries(members)) {
      const row = document.createElement("div");
      row.className = "member-row";
      const isOn = S.onlinePeers.has(id);
      const memberAvatar = S.peerProfiles[id]?.avatar || m.avatar || null;
      const memberName = S.peerProfiles[id]?.username || m.username || id;
      row.innerHTML = `<img src="${esc(avatar(memberName, 22, memberAvatar))}" /><span>${esc(memberName)}</span><span class="online-dot ${isOn ? "online" : "offline"}"></span>`;
      row.style.cursor = "pointer";
      row.addEventListener("click", () => { closeAllModals(); showUserInfo(id, memberName); });
      memberList.appendChild(row);
    }
  }

  const keyRow = $("ri-copy-key").parentElement;
  if (PRE_JOINED_ROOM_KEY && S.activeRoom === PRE_JOINED_ROOM_KEY) {
    keyRow.style.display = "none";
  } else if (room.isDM) {
    const dmPeerOnline = room.dmWith && S.onlinePeers.has(room.dmWith);
    keyRow.style.display = dmPeerOnline ? "none" : "";
  } else {
    keyRow.style.display = "";
  }

  $("ri-copy-key").onclick = () => {
    copyText(S.activeRoom).then(() => {
      $("ri-copy-key").textContent = "Copied!";
      setTimeout(() => { $("ri-copy-key").textContent = "Copy"; }, 1500);
    });
  };

  openModal("room-info-modal");
});

let _uiCurrentPeerId = null;
let _uiCurrentPeerName = null;

function showUserInfo(senderId, displayName) {
  const peer = S.peerProfiles[senderId];
  const name = peer?.username || displayName || senderId;
  _uiCurrentPeerId = senderId;
  _uiCurrentPeerName = name;

  $("ui-avatar").src = avatar(name, 64, peer?.avatar || null);
  $("ui-name").textContent = name;
  $("ui-bio").textContent = peer?.bio || "";

  const isOn = S.onlinePeers.has(senderId);
  $("ui-status").innerHTML = `<span class="online-dot ${isOn ? "online" : "offline"}"></span> ${isOn ? "Online" : "Offline"}`;

  const room = S.rooms[S.activeRoom];
  const member = room?.members?.[senderId];
  $("ui-joined").textContent = member?.joinedAt ? `Joined ${formatDate(member.joinedAt)}` : "";

  const msgBtn = $("ui-message-btn");
  if (msgBtn) msgBtn.style.display = senderId === S.profile?.id ? "none" : "";

  openModal("user-info-modal");
}

async function dmRoomKey(id1, id2) {
  const sorted = [String(id1 || "").toLowerCase(), String(id2 || "").toLowerCase()].sort().join(":dm:");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sorted));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function openDM(peerId, peerUsername) {
  const myId = S.profile?.id;
  if (!myId || !peerId || peerId === myId) return;
  try {
    const roomKey = await dmRoomKey(myId, peerId);
    closeAllModals();
    if (S.rooms[roomKey]) {
      openRoom(roomKey);
      return;
    }
    const peer = S.peerProfiles[peerId];
    const peerAv = peer?.avatar || null;
    $("chat-empty").style.display = "none";
    $("chat-active").style.display = "flex";
    $("chat-room-avatar").src = avatar(peerUsername, 32, peerAv);
    $("chat-room-name").textContent = peerUsername || peerId;
    $("chat-room-peers").textContent = "Sending request…";
    $("messages").innerHTML = `<div class="dm-loading-state"><span class="muted small">Sending message request to ${esc(peerUsername || peerId)}…</span></div>`;
    $("message-input").disabled = true;
    $("send-btn").disabled = true;
    const result = await api("join-dm", {
      body: {
        roomKey, toId: peerId, toUsername: peerUsername,
        toAvatar: peerAv, toBio: peer?.bio || "",
      },
    });
    if (result.roomKey) {
      delete S.pendingDMs?.[result.roomKey];
      await loadRooms();
      renderRoomList();
      openRoom(result.roomKey);
    }
  } catch (err) {
    console.error("[chat] DM error:", err);
    $("chat-empty").style.display = "";
    $("chat-active").style.display = "none";
    alert("Could not open DM: " + err.message);
  }
}

async function acceptDM(roomKey) {
  try {
    closeAllModals();
    const result = await api("accept-dm", { body: { roomKey } });
    if (result.roomKey) {
      delete S.pendingDMs?.[result.roomKey];
      await loadRooms();
      renderRoomList();
      openRoom(result.roomKey);
      refreshRoomHeader(result.roomKey);
    }
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function rejectDM(roomKey) {
  try {
    await api("reject-dm", { body: { roomKey } });
    closeAllModals();
    delete S.pendingDMs?.[roomKey];
  } catch (err) {
    alert("Error: " + err.message);
  }
}

$("ui-message-btn")?.addEventListener("click", () => {
  if (_uiCurrentPeerId) openDM(_uiCurrentPeerId, _uiCurrentPeerName);
});

$("dmi-accept")?.addEventListener("click", () => {
  if (_dmiRoomKey) acceptDM(_dmiRoomKey);
});

$("dmi-reject")?.addEventListener("click", () => {
  if (_dmiRoomKey) rejectDM(_dmiRoomKey);
});

$("settings-btn")?.addEventListener("click", () => {
  $("set-username").value = S.profile?.username || "";
  $("set-bio").value = S.profile?.bio || "";
  $("set-sounds").checked = S.settings.sounds;
  $("set-notifications").checked = S.settings.notifications;
  $("set-avatar-preview").src = avatar(S.profile?.username, 64, S.profile?.avatar);
  pendingAvatar = null;
  openModal("settings-modal");
});

$("settings-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("set-username").value.trim();
  if (!username) { alert("Username required."); return; }
  try {
    const sounds = $("set-sounds").checked;
    const notifications = $("set-notifications").checked;
    const body = { username, bio: $("set-bio").value.trim(), notifications };
    if (pendingAvatar) body.avatar = pendingAvatar;
    const { profile } = await api("save-profile", { body });
    S.profile = profile;
    S.settings.sounds = sounds;
    S.settings.notifications = notifications;
    $("sidebar-avatar").src = avatar(username, 32, profile.avatar);
    $("sidebar-username").textContent = username;
    pendingAvatar = null;
    closeAllModals();
  } catch (err) { alert(err.message); }
});

function showCtxMenu(e, roomKey) {
  ctxTarget = roomKey;
  const menu = $("room-menu");
  const room = S.rooms[roomKey];
  menu.querySelector('[data-action="pin"]').textContent = room?.isPinned ? "Unpin" : "Pin";
  menu.querySelector('[data-action="mute"]').textContent = room?.isMuted ? "Unmute" : "Mute";
  const copyBtn = menu.querySelector('[data-action="copy"]');
  if (copyBtn) {
    const dmOnline = room?.isDM && room.dmWith && S.onlinePeers.has(room.dmWith);
    const isPreJoined = PRE_JOINED_ROOM_KEY && roomKey === PRE_JOINED_ROOM_KEY;
    copyBtn.style.display = (dmOnline || isPreJoined) ? "none" : "";
  }
  menu.style.top = e.clientY + "px";
  menu.style.left = e.clientX + "px";
  menu.classList.add("open");
}

document.addEventListener("click", () => {
  $("room-menu")?.classList.remove("open");
  $("msg-menu")?.classList.remove("open");
});

$("room-menu")?.addEventListener("click", async (e) => {
  const action = e.target.dataset.action;
  if (!action || !ctxTarget) return;
  const room = S.rooms[ctxTarget];
  if (!room) return;

  if (action === "pin") {
    await api("update-room", { roomKey: ctxTarget, body: { isPinned: !room.isPinned } });
    room.isPinned = !room.isPinned;
    renderRoomList();
  } else if (action === "mute") {
    await api("update-room", { roomKey: ctxTarget, body: { isMuted: !room.isMuted } });
    room.isMuted = !room.isMuted;
    renderRoomList();
  } else if (action === "copy") {
    copyText(ctxTarget);
  } else if (action === "delete") {
    if (!confirm("Leave this room? You can rejoin with the room key.")) return;
    await api("delete-room", { roomKey: ctxTarget, post: true });
    delete S.rooms[ctxTarget];
    if (S.activeRoom === ctxTarget) {
      S.activeRoom = null;
      $("chat-active").style.display = "none";
      $("chat-empty").style.display = "flex";
    }
    renderRoomList();
  }

  $("room-menu").classList.remove("open");
  ctxTarget = null;
});

function $(id) { return document.getElementById(id); }

function openModal(id) { $(id)?.classList.add("open"); }
function closeAllModals() {
  document.querySelectorAll(".modal.open").forEach((m) => m.classList.remove("open"));
}

document.addEventListener("click", (e) => {
  if (e.target.classList.contains("modal")) closeAllModals();
  if (e.target.hasAttribute("data-close")) closeAllModals();
  const msp = $("chat-message-search-panel");
  if (
    msp && !msp.hidden
    && !e.target.closest("#chat-message-search-panel")
    && !e.target.closest("#chat-search-btn")
  ) {
    closeMessageSearchPanel();
  }
  const ep = $("emoji-panel");
  if (ep?.classList.contains("open") && !e.target.closest("#emoji-panel") && !e.target.closest("#emoji-btn")) {
    closeEmojiPanel();
  }
});

$("room-search")?.addEventListener("input", () => renderRoomList());

$("chat-search-btn")?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  toggleMessageSearchPanel();
});

$("message-search")?.addEventListener("input", () => {
  messageSearchQuery = $("message-search")?.value || "";
  if (S.activeRoom) renderMessages(S.activeRoom);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const msp = $("chat-message-search-panel");
    if (msp && !msp.hidden) {
      closeMessageSearchPanel();
      e.preventDefault();
      return;
    }
    if ($("emoji-panel")?.classList.contains("open")) {
      closeEmojiPanel();
      e.preventDefault();
      return;
    }
    $("msg-menu")?.classList.remove("open");
    const mv = $("media-viewer");
    if (mv?.classList.contains("open")) {
      mv.classList.remove("open");
      $("media-viewer-body").innerHTML = "";
    } else {
      closeAllModals();
    }
  }
});

document.addEventListener("click", (ev) => {
  const dlBtn = ev.target.closest(".msg-file-attach-dl-btn");
  if (dlBtn) {
    ev.preventDefault();
    ev.stopPropagation();
    const url = dlBtn.getAttribute("data-file-url");
    const fname = dlBtn.getAttribute("data-file-name");
    if (url) downloadHyperFile(url, fname);
    return;
  }
  const openZone = ev.target.closest(".msg-file-attach-open");
  if (openZone) {
    ev.preventDefault();
    ev.stopPropagation();
    const wrap = openZone.closest(".msg-file-attach");
    const url = wrap?.getAttribute("data-file-url");
    if (url) window.open(url);
    return;
  }
  const a = ev.target.closest("a[href]");
  if (!a) return;
  const hrefAttr = a.getAttribute("href") || "";
  const hrefLower = hrefAttr.toLowerCase();
  if (a.hasAttribute("download") || hrefLower.startsWith("blob:") || hrefLower.startsWith("data:")) return;
  ev.preventDefault();
  window.open(a.href);
});

$("attach-btn")?.addEventListener("click", () => $("file-input")?.click());
$("emoji-btn")?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  void toggleEmojiPanel();
});

$("file-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file || !S.activeRoom) return;
  await uploadAndSendFile(file);
});

async function uploadAndSendFile(file) {
  const base = await getDriveUrl();
  if (!base) { alert("Could not initialize file storage."); return; }
  const ts = Date.now();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${S.activeRoom.slice(0, 8)}/${ts}-${safeName}`;
  try {
    const buf = await file.arrayBuffer();
    const uploadResp = await fetch(base + path, { method: "PUT", body: new Uint8Array(buf) });
    if (!uploadResp.ok) throw new Error("Upload failed");
    const fileUrl = base + path;
    const resp = await api("send", {
      roomKey: S.activeRoom,
      body: { message: fileUrl, fileName: file.name, fileSize: file.size },
    });
    if (resp.sent) appendMessage(S.activeRoom, resp.sent);
    playSound("send");
  } catch (err) { alert("Upload failed: " + err.message); }
}

const msgArea = $("messages");
if (msgArea) {
  msgArea.addEventListener("keydown", (e) => {
    const dlBtn = e.target.closest(".msg-file-attach-dl-btn");
    if (dlBtn && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      const url = dlBtn.getAttribute("data-file-url");
      const fname = dlBtn.getAttribute("data-file-name");
      if (url) downloadHyperFile(url, fname);
      return;
    }
    const openZone = e.target.closest(".msg-file-attach-open");
    if (openZone && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      const url = openZone.closest(".msg-file-attach")?.getAttribute("data-file-url");
      if (url) window.open(url);
    }
  });
  msgArea.addEventListener("dragover", (e) => { e.preventDefault(); $("dropzone").style.display = "flex"; });
  msgArea.addEventListener("dragleave", (e) => {
    if (!msgArea.contains(e.relatedTarget)) $("dropzone").style.display = "none";
  });
  msgArea.addEventListener("drop", async (e) => {
    e.preventDefault(); $("dropzone").style.display = "none";
    const file = e.dataTransfer?.files?.[0];
    if (file && S.activeRoom) await uploadAndSendFile(file);
  });
}

$("set-avatar-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    pendingAvatar = await resizeImage(file);
    $("set-avatar-preview").src = pendingAvatar;
  } catch (err) { alert(err.message); }
});

$("new-room-avatar-input")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    pendingRoomAvatar = await resizeImage(file);
    $("new-room-avatar-preview").src = pendingRoomAvatar;
  } catch (err) { alert(err.message); }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    connectGlobalSSE();
  }
});

function openMediaViewer(src, type, hint) {
  const overlay = $("media-viewer");
  if (!overlay) return;
  overlay.dataset.mediaSrc = src;
  overlay.dataset.mediaType = type || "image";
  overlay.dataset.mediaFilename = hint || "";
  const body = $("media-viewer-body");
  body.innerHTML = "";
  if (type === "video") {
    const v = document.createElement("video");
    v.src = src; v.controls = true; v.autoplay = true;
    v.className = "media-viewer-content";
    body.appendChild(v);
  } else {
    const img = document.createElement("img");
    img.src = src;
    img.className = "media-viewer-content";
    body.appendChild(img);
  }
  overlay.classList.add("open");
}

$("media-viewer")?.addEventListener("click", (e) => {
  if (e.target.id === "media-viewer" || e.target.id === "media-viewer-close") {
    $("media-viewer").classList.remove("open");
    $("media-viewer-body").innerHTML = "";
  }
});

$("media-viewer-dl")?.addEventListener("click", async () => {
  const overlay = $("media-viewer");
  const src = overlay?.dataset.mediaSrc;
  if (!src) return;
  try {
    const resp = await fetch(src);
    const blob = await resp.blob();
    const ext = blob.type.split("/")[1]?.split("+")[0] || "jpg";
    const rawHint = (overlay?.dataset.mediaFilename || "").trim().replace(/[/\\?%*:|"<>]/g, "_").slice(0, 60);
    const fname = rawHint ? `peerchat-${rawHint}.${ext}` : `peerchat-image.${ext}`;
    if (typeof window.showSaveFilePicker === "function") {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: fname });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (pickErr) {
        if (pickErr?.name === "AbortError") return;
      }
    }
    const obj = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = obj; a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(obj), 2500);
  } catch (err) { alert("Could not save image: " + err.message); }
});

document.addEventListener("click", (e) => {
  const mentionEl = e.target.closest(".mention[data-mention]");
  if (mentionEl) {
    e.stopPropagation();
    const uname = mentionEl.dataset.mention;
    const peerId = Object.entries(S.peerProfiles).find(([, p]) => p.username === uname)?.[0];
    if (peerId) { showUserInfo(peerId, uname); return; }
    const room = S.rooms[S.activeRoom];
    const memberId = room && Object.entries(room.members || {}).find(([, m]) => m.username === uname)?.[0];
    if (memberId) { showUserInfo(memberId, uname); return; }
    return;
  }
  const img = e.target.closest(".msg-file-img");
  if (img) {
    e.preventDefault();
    e.stopPropagation();
    const tag = img.tagName.toLowerCase();
    const imgHint = S.activeRoom ? (S.rooms[S.activeRoom]?.name || "") : "";
    openMediaViewer(img.src, tag === "video" ? "video" : "image", imgHint);
    return;
  }
  const av = e.target.closest(".modal.open img.avatar-lg");
  if (av && av.src && (av.src.startsWith("data:image/") || av.src.startsWith("blob:"))) {
    e.stopPropagation();
    let avHint = "";
    if (e.target.closest("#room-info-modal")) avHint = $("ri-name")?.textContent || "";
    else if (e.target.closest("#user-info-modal")) avHint = $("ui-name")?.textContent || "";
    else if (e.target.closest("#settings-modal")) avHint = S.profile?.username || "";
    openMediaViewer(_blobToDataCache.get(av.src) || av.src, "image", avHint);
  }
});

init();
