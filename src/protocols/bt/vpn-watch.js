// Which proxies a VPN extension has the browser use, for torrents to follow.
//
// Extensions set the proxy through chrome.proxy, which the extension host
// turns into session.setProxy. This wraps setProxy to see each change, then
// asks the session which proxy it now picks, the way a page's request would
// get it. A public address is asked first, like a torrent peer's: a VPN's PAC
// script sends private and reserved addresses direct (VeePN sends 192.0.2.1
// direct), and a site after it in case a script treats bare addresses apart.
//
// Only an extension's proxy counts: "system" and "direct" leave torrents as
// they were, connecting directly.

import { parseProxyList } from './proxy-tunnel.js'

const PROBES = ['http://1.1.1.1/', 'https://archive.org/']
const SETTLE_MS = 600

/**
 * Calls onChange(proxies) whenever the VPN's proxies change, best first, or
 * with [] when no VPN extension is on. Returns { current(), check(), stop() }:
 * check() looks now, without waiting for the proxy to settle.
 */
export function watchExtensionProxy (session, onChange, { probes = PROBES, settleMs = SETTLE_MS } = {}) {
  // Electron's sessions have setProxy on their prototype: stop() puts back
  // whatever was there.
  const ownSetProxy = Object.prototype.hasOwnProperty.call(session, 'setProxy') ? session.setProxy : null
  const setProxy = session.setProxy.bind(session)
  let extensionMode = null
  let timer = null
  let last = '[]'
  let stopped = false

  async function current () {
    if (!extensionMode) return []
    for (const url of probes) {
      try {
        const proxies = parseProxyList(await session.resolveProxy(url))
        if (proxies.length) return proxies
      } catch {}
    }
    return []
  }

  async function check () {
    clearTimeout(timer)
    const proxies = await current()
    const key = JSON.stringify(proxies)
    if (stopped || key === last) return proxies
    last = key
    onChange(proxies)
    return proxies
  }

  // A VPN that connects sets the proxy more than once in a row; wait for it to
  // settle so torrents restart once.
  function settle () {
    clearTimeout(timer)
    timer = setTimeout(check, settleMs)
    timer.unref?.()
  }

  session.setProxy = async function watchedSetProxy (config) {
    const result = await setProxy(config)
    const mode = config?.mode
    extensionMode = mode === 'pac_script' || mode === 'fixed_servers' ? mode : null
    settle()
    return result
  }

  return {
    current,
    check,
    stop () {
      stopped = true
      clearTimeout(timer)
      if (ownSetProxy) session.setProxy = ownSetProxy
      else delete session.setProxy
    }
  }
}

/**
 * A proxy's login from the extension that set the proxy, asked the way the
 * browser asks when a proxy answers 407 (chrome.webRequest.onAuthRequired).
 * webRequest is the extension host's webRequest API.
 */
export async function extensionProxyCredentials (webRequest, proxy, { realm, target }) {
  if (!webRequest?.notifyOnAuthRequired || !target?.host) return null
  const host = target.host.includes(':') ? `[${target.host}]` : target.host
  const result = await webRequest.notifyOnAuthRequired({
    url: `https://${host}:${target.port}/`,
    method: 'GET',
    timestamp: Date.now(),
    isProxy: true,
    scheme: 'basic',
    realm: realm || '',
    challenger: { host: proxy.host, port: proxy.port }
  })
  const given = result?.authCredentials
  if (!given || (given.username == null && given.password == null)) return null
  return { username: String(given.username ?? ''), password: String(given.password ?? '') }
}
