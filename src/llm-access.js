// The check in front of every window.llm call that reaches the main process.
// It runs here and not in the preload, and judges the frame that sent the
// call, so a page cannot talk its way past it.
import {
  getPermissionsForOrigin,
  llmAccessFor,
  permissionOriginFromUrl,
  requestSitePermission
} from './permissions.js'
import { getIncognitoSession } from './session.js'

/**
 * Whether the page behind an IPC event may use AI. PeerSky's own pages may.
 * Any other page that has the bridge asks once per site, in the same prompt as
 * camera or location, and the answer shows in the site panel by the address
 * bar. With `ask: false` nothing pops up and only a Block refuses, so
 * isSupported() can tell a page AI is there before it has asked.
 */
export async function mayUseLLM (event, { ask = true } = {}) {
  const url = event?.senderFrame?.url || ''
  const access = llmAccessFor(url)
  if (access === 'own') return true
  if (access !== 'ask') return false
  const origin = permissionOriginFromUrl(url)
  if (!origin) return false
  const incognito = !!event.sender && event.sender.session === getIncognitoSession()
  if (!ask) return getPermissionsForOrigin(origin, { incognito }).llm !== 'block'
  return requestSitePermission(event.sender, origin, 'llm', { incognito })
}
