import { app, dialog, BrowserWindow } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { NAVIGABLE_SCHEMES } from './utils.js'

export const MANAGED_PERMISSIONS = [
  { id: 'geolocation', label: 'Location' },
  { id: 'media', label: 'Camera and microphone' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'midi', label: 'MIDI devices' },
  { id: 'pointerLock', label: 'Pointer lock' },
  { id: 'fullscreen', label: 'Full screen' },
  {
    id: 'p2pPublish',
    label: 'P2P publishing',
    detail: 'This site wants to create or change files in your Hyper drives, or add content to your IPFS node.'
  }
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

/**
 * A file the person chose in a save or open dialog, read or written by one of
 * PeerSky's own pages. Electron asks here before a page may write to the file
 * it was handed, and the deny-by-default branch refused: PeerChat's media
 * viewer then fell back to a download link, which asked where to save all over
 * again, and an attachment did not save at all. Only one file, and only for
 * the browser's own pages; a website, or a whole folder, is refused as before.
 */
export function isOwnPageFileAccess (permission, details, fallbackUrl = '') {
  if (permission !== 'fileSystem' || !details || details.isDirectory === true) return false
  try {
    return new URL(details.requestingUrl || fallbackUrl || '').protocol === 'peersky:'
  } catch {
    return false
  }
}

// blob:/data:/about: have no stable host; do not share a cache key across them.
const OPAQUE_SCHEMES = new Set(['blob:', 'data:', 'about:'])

const PERMISSIONS_FILE = path.join(app.getPath('userData'), 'permissions.json')
const MAX_CACHE_ENTRIES = 500
const MAX_FILE_BYTES = 512 * 1024
const STATES = new Set(['allow', 'block', 'ask'])

const permissionCache = new Map()
// Incognito answers, apart from the ones above, kept only until the last
// incognito window closes.
const incognitoCache = new Map()
const pendingPrompts = new Map()
let saveTimeout = null

function isManagedPermission (permission) {
  return PROMPT_PERMISSIONS.has(permission)
}

/**
 * Stable permission key for a page URL.
 * http(s) use URL.origin; other navigable schemes use scheme://host so Node's
 * opaque "null" origin does not collapse peersky/ipfs/hyper/file into one bucket.
 */
export function permissionOriginFromUrl (raw) {
  if (!raw || typeof raw !== 'string') return null
  if (raw === 'null' || raw === 'unknown') return null
  try {
    const url = new URL(raw)
    if (!NAVIGABLE_SCHEMES.has(url.protocol)) return null
    if (OPAQUE_SCHEMES.has(url.protocol)) return null

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (!url.host || url.origin === 'null') return null
      return url.origin.length < 256 ? url.origin : null
    }

    if (url.host) {
      const key = `${url.protocol}//${url.host}`
      return key.length < 256 ? key : null
    }

    // file:///… has an empty host; one shared key for local files.
    if (url.protocol === 'file:') return 'file://'

    return null
  } catch {
    return null
  }
}

