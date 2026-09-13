/**
 * Links the shell cannot render are the operating system's job.
 *
 * A page that opens itms-apps://, mailto: or any other app scheme used to be
 * routed into a new tab, which then had nothing to load and sat there blank.
 * Those navigations are handed to the OS instead, after asking, because
 * forwarding a scheme launches whatever app claims it.
 */
import { shell, dialog } from 'electron'
import { createLogger } from './logger.js'

const log = createLogger('external-scheme')

// Everything the browser renders itself.
const INTERNAL_SCHEMES = new Set([
  'http:', 'https:', 'about:', 'file:', 'blob:', 'data:',
  'peersky:', 'browser:', 'ipfs:', 'ipns:', 'pubsub:',
  'hyper:', 'hs:', 'web3:', 'bittorrent:', 'bt:', 'magnet:'
])

// Forwarding these is how a page would run code or read disk through another
// app, so they are dropped whoever asks.
const NEVER_FORWARD = new Set([
  'javascript:', 'vbscript:', 'chrome:', 'chrome-extension:', 'devtools:',
  'ms-msdt:', 'search-ms:', 'shell:', 'vscode:', 'smb:'
])

export function isExternalScheme (url) {
  try {
    const { protocol } = new URL(url)
    return !INTERNAL_SCHEMES.has(protocol) && !NEVER_FORWARD.has(protocol)
  } catch {
    return false
  }
}

export async function openExternalScheme (browserWindow, url) {
  if (!isExternalScheme(url)) {
    log.warn('refused to forward:', String(url).slice(0, 120))
    return false
  }
  const shown = url.length > 120 ? `${url.slice(0, 119)}…` : url
  try {
    const { response } = await dialog.showMessageBox(browserWindow ?? null, {
      type: 'question',
      buttons: ['Open', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Open in another app?',
      message: 'This link opens outside Peersky.',
      detail: shown
    })
    if (response !== 0) return false
    await shell.openExternal(url)
    return true
  } catch (err) {
    log.error('handoff failed:', err?.message || err)
    return false
  }
}
