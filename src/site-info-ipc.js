import { ipcMain, BrowserWindow } from 'electron'
import {
  MANAGED_PERMISSIONS,
  getPermissionsForOrigin,
  setPermission,
  resetPermissionsForOrigin,
  isValidOrigin
} from './permissions.js'
import extensionManager from './extensions/index.js'
import { connectionFor } from './site-info-connection.js'

const SITE_STORAGES = [
  'cookies',
  'localstorage',
  'sessionstorage',
  'indexdb',
  'cachestorage',
  'serviceworkers'
]

const PRIVACY_EXTENSIONS = [
  { key: 'ublock', label: 'uBlock Origin', match: /ublock/i },
  { key: 'consentAutodeny', label: 'Consent Autodeny', match: /consent\s*autodeny/i }
]

function parsePageUrl (raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'url required' }
  }
  try {
    const url = new URL(raw.trim())
    return {
      ok: true,
      href: url.href,
      origin: url.origin,
      hostname: url.hostname || url.host || url.pathname,
      protocol: url.protocol
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

    const originOk = isValidOrigin(parsed.origin)
    const permissions = originOk
      ? getPermissionsForOrigin(parsed.origin)
      : Object.fromEntries(MANAGED_PERMISSIONS.map(p => [p.id, 'ask']))

    return {
      ok: true,
      url: parsed.href,
      origin: parsed.origin,
      hostname: parsed.hostname,
      protocol: parsed.protocol,
      connection: connectionFor(parsed.protocol),
      permissions,
      permissionMeta: MANAGED_PERMISSIONS,
      canEditPermissions: originOk && parsed.origin !== 'unknown',
      cookies: {
        count: await cookieCount(session, parsed.href)
      },
      privacy: await getPrivacyStatus(event)
    }
  })

  ipcMain.handle('site-info-set-permission', async (_event, payload = {}) => {
    const { origin, permission, state } = payload
    return setPermission(origin, permission, state)
  })

  ipcMain.handle('site-info-reset-permissions', async (_event, origin) => {
    if (!isValidOrigin(origin) || origin === 'unknown') {
      return { ok: false, error: 'invalid origin' }
    }
    return { ok: true, cleared: resetPermissionsForOrigin(origin) }
  })

  ipcMain.handle('site-info-clear-data', async (_event, origin) => {
    if (!isValidOrigin(origin) || origin === 'unknown') {
      return { ok: false, error: 'invalid origin' }
    }
    try {
      await session.clearStorageData({ origin, storages: SITE_STORAGES })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err?.message || 'clear failed' }
    }
  })

  ipcMain.handle('site-info-get-cookies', async (_event, pageUrl) => {
    const parsed = parsePageUrl(pageUrl)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    try {
      const cookies = await session.cookies.get({ url: parsed.href })
      return {
        ok: true,
        count: cookies.length,
        cookies: cookies.slice(0, 100).map(c => ({
          name: c.name,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          session: c.session
        }))
      }
    } catch (err) {
      return { ok: false, error: err?.message || 'cookies failed' }
    }
  })
}
