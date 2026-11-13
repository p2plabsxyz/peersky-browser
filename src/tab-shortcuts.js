/**
 * Chrome's tab shortcuts.
 *
 * Chrome keeps some for itself, so a page never sees them: reopening the tab
 * closed last (Cmd+Shift+T, Ctrl+Shift+T elsewhere) and going to the next or
 * the one before (Ctrl+Tab and Ctrl+Shift+Tab, and on a Mac Cmd+Option+Right
 * and Left, and Cmd+Shift+] and [). Those are taken from a tab's page before
 * it has them (main.js). The rest, such as Cmd+1 to Cmd+9 and the reloads,
 * reach a page first and are menu items (actions.js).
 *
 * Kept free of Electron imports so it can be tested directly.
 */

/** A call to the tab bar of a window, whichever tab layout it has, to run in that window. */
export function tabBarCall (method, ...args) {
  const list = args.map((arg) => JSON.stringify(arg)).join(', ')
  return `(() => { try { const tabBar = document.querySelector('#tabbar'); if (tabBar && typeof tabBar.${method} === 'function') tabBar.${method}(${list}) } catch (error) { console.error(error) } })()`
}

// The key that types one of these characters, as Chrome matches its
// shortcuts, or on a layout that types none of them, the key in their place.
function isKey (input, characters, code) {
  const typed = String(input.key || '').toLowerCase()
  if (characters.includes(typed)) return true
  return input.code === code && !/^[\x21-\x7e]$/.test(typed)
}

/**
 * The tab bar call for a key a page must not keep, as { method, args }, or
 * null. input is Electron's before-input-event input.
 */
export function reservedTabShortcut (input, platform = process.platform) {
  if (!input || input.type !== 'keyDown') return null
  const mac = platform === 'darwin'
  const command = mac ? input.meta && !input.control : input.control && !input.meta
  if (command && input.shift && !input.alt && isKey(input, ['t'], 'KeyT')) return { method: 'reopenClosedTab', args: [] }
  if (input.control && input.key === 'Tab') return { method: 'selectAdjacentTab', args: [input.shift ? -1 : 1] }
  if (!mac || !input.meta) return null
  if (input.alt && (input.key === 'ArrowRight' || input.key === 'ArrowLeft')) {
    return { method: 'selectAdjacentTab', args: [input.key === 'ArrowRight' ? 1 : -1] }
  }
  if (input.shift && !input.alt && !input.control) {
    if (isKey(input, [']', '}'], 'BracketRight')) return { method: 'selectAdjacentTab', args: [1] }
    if (isKey(input, ['[', '{'], 'BracketLeft')) return { method: 'selectAdjacentTab', args: [-1] }
  }
  return null
}

/** Escape with nothing else held, which stops a page still loading, as in Chrome. */
export function isStopKey (input) {
  return input?.type === 'keyDown' && input.key === 'Escape' && !input.isComposing &&
    !input.shift && !input.control && !input.alt && !input.meta
}
