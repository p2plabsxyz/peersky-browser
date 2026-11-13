/**
 * A site that asks for a sign-in (HTTP Basic or Digest: a 401 with
 * WWW-Authenticate) gets a sign-in dialog over its tab, as in Chrome, where
 * Electron cancelled the challenge and the page showed the 401.
 *
 * Extensions hear the challenge first, through chrome.webRequest.onAuthRequired,
 * and one that answers or cancels it is taken at its word, as in Chrome. The
 * person is asked only when none does. The extension host owns the app's
 * 'login' event for the browser's session, so its answer gets the dialog as a
 * fallback. Pages in a private window, and any page before extensions load,
 * are answered here.
 *
 * A proxy's challenge is left to what answered it before: a VPN extension's
 * login through the host, or nothing (extensions/services/proxy-settings.js).
 *
 * What is typed answers the one challenge it was asked for, through Electron's
 * callback, so only the host that asked gets it. It is not kept or filled in.
 */
import { app, webContents } from 'electron'
import { ElectronChromeExtensions } from '@p2plabs/peersky-chrome-extensions'
import { askInTab, closeTabDialogs, tabHost } from './tab-dialogs.js'

const LOOPBACK_HOST = /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i

/**
 * What the dialog names: the origin that asked, and whether the connection
 * to it is not private. As in Chrome, http on this machine counts as private.
 * Null for an address no sign-in can come from.
 */
export function signInRequest (url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return {
    origin: parsed.origin,
    notPrivate: parsed.protocol === 'http:' && !LOOPBACK_HOST.test(parsed.hostname)
  }
}

// Challenges waiting on one dialog: a page's images or requests that hit the
// same protected space together get one dialog and share its answer.
const waiting = new Map()

/**
 * Asks the person over guest's tab to sign in to the site at url. Resolves
 * with { username, password }, or null for Cancel or a dialog taken down.
 */
export function askToSignIn (guest, url, authInfo = {}) {
  const request = signInRequest(url)
  if (!request || !tabHost(guest)) return Promise.resolve(null)
  closeOnNavigation(guest)
  const key = [guest.id, request.origin, authInfo.scheme, authInfo.realm].join('\n')
  let answer = waiting.get(key)
  if (!answer) {
    answer = askInTab(guest, { kind: 'sign-in', ...request })
      .then((given) => (typeof given?.username === 'string' && typeof given?.password === 'string')
        ? { username: given.username, password: given.password }
        : null)
      .catch(() => null)
      .finally(() => waiting.delete(key))
    waiting.set(key, answer)
  }
  return answer
}

// Another page in the tab ends the sign-in, as in Chrome.
const navigationWatched = new Set() // webContents ids

function closeOnNavigation (guest) {
  const id = guest.id
  if (navigationWatched.has(id)) return
  navigationWatched.add(id)
  guest.on('did-start-navigation', (details) => {
    if (details?.isMainFrame && !details.isSameDocument) closeTabDialogs(id, ['sign-in'])
  })
  guest.once('destroyed', () => navigationWatched.delete(id))
}

const withFallback = new WeakSet()

/**
 * Has the extension host ask the person when no extension answered a site's
 * challenge, instead of cancelling it.
 */
export function fallBackToSignIn (host) {
  const api = host?.api?.webRequest
  if (!api || typeof api.notifyOnAuthRequired !== 'function' || withFallback.has(api)) return
  withFallback.add(api)
  const notify = api.notifyOnAuthRequired.bind(api)
  api.notifyOnAuthRequired = async (details) => {
    const result = await notify(details)
    if (!details || details.isProxy || result?.cancel || result?.authCredentials) return result
    const guest = Number.isInteger(details.webContentsId) ? webContents.fromId(details.webContentsId) : null
    if (!tabHost(guest)) return result
    const given = await askToSignIn(guest, details.url, { scheme: details.scheme, realm: details.realm })
    return given ? { ...result, authCredentials: given } : result
  }
}

function extensionHostFor (contents) {
  try {
    return ElectronChromeExtensions.fromSession(contents.session) || null
  } catch {
    return null
  }
}

function onLogin (event, contents, details, authInfo, callback) {
  if (!contents || authInfo?.isProxy) return
  // The host's own listener runs next and answers this one.
  const host = extensionHostFor(contents)
  if (host) {
    fallBackToSignIn(host)
    return
  }
  if (!tabHost(contents)) return
  event.preventDefault()
  askToSignIn(contents, details?.url, authInfo).then(
    (given) => (given ? callback(given.username, given.password) : callback()),
    () => callback()
  )
}

// Ahead of the extension host's listener, so its fallback is in place by the
// time it asks extensions.
export function setupHttpAuth () {
  app.prependListener('login', onLogin)
}