export function isValidOrigin (origin) {
  if (typeof origin !== 'string' || !origin || origin.length >= 256) return false
  return permissionOriginFromUrl(origin) === origin
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

function getPermissionState (origin, permission, cache) {
  if (!isManagedPermission(permission) || !isValidOrigin(origin)) return 'ask'
  const entry = cache.get(cacheKey(origin, permission))
  if (!entry) return 'ask'
  if (entry.state === 'allow' && !entry.permanent) return 'allow-session'
  return entry.state
}

export function getPermissionsForOrigin (origin, { incognito = false } = {}) {
  const cache = incognito ? incognitoCache : permissionCache
  const result = {}
  for (const { id } of MANAGED_PERMISSIONS) {
    result[id] = getPermissionState(origin, id, cache)
  }
  return result
}

export function setPermission (origin, permission, state, { incognito = false } = {}) {
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
  if (incognito) {
    if (state === 'ask') incognitoCache.delete(key)
    else incognitoCache.set(key, { state, permanent: false })
    return { ok: true }
  }
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

export function resetPermissionsForOrigin (origin, { incognito = false } = {}) {
  if (!isValidOrigin(origin)) return 0
  const cache = incognito ? incognitoCache : permissionCache
  let cleared = 0
  for (const key of [...cache.keys()]) {
    const parsed = parseCacheKey(key)
    if (parsed?.origin === origin) {
      cache.delete(key)
      cleared++
    }
  }
  if (cleared && !incognito) savePermissions()
  return cleared
}

export function clearIncognitoPermissions () {
  incognitoCache.clear()
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
    return permissionOriginFromUrl(webContents.getURL() || '')
  } catch {
    return null
  }
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

/**
 * Resolve a site's permission from its stored decision, or ask the user.
 * Requests that arrive while a dialog is open share that dialog.
 */
export function requestSitePermission (webContents, origin, permission, { incognito = false } = {}) {
  if (!isManagedPermission(permission) || !isValidOrigin(origin)) return Promise.resolve(false)
  const key = cacheKey(origin, permission)
  const cached = (incognito ? incognitoCache : permissionCache).get(key)
  if (cached) return Promise.resolve(entryAllows(cached))
  const pendingKey = incognito ? `incognito ${key}` : key
  if (!pendingPrompts.has(pendingKey)) {
    const prompt = promptForPermission(webContents, origin, permission, { incognito })
      .finally(() => pendingPrompts.delete(pendingKey))
    pendingPrompts.set(pendingKey, prompt)
  }
  return pendingPrompts.get(pendingKey)
}

async function promptForPermission (webContents, origin, permission, { incognito = false } = {}) {
  const key = cacheKey(origin, permission)
  const meta = MANAGED_PERMISSIONS.find(p => p.id === permission)
  const options = {
    type: 'question',
    // Nothing in incognito is remembered past its last window.
    buttons: incognito ? ['Allow', 'Block'] : ['Allow always', 'Allow this time', 'Block'],
    defaultId: incognito ? 1 : 2,
    title: 'Permission request',
    message: `Allow "${PERMISSION_LABELS[permission] ?? permission}"?`,
    detail: meta?.detail ? `${origin}\n\n${meta.detail}` : origin
  }
  try {
    const host = webContents?.hostWebContents || webContents
    const win = host ? BrowserWindow.fromWebContents(host) : null
    const parent = win && !win.isDestroyed() ? win : BrowserWindow.getAllWindows()[0]
    const { response } = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
    if (incognito) {
      if (response === 0 || response === 1) {
        incognitoCache.set(key, { state: response === 0 ? 'allow' : 'block', permanent: false })
      }
      return response === 0
    }
    if (response === 0) {
      permissionCache.set(key, { state: 'allow', permanent: true })
      savePermissions()
      return true
    }
    if (response === 1) {
      permissionCache.set(key, { state: 'allow', permanent: false })
      return true
    }
    if (response === 2) {
      permissionCache.set(key, { state: 'block', permanent: true })
      savePermissions()
    }
    // A dismissed dialog (response -1) denies once without persisting.
    return false
  } catch {
    return false
  }
}

// Incognito asks the same way, but neither reads nor writes the decisions
// above. P2P publishing is never asked there: the request gate refuses it.
export function setupIncognitoPermissionHandler (session) {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (SILENT_GRANT_PERMISSIONS.has(permission) || isOwnPageFileAccess(permission, details, webContents?.getURL?.())) {
      callback(true) // eslint-disable-line n/no-callback-literal
      return
    }
    const origin = originFromWebContents(webContents)
    if (!PROMPT_PERMISSIONS.has(permission) || permission === 'p2pPublish' || !origin) {
      callback(false) // eslint-disable-line n/no-callback-literal
      return
    }
    requestSitePermission(webContents, origin, permission, { incognito: true }).then(callback)
  })
  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (SILENT_GRANT_PERMISSIONS.has(permission) || isOwnPageFileAccess(permission, details, requestingOrigin)) return true
    if (!PROMPT_PERMISSIONS.has(permission)) return false
    const origin = permissionOriginFromUrl(requestingOrigin)
    return !!origin && entryAllows(incognitoCache.get(cacheKey(origin, permission)))
  })
}

export async function setupPermissionHandler (session) {
  await loadPermissions()

  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (SILENT_GRANT_PERMISSIONS.has(permission) || isOwnPageFileAccess(permission, details, webContents?.getURL?.())) {
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

    requestSitePermission(webContents, origin, permission).then(callback)
  })

  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (SILENT_GRANT_PERMISSIONS.has(permission) || isOwnPageFileAccess(permission, details, requestingOrigin)) return true
    if (!PROMPT_PERMISSIONS.has(permission)) return false
    const origin = permissionOriginFromUrl(requestingOrigin)
    if (!origin) return false
    return entryAllows(permissionCache.get(cacheKey(origin, permission)))
  })
}
