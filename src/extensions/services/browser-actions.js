// Browser actions (click/open popup) and helpers

import { app, BrowserWindow, Menu, webContents } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import { registerPopupForStabilization, consumeRecentFocusClose } from './popup-guards.js'
import { tryOpenSidePanelOnActionClick } from './side-panel.js'
import { createLogger } from '../../logger.js'

const log = createLogger('extensions')

/** opaque background for extension popup window to match settings-card-bg on transparent/dark theme */
const EXTENSION_POPUP_BG = '#27272a'

function pinECEWindowFocus (manager, window, activeTab) {
  try {
    const ece = manager.electronChromeExtensions
    if (!ece) return
    const store = ece.ctx.store

    store.lastFocusedWindowId = window.id

    if (!store.tabs.has(activeTab)) {
      ece.addTab(activeTab, window)
    }

    ece.selectTab(activeTab)

    store.windowToActiveTab.set(window, activeTab)

    const cached = store.tabDetailsCache.get(activeTab.id)
    if (cached) {
      cached.active = true
      cached.windowId = window.id
    }

    try {
      if (ece.ctx && ece.ctx.router) {
        ece.ctx.router.broadcastEvent('windows.onFocusChanged', window.id)
        ece.ctx.router.broadcastEvent('tabs.onActivated', { tabId: activeTab.id, windowId: window.id })
      }
    } catch (_) { }
  } catch (_) { }
}

function cleanupPopupOnClose (manager, popup) {
  manager.activePopups.delete(popup)
  const opener = manager.popupToOpener.get(popup)
  const extId = manager.popupToExtensionId.get(popup)
  if (opener && !opener.isDestroyed() && opener.webContents && !opener.webContents.isDestroyed() && extId) {
    opener.webContents.send('remove-tempIcon', extId)
  }
  manager.popupToOpener.delete(popup)
  manager.popupToExtensionId.delete(popup)
}

export async function listBrowserActions (manager, window) {
  let state = null
  try {
    const api = manager.electronChromeExtensions?.api?.browserAction
    if (api && typeof api.getState === 'function') {
      state = api.getState()
    }
  } catch (_) {
    state = null
  }

  const activeTabId = state && typeof state.activeTabId === 'number' ? state.activeTabId : null
  const stateByExtensionId = new Map()
  if (state && Array.isArray(state.actions)) {
    for (const entry of state.actions) {
      if (!entry || typeof entry.id !== 'string') continue
      const tabInfo = activeTabId != null && entry.tabs && entry.tabs[activeTabId] ? entry.tabs[activeTabId] : null
      stateByExtensionId.set(entry.id, {
        text: (tabInfo && typeof tabInfo.text !== 'undefined') ? tabInfo.text : entry.text,
        color: (tabInfo && typeof tabInfo.color !== 'undefined') ? tabInfo.color : entry.color,
        title: (tabInfo && typeof tabInfo.title !== 'undefined') ? tabInfo.title : entry.title,
        popup: (tabInfo && typeof tabInfo.popup !== 'undefined') ? tabInfo.popup : entry.popup
      })
    }
  }

  const actions = []
  for (const extension of manager.loadedExtensions.values()) {
    if (extension.enabled && extension.manifest) {
      const action = extension.manifest.action || extension.manifest.browser_action
      const extState = extension.electronId ? stateByExtensionId.get(extension.electronId) : null
      const badgeTextRaw = extState?.text
      const badgeText = typeof badgeTextRaw === 'string' ? badgeTextRaw : (badgeTextRaw != null ? String(badgeTextRaw) : '')
      const badgeBackgroundColor = typeof extState?.color === 'string' ? extState.color : '#666'
      const title = typeof extState?.title === 'string'
        ? extState.title
        : (action && (action.default_title || extension.displayName || extension.name)) || (extension.displayName || extension.name)
      actions.push({
        id: extension.id,
        extensionId: extension.electronId,
        name: extension.displayName || extension.name,
        title,
        icon: extension.iconPath,
        popup: (typeof extState?.popup === 'string' ? extState.popup : (action ? action.default_popup : undefined)),
        badgeText,
        badgeBackgroundColor,
        enabled: true,
        hasAction: Boolean(action)
      })
    }
  }
  // Every badge or icon update makes each window re-list, so this runs far too
  // often to log at info level.
  if (actions.length > 0) {
    log.debug(`ExtensionManager: Found ${actions.length} browser actions`)
  }
  return actions
}

