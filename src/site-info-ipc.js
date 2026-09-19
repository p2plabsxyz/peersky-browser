import { ipcMain, BrowserWindow } from 'electron'
import {
  MANAGED_PERMISSIONS,
  getPermissionsForOrigin,
  setPermission,
  resetPermissionsForOrigin,
  isValidOrigin,
  permissionOriginFromUrl
} from './permissions.js'
import { connectionFor } from './utils.js'
import extensionManager from './extensions/index.js'

const SITE_STORAGES = [
  'cookies',
  'localstorage',
  'indexdb',
  'cachestorage',
  'serviceworkers'
]

const PRIVACY_EXTENSIONS = [
  { key: 'ublock', label: 'uBlock Origin', match: /ublock/i },
  { key: 'consentAutodeny', label: 'Consent Autodeny', match: /consent\s*autodeny/i }
]

function isTrustedSiteInfoSender (event) {
  const wc = event?.sender
  if (!wc || wc.isDestroyed()) return false
  if (BrowserWindow.fromWebContents(wc)) return true
  try {
    const url = wc.getURL() || ''
    return /^peersky:\/\/site-settings([/?#]|$)/i.test(url)
  } catch {
    return false
  }
}

function parsePageUrl (raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'url required' }
  }
  try {
    const url = new URL(raw.trim())
    const origin = permissionOriginFromUrl(url.href)
    return {
      ok: true,
      href: url.href,
      origin: origin || '',
      hostname: url.hostname || url.host || url.pathname,
      protocol: url.protocol,
      originOk: !!origin
    }
  } catch {
    return { ok: false, error: 'invalid url' }
  }
}

async function cookieCount (session, url) {
  try {
    const cookies = await session.cookies.get({ url })
    return cookies.length
  } catch {
    return 0
  }
}

function extensionName (ext) {
  return ext?.displayName || ext?.name || ''
}

async function getPrivacyStatus (event) {
  let extensions = []
  let actions = []
  try {
    extensions = await extensionManager.listExtensions()
  } catch {
    extensions = []
  }
  try {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      actions = await extensionManager.listBrowserActions(win)
    }
  } catch {
    actions = []
  }

  const actionById = new Map(
    (Array.isArray(actions) ? actions : []).map(a => [a.id, a])
  )

  const privacy = {}
  for (const { key, label, match } of PRIVACY_EXTENSIONS) {
    const ext = (Array.isArray(extensions) ? extensions : []).find(e =>
      match.test(extensionName(e))
    )
    if (!ext) {
      privacy[key] = {
        id: null,
        name: label,
        installed: false,
        enabled: false,
        badgeText: '',
        hasAction: false
      }
      continue
    }
    const action = actionById.get(ext.id)
    privacy[key] = {
      id: ext.id,
      name: extensionName(ext) || label,
      installed: true,
      enabled: ext.enabled === true,
      badgeText: action?.badgeText ? String(action.badgeText) : '',
      hasAction: !!action?.hasAction
    }
  }
  return privacy
}

export function setupSiteInfoIpc (session) {
  ipcMain.handle('site-info-get', async (event, pageUrl) => {
    const parsed = parsePageUrl(pageUrl)
    if (!parsed.ok) return { ok: false, error: parsed.error }

    const permissions = parsed.originOk
      ? getPermissionsForOrigin(parsed.origin)
      : Object.fromEntries(MANAGED_PERMISSIONS.map(p => [p.id, 'ask']))

    const cookieUrl = parsed.origin
      ? (parsed.origin.endsWith('/') ? parsed.origin : parsed.origin + '/')
      : parsed.href

    return {
      ok: true,
      url: parsed.href,
      origin: parsed.origin,
      hostname: parsed.hostname,
      protocol: parsed.protocol,
      connection: connectionFor(parsed.protocol),
      permissions,
      permissionMeta: MANAGED_PERMISSIONS,
      canEditPermissions: parsed.originOk,
      cookies: {
        count: await cookieCount(session, cookieUrl)
      },
      privacy: await getPrivacyStatus(event)
    }
  })

  ipcMain.handle('site-info-set-permission', async (event, payload = {}) => {
    if (!isTrustedSiteInfoSender(event)) {
      return { ok: false, error: 'unauthorized' }
    }
    const { origin, permission, state } = payload
    return setPermission(origin, permission, state)
  })

  ipcMain.handle('site-info-reset-permissions', async (event, origin) => {
    if (!isTrustedSiteInfoSender(event)) {
      return { ok: false, error: 'unauthorized' }
    }
    if (!isValidOrigin(origin)) {
      return { ok: false, error: 'invalid origin' }
    }
    return { ok: true, cleared: resetPermissionsForOrigin(origin) }
  })

  ipcMain.handle('site-info-clear-data', async (event, origin) => {
    if (!isTrustedSiteInfoSender(event)) {
      return { ok: false, error: 'unauthorized' }
    }
    if (!isValidOrigin(origin)) {
      return { ok: false, error: 'invalid origin' }
    }
    try {
      await session.clearStorageData({ origin, storages: SITE_STORAGES })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err?.message || 'clear failed' }
    }
  })
}
