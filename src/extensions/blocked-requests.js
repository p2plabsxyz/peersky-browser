// A content blocker stops a request with a network error. For a page's own
// calls, fetch, XHR and beacons, that error can stop the page too: Figma's
// sign-up dialog only fades in once its sign-in frame has logged an analytics
// event, EasyPrivacy blocks Figma's analytics, and the dialog never showed.
// Any site can wait on a call like that, so instead of the error, a blocked
// call is answered here, on this device, with an empty response. The page
// carries on and nothing reaches the server. Scripts, frames, images and the
// rest still fail as blocked: an empty one of those can break a page as easily
// as a missing one.
//
// A blocker can also answer a request with content of its own, in a data:
// address: uBlock Origin answers every fetch and XHR its filters redirect that
// way, often with an empty text, so the page carries on as if the server had
// answered. Chrome lets an extension redirect a request to data:, but Electron
// will not follow one (net::ERR_UNSAFE_REDIRECT), so the page got a network
// error instead. The content is served here, at an address made for that one
// request, so no other page can read it.

import { randomBytes } from 'node:crypto'

export const BLOCKED_SCHEME = 'peersky-blocked'
const BLOCKED_ANSWER = `${BLOCKED_SCHEME}://blocked/`
const DATA_ANSWER_HOST = 'data'

// Electron's names for fetch and XHR, and for beacons and <a ping>.
const ANSWERED_TYPES = new Set(['xhr', 'ping'])

// A page loads data: content in a frame on its own, and a WebSocket has no
// content to stand in for.
const NO_DATA_ANSWER_TYPES = new Set(['mainFrame', 'subFrame', 'webSocket'])

// Long enough for the page to follow the redirect, and short, so an address a
// page has seen soon stops working. Blockers' answers are a few bytes; a large
// one is left to fail as it did.
const DATA_ANSWER_LIFETIME_MS = 60_000
const MAX_DATA_ANSWERS = 256
const MAX_DATA_URL_LENGTH = 64 * 1024

// The answer is where a page's own request is redirected, so the page must be
// able to fetch it, and its Content-Security-Policy, which never lists this
// scheme, must not stop it.
export const BLOCKED_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  bypassCSP: true
}

const ANSWER_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Cache-Control': 'no-store'
}

// The data: answers handed out, by the random part of their address, oldest
// first.
const dataAnswers = new Map()

/**
 * What webRequest should do with a request once the extensions have decided:
 * an empty answer in place of a block for a page's own calls, an address
 * Electron follows in place of a data: one, and anything else as the
 * extensions gave it.
 * @param {{ resourceType?: string }} details
 * @param {{ cancel?: boolean, redirectURL?: string }} result
 */
export function answerBlockedCall (details, result) {
  const type = details?.resourceType
  if (result?.cancel) return ANSWERED_TYPES.has(type) ? { redirectURL: BLOCKED_ANSWER } : result
  const target = result?.redirectURL
  if (
    typeof target === 'string' &&
    /^data:/i.test(target) &&
    target.length <= MAX_DATA_URL_LENGTH &&
    typeof type === 'string' &&
    !NO_DATA_ANSWER_TYPES.has(type)
  ) {
    return { redirectURL: keepDataAnswer(target) }
  }
  return result
}

/** The empty answer, or the data: content a request was given. */
export function blockedCallHandler (request) {
  let url = null
  try {
    url = new URL(request?.url)
  } catch (_) {}
  if (url?.hostname === DATA_ANSWER_HOST) return dataAnswer(url.pathname.slice(1))
  return new Response(null, { status: 204, headers: ANSWER_HEADERS })
}

function keepDataAnswer (dataUrl) {
  const now = Date.now()
  for (const [token, kept] of dataAnswers) {
    if (kept.expires > now && dataAnswers.size < MAX_DATA_ANSWERS) break
    dataAnswers.delete(token)
  }
  const token = randomBytes(16).toString('hex')
  dataAnswers.set(token, { dataUrl, expires: now + DATA_ANSWER_LIFETIME_MS })
  return `${BLOCKED_SCHEME}://${DATA_ANSWER_HOST}/${token}`
}

async function dataAnswer (token) {
  const kept = dataAnswers.get(token)
  if (!kept || kept.expires <= Date.now()) {
    dataAnswers.delete(token)
    return new Response(null, { status: 404, headers: ANSWER_HEADERS })
  }
  try {
    // Node reads a data: address as the Fetch standard says: its type, and
    // its text or base64 content.
    const decoded = await fetch(kept.dataUrl)
    const body = await decoded.arrayBuffer()
    const type = decoded.headers.get('content-type') || 'text/plain;charset=US-ASCII'
    return new Response(body, { status: 200, headers: { ...ANSWER_HEADERS, 'Content-Type': type } })
  } catch (_) {
    return new Response(null, { status: 404, headers: ANSWER_HEADERS })
  }
}
