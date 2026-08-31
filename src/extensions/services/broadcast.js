/**
 * Broadcasting to browser windows.
 *
 * Kept free of electron imports so the frame-liveness rules can be tested
 * directly.
 */

/**
 * True when a window can still receive IPC.
 *
 * webContents.isDestroyed() is not sufficient: a closed window can leave a
 * WebContents whose render frame is already disposed, and send() then makes
 * Electron print "Render frame was disposed" internally rather than throwing,
 * so callers cannot suppress it. Reading mainFrame surfaces that state as a
 * catchable error.
 *
 * @param {any} win
 * @returns {boolean}
 */
export function isWindowSendable (win) {
  try {
    if (!win || win.isDestroyed()) return false
    const wc = win.webContents
    if (!wc || wc.isDestroyed()) return false
    const frame = wc.mainFrame
    if (!frame || frame.isDestroyed()) return false
    return true
  } catch (_) {
    return false
  }
}

/**
 * Send a channel to every window that can still receive it. A window that goes
 * away mid-loop never prevents the rest from being notified.
 *
 * @param {any[]} windows
 * @param {string} channel
 * @param {any} [payload]
 * @returns {number} Windows actually sent to
 */
export function sendToWindows (windows, channel, payload) {
  if (!Array.isArray(windows) || !channel) return 0

  let sent = 0
  for (const win of windows) {
    if (!isWindowSendable(win)) continue
    try {
      if (payload === undefined) win.webContents.send(channel)
      else win.webContents.send(channel, payload)
      sent++
    } catch (_) { }
  }
  return sent
}
