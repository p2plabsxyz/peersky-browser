/**
 * Why a removeTab callback from the extension system must not close the tab.
 *
 * The store's own removeTab(), which is the documented way to stop tracking a
 * webContents, calls the host's removeTab impl on its way out. So untracking a
 * tab that is already closing asked the UI to close it a second time, and that
 * second close ran executeJavaScript against a webContents being torn down and
 * took the main process down with SIGTRAP. Traced on a plain tab close:
 * extensions-unregister-webview -> removeWindow -> ece.removeTab ->
 * ExtensionStore.removeTab -> the host removeTab impl -> tabBar.closeTab for a
 * tab the renderer had already dropped.
 *
 * A close that does not arrive during untracking, which is how
 * chrome.tabs.remove() reaches us, must still be honoured.
 *
 * @returns {string|null} The reason to refuse, or null to close the tab.
 */
export function refuseTabClose ({ untracking, tab }) {
  if (!tab) return 'no tab given'
  if (typeof tab.id !== 'number') return 'no valid webContents ID'
  if (untracking && untracking.has(tab.id)) return 'tab is already closing, only untracking'
  if (typeof tab.isDestroyed === 'function' && tab.isDestroyed()) return 'tab already destroyed'
  return null
}
