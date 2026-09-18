import { app, dialog, BrowserWindow } from 'electron'
import fs from 'fs/promises'
import path from 'path'

export const MANAGED_PERMISSIONS = [
  { id: 'geolocation', label: 'Location' },
  { id: 'media', label: 'Camera and microphone' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'midi', label: 'MIDI devices' },
  { id: 'pointerLock', label: 'Pointer lock' },
  { id: 'fullscreen', label: 'Full screen' }
]

const PROMPT_PERMISSIONS = new Set(MANAGED_PERMISSIONS.map(p => p.id))
const PERMISSION_LABELS = Object.fromEntries(
  MANAGED_PERMISSIONS.map(p => [p.id, p.label])
)

// Chromium grants a sanitized clipboard write on user activation without ever
// asking, so routing it through the deny-by-default branch below silently broke
// every copy button in the browser's own pages. Reading the clipboard is not
// here on purpose: that one stays denied.
const SILENT_GRANT_PERMISSIONS = new Set(['clipboard-sanitized-write'])

const PERMISSIONS_FILE = path.join(app.getPath('userData'), 'permissions.json')
const MAX_CACHE_ENTRIES = 500
const MAX_FILE_BYTES = 512 * 1024
const ORIGIN_REGEX = /^https?:\/\/[^/]+$/
const STATES = new Set(['allow', 'block', 'ask'])

const permissionCache = new Map()
let saveTimeout = null

function isManagedPermission (permission) {
  return PROMPT_PERMISSIONS.has(permission)
}

export function isValidOrigin (origin) {
  return typeof origin === 'string' &&
    origin.length > 0 &&
    origin.length < 256 &&
    ORIGIN_REGEX.test(origin)
}

function cacheKey (origin, permission) {
  return `${origin}|${permission}`
}

function parseCacheKey (key) {
  const i = key.indexOf('|')
  if (i <= 0 || i >= key.length - 1) return null
  return { origin: key.slice(0, i), permission: key.slice(i + 1) }
}

function normalizeEntry (value) {
  if (value === true) return { state: 'allow', permanent: true }
  if (value === false) return { state: 'block', permanent: true }
  return null
}

function isValidCacheKey (key, value) {
  const parsed = parseCacheKey(key)
  if (!parsed) return false
  if (!PROMPT_PERMISSIONS.has(parsed.permission)) return false
  if (!isValidOrigin(parsed.origin)) return false
  return normalizeEntry(value) !== null
}

function entryAllows (entry) {
  return entry?.state === 'allow'
}

function getPermissionState (origin, permission) {
  if (!isManagedPermission(permission) || !isValidOrigin(origin)) return 'ask'
  const entry = permissionCache.get(cacheKey(origin, permission))
  if (!entry) return 'ask'
  if (entry.state === 'allow' && !entry.permanent) return 'allow-session'
  return entry.state
}

export function getPermissionsForOrigin (origin) {
  const result = {}
  for (const { id } of MANAGED_PERMISSIONS) {
    result[id] = getPermissionState(origin, id)
  }
  return result
}

export function setPermission (origin, permission, state) {
  if (!isValidOrigin(origin)) {
    return { ok: false, error: 'invalid origin' }
  }
  if (!isManagedPermission(permission)) {
    return { ok: false, error: 'unknown permission' }
  }
  if (!STATES.has(state)) {
    return { ok: false, error: 'invalid state' }
  }

  const key = cacheKey(origin, permission)
  if (state === 'ask') {
    if (permissionCache.has(key)) {
      permissionCache.delete(key)
      savePermissions()
    }
    return { ok: true }
  }

  permissionCache.set(key, { state, permanent: true })
  savePermissions()
  return { ok: true }
}

export function resetPermissionsForOrigin (origin) {
  if (!isValidOrigin(origin)) return 0
  let cleared = 0
  for (const key of [...permissionCache.keys()]) {
    const parsed = parseCacheKey(key)
    if (parsed?.origin === origin) {
      permissionCache.delete(key)
      cleared++
    }
  }
  if (cleared) savePermissions()
  return cleared
}

export async function clearPersistedPermissions () {
  if (saveTimeout) {
    clearTimeout(saveTimeout)
    saveTimeout = null
  }
  permissionCache.clear()
  try {
    await fs.unlink(PERMISSIONS_FILE)
  } catch {
    /* ignore */
  }
}

