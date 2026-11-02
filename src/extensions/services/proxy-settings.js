/**
 * A VPN extension's proxy outlives a restart, as it does in Chrome.
 *
 * The extension host keeps what an extension sets with chrome.proxy in memory
 * only. After a restart the VPN extension still said it was connected, while
 * every restored tab, and torrents, went out with this computer's own address.
 * So the setting is saved each time an extension changes it, put back on the
 * session before the first window opens, and handed back to that extension
 * before it runs.
 *
 * As in Chrome, turning the extension off takes its proxy off and turning it
 * on puts it back; removing the extension forgets it.
 *
 * Kept free of Electron imports so it can be tested directly. The proxy API it
 * works with is the extension host's (api.proxy).
 */

import path from 'path'
import { promises as fs } from 'fs'
import { WEBSTORE_ID_RE, readJsonSafe, writeJsonAtomic } from '../util.js'

export const PROXY_SETTINGS_FILE = 'extension-proxy.json'

// What a VPN extension sets. "direct" and "system" leave nothing to restore.
const RESTORED_MODES = new Set(['pac_script', 'fixed_servers'])
const PROXY_SCHEMES = new Set(['http', 'https', 'socks4', 'socks5'])
const PAC_MIME_TYPE = 'application/x-ns-proxy-autoconfig'

// Where the browser logs in to a VPN's proxy: the project's own home, which its
// updates come from anyway.
const LOGIN_URL = 'https://github.com/'

function settingsFile (userDataDir) {
  return path.join(userDataDir, PROXY_SETTINGS_FILE)
}

function proxyUri (server) {
  if (!server || typeof server.host !== 'string' || !server.host) return null
  // A host that could end one rule and start another is not a host.
  if (/[\s;=,/@?#]/.test(server.host)) return null
  const scheme = server.scheme || 'http'
  if (!PROXY_SCHEMES.has(scheme)) return null
  const host = server.host.includes(':') && !server.host.startsWith('[') ? `[${server.host}]` : server.host
  const port = Number.isInteger(server.port) && server.port > 0 && server.port < 65536 ? `:${server.port}` : ''
  return `${scheme}://${host}${port}`
}

/**
 * A chrome.proxy ProxyConfig as Electron's session.setProxy takes it, or null
 * when it is not one an extension's VPN would set.
 */
export function toSessionProxy (value) {
  if (!value || typeof value !== 'object') return null
  if (value.mode === 'pac_script') {
    const pac = value.pacScript || {}
    if (typeof pac.data === 'string' && pac.data) {
      return { mode: 'pac_script', pacScript: `data:${PAC_MIME_TYPE};base64,${Buffer.from(pac.data, 'utf8').toString('base64')}` }
    }
    if (typeof pac.url === 'string' && pac.url) return { mode: 'pac_script', pacScript: pac.url }
    return null
  }
  if (value.mode === 'fixed_servers') {
    const rules = value.rules || {}
    let proxyRules = ''
    if (rules.singleProxy) {
      proxyRules = proxyUri(rules.singleProxy) || ''
    } else {
      // As Chrome writes them: fallbackProxy goes in the "socks=" slot, which
      // Chromium reads as "for everything else", whatever its scheme.
      proxyRules = [['http', rules.proxyForHttp], ['https', rules.proxyForHttps], ['ftp', rules.proxyForFtp], ['socks', rules.fallbackProxy]]
        .map(([key, server]) => [key, proxyUri(server)])
        .filter(([, uri]) => uri)
        .map(([key, uri]) => `${key}=${uri}`)
        .join(';')
    }
    if (!proxyRules) return null
    const config = { mode: 'fixed_servers', proxyRules }
    if (Array.isArray(rules.bypassList) && rules.bypassList.length) {
      config.proxyBypassRules = rules.bypassList.filter((rule) => typeof rule === 'string').join(',')
    }
    return config
  }
  return null
}

function validSaved (saved) {
  if (!saved || typeof saved !== 'object') return null
  const { extensionId, value } = saved
  if (typeof extensionId !== 'string' || !WEBSTORE_ID_RE.test(extensionId)) return null
  if (!value || !RESTORED_MODES.has(value.mode) || !toSessionProxy(value)) return null
  return { extensionId, value, off: saved.off === true }
}

/**
 * The proxy an extension has set, as { extensionId, value, off }, or null.
 * off: its extension is turned off, so the proxy waits for it.
 */
export async function readSavedProxy (userDataDir) {
  return validSaved(await readJsonSafe(settingsFile(userDataDir), null))
}

// One write at a time, in order, so the last change is what stays on disk.
let writing = Promise.resolve()

function queueWrite (write) {
  writing = writing.then(write, write)
  return writing
}

/** Saves what an extension set, or removes the file when there is nothing to restore. */
export function saveProxySettings (userDataDir, extensionId, value, { off = false } = {}) {
  const saved = validSaved({ extensionId, value, off })
  const file = settingsFile(userDataDir)
  return queueWrite(() => (saved ? writeJsonAtomic(file, saved) : fs.rm(file, { force: true })))
}

function forgetSaved (userDataDir, extensionId) {
  return queueWrite(async () => {
    const saved = validSaved(await readJsonSafe(settingsFile(userDataDir), null))
    if (!saved || saved.extensionId === extensionId) await fs.rm(settingsFile(userDataDir), { force: true })
  })
}

/**
 * Puts the saved proxy back on the browser's session. Run before any window
 * opens, so no page or torrent connects without the VPN in the meantime.
 * Returns what was restored, or null.
 */
export async function restoreSavedProxy (session, userDataDir) {
  const saved = await readSavedProxy(userDataDir)
  if (!saved || saved.off) return null
  await session.setProxy(toSessionProxy(saved.value))
  return saved
}

/**
 * Logs the browser's own requests in to the VPN's proxy.
 *
 * A page gets the proxy's login from the VPN extension when the proxy asks,
 * but a fetch the browser makes itself (the updater's, a torrent file's)
 * cannot answer: Electron cancels the login and it fails with 407. Chromium
 * keeps a proxy's login once one request has given it, so this makes one
 * request that answers with the extension's login, and theirs go through
 * after it. request is net.request bound to the browser's session;
 * credentialsFor(authInfo) gives { username, password } or null. Resolves
 * true once the proxy let a request through.
 */
export function logInToProxy ({ request, credentialsFor, url = LOGIN_URL, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    let req = null
    let settled = false
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    function finish (loggedIn) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { req?.abort() } catch {}
      resolve(loggedIn)
    }
    try {
      req = request({ method: 'HEAD', url, redirect: 'manual' })
    } catch {
      return finish(false)
    }
    req.on('login', (authInfo, callback) => {
      if (!authInfo?.isProxy) return callback()
      Promise.resolve()
        .then(() => credentialsFor(authInfo))
        .then((given) => (given ? callback(given.username, given.password) : callback()), () => callback())
    })
    req.on('redirect', () => finish(true))
    req.on('response', (response) => finish(response.statusCode !== 407))
    req.on('error', () => finish(false))
    req.end()
  })
}

