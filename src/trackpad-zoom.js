// Zoom from the trackpad and the mouse wheel, as other browsers have it.
// Electron turns both off in a page. A pinch magnifies the page (visual zoom,
// the way Chrome and Safari pinch on a Mac), and Ctrl or Cmd with the wheel,
// or a pinch a touchpad sends as one, zooms the page itself through the same
// per-tab level the menu's Zoom In and Zoom Out set.

// From the page's own size up to three times it, like Chrome's pinch.
export const PINCH_ZOOM_LIMITS = [1, 3]
// The step the menu uses. A trackpad sends dozens of wheel events for one
// gesture, so at most one step goes through in this long.
export const WHEEL_ZOOM_STEP = 0.5
export const WHEEL_ZOOM_INTERVAL_MS = 120

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
