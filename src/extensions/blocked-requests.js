// A content blocker stops a request with a network error. For a page's own
// calls, fetch, XHR and beacons, that error can stop the page too: Figma's
// sign-up dialog only fades in once its sign-in frame has logged an analytics
// event, EasyPrivacy blocks Figma's analytics, and the dialog never showed.
// Any site can wait on a call like that, so instead of the error, a blocked
// call is answered here, on this device, with an empty response. The page
// carries on and nothing reaches the server. Scripts, frames, images and the
// rest still fail as blocked: an empty one of those can break a page as easily
// as a missing one.

export const BLOCKED_SCHEME = 'peersky-blocked'
const BLOCKED_ANSWER = `${BLOCKED_SCHEME}://blocked/`

// Electron's names for fetch and XHR, and for beacons and <a ping>.
const ANSWERED_TYPES = new Set(['xhr', 'ping'])

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

/**
 * What webRequest should do with a request once the extensions have decided:
 * an empty answer in place of a block for a page's own calls, and anything
 * else as the extensions gave it.
 * @param {{ resourceType?: string }} details
 * @param {{ cancel?: boolean, redirectURL?: string }} result
 */
export function answerBlockedCall (details, result) {
  if (!result?.cancel) return result
  if (!ANSWERED_TYPES.has(details?.resourceType)) return result
  return { redirectURL: BLOCKED_ANSWER }
}

/** The empty answer, for every request to the scheme. */
export function blockedCallHandler () {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'no-store'
    }
  })
}
