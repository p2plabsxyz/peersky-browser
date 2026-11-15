import { BrowserWindow } from 'electron'

// Whether a page in a tab is in front of the person. A tab's page cannot tell:
// Electron gives a webview the visibility of its window, so a tab behind
// another still reads "visible". The window it is in knows which tabs it
// shows, side by side ones included, by which webviews are laid out.

/** The script the window runs: whether the webview for this page is laid out. */
export function laidOutScript (contentsId) {
  if (!Number.isSafeInteger(contentsId) || contentsId < 0) return null
  return `(() => {
    for (const view of document.querySelectorAll('webview')) {
      let id = null
      try { id = view.getWebContentsId() } catch {}
      if (id === ${contentsId}) return view.getClientRects().length > 0
    }
    return false
  })()`
}

/**
 * True when the page is a tab shown in an open window that is not minimized.
 * Anything else, a page gone or one not in a tab, is not on screen.
 */
export async function isTabOnScreen (contents, { windowOf = (host) => BrowserWindow.fromWebContents(host) } = {}) {
  try {
    if (!contents || contents.isDestroyed() || contents.getType() !== 'webview') return false
    const host = contents.hostWebContents
    if (!host || host.isDestroyed()) return false
    const win = windowOf(host)
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return false
    const script = laidOutScript(contents.id)
    if (!script) return false
    return (await host.executeJavaScript(script)) === true
  } catch {
    return false
  }
}
