// Zoom from the trackpad and the mouse wheel, as other browsers have it.
// Electron turns both off in a page. Ctrl or Cmd with the wheel, or a pinch a
// touchpad sends as one, zooms the page itself through the same per-tab level
// the menu's Zoom In and Zoom Out set. On a Mac, Chromium leaves Ctrl with the
// wheel to the page and the pinch itself to the window, where Electron keeps
// it off for a page in a tab: there the pinch, which comes to the page as
// Ctrl with the wheel, is picked up by the page's preload and handed on here
// (handlePinchZoom), or by the window when it reaches the window instead.

// From the page's own size up to three times it, like Chrome's pinch.
export const PINCH_ZOOM_LIMITS = [1, 3]
// The step the menu uses. A trackpad sends dozens of wheel events for one
// gesture, so at most one step goes through in this long.
export const WHEEL_ZOOM_STEP = 0.5
export const WHEEL_ZOOM_INTERVAL_MS = 120

// A pinch comes as wheel events whose deltaY is -100 times the natural log of
// how much the fingers spread, so 1.6 times is about -47 in all. A zoom level
// is a power of 1.2, so this is the level that zooms the page as much.
export function pinchZoomStep (deltaY) {
  return -deltaY / (100 * Math.log(1.2))
}

/**
 * A pinch the page's preload handed on (unified-preload.js): the tab whose
 * page it was zooms by as much as the fingers moved. A trackpad sends dozens
 * of events a second, so they are added up and sent to the window together.
 */
export function handlePinchZoom (ipcMain, { delay = 16 } = {}) {
  const pending = new Map()
  ipcMain.on('peersky-pinch-zoom', (event, deltaY) => {
    const wc = event.sender
    if (!wc || wc.isDestroyed() || wc.getType() !== 'webview') return
    if (typeof deltaY !== 'number' || !Number.isFinite(deltaY) || Math.abs(deltaY) > 1000) return
    const host = wc.hostWebContents
    if (!host || host.isDestroyed()) return
    const queued = pending.get(wc.id)
    if (queued) {
      queued.step += pinchZoomStep(deltaY)
      return
    }
    const entry = { step: pinchZoomStep(deltaY) }
    pending.set(wc.id, entry)
    setTimeout(() => {
      pending.delete(wc.id)
      if (host.isDestroyed() || !Number.isFinite(entry.step)) return
      host.executeJavaScript(`{
        const tabBar = document.querySelector('#tabbar');
        if (tabBar && typeof tabBar.zoomTabForWebContents === 'function') tabBar.zoomTabForWebContents(${wc.id}, ${entry.step});
      }`).catch(() => {})
    }, delay)
  })
}

export function attachTrackpadZoom (wc, { now = Date.now } = {}) {
  if (!wc || typeof wc.getType !== 'function' || wc.getType() !== 'webview') return

  // Set again for every page, since a navigation can swap in a new renderer
  // that starts with pinching off.
  const allowPinch = () => {
    try {
      if (!wc.isDestroyed()) wc.setVisualZoomLevelLimits(...PINCH_ZOOM_LIMITS)
    } catch {}
  }
  wc.on('dom-ready', allowPinch)
  wc.on('did-navigate', allowPinch)

  let lastStepAt = 0
  wc.on('zoom-changed', (_event, direction) => {
    const at = now()
    if (at - lastStepAt < WHEEL_ZOOM_INTERVAL_MS) return
    lastStepAt = at
    const host = wc.hostWebContents
    if (!host || host.isDestroyed()) return
    const step = direction === 'in' ? WHEEL_ZOOM_STEP : -WHEEL_ZOOM_STEP
    host.executeJavaScript(`{
      const tabBar = document.querySelector('#tabbar');
      if (tabBar && typeof tabBar.zoomActiveTab === 'function') tabBar.zoomActiveTab(${step});
    }`).catch(() => {})
  })
}
