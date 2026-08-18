import electron from 'electron'
import { createLogger } from '../../logger.js'

const { BrowserWindow, webContents } = electron
const log = createLogger('extensions')

const PANEL_WIDTH = 380

function findBrowserWindow (windowId) {
  if (typeof windowId === 'number') {
    const win = BrowserWindow.fromId(windowId)
    if (win && !win.isDestroyed()) return win
  }
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  return BrowserWindow.getAllWindows().find((w) => {
    if (w.isDestroyed()) return false
    const { width, height } = w.getBounds()
    return width >= 500 && height >= 400
  }) || null
}

function panelUrl (extension, path) {
  const rel = String(path || '').replace(/^\//, '')
  return `chrome-extension://${extension.id}/${rel}`
}

function urlMatchesPanel (url, panelUrlValue) {
  if (!url || !panelUrlValue) return false
  const base = panelUrlValue.split('#')[0]
  return url === panelUrlValue || url === base || url.startsWith(`${base}#`)
}

function tabKey (windowId, tabId) {
  return `${windowId}:${tabId}`
}

function ensureMaps (manager) {
  if (!manager.activeSidePanels) manager.activeSidePanels = new Map()
  if (!manager.sidePanelOpenByTab) manager.sidePanelOpenByTab = new Map()
  if (!manager.sidePanelOpenGlobal) manager.sidePanelOpenGlobal = new Map()
  if (!manager.sidePanelGuestIds) manager.sidePanelGuestIds = new Set()
}

function getElectronExtension (manager, extension) {
  const id = extension?.electronId || extension?.id
  if (!id || !manager.session) return null
  try {
    const sessionExtensions = manager.session.extensions || manager.session
    return sessionExtensions.getExtension?.(id) || null
  } catch (_) {
    return null
  }
}

function resolvePanelPath (manager, extension, tabId) {
  const ece = manager.electronChromeExtensions
  const api = ece?.api?.sidePanel
  const electronId = extension.electronId || extension.id
  if (api && typeof api.getResolvedOptions === 'function') {
    const opts = api.getResolvedOptions(electronId, tabId)
    if (opts?.enabled === false) return null
    if (typeof opts?.path === 'string' && opts.path) return opts.path.replace(/^\//, '')
  }
  const fromManifest = extension.manifest?.side_panel?.default_path
  return typeof fromManifest === 'string' && fromManifest
    ? fromManifest.replace(/^\//, '')
    : null
}

function resolveTitle (manager, extensionId, fallback) {
  try {
    for (const ext of manager.loadedExtensions.values()) {
      if (ext.electronId === extensionId || ext.id === extensionId) {
        return ext.displayName || ext.name || fallback
      }
    }
  } catch (_) {}
  return fallback
}

function isEnabledForTab (manager, extensionId, tabId) {
  const api = manager.electronChromeExtensions?.api?.sidePanel
  if (!api || typeof api.getResolvedOptions !== 'function') return true
  const opts = api.getResolvedOptions(extensionId, tabId)
  return opts?.enabled !== false
}

function resolvePathForTab (manager, extensionId, tabId, fallbackPath) {
  const api = manager.electronChromeExtensions?.api?.sidePanel
  if (api && typeof api.getResolvedOptions === 'function') {
    const opts = api.getResolvedOptions(extensionId, tabId)
    if (typeof opts?.path === 'string' && opts.path) return opts.path.replace(/^\//, '')
  }
  return fallbackPath
}

/** Keep tabs.getCurrent / debugger aimed at the left page, not the panel guest. */
function pinPageTab (manager, win, tabId) {
  if (!win || win.isDestroyed() || typeof tabId !== 'number') return
  const ece = manager.electronChromeExtensions
  const store = ece?.ctx?.store
  if (!ece || !store) return

  let tab
  try {
    tab = webContents.fromId(tabId)
  } catch (_) {
    return
  }
  if (!tab || tab.isDestroyed()) return

  try {
    store.lastFocusedWindowId = win.id
    if (!store.tabs?.has?.(tab)) {
      try { ece.addTab(tab, win) } catch (_) {}
    }
    try { store.windowToActiveTab?.set?.(win, tab) } catch (_) {}
    try { ece.selectTab?.(tab, win) } catch (_) {}
  } catch (err) {
    log.warn(`Side panel: failed to pin page tab ${tabId}:`, err?.message || err)
  }
}

/**
 * True when this webContents is (or will be) the docked side panel guest,
 * and must never be registered as an ECE browser tab.
 */
export function isSidePanelGuest (manager, window, guest) {
  if (!manager || !guest || guest.isDestroyed?.()) return false
  ensureMaps(manager)

  if (typeof guest.id === 'number' && manager.sidePanelGuestIds.has(guest.id)) {
    return true
  }

  const winId = window?.id
  if (typeof winId !== 'number') return false

  let url = ''
  try {
    url = guest.getURL?.() || ''
  } catch (_) {
    return false
  }
  if (!url.startsWith('chrome-extension://')) return false

  const active = manager.activeSidePanels.get(winId)
  if (urlMatchesPanel(url, active?.url)) return true
  if (active?.extensionId && active?.path) {
    const expected = `chrome-extension://${active.extensionId}/${String(active.path).replace(/^\//, '')}`
    if (urlMatchesPanel(url, expected)) return true
  }

  const prefix = `${winId}:`
  for (const [key, record] of manager.sidePanelOpenByTab.entries()) {
    if (!key.startsWith(prefix)) continue
    if (urlMatchesPanel(url, record?.url)) return true
  }
  const global = manager.sidePanelOpenGlobal.get(winId)
  if (urlMatchesPanel(url, global?.url)) return true

  return false
}

/** Record panel guest id and drop it from ECE if it was already registered. */
export function registerSidePanelGuest (manager, webContentsId) {
  if (typeof webContentsId !== 'number') return
  ensureMaps(manager)
  manager.sidePanelGuestIds.add(webContentsId)

  const ece = manager.electronChromeExtensions
  let guest
  try {
    guest = webContents.fromId(webContentsId)
  } catch (_) {
    guest = null
  }

  if (guest && !guest.isDestroyed()) {
    try {
      ece?.removeTab?.(guest)
    } catch (_) {}
  }
  manager._registeredTabs?.delete?.(webContentsId)

  try {
    guest?.once?.('destroyed', () => {
      manager.sidePanelGuestIds?.delete(webContentsId)
    })
  } catch (_) {}
}

function showPanel (manager, win, state) {
  ensureMaps(manager)
  const path = String(state.path || '').replace(/^\//, '')
  const url = state.url || `chrome-extension://${state.extensionId}/${path}`
  const title = resolveTitle(manager, state.extensionId, state.extensionId)
  const tabId = typeof state.tabId === 'number' ? state.tabId : null

  manager.activeSidePanels.set(win.id, {
    extensionId: state.extensionId,
    path,
    tabId,
    url
  })

  win.webContents.send('extensions-side-panel-open', {
    extensionId: state.extensionId,
    path,
    tabId,
    url,
    title,
    width: PANEL_WIDTH
  })

  if (tabId != null) pinPageTab(manager, win, tabId)
}

function hidePanel (manager, win) {
  if (!win || win.isDestroyed()) return
  ensureMaps(manager)
  manager.activeSidePanels.delete(win.id)
  win.webContents.send('extensions-side-panel-close', {})
}

/**
 * If the extension set openPanelOnActionClick, open/toggle the docked panel.
 * Returns true when the click was handled (caller should skip popup/onClicked).
 */
export async function tryOpenSidePanelOnActionClick (manager, extension, window, activeTab) {
  const ece = manager.electronChromeExtensions
  const api = ece?.api?.sidePanel
  if (!api || typeof api.getResolvedPanelBehavior !== 'function') return false

  const electronId = extension.electronId || extension.id
  const behavior = api.getResolvedPanelBehavior(electronId)
  if (!behavior?.openPanelOnActionClick) return false
  if (!window || window.isDestroyed()) return false

  ensureMaps(manager)
  const existing = manager.activeSidePanels.get(window.id)
  if (existing && existing.extensionId === electronId) {
    await closeSidePanel(manager, {
      extension: { id: electronId },
      windowId: window.id,
      tabId: existing.tabId != null ? existing.tabId : undefined
    })
    return true
  }

  const tabId = activeTab && typeof activeTab.id === 'number' ? activeTab.id : undefined
  const path = resolvePanelPath(manager, extension, tabId)
  if (!path) {
    log.warn(`Side panel: openPanelOnActionClick set but no path for ${extension.displayName || extension.name}`)
    return false
  }

  const electronExtension = getElectronExtension(manager, extension) || {
    id: electronId,
    name: extension.displayName || extension.name
  }

  await openSidePanel(manager, {
    extension: electronExtension,
    path,
    tabId,
    windowId: window.id
  })
  return true
}

export async function openSidePanel (manager, details = {}) {
  const { extension, path, tabId, windowId } = details
  if (!extension?.id || !path) {
    throw new Error('openSidePanel requires extension and path')
  }

  const win = findBrowserWindow(windowId)
  if (!win || win.isDestroyed()) {
    throw new Error('No browser window available for side panel')
  }

  ensureMaps(manager)
  const rel = String(path).replace(/^\//, '')
  const url = panelUrl(extension, rel)
  const record = {
    extensionId: extension.id,
    path: rel,
    url,
    tabId: typeof tabId === 'number' ? tabId : null
  }

  if (typeof tabId === 'number') {
    manager.sidePanelOpenByTab.set(tabKey(win.id, tabId), record)
  } else {
    manager.sidePanelOpenGlobal.set(win.id, record)
  }

  showPanel(manager, win, record)
  log.info(`Side panel open: ${extension.id} → ${url} (window ${win.id})`)
}

export async function closeSidePanel (manager, details = {}) {
  const { windowId, tabId } = details
  let win = findBrowserWindow(windowId)

  ensureMaps(manager)

  if ((!win || win.isDestroyed()) && typeof tabId === 'number') {
    for (const [id, state] of manager.activeSidePanels) {
      if (state.tabId === tabId) {
        win = BrowserWindow.fromId(id)
        break
      }
    }
  }

  if (!win || win.isDestroyed()) return

  if (typeof tabId === 'number') {
    manager.sidePanelOpenByTab.delete(tabKey(win.id, tabId))
  } else {
    manager.sidePanelOpenGlobal.delete(win.id)
  }

  const visible = manager.activeSidePanels.get(win.id)
  const shouldHide =
    !visible ||
    (typeof tabId === 'number'
      ? visible.tabId === tabId
      : visible.tabId == null || details.extension?.id === visible.extensionId)

  if (shouldHide) hidePanel(manager, win)
  log.info(`Side panel close (window ${win.id})`)
}

/** Re-apply tab/global open intent after the active tab changes. */
export function syncSidePanelForActiveTab (manager, window, tabId) {
  if (!window || window.isDestroyed() || typeof tabId !== 'number') return
  ensureMaps(manager)

  const byTab = manager.sidePanelOpenByTab.get(tabKey(window.id, tabId))
  if (byTab) {
    if (!isEnabledForTab(manager, byTab.extensionId, tabId)) {
      hidePanel(manager, window)
      return
    }
    const path = resolvePathForTab(manager, byTab.extensionId, tabId, byTab.path)
    showPanel(manager, window, {
      ...byTab,
      path,
      url: `chrome-extension://${byTab.extensionId}/${path}`,
      tabId
    })
    return
  }

  const global = manager.sidePanelOpenGlobal.get(window.id)
  if (global) {
    if (!isEnabledForTab(manager, global.extensionId, tabId)) {
      hidePanel(manager, window)
      return
    }
    const path = resolvePathForTab(manager, global.extensionId, tabId, global.path)
    showPanel(manager, window, {
      ...global,
      path,
      url: `chrome-extension://${global.extensionId}/${path}`,
      tabId: null
    })
    return
  }

  if (manager.activeSidePanels.has(window.id)) {
    hidePanel(manager, window)
  }
}

export function clearSidePanelState (manager, windowId) {
  ensureMaps(manager)
  const visible = manager.activeSidePanels.get(windowId)
  manager.activeSidePanels.delete(windowId)

  if (visible && typeof visible.tabId === 'number') {
    manager.sidePanelOpenByTab.delete(tabKey(windowId, visible.tabId))
  } else if (visible) {
    manager.sidePanelOpenGlobal.delete(windowId)
  }

  // Drop any leftover per-tab intents for a destroyed window.
  for (const key of [...manager.sidePanelOpenByTab.keys()]) {
    if (key.startsWith(`${windowId}:`)) manager.sidePanelOpenByTab.delete(key)
  }
}
