/**
 * Tabs that attached before the extension host existed.
 *
 * The extension host now boots alongside the first windows instead of ahead of
 * them, so a webview can attach while there is still nothing to register it
 * with. Dropping one leaves that tab invisible to every extension for the rest
 * of the session — the tab's popup opens against the wrong tab, or does nothing
 * until the user clicks again — so they are held here and registered once the
 * host is up.
 *
 * Kept free of Electron imports so the queueing rules can be tested directly.
 */

/**
 * @typedef {object} PendingTabs
 * @property {(window: any, webContents: any) => boolean} add
 * @property {() => Array<{ window: any, webContents: any }>} drain
 * @property {() => void} clear
 * @property {() => number} size
 */

/**
 * @returns {PendingTabs}
 */
export function createPendingTabs () {
  /** @type {Map<number, { window: any, webContents: any }>} */
  const pending = new Map()

  return {
    /**
     * Hold a tab until the extension host is ready.
     *
     * @returns {boolean} false when there is nothing to hold (the shell window
     *   itself, or a WebContents that is already gone).
     */
    add (window, webContents) {
      if (!webContents || webContents.isDestroyed?.()) return false
      const id = webContents.id
      if (pending.has(id)) return true
      pending.set(id, { window, webContents })
      // A tab that closes while waiting must not be registered later.
      webContents.once?.('destroyed', () => pending.delete(id))
      return true
    },

    /** Take everything still worth registering, and forget it. */
    drain () {
      const entries = [...pending.values()]
      pending.clear()
      return entries.filter(({ window, webContents }) =>
        webContents && !webContents.isDestroyed?.() && !window?.isDestroyed?.()
      )
    },

    clear () {
      pending.clear()
    },

    size () {
      return pending.size
    }
  }
}
