import electron from 'electron'
import { createLogger } from '../../logger.js'

const { BrowserWindow } = electron
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

  const existing = manager.activeSidePanels?.get(window.id)
  if (existing && existing.extensionId === electronId) {
    await closeSidePanel(manager, {
      extension: { id: electronId },
      windowId: window.id
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

  const url = panelUrl(extension, path)
  let title = extension.name || extension.id
  try {
    for (const ext of manager.loadedExtensions.values()) {
      if (ext.electronId === extension.id || ext.id === extension.id) {
        title = ext.displayName || ext.name || title
        break
      }
    }
  } catch (_) {}

  if (!manager.activeSidePanels) manager.activeSidePanels = new Map()
  manager.activeSidePanels.set(win.id, {
    extensionId: extension.id,
    path: String(path).replace(/^\//, ''),
    tabId: typeof tabId === 'number' ? tabId : null,
    url
  })

  win.webContents.send('extensions-side-panel-open', {
    extensionId: extension.id,
    path: String(path).replace(/^\//, ''),
    tabId: typeof tabId === 'number' ? tabId : null,
    url,
    title,
    width: PANEL_WIDTH
  })

  log.info(`Side panel open: ${extension.id} → ${url} (window ${win.id})`)
}

export async function closeSidePanel (manager, details = {}) {
  const { windowId, tabId } = details
  let win = findBrowserWindow(windowId)

  if ((!win || win.isDestroyed()) && typeof tabId === 'number') {
    for (const [id, state] of (manager.activeSidePanels || [])) {
      if (state.tabId === tabId) {
        win = BrowserWindow.fromId(id)
        break
      }
    }
  }

  if (!win || win.isDestroyed()) return

  if (manager.activeSidePanels) manager.activeSidePanels.delete(win.id)
  win.webContents.send('extensions-side-panel-close', {
    extensionId: details.extension?.id || null,
    tabId: typeof tabId === 'number' ? tabId : null
  })
  log.info(`Side panel close (window ${win.id})`)
}

export function clearSidePanelState (manager, windowId) {
  if (!manager.activeSidePanels) return
  manager.activeSidePanels.delete(windowId)
}
