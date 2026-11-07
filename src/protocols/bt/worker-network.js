// The worker's first import: before WebTorrent loads, it locks the network to
// the VPN extension's proxies the browser handed over when it started this
// worker (PEERSKY_BT_PROXIES, see network-lock.js). With none, torrents
// connect directly, as they always have.
//
// A proxy's login is asked of the browser when the proxy wants one, and kept
// in memory only.

import { installNetworkLock } from './network-lock.js'

const CREDENTIALS_TIMEOUT_MS = 20000
const pending = new Map()
let nextRequest = 0

function requestCredentials (proxy, { realm, target, stale }) {
  if (!process.send) return Promise.resolve(null)
  return new Promise((resolve) => {
    const requestId = ++nextRequest
    const timer = setTimeout(() => {
      pending.delete(requestId)
      resolve(null)
    }, CREDENTIALS_TIMEOUT_MS)
    timer.unref?.()
    pending.set(requestId, (credentials) => {
      clearTimeout(timer)
      resolve(credentials || null)
    })
    try {
      process.send({ type: 'proxy-credentials-request', requestId, proxy, realm, target, stale })
    } catch {
      clearTimeout(timer)
      pending.delete(requestId)
      resolve(null)
    }
  })
}

/** The browser's answer to a login request. True when the message was one. */
export function onNetworkMessage (msg) {
  if (!msg || msg.type !== 'proxy-credentials') return false
  const resolve = pending.get(msg.requestId)
  if (resolve) {
    pending.delete(msg.requestId)
    resolve(msg.credentials)
  }
  return true
}

const given = process.env.PEERSKY_BT_PROXIES || ''
let proxies = []
try {
  proxies = given ? JSON.parse(given) : []
} catch {
  proxies = null
}

export const networkLock = installNetworkLock({ proxies: proxies || [], requestCredentials })

// A VPN was meant but its proxies could not be read: stop here rather than
// let torrents connect without it.
if (given && !networkLock) {
  console.error('[BT-Worker] The VPN proxies could not be read, so torrents will not start')
  process.exit(1)
}
if (networkLock) console.log(`[BT-Worker] Torrents go through the VPN extension (${networkLock.proxies.length} proxy server${networkLock.proxies.length === 1 ? '' : 's'})`)
