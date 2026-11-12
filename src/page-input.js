// Whether a page in a tab just had real input from the person: a click, a key
// or a press of a mouse button, as the browser saw it before the page did. A
// page cannot make these up. Chrome's popup blocker lets through what a person
// opens and stops what a page opens on its own; this tells the two apart.

// A click opens its tab within a moment of the mouse going up.
export const INPUT_GRACE_MS = 1000

const inputs = new WeakMap() // webContents -> { at, spent }

export function watchPageInput (wc) {
  if (!wc || inputs.has(wc)) return
  const input = { at: 0, spent: true }
  inputs.set(wc, input)
  const note = () => {
    input.at = Date.now()
    input.spent = false
  }
  wc.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseDown' || mouse.type === 'mouseUp') note()
  })
  wc.on('before-input-event', (_event, key) => {
    if (key.type === 'keyDown') note()
  })
}

// One open per input, as one click opens one popup in Chrome: a page that
// opens several on one click has the rest counted as its own.
export function takeInputGrant (wc, now = Date.now()) {
  const input = inputs.get(wc)
  if (!input || input.spent || now - input.at > INPUT_GRACE_MS) return false
  input.spent = true
  return true
}
