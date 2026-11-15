/**
 * A VPN extension's proxy outlives a restart, as it does in Chrome, and is on
 * the session before any tab or torrent connects.
 *
 * The extension host (@p2plabs/peersky-chrome-extensions 2.x) keeps what an
 * extension sets with chrome.proxy, and applies it again once that extension
 * loads after a restart. Extensions load after the first window opens, so the
 * proxy that counts is also saved here each time it changes and put back on
 * the session before then. Turning the extension off takes its proxy off and
 * turning it on puts it back, as in Chrome; removing it forgets it.
 *
 * The host's 1.x kept chrome.proxy in memory only, and this file was the only
 * copy. What it saved then is handed back to its extension once.
 *
 * Kept free of Electron imports so it can be tested directly.
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

function clearSaved (userDataDir) {
  return queueWrite(() => fs.rm(settingsFile(userDataDir), { force: true }))
}

// The host's proxy API: the proxy that counts and the extension that set it,
// a 'proxy-changed' event, and a way to hand an extension back its proxy.
function usable (host) {
  return !!host && typeof host.getProxySettings === 'function' &&
    typeof host.restoreExtensionProxy === 'function' && typeof host.on === 'function'
}

/**
 * Saves the proxy that counts each time it changes, and hands the saved one
 * back to its extension, so chrome.proxy.settings.get tells a VPN its proxy is
 * still set, as Chrome does. Run when the extension host is created, before
 * any extension loads. closing() is true while the browser shuts down: it
 * unloads every extension then, and that is no reason to forget the proxy.
 * Returns the saved proxy, or null.
 */
export async function keepExtensionProxy (host, userDataDir, { log, closing = () => false } = {}) {
  if (!usable(host)) {
    log?.warn('[ProxySettings] The extension host has no proxy API to keep: a VPN extension must connect again after a restart')
    return null
  }
  if (!host.__peerskyProxyKept) {
    host.on('proxy-changed', (current) => {
      if (!current && closing()) return
      const write = current
        ? saveProxySettings(userDataDir, current.extensionId, current.value)
        : clearSaved(userDataDir)
      write.catch((error) => log?.warn('[ProxySettings] Could not save the extension proxy:', error?.message || error))
    })
    host.__peerskyProxyKept = true
  }
  const saved = await readSavedProxy(userDataDir)
  if (!saved) return null
  // From 1.x, or from a host that lost its own copy. One the extension set
  // since stays as it is.
  await host.restoreExtensionProxy(saved.extensionId, saved.value)
  return saved
}

/** The extension was removed: its saved proxy goes too. The host forgets what it set (clearExtensionSettings). */
export async function forgetExtensionProxy (userDataDir, extensionId) {
  if (!extensionId) return false
  await forgetSaved(userDataDir, extensionId)
  return true
}

/**
 * After extensions load: the saved proxy went on the session before any window
 * opened, and if its extension is gone or turned off, nothing will replace it,
 * so it comes off. installed(id) and enabled(id) answer for the extension's
 * session id.
 */
export async function settleExtensionProxy (session, userDataDir, { installed, enabled }) {
  const saved = await readSavedProxy(userDataDir)
  if (!saved) return null
  const id = saved.extensionId
  if (installed(id) && enabled(id)) return 'kept'
  if (!saved.off) await session.setProxy({ mode: 'system' })
  if (!installed(id)) {
    await forgetSaved(userDataDir, id)
    return 'forgotten'
  }
  if (!saved.off) await saveProxySettings(userDataDir, id, saved.value, { off: true })
  return 'off'
}
