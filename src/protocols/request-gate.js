import { randomBytes } from 'crypto'

// Electron applies no CORS to custom-scheme responses and sends no Origin, so
// any page can call the p2p backends and read the reply. Requests are judged in
// webRequest, where the calling origin is known, and stamped there. Service
// worker requests skip webRequest entirely, so handlers refuse sensitive
// requests that arrive without the stamp.

const VETTED_HEADER = 'x-peersky-vetted'
const vettedToken = randomBytes(32).toString('hex')
// Marks a tab loading a hyper:// page. A protocol handler cannot tell that from
// a page's fetch: Electron passes it no Sec-Fetch headers.
const NAVIGATION_HEADER = 'x-peersky-navigation'
const navigationToken = randomBytes(32).toString('hex')
const STAMP_HEADERS = new Set([VETTED_HEADER, NAVIGATION_HEADER])

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const P2P_WRITE_SCHEMES = new Set(['hyper:', 'ipfs:', 'ipns:', 'pubsub:'])
const TORRENT_SCHEMES = new Set(['bt:', 'bittorrent:', 'magnet:'])
// Pages that show a torrent and call its API: a webtorrent: link opens the
// same page, but has no API of its own.
const TORRENT_UI_SCHEMES = new Set([...TORRENT_SCHEMES, 'webtorrent:'])

const ALLOW = { action: 'allow' }
const BLOCK = { action: 'block' }

const isP2PApp = (caller) => caller.protocol === 'peersky:' && caller.hostname === 'p2p'

// PeerSky's own pages. An app someone added under peersky://myapps is served on
// the same scheme but came from somewhere else, so it is treated like any other
// site: it asks before it writes, and never uses a private drive.
const isOwnPage = (caller) =>
  caller.protocol === 'peersky:' && caller.hostname !== '' && caller.hostname.toLowerCase() !== 'myapps'

const TORRENT_FILE_SCHEMES = new Set(['bt:', 'bittorrent:'])

// A file a torrent holds, served at bt://<infohash>/<path>: its torrent's
// hash, or null for anything else.
function torrentFileHash (target) {
  if (!TORRENT_FILE_SCHEMES.has(target.protocol) || target.pathname === '/' || target.pathname === '') return null
  return target.hostname.toLowerCase()
}

// The torrent pages and the manager, not a file a torrent holds: that is a page
// from anyone, sandboxed, so it calls with no origin and is judged by its URL.
const isTorrentUi = (caller) =>
  (caller.protocol === 'peersky:' && caller.hostname === 'bt-manager') ||
  (TORRENT_UI_SCHEMES.has(caller.protocol) && !torrentFileHash(caller))