function savePermissions () {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(async () => {
    saveTimeout = null
    const obj = {}
    for (const [key, entry] of permissionCache) {
      if (!entry.permanent) continue
      obj[key] = entry.state === 'allow'
    }
    const keys = Object.keys(obj)
    const trimmed = keys.length > MAX_CACHE_ENTRIES
      ? Object.fromEntries(keys.slice(-MAX_CACHE_ENTRIES).map(k => [k, obj[k]]))
      : obj
    const tmp = PERMISSIONS_FILE + '.tmp'
    try {
      await fs.writeFile(tmp, JSON.stringify(trimmed), 'utf8')
      await fs.rename(tmp, PERMISSIONS_FILE)
    } catch (err) {
      console.warn('[permissions] save failed:', err?.message)
    }
  }, 200)
}

function originFromWebContents (webContents) {
  try {
    const url = webContents.getURL() || ''
    if (!url) return null
    const o = new URL(url).origin
    if (o && o.length < 256 && ORIGIN_REGEX.test(o)) return o
  } catch {
    /* ignore */
  }
  return null
}

async function loadPermissions () {
  try {
    const stat = await fs.stat(PERMISSIONS_FILE).catch(() => null)
    if (stat && stat.size > MAX_FILE_BYTES) throw new Error('file too large')
    const data = await fs.readFile(PERMISSIONS_FILE, 'utf8')
    const obj = JSON.parse(data)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return
    for (const [key, value] of Object.entries(obj)) {
      if (!isValidCacheKey(key, value)) continue
      permissionCache.set(key, normalizeEntry(value))
    }
  } catch {
    /* start fresh */
  }
}

export async function setupPermissionHandler (session) {
  await loadPermissions()

  session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (SILENT_GRANT_PERMISSIONS.has(permission)) {
      callback(true) // eslint-disable-line n/no-callback-literal
      return
    }
    if (!PROMPT_PERMISSIONS.has(permission)) {
      callback(false) // eslint-disable-line n/no-callback-literal
      return
    }

    const origin = originFromWebContents(webContents)
    if (!origin) {
      callback(false) // eslint-disable-line n/no-callback-literal
      return
    }

    const key = cacheKey(origin, permission)
    const cached = permissionCache.get(key)
    if (cached) {
      callback(entryAllows(cached))
      return
    }

    const label = PERMISSION_LABELS[permission] ?? permission
    const win = BrowserWindow.fromWebContents(webContents)
    const parent = win && !win.isDestroyed() ? win : BrowserWindow.getAllWindows()[0]
    dialog
      .showMessageBox(parent, {
        type: 'question',
        buttons: ['Allow always', 'Allow this time', 'Block'],
        defaultId: 2,
        title: 'Permission request',
        message: `Allow "${label}"?`,
        detail: origin
      })
      .then(({ response }) => {
        if (response === 0) {
          permissionCache.set(key, { state: 'allow', permanent: true })
          savePermissions()
          callback(true) // eslint-disable-line n/no-callback-literal
        } else if (response === 1) {
          permissionCache.set(key, { state: 'allow', permanent: false })
          callback(true) // eslint-disable-line n/no-callback-literal
        } else if (response === 2) {
          permissionCache.set(key, { state: 'block', permanent: true })
          savePermissions()
          callback(false) // eslint-disable-line n/no-callback-literal
        } else {
          // Dialog dismissed (e.g. response === -1) — deny once, do not persist.
          callback(false) // eslint-disable-line n/no-callback-literal
        }
      })
      .catch(() => {
        callback(false) // eslint-disable-line n/no-callback-literal
      })
  })

  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (SILENT_GRANT_PERMISSIONS.has(permission)) return true
    if (!PROMPT_PERMISSIONS.has(permission)) return false
    let origin = null
    try {
      if (requestingOrigin) {
        const o = new URL(requestingOrigin).origin
        if (ORIGIN_REGEX.test(o)) origin = o
      }
    } catch {
      /* ignore */
    }
    if (!origin) return false
    return entryAllows(permissionCache.get(cacheKey(origin, permission)))
  })
}
