import { app, dialog, BrowserWindow } from "electron";
import fs from "fs/promises";
import path from "path";

const PROMPT_PERMISSIONS = new Set([
  "geolocation",
  "media",
  "notifications",
  "midi",
  "pointerLock",
  "fullscreen",
]);

const PERMISSION_LABELS = {
  geolocation: "Location",
  media: "Camera and microphone",
  notifications: "Notifications",
  midi: "MIDI devices",
  pointerLock: "Pointer lock",
  fullscreen: "Full screen",
};

const PERMISSIONS_FILE = path.join(app.getPath("userData"), "permissions.json");
const MAX_CACHE_ENTRIES = 500;
const MAX_FILE_BYTES = 512 * 1024;
const ORIGIN_REGEX = /^https?:\/\/[^/]+$/;

const permissionCache = new Map();
let saveTimeout = null;

function isValidCacheKey(key, value) {
  if (value !== true && value !== false) return false;
  const i = key.indexOf("|");
  if (i <= 0 || i >= key.length - 1) return false;
  const origin = key.slice(0, i);
  const perm = key.slice(i + 1);
  if (!PROMPT_PERMISSIONS.has(perm)) return false;
  if (origin !== "unknown" && !ORIGIN_REGEX.test(origin)) return false;
  return true;
}

export async function clearPersistedPermissions() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  permissionCache.clear();
  try {
    await fs.unlink(PERMISSIONS_FILE);
  } catch {
    /* ignore */
  }
}

function savePermissions() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    saveTimeout = null;
    const entries = [...permissionCache.entries()].slice(-MAX_CACHE_ENTRIES);
    const obj = Object.fromEntries(entries);
    const tmp = PERMISSIONS_FILE + ".tmp";
    try {
      await fs.writeFile(tmp, JSON.stringify(obj), "utf8");
      await fs.rename(tmp, PERMISSIONS_FILE);
    } catch (err) {
      console.warn("[permissions] save failed:", err?.message);
    }
  }, 200);
}

export async function setupPermissionHandler(session) {
  try {
    const stat = await fs.stat(PERMISSIONS_FILE).catch(() => null);
    if (stat && stat.size > MAX_FILE_BYTES) throw new Error("file too large");
    const data = await fs.readFile(PERMISSIONS_FILE, "utf8");
    const obj = JSON.parse(data);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const [key, value] of Object.entries(obj)) {
        if (isValidCacheKey(key, value)) permissionCache.set(key, value);
      }
    }
  } catch {
    /* start fresh */
  }

  session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (!PROMPT_PERMISSIONS.has(permission)) {
      callback(false);
      return;
    }
    let origin = "unknown";
    try {
      const url = webContents.getURL() || "";
      if (url) {
        const o = new URL(url).origin;
        if (o && o.length < 256) origin = o;
      }
    } catch {
      /* keep unknown */
    }
    const cacheKey = `${origin}|${permission}`;
    const cached = permissionCache.get(cacheKey);
    if (cached !== undefined) {
      callback(cached);
      return;
    }
    const label = PERMISSION_LABELS[permission] ?? permission;
    const win = BrowserWindow.fromWebContents(webContents);
    const parent = win && !win.isDestroyed() ? win : BrowserWindow.getAllWindows()[0];
    dialog
      .showMessageBox(parent, {
        type: "question",
        buttons: ["Allow always", "Allow this time", "Block"],
        defaultId: 2,
        title: "Permission request",
        message: `Allow "${label}"?`,
        detail: origin,
      })
      .then(({ response }) => {
        const allow = response === 0 || response === 1;
        permissionCache.set(cacheKey, allow);
        if (response === 0 || response === 2) savePermissions();
        callback(allow);
      })
      .catch(() => {
        callback(false);
      });
  });
}