export async function clickBrowserAction (manager, actionId, window) {
  const extension = manager.loadedExtensions.get(actionId)
  if (!extension || !extension.enabled) {
    log.warn(`ExtensionManager: Extension ${actionId} not found or disabled`)
    return
  }
  const action = extension.manifest?.action || extension.manifest?.browser_action
  if (!action) {
    log.warn(`ExtensionManager: Extension ${actionId} has no browser action`)
    return
  }
  if (manager.electronChromeExtensions && extension.electronId) {
    try {
      log.info(`ExtensionManager: Triggering browser action click for ${extension.displayName || extension.name}`)

      const activeWebview = await getAndRegisterActiveWebview(manager, window)
      const activeTab = activeWebview || window.webContents

      pinECEWindowFocus(manager, window, activeTab)

      // openPanelOnActionClick: open/toggle panel and skip onClicked.
      // Extensions like WebBrain leave this false and open via sidePanel.open() from onClicked.
      if (await tryOpenSidePanelOnActionClick(manager, extension, window, activeTab)) {
        return
      }

      // Method 1: Use activateExtension if available (preferred for extensions without popups)
      if (manager.electronChromeExtensions.activateExtension) {
        try {
          await manager.electronChromeExtensions.activateExtension(activeTab, extension.electronId)
          log.info(`ExtensionManager: activateExtension called for ${extension.displayName || extension.name}`)
          return
        } catch (activateError) {
          log.warn(`ExtensionManager: activateExtension failed for ${extension.displayName || extension.name}:`, activateError)
        }
      }

      // Method 2: Use browserAction.openPopup (peersky-chrome-extensions handles no-popup case)
      // For extensions WITHOUT a popup, openPopup should dispatch onClicked event
      if (manager.electronChromeExtensions.api && manager.electronChromeExtensions.api.browserAction) {
        const browserActionAPI = manager.electronChromeExtensions.api.browserAction
        try {
          if (browserActionAPI.openPopup) {
            await browserActionAPI.openPopup({ extension: { id: extension.electronId } }, { windowId: window.id })
            log.info(`ExtensionManager: browserAction.openPopup called for ${extension.displayName || extension.name} (no popup = triggers onClicked)`)
            return
          }
        } catch (openPopupError) {
          log.warn(`ExtensionManager: browserAction.openPopup failed for ${extension.displayName || extension.name}:`, openPopupError)
        }
      }

      // Method 3: Try action API (MV3 style)
      if (manager.electronChromeExtensions.api && manager.electronChromeExtensions.api.action) {
        const actionAPI = manager.electronChromeExtensions.api.action
        try {
          if (actionAPI.openPopup) {
            await actionAPI.openPopup({ extensionId: extension.electronId })
            log.info(`ExtensionManager: action.openPopup called for ${extension.displayName || extension.name}`)
            return
          }
        } catch (actionError) {
          log.warn(`ExtensionManager: action.openPopup failed for ${extension.displayName || extension.name}:`, actionError)
        }
      }

      // Method 4: Fallback - try to manually emit onClicked event via emit/dispatch if available
      const tabInfo = { id: activeTab.id, windowId: window.id, url: activeTab.getURL?.() || '', active: true }

      if (manager.electronChromeExtensions.api && manager.electronChromeExtensions.api.browserAction) {
        const browserActionAPI = manager.electronChromeExtensions.api.browserAction
        try {
          // Try emit method (some versions use this)
          if (browserActionAPI.emit) {
            browserActionAPI.emit('clicked', extension.electronId, tabInfo)
            log.info(`ExtensionManager: browserAction.emit('clicked') called for ${extension.displayName || extension.name}`)
            return
          }
          // Try click method directly
          if (browserActionAPI.click) {
            await browserActionAPI.click(extension.electronId, tabInfo)
            log.info(`ExtensionManager: browserAction.click called for ${extension.displayName || extension.name}`)
            return
          }
        } catch (emitError) {
          log.warn(`ExtensionManager: browserAction emit/click failed for ${extension.displayName || extension.name}:`, emitError)
        }
      }

      // Method 5: Last resort - try getBrowserAction and trigger
      if (manager.electronChromeExtensions.getBrowserAction) {
        const browserAction = manager.electronChromeExtensions.getBrowserAction(extension.electronId)
        if (browserAction) {
          // Try multiple trigger approaches
          if (typeof browserAction.activate === 'function') {
            await browserAction.activate(activeTab)
            log.info(`ExtensionManager: browserAction.activate called for ${extension.displayName || extension.name}`)
            return
          }
          if (browserAction.onClicked && typeof browserAction.onClicked.emit === 'function') {
            browserAction.onClicked.emit(tabInfo)
            log.info(`ExtensionManager: browserAction.onClicked.emit triggered for ${extension.displayName || extension.name}`)
            return
          }
        }
      }

      log.warn(`ExtensionManager: No suitable browser action trigger method found for ${extension.displayName || extension.name}`)
    } catch (error) {
      log.error(`ExtensionManager: Failed to trigger browser action for ${extension.displayName || extension.name}:`, error)
    }
  }
}

