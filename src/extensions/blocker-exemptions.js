// Requests kept away from extensions, so no content blocker can cancel them.
// Each one is blocked by a filter list for privacy but needed by a site for
// something people do there, and says why. Keep this list short: every other
// request stays the blocker's to decide.

const EXEMPTIONS = [
  {
    // Figma's sign-up dialog stayed invisible behind a dimmed page. EasyPrivacy
    // blocks Figma's analytics (figment-proxy). When the sign-in frame cannot
    // reach it, Figma stops sending events, and the page only fades the dialog
    // in once that frame reports it is ready, as one of those events. Only the
    // sign-in frame gets through: Figma's analytics from its other pages stay
    // blocked.
    origin: 'https://www.figma.com',
    path: '/api/figment-proxy/',
    framePath: '/login_iframe'
  }
]

function parse (address) {
  if (typeof address !== 'string' || !address) return null
  try {
    return new URL(address)
  } catch {
    return null
  }
}

// A frame torn down mid-request throws on access instead of returning null.
export function frameUrlOf (details) {
  try {
    return details?.frame?.url || ''
  } catch {
    return ''
  }
}

/**
 * Whether a webRequest should skip extensions.
 * @param {{ url?: string, frame?: { url?: string }, referrer?: string }} details
 * @returns {boolean}
 */
export function isExemptFromBlockers (details) {
  const request = parse(details?.url)
  if (!request) return false
  const exemption = EXEMPTIONS.find((entry) => request.origin === entry.origin && request.pathname.startsWith(entry.path))
  if (!exemption) return false
  // The frame that asked, or its address as the referrer when the frame is gone.
  const frame = parse(frameUrlOf(details) || details?.referrer)
  return !!frame && frame.origin === exemption.origin && frame.pathname === exemption.framePath
}
