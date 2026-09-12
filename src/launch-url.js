/**
 * Links the operating system hands to the browser: a click in another app once
 * Peersky is the default browser, a peersky:// or hyper:// link anywhere, or a
 * URL on the command line. macOS delivers them as open-url events, which can
 * arrive before a window exists; Windows and Linux start a second process with
 * the URL in argv, which the single-instance lock turns into second-instance
 * on the process that owns the profile.
 */

// Every scheme package.json declares to the installer, plus the two Peersky
// renders without declaring. A test keeps this in step with build.protocols.
export const LAUNCH_SCHEMES = new Set([
  'http:', 'https:', 'peersky:', 'browser:', 'ipfs:', 'ipns:', 'ipld:',
  'hyper:', 'dat:', 'web3:', 'bittorrent:', 'bt:', 'magnet:', 'hs:', 'pubsub:'
])

// argv[0] is the executable; in dev argv[1] is the app path, which fails to
// parse as a URL and drops out on its own.
export function urlFromArgv (argv) {
  for (const arg of (argv || []).slice(1)) {
    if (typeof arg !== 'string' || arg.startsWith('-')) continue
    try {
      const url = new URL(arg)
      if (LAUNCH_SCHEMES.has(url.protocol)) return url.href
    } catch {}
  }
  return null
}

const pending = []
let deliver = null

export function queueLaunchUrl (url) {
  if (!url) return
  if (deliver) deliver(url)
  else pending.push(url)
}

// Called once a window can take a tab; anything queued before that is flushed
// in arrival order.
export function startDeliveringLaunchUrls (fn) {
  deliver = fn
  while (pending.length) fn(pending.shift())
}
