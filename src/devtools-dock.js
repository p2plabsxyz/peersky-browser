import { BrowserWindow, WebContentsView, ipcMain } from 'electron'

// A page's DevTools, docked on the right of its window the way Chrome docks
// them (issue 22).
//
// A page is a <webview>, and Electron opens a <webview>'s DevTools in a window
// of their own; asked for mode "right", they did not open at all. So the
// window page keeps a dock free on the right (src/pages/devtools-dock.js) and
// says where it is, and the DevTools are drawn in a WebContentsView laid over
// it, through setDevToolsWebContents. A <webview> as the host shows the
// DevTools but never connects them to the page, so it has to be a view.

// Guest webContents id -> the docked DevTools for that page.
const docks = new Map()

// DevTools only say they closed once their view is gone, and a view set up
// before then is cut off by the old one going. Waits no longer than this.
const CLOSE_WAIT_MS = 1500

export function isDevToolsDocked (guest) {
  const dock = guest && docks.get(guest.id)
  return Boolean(dock && !dock.closing)
}

/**
 * Opens a tab's DevTools in the dock of its window, or shows them again if they
 * are open. With inspect, the element at that point is selected, as with
 * Inspect in the page's menu.
 */
export async function openDockedDevTools (guest, { inspect = null } = {}) {
  if (!guest || guest.isDestroyed()) return
  const shell = guest.hostWebContents
  const win = shell && !shell.isDestroyed() ? BrowserWindow.fromWebContents(shell) : null
  if (!win || win.isDestroyed()) {
    // Not a tab in a browser window: the window of their own they always had.
    guest.openDevTools({ mode: 'detach' })
    if (inspect) guest.inspectElement(inspect.x, inspect.y)
    return
  }

  const open = docks.get(guest.id)
  if (open && !open.closing) {
    if (inspect) guest.inspectElement(inspect.x, inspect.y)
    open.view.webContents.focus()
    return
  }
  if (open) await open.closing
  if (guest.isDestroyed() || win.isDestroyed()) return

  const view = new WebContentsView()
  // Hidden until the window page says where the dock is.
  view.setVisible(false)
  win.contentView.addChildView(view)

  const guestId = guest.id
  const dock = { guestId, guest, view, win, shell, closing: null }
  docks.set(guestId, dock)
  guest.once('destroyed', () => closeDockedDevTools(guestId))
  view.webContents.once('destroyed', () => closeDockedDevTools(guestId))

  guest.setDevToolsWebContents(view.webContents)
  guest.openDevTools()
  if (inspect) guest.inspectElement(inspect.x, inspect.y)
  shell.send('devtools-dock-opened', guestId)
}

export function closeDockedDevTools (guestId) {
  const dock = docks.get(guestId)
  if (!dock) return Promise.resolve()
  if (dock.closing) return dock.closing

  const { guest, view, win, shell } = dock
  dock.closing = new Promise((resolve) => {
    let waiting = 2
    let timer = null
    const finish = () => {
      clearTimeout(timer)
      if (docks.get(guestId) === dock) docks.delete(guestId)
      resolve()
    }
    const done = () => { if (--waiting === 0) finish() }
    timer = setTimeout(finish, CLOSE_WAIT_MS)

    if (guest.isDestroyed()) done()
    else guest.once('devtools-closed', done)
    if (view.webContents.isDestroyed()) done()
    else view.webContents.once('destroyed', done)

    try { if (!guest.isDestroyed()) guest.closeDevTools() } catch (_) {}
    try { if (!win.isDestroyed()) win.contentView.removeChildView(view) } catch (_) {}
    // Closing DevTools leaves their view alive; it is ours to destroy.
    try { if (!view.webContents.isDestroyed()) view.webContents.close() } catch (_) {}
  })
  if (!shell.isDestroyed()) shell.send('devtools-dock-closed', guestId)
  return dock.closing
}

export function toggleDockedDevTools (guest) {
  if (!guest || guest.isDestroyed()) return
  if (isDevToolsDocked(guest)) return closeDockedDevTools(guest.id)
  return openDockedDevTools(guest)
}

/**
 * Puts the DevTools of the page on screen where the window page's dock is, and
 * hides the others in that window. The rectangle is in the page's CSS pixels.
 */
export function layoutDockedDevTools (shell, { visibleGuestId = null, bounds = null } = {}) {
  const zoom = shell.getZoomFactor?.() || 1
  for (const dock of docks.values()) {
    if (dock.shell !== shell || dock.closing || dock.view.webContents.isDestroyed()) continue
    const visible = dock.guestId === visibleGuestId && isUsableBounds(bounds)
    if (visible) {
      dock.view.setBounds({
        x: Math.round(bounds.x * zoom),
        y: Math.round(bounds.y * zoom),
        width: Math.round(bounds.width * zoom),
        height: Math.round(bounds.height * zoom)
      })
    }
    dock.view.setVisible(visible)
  }
}

function isUsableBounds (bounds) {
  return Boolean(bounds) &&
    ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key])) &&
    bounds.width > 0 && bounds.height > 0
}

export function setupDevToolsDock () {
  ipcMain.on('devtools-dock-layout', (event, layout) => {
    layoutDockedDevTools(event.sender, layout || {})
  })
  ipcMain.on('devtools-dock-close', (event, guestId) => {
    // Only the window the DevTools are docked in can close them.
    const dock = docks.get(guestId)
    if (dock && dock.shell === event.sender) closeDockedDevTools(guestId)
  })
}
