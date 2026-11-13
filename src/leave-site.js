// A page's "leave site?" handler (beforeunload) gets its question asked when
// the person leaves the page, as in Chrome: by typing an address, Reload, Back
// or a link, or by closing its tab. Electron keeps the page where it is unless
// something answers, so nothing happened: Enter in the address bar left the
// typed address there, Reload did nothing, and Cmd+W closed the tab without a
// word, since a tab was taken away without asking its page at all.
import { BrowserWindow, dialog, ipcMain, webContents } from 'electron'
import { watchPageInput, hasBeenUsed } from './page-input.js'

const LEAVE = 0
const STAY = 1

export const LEAVE_QUESTION = {
  type: 'question',
  buttons: ['Leave', 'Stay'],
  defaultId: LEAVE,
  cancelId: STAY,
  message: 'Leave site?',
  detail: 'Changes that you made may not be saved.',
  noLink: true
}

// Electron wants the answer before will-prevent-unload returns, so this is
// the sheet that waits for one, as Electron's own docs show it.
export function askToLeave (tab) {
  const host = tab.hostWebContents
  const win = host && !host.isDestroyed() ? BrowserWindow.fromWebContents(host) : null
  const choice = win && !win.isDestroyed()
    ? dialog.showMessageBoxSync(win, { ...LEAVE_QUESTION })
    : dialog.showMessageBoxSync({ ...LEAVE_QUESTION })
  return choice === LEAVE
}

// Tabs whose window asked to close them, by webContents id: each settles with
// whether the tab may go.
const closing = new Map()

export function watchLeaving (tab) {
  watchPageInput(tab)
  tab.on('will-prevent-unload', (event) => {
    if (askToLeave(tab)) {
      event.preventDefault()
      return
    }
    closing.get(tab.id)?.(false)
    // The address that was on its way goes from the tab and the address bar,
    // as Chrome drops it.
    const host = tab.hostWebContents
    if (host && !host.isDestroyed()) host.send('tab-stayed', tab.id)
  })
  // Electron honours a page's "stay" when closing a window, but unloads a
  // <webview> anyway, which left a tab with no page in it. This is the event
  // it decides that on: told to stop, it keeps the page, as for a window.
  tab.on('-before-unload-fired', (event, proceed) => {
    if (!proceed) event.preventDefault()
  })
}

// Closes the tab's page as Chrome closes a tab: its beforeunload runs first,
// and a page that asks gets its question. A tab is a <webview>, which its
// window takes away once the page has gone ('close').
function closeAskingPage (tab) {
  if (closing.has(tab.id)) return Promise.resolve(false)
  return new Promise((resolve) => {
    const settle = (closed) => {
      if (closing.get(tab.id) !== settle) return
      closing.delete(tab.id)
      tab.off('close', gone)
      tab.off('destroyed', gone)
      resolve(closed)
    }
    const gone = () => settle(true)
    closing.set(tab.id, settle)
    tab.once('close', gone)
    tab.once('destroyed', gone)
    tab.close({ waitForBeforeUnload: true })
  })
}

export function registerTabClosing () {
  // A window asks before it takes one of its tabs away (tab-bar.js
  // askToCloseTab): true once the tab may go. Chrome asks only a page someone
  // has clicked or typed in; Electron would let any page ask.
  ipcMain.handle('close-tab-asking-page', async (event, webContentsId) => {
    const tab = Number.isInteger(webContentsId) ? webContents.fromId(webContentsId) : null
    if (!tab || tab.isDestroyed()) return true
    if (tab.getType() !== 'webview' || tab.hostWebContents?.id !== event.sender.id) return false
    if (!hasBeenUsed(tab)) return true
    return closeAskingPage(tab)
  })
}