function parseUrl (raw) {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

// The pages allowed to call a control API, or null when target is not one.
function controlApiCallers (target) {
  if (TORRENT_SCHEMES.has(target.protocol) && target.searchParams.get('action') === 'api') return isTorrentUi
  if (target.protocol === 'hs:' && target.hostname === 'p2pmd') return isP2PApp
  if (target.protocol === 'hyper:' && target.hostname === 'chat') return isP2PApp
  return null
}

function isP2PWrite (target, method) {
  return P2P_WRITE_SCHEMES.has(target.protocol) && !SAFE_METHODS.has(method)
}

/**
 * The address of the frame behind a webRequest, or '' when there is none. A
 * frame torn down mid-request throws on access instead of returning null.
 */
export function frameUrlOf (details) {
  try {
    return details?.frame?.url || ''
  } catch {
    return ''
  }
}

// initiatorOrigin is the security origin, so an about:blank frame counts as the
// page that made it. Opaque origins read "null" and fall back to the frame URL.
function callerOf (initiatorOrigin, frameUrl) {
  const origin = initiatorOrigin && initiatorOrigin !== 'null' ? parseUrl(initiatorOrigin) : null
  return origin || parseUrl(frameUrl)
}

/**
 * Decide a request seen by webRequest.onBeforeRequest.
 * @returns {{ action: 'allow' | 'block' } |
 *   { action: 'extension', extensionId: string, scheme: string } |
 *   { action: 'ask', caller: string }}
 */
export function gateRequest ({ url, method, resourceType, initiatorOrigin, frameUrl }) {
  const target = parseUrl(url)
  if (!target) return ALLOW
  const verb = String(method || 'GET').toUpperCase()
  const caller = callerOf(initiatorOrigin, frameUrl)

  const allowedCaller = controlApiCallers(target)
  if (allowedCaller) {
    // A top-level GET only shows the result in a tab the caller cannot read.
    if (resourceType === 'mainFrame' && SAFE_METHODS.has(verb)) return ALLOW
    return caller && allowedCaller(caller) ? ALLOW : BLOCK
  }

  // Torrent pages and files open in tabs. Read from another page, a downloaded
  // file would be the caller's to read, or tell it what was downloaded, and a
  // webtorrent: link would have the browser fetch any address. A torrent's own
  // files may load one another.
  if (TORRENT_UI_SCHEMES.has(target.protocol)) {
    if (resourceType === 'mainFrame' && SAFE_METHODS.has(verb)) return ALLOW
    const hash = torrentFileHash(target)
    const sameTorrent = !!hash && !!caller && TORRENT_FILE_SCHEMES.has(caller.protocol) && caller.hostname.toLowerCase() === hash
    return sameTorrent && SAFE_METHODS.has(verb) ? ALLOW : BLOCK
  }

  if (!isP2PWrite(target, verb)) return ALLOW
  if (!caller) return BLOCK
  if (isOwnPage(caller)) return ALLOW
  if (caller.protocol === 'chrome-extension:') {
    return { action: 'extension', extensionId: caller.hostname, scheme: target.protocol.slice(0, -1) }
  }
  return { action: 'ask', caller: caller.href }
}

// A torrent's files too: a service worker's fetch skips webRequest.
function isSensitive (url, method) {
  const target = parseUrl(url)
  if (!target) return false
  return !!controlApiCallers(target) || !!torrentFileHash(target) || isP2PWrite(target, String(method || 'GET').toUpperCase())
}

/** Request headers with the stamps added, or null when the request needs none. */
export function stampVetted ({ url, method, resourceType, requestHeaders }) {
  const sensitive = isSensitive(url, method)
  const navigation = resourceType === 'mainFrame' &&
    SAFE_METHODS.has(String(method || 'GET').toUpperCase()) &&
    parseUrl(url)?.protocol === 'hyper:'
  if (!sensitive && !navigation) return null
  const headers = Object.fromEntries(
    Object.entries(requestHeaders || {}).filter(([name]) => !STAMP_HEADERS.has(name.toLowerCase()))
  )
  if (sensitive) headers[VETTED_HEADER] = vettedToken
  if (navigation) headers[NAVIGATION_HEADER] = navigationToken
  return headers
}

/** Whether the request gate saw a request as a tab loading a page. Takes the stamp off. */
export function takeNavigationStamp (request) {
  const stamped = request.headers.get(NAVIGATION_HEADER) === navigationToken
  request.headers.delete(NAVIGATION_HEADER)
  return stamped
}

/**
 * Whether a request may make, read or write a private drive: the phone's rule.
 * The browser's own pages and the drive's own pages may, and so may a tab
 * opening it, where the page that linked to it cannot read it. Any other page,
 * an app added under peersky://myapps included, could only know the address or
 * the name, and as Electron applies no CORS to hyper://, it would otherwise
 * read the drive with this device's keys.
 * @param {{ url: string, initiatorOrigin?: string, navigation?: boolean }} request
 */
export function mayUsePrivateDrive ({ url, initiatorOrigin, navigation = false }) {
  if (navigation) return true
  // Absent when the browser made the request itself: a typed address, a
  // bookmark, a restored tab.
  if (initiatorOrigin === undefined) return true
  const caller = parseUrl(initiatorOrigin)
  const target = parseUrl(url)
  if (!caller || !target) return false
  if (isOwnPage(caller)) return true
  return caller.protocol === 'hyper:' && caller.hostname === target.hostname
}

/** Wrap a protocol handler so sensitive requests must carry the stamp. */
export function requireVetted (handler) {
  return (request) => {
    const vetted = request.headers.get(VETTED_HEADER) === vettedToken
    request.headers.delete(VETTED_HEADER)
    if (!vetted && isSensitive(request.url, request.method)) {
      return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } })
    }
    return handler(request)
  }
}
