/**
 * The user agent PeerSky sends: Chrome's, as Chrome sends it, with PeerSky
 * named inside the platform part.
 *
 * Electron's own adds the app's name and an Electron token after Chrome's.
 * Sites read any token there as an unknown browser: WhatsApp Web asked to
 * update Chrome, Teams showed a blank page, Notion sent people to its login.
 * Inside the parentheses those sites do not look, and pages that look for
 * "peersky" to offer P2P links, such as the Wiki app, still find it. The
 * version is reduced as Chrome reduces it.
 *
 * Kept free of Electron imports so it can be tested directly.
 */

const ELECTRON_UA = /^Mozilla\/5\.0 \(([^)]*)\) AppleWebKit\/([\d.]+) \(KHTML, like Gecko\) (?:\S+ )*?Chrome\/(\d+)(?:\.[\d.]+)?(?: \S+)*? Safari\/([\d.]+)$/

export function chromeLikeUserAgent (userAgent, version) {
  const match = ELECTRON_UA.exec(String(userAgent || ''))
  // A shape this does not know is left as it is.
  if (!match) return userAgent
  const [, platform, webkit, chromeMajor, safari] = match
  const name = /^[\w.-]+$/.test(String(version || '')) ? `PeerSky/${version}` : 'PeerSky'
  return `Mozilla/5.0 (${platform}; ${name}) AppleWebKit/${webkit} (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/${safari}`
}