/**
 * Open (or toggle off) an extension's popup.
 *
 * @param {any} manager
 * @param {string} actionId
 * @param {Electron.BrowserWindow} window
 * @param {object} anchorRect - Toolbar button rect, for popup placement.
 * @param {object} [options]
 * @param {number|null} [options.activeWebContentsId] - See getAndRegisterActiveWebview.
 */
export async function openBrowserAction (manager, actionId, window, anchorRect, options = {}) {
  const { activeWebContentsId = null } = options
  try {
    // If the click that stole focus already closed this popup, treat this
    // invocation as the toggle-off half of that click.
    if (consumeRecentFocusClose(actionId)) {
      return { success: true, toggled: true }
    }

    const extension = manager.loadedExtensions.get(actionId)
    if (!extension || !extension.enabled) {
      log.warn(`ExtensionManager: Extension ${actionId} not found or disabled`)
      return { success: false, error: 'Extension not found or disabled' }
    }
    const action = extension.manifest?.action || extension.manifest?.browser_action
    if (!action) {
      log.warn(`ExtensionManager: Extension ${actionId} has no browser action`)
      return { success: false, error: 'No browser action found' }
    }

    const activeWebview = await getAndRegisterActiveWebview(manager, window, activeWebContentsId)
    const activeTab = activeWebview || window.webContents
    pinECEWindowFocus(manager, window, activeTab)

    if (await tryOpenSidePanelOnActionClick(manager, extension, window, activeTab)) {
      if (window && !window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
        window.webContents.send('remove-tempIcon', actionId)
      }
      return { success: true, sidePanel: true }
    }

    if (!action.default_popup) {
      log.info(`ExtensionManager: Extension ${extension.displayName || extension.name} has no popup, triggering click instead`)
      await clickBrowserAction(manager, actionId, window)
      if (window && !window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
        window.webContents.send('remove-tempIcon', actionId)
      }
      return { success: true }
    }
    const popupRelRaw = String(action.default_popup || '').replace(/^\//, '')

    // Where the popup file actually lives is only needed if the extension host
    // cannot open it for us. Probing the extension directory here — a stat, and
    // for a mismatched manifest a two-deep directory walk — put disk I/O in
    // front of every single click.
    const resolvePopupPath = async () => {
      if (await doesExtensionFileExist(extension.installedPath, popupRelRaw)) return popupRelRaw
      const alt = await resolvePopupRelativePath(extension.installedPath, popupRelRaw)
      if (alt) {
        log.warn(`ExtensionManager: Manifest popup missing (${popupRelRaw}), using detected ${alt}`)
        return alt
      }
      return popupRelRaw
    }

    if (manager.electronChromeExtensions && extension.electronId) {
      try {
        log.info(`ExtensionManager: Opening popup for ${extension.displayName || extension.name} at`, anchorRect)

        // Method 2: Use browserAction.openPopup
        if (manager.electronChromeExtensions.api && manager.electronChromeExtensions.api.browserAction) {
          const browserActionAPI = manager.electronChromeExtensions.api.browserAction
          try {
            if (browserActionAPI.openPopup) {
              app.once('browser-window-created', (event, newWindow) => {
                // Register for stabilization IMMEDIATELY to prevent race condition
                registerPopupForStabilization(newWindow)
                newWindow.setBackgroundColor(EXTENSION_POPUP_BG)
                if (manager.activePopups) {
                  manager.activePopups.add(newWindow)
                  manager.popupToOpener.set(newWindow, window)
                  manager.popupToExtensionId.set(newWindow, actionId)
                  newWindow.on('closed', () => cleanupPopupOnClose(manager, newWindow))
                }

                newWindow.webContents.once('did-finish-load', () => {
                  const url = newWindow.webContents.getURL()
                  if (url.includes(`chrome-extension://${extension.electronId}/`)) {
                    // CRITICAL FIX: DO NOT call manager.addWindow(newWindow, newWindow.webContents) here.
                    // Doing so registers the popup as a tab, which steals ECE's internal focus and breaks extensions like Linguist.
                    newWindow.webContents.on('context-menu', (evt, params) => {
                      const menu = Menu.buildFromTemplate([
                        {
                          label: 'Inspect',
                          click: () => {
                            try { if (!newWindow.webContents.isDevToolsOpened()) { newWindow.webContents.openDevTools({ mode: 'detach' }) } } catch (_) { }
                            try { newWindow.webContents.inspectElement(params.x, params.y) } catch (_) { }
                          }
                        }
                      ])
                      try { menu.popup({ window: newWindow, x: params.x, y: params.y }) } catch (_) { menu.popup({ window: newWindow }) }
                    })
                    function lockWindowPosition (win, getPosition) {
                      if (!win || win.isDestroyed()) return
                      const _setBounds = win.setBounds.bind(win)
                      const _setBoundsSafe = (newBounds) => {
                        if (win.isDestroyed()) return
                        const pos = getPosition(newBounds)
                        _setBounds({ x: pos.x, y: pos.y, width: newBounds.width, height: newBounds.height })
                      }
                      win.setBounds = _setBoundsSafe
                    }
                    const calcPosition = (popupBounds) => {
                      const mainBounds = window.getBounds()
                      return { x: (mainBounds.x + anchorRect.x - popupBounds.width + anchorRect.width), y: mainBounds.y + anchorRect.y + 38 }
                    }
                    lockWindowPosition(newWindow, calcPosition)
                  }
                })
              })
              await browserActionAPI.openPopup({ extension: { id: extension.electronId } }, { windowId: window.id })
              return { success: true }
            }
          } catch (openPopupError) {
            log.warn(`ExtensionManager: browserAction.openPopup failed for ${extension.displayName || extension.name}:`, openPopupError)
          }
        }
        log.info(`ExtensionManager: Falling back to regular click for ${extension.displayName || extension.name}`)
        await clickBrowserAction(manager, actionId, window)
        const resolvedPopupRel = await resolvePopupPath()
        if (resolvedPopupRel) {
          log.info(`ExtensionManager: Attempting manual popup creation for ${extension.displayName || extension.name}`)
          try {
            const popupUrl = `chrome-extension://${extension.electronId}/${resolvedPopupRel}?windowId=${window.id}&tabId=${activeTab.id}`
            const popupWindow = new (await import('electron')).BrowserWindow({
              width: 400,
              height: 600,
              x: Math.round(anchorRect.x),
              y: Math.round(anchorRect.bottom + 5),
              show: false,
              frame: false,
              resizable: false,
              backgroundColor: EXTENSION_POPUP_BG,
              webPreferences: { nodeIntegration: false, contextIsolation: true, enableRemoteModule: false, partition: window.webContents.session.partition }
            })
            // Register for stabilization to prevent early closure
            registerPopupForStabilization(popupWindow)
            if (manager.activePopups) {
              manager.activePopups.add(popupWindow)
              manager.popupToOpener.set(popupWindow, window)
              manager.popupToExtensionId.set(popupWindow, actionId)
              popupWindow.on('closed', () => cleanupPopupOnClose(manager, popupWindow))
            }

            const isExternalUrl = (u) => /^(https?:|ipfs:|ipns:|hyper:|web3:)/i.test(u)
            popupWindow.webContents.setWindowOpenHandler(({ url }) => {
              if (isExternalUrl(url)) { try { manager.electronChromeExtensions?.createTab?.({ url, active: true }) } catch (_) { } return { action: 'deny' } }
              return { action: 'allow' }
            })
            await popupWindow.loadURL(popupUrl)
            popupWindow.showInactive()
            return { success: true }
          } catch (manualError) {
            log.error(`ExtensionManager: Manual popup creation failed for ${extension.displayName || extension.name}:`, manualError)
          }
        }
        return { success: true }
      } catch (error) {
        log.error(`ExtensionManager: Failed to open popup for ${extension.displayName || extension.name}:`, error)
        return { success: false, error: error.message }
      }
    }
    return { success: false, error: 'Extension system not available' }
  } catch (error) {
    log.error('ExtensionManager: Browser action popup failed:', error)
    return { success: false, error: error.message }
  }
}

export function closeAllPopups (manager) {
  if (manager.activePopups?.size > 0) {
    log.info(`[ExtensionManager] Closing ${manager.activePopups.size} active popups`)
    for (const popup of manager.activePopups) {
      try { if (!popup.isDestroyed()) { popup.close() } } catch (error) { log.warn('[ExtensionManager] Error closing popup:', error) }
    }
    manager.activePopups.clear()
  }
}

/**
 * True when `wc` is a guest of `window`, so a renderer-supplied webContents id
 * can only ever name a tab of the window that sent it.
 */
function isOwnedByWindow (wc, window) {
  try {
    if (!wc || wc.isDestroyed() || !window || window.isDestroyed()) return false
    if (wc.hostWebContents && wc.hostWebContents.id === window.webContents.id) return true
    return BrowserWindow.fromWebContents(wc) === window
  } catch (_) {
    return false
  }
}

/**
 * Resolve the window's active tab and make sure the extension host knows about
 * it.
 *
 * @param {any} manager
 * @param {Electron.BrowserWindow} window
 * @param {number|null} [activeWebContentsId] - The active webview's id as the
 *   renderer already knows it. Supplying it skips an executeJavaScript round-trip
 *   on the click path; it is verified to belong to `window` before use, and a
 *   stale or foreign id just falls back to asking the renderer.
 * @returns {Promise<Electron.WebContents|null>}
 */
export async function getAndRegisterActiveWebview (manager, window, activeWebContentsId = null) {
  if (typeof activeWebContentsId === 'number') {
    const hinted = webContents.fromId(activeWebContentsId)
    if (isOwnedByWindow(hinted, window)) {
      manager.addWindow(window, hinted)
      return hinted
    }
    log.debug(`[ExtensionManager] Ignoring unusable active webContents hint ${activeWebContentsId}`)
  }

  try {
    const activeTabData = await window.webContents.executeJavaScript(`
      (function() {
        try {
          const tabBar = document.querySelector('#tabbar');
          if (!tabBar || !tabBar.getActiveTab) return null;
          const activeTab = tabBar.getActiveTab();
          if (!activeTab) return null;
          const activeWebview = tabBar.getActiveWebview();
          if (!activeWebview) return null;
          return { tabId: activeTab.id, url: activeTab.url, title: activeTab.title, webContentsId: activeWebview.getWebContentsId() };
        } catch (error) { console.error('[ExtensionManager] Error getting active tab:', error); return null; }
      })();
    `)
    if (!activeTabData || !activeTabData.webContentsId) return null
    const activeWebviewContents = webContents.fromId(activeTabData.webContentsId)
    if (!activeWebviewContents) {
      log.warn(`[ExtensionManager] WebContents ${activeTabData.webContentsId} not found`)
      return null
    }
    manager.addWindow(window, activeWebviewContents)
    return activeWebviewContents
  } catch (error) {
    log.error('[ExtensionManager] Failed to get and register active webview:', error)
    return null
  }
}

export async function doesExtensionFileExist (root, rel) {
  try {
    await fs.access(path.join(root, rel))
    return true
  } catch (_) { return false }
}

export async function resolvePopupRelativePath (root, desiredRel) {
  const desiredBase = desiredRel ? path.basename(desiredRel) : 'popup.html'
  const candidates = [desiredRel, 'popup.html', 'popup/index.html', 'ui/popup.html', 'dist/popup.html', 'build/popup.html']
  for (const rel of candidates) {
    if (!rel) continue
    try { await fs.access(path.join(root, rel)); return rel } catch (_) { }
  }
  try {
    const found = await findFileByName(root, desiredBase, 2)
    if (found) return path.relative(root, found)
  } catch (_) { }
  return null
}

async function findFileByName (dir, name, depth) {
  if (depth < 0) return null
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue
        const r = await findFileByName(full, name, depth - 1)
        if (r) return r
      } else if (e.name === name) {
        return full
      }
    }
  } catch (_) { }
  return null
}
