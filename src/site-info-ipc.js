import { ipcMain } from 'electron'
import {
  MANAGED_PERMISSIONS,
  getPermissionsForOrigin,
  setPermission,
  resetPermissionsForOrigin,
  isValidOrigin
} from './permissions.js'

const SITE_STORAGES = [
  'cookies',
  'localstorage',
  'sessionstorage',
  'indexdb',
  'cachestorage',
  'serviceworkers'
]

const SECURE_SCHEMES = new Set([
  'https:',
  'peersky:',
  'ipfs:',
  'ipns:',
  'hyper:',
  'bt:',
  'bittorrent:',
  'magnet:',
  'web3:',
  'file:'
])

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

function connectionFor (protocol) {
  if (protocol === 'http:') {
    return { secure: false, label: 'Not secure' }
  }
  if (SECURE_SCHEMES.has(protocol)) {
    return { secure: true, label: 'Connection is secure' }
  }
  return { secure: false, label: 'Connection status unknown' }
}

async function cookieCount (session, url) {
  try {
    const cookies = await session.cookies.get({ url })
    return cookies.length
  } catch {
    return 0
  }
}

export function setupSiteInfoIpc (session) {
  ipcMain.handle('site-info-get', async (_event, pageUrl) => {
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
      cookies: {
        count: await cookieCount(session, parsed.href)
      }
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
