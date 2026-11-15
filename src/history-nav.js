/**
 * Step the active tab through its own history.
 *
 * The shell owns the tab strip, so history belongs to the active tab's webview
 * rather than the window's webContents. The menu items, the keyboard shortcuts
 * and the mouse back/forward buttons all go through here so they cannot drift
 * apart.
 */
const RENDERER_SNIPPET = (method) => `{
  const tabBar = document.querySelector('#tabbar');
  if (tabBar && typeof tabBar.${method}ActiveTab === 'function') {
    tabBar.${method}ActiveTab();
  } else {
    const webview = document.querySelector('webview');
    if (webview && webview.can${method === 'goBack' ? 'GoBack' : 'GoForward'}()) {
      webview.${method}();
    }
  }
}`

export function goBackActiveTab (browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) return
  browserWindow.webContents.executeJavaScript(RENDERER_SNIPPET('goBack'))
}

export function goForwardActiveTab (browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) return
  browserWindow.webContents.executeJavaScript(RENDERER_SNIPPET('goForward'))
}

/**
 * Steps one tab's history, asked from inside that tab: the mouse's back and
 * forward buttons on a Mac (pages/unified-preload.js). The tab comes to the
 * front if it was not, as a click in it brings it.
 */
export function stepTabHistory (tab, step) {
  const host = tab?.hostWebContents
  if (!host || host.isDestroyed() || (step !== 'back' && step !== 'forward')) return
  const method = step === 'back' ? 'goBackActiveTab' : 'goForwardActiveTab'
  host.executeJavaScript(`(() => {
    const tabBar = document.querySelector('#tabbar')
    const tab = tabBar?.findTabByWebContentsId?.(${Number(tab.id)})
    if (!tab) return
    if (tab.id !== tabBar.activeTabId) tabBar.selectTab(tab.id)
    tabBar.${method}()
  })()`).catch(() => {})
}