function usable (proxyApi) {
  return !!proxyApi && typeof proxyApi.settingsSet === 'function' &&
    typeof proxyApi.settingsClear === 'function' && typeof proxyApi.emitSettingsChange === 'function'
}

async function handBack (proxyApi, saved) {
  await proxyApi.settingsSet({ extension: { id: saved.extensionId } }, { value: saved.value })
}

// Takes the extension's proxy off the session without forgetting it.
async function takeOff (proxyApi) {
  proxyApi.__peerskyProxyPausing = true
  try {
    await proxyApi.settingsClear({ extension: { id: proxyApi.controllingExtensionId } })
  } finally {
    proxyApi.__peerskyProxyPausing = false
  }
}

/**
 * Saves every change an extension makes with chrome.proxy, and hands the
 * saved proxy back to its extension. Run when the extension host is created,
 * before any extension loads, so chrome.proxy.settings.get tells the VPN its
 * proxy is still set, as Chrome does. Returns the saved proxy, or null.
 */
export async function keepExtensionProxy (proxyApi, userDataDir, { log } = {}) {
  if (!usable(proxyApi)) {
    log?.warn('[ProxySettings] The extension host has no proxy API to keep: a VPN extension must connect again after a restart')
    return null
  }
  if (!proxyApi.__peerskyProxyKept) {
    const emit = proxyApi.emitSettingsChange.bind(proxyApi)
    proxyApi.emitSettingsChange = (...args) => {
      if (!proxyApi.__peerskyProxyPausing) {
        saveProxySettings(userDataDir, proxyApi.controllingExtensionId, proxyApi.currentConfig)
          .catch((error) => log?.warn('[ProxySettings] Could not save the extension proxy:', error?.message || error))
      }
      return emit(...args)
    }
    proxyApi.__peerskyProxyKept = true
  }
  const saved = await readSavedProxy(userDataDir)
  if (!saved || saved.off) return null
  await handBack(proxyApi, saved)
  return saved
}

/**
 * The extension was turned off: its proxy comes off the session, and waits
 * for the extension to be turned on again. extensionId is its id in the session.
 */
export async function pauseExtensionProxy (proxyApi, userDataDir, extensionId) {
  if (!usable(proxyApi) || !extensionId || proxyApi.controllingExtensionId !== extensionId) return false
  const value = proxyApi.currentConfig
  await takeOff(proxyApi)
  await saveProxySettings(userDataDir, extensionId, value, { off: true })
  return true
}

/** The extension was turned on again: the proxy it had set is back. */
export async function resumeExtensionProxy (proxyApi, userDataDir, extensionId) {
  if (!usable(proxyApi) || !extensionId) return false
  const saved = await readSavedProxy(userDataDir)
  if (!saved || saved.extensionId !== extensionId) return false
  await handBack(proxyApi, saved)
  return true
}

/** The extension was removed: its proxy comes off and is forgotten. */
export async function forgetExtensionProxy (proxyApi, userDataDir, extensionId) {
  if (!extensionId) return false
  const controlling = usable(proxyApi) && proxyApi.controllingExtensionId === extensionId
  if (controlling) await proxyApi.settingsClear({ extension: { id: extensionId } })
  await forgetSaved(userDataDir, extensionId)
  return controlling
}

/**
 * After extensions load: a saved proxy whose extension is not installed any
 * more is forgotten, and one whose extension is turned off comes off the
 * session. installed(id) and enabled(id) answer for the extension's session id.
 */
export async function settleExtensionProxy (proxyApi, userDataDir, { installed, enabled }) {
  const saved = await readSavedProxy(userDataDir)
  if (!saved) return null
  const id = saved.extensionId
  if (!installed(id)) {
    await forgetExtensionProxy(proxyApi, userDataDir, id)
    return 'forgotten'
  }
  if (!enabled(id)) {
    if (!saved.off) await pauseExtensionProxy(proxyApi, userDataDir, id)
    return 'off'
  }
  return 'kept'
}
