import { app, ipcMain } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';
import settingsManager from './settings-manager.js';

const LLM_MEMORY_FILE = path.join(app.getPath('userData'), 'llm.json');
const MAX_ENTRIES = 2000;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

let _cache = null;

async function load() {
  if (_cache) return _cache;
  try {
    const raw = await fs.readFile(LLM_MEMORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    _cache = parsed;
    return _cache;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('llm-memory: failed to read llm.json:', e.message);
    }
    _cache = { version: 1, entries: [] };
    return _cache;
  }
}

async function save(data) {
  const json = JSON.stringify(data, null, 2);
  const byteLen = Buffer.byteLength(json, 'utf8');
  if (byteLen > MAX_FILE_BYTES) {
    // Prune oldest entries until under limit
    while (data.entries.length > 0 && Buffer.byteLength(JSON.stringify(data, null, 2), 'utf8') > MAX_FILE_BYTES) {
      data.entries.shift();
    }
  }
  const tmp = LLM_MEMORY_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, LLM_MEMORY_FILE);
  _cache = data;
}

function isMemoryEnabled() {
  return !!(settingsManager.settings?.llm?.memoryEnabled);
}

// ── IPC Handlers ────────────────────────────────────────────────────────────

ipcMain.handle('llm-memory-add', async (_event, entry) => {
  if (!isMemoryEnabled()) return { ok: false, reason: 'memory_disabled' };

  if (!entry || typeof entry !== 'object') return { ok: false, reason: 'invalid_entry' };

  const data = await load();

  const safeEntry = {
    ts: entry.ts || new Date().toISOString(),
    appId: String(entry.appId || 'unknown').slice(0, 64),
    sessionId: String(entry.sessionId || '').slice(0, 64),
    role: String(entry.role || 'user').slice(0, 16),
    content: typeof entry.content === 'string' ? entry.content.slice(0, 100_000) : '',
    model: String(entry.model || '').slice(0, 128),
    meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : {}
  };

  data.entries.push(safeEntry);

  if (data.entries.length > MAX_ENTRIES) {
    data.entries = data.entries.slice(data.entries.length - MAX_ENTRIES);
  }

  await save(data);
  return { ok: true };
});

ipcMain.handle('llm-memory-list', async (_event, opts = {}) => {
  if (!isMemoryEnabled()) return [];

  const data = await load();
  let entries = data.entries;

  if (opts.appId) {
    entries = entries.filter(e => e.appId === opts.appId);
  }
  if (opts.sessionId) {
    entries = entries.filter(e => e.sessionId === opts.sessionId);
  }
  if (opts.search) {
    const q = String(opts.search).toLowerCase();
    entries = entries.filter(e => e.content.toLowerCase().includes(q));
  }
  if (opts.limit && Number.isFinite(opts.limit) && opts.limit > 0) {
    entries = entries.slice(-opts.limit);
  }

  return entries;
});

ipcMain.handle('llm-memory-list-sessions', async (_event, opts = {}) => {
  if (!isMemoryEnabled()) return [];

  const data = await load();
  let entries = data.entries;

  if (opts.appId) {
    entries = entries.filter(e => e.appId === opts.appId);
  }

  // Build session map: sessionId -> { sessionId, appId, title, ts, model, messageCount }
  const sessionsMap = new Map();
  for (const e of entries) {
    if (!e.sessionId) continue;
    if (!sessionsMap.has(e.sessionId)) {
      sessionsMap.set(e.sessionId, {
        sessionId: e.sessionId,
        appId: e.appId,
        title: '',
        ts: e.ts,
        model: e.model,
        messageCount: 0
      });
    }
    const s = sessionsMap.get(e.sessionId);
    s.messageCount++;
    if (!s.title && e.role === 'user') {
      s.title = e.content.slice(0, 80).replace(/\n/g, ' ');
    }
    if (e.ts > s.ts) s.ts = e.ts;
  }

  let sessions = Array.from(sessionsMap.values());
  sessions.sort((a, b) => (b.ts > a.ts ? 1 : -1));

  if (opts.limit && Number.isFinite(opts.limit) && opts.limit > 0) {
    sessions = sessions.slice(0, opts.limit);
  }

  return sessions;
});

ipcMain.handle('llm-memory-clear', async (_event, opts = {}) => {
  const data = await load();

  if (opts.appId) {
    data.entries = data.entries.filter(e => e.appId !== opts.appId);
  } else if (opts.sessionId) {
    data.entries = data.entries.filter(e => e.sessionId !== opts.sessionId);
  } else {
    data.entries = [];
  }

  await save(data);
  return { ok: true };
});

ipcMain.handle('llm-memory-enabled', async () => {
  return isMemoryEnabled();
});

export function resetCache() {
  _cache = null;
}
