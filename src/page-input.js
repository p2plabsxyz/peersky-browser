// Whether a page in a tab just had real input from the person: a click, a key
// or a press of a mouse button, as the browser saw it before the page did. A
// page cannot make these up. Chrome's popup blocker lets through what a person
// opens and stops what a page opens on its own; this tells the two apart.

// A click opens its tab within a moment of the mouse going up.
export const INPUT_GRACE_MS = 1000

const inputs = new WeakMap() // webContents -> { at, spent, used }

export function watchPageInput (wc) {
  if (!wc || inputs.has(wc)) return
  const input = { at: 0, spent: true, used: false }
  inputs.set(wc, input)
  const note = (use) => {
    input.at = Date.now()
    input.spent = false
    if (use) input.used = true
  }
  wc.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseDown') note(true)
    else if (mouse.type === 'mouseUp') note(false)
  })
  wc.on('before-input-event', (_event, key) => {
    if (key.type !== 'keyDown') return
    // A browser shortcut such as Cmd+W, or Escape, is not using the page.
    note(!key.meta && !key.control && key.key !== 'Escape')
  })
  // Each new page starts unused.
  wc.on('did-navigate', () => {
    input.used = false
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

// Whether the person has clicked in the page or typed into it since it
// loaded. Chrome lets only such a page ask "Leave site?".
export function hasBeenUsed (wc) {
  return inputs.get(wc)?.used === true
}
