/**
 * Dialogs over a tab, the way Chrome shows a site's sign-in: the window that
 * holds the tab draws it over that tab only, and only while the tab is on
 * screen (pages/tab-dialogs.js), then says what was chosen.
 *
 * A dialog is answered with null when its tab or its window goes, and when
 * closeTabDialogs takes it down.
 */
import { ipcMain } from 'electron'

export const SHOW_TAB_DIALOG = 'tab-dialog-show'
export const CLOSE_TAB_DIALOG = 'tab-dialog-close'
export const TAB_DIALOG_ANSWER = 'tab-dialog-answer'

let lastId = 0
const open = new Map() // id -> { id, kind, guestId, host, hostId, finish }
const watched = new Set() // webContents ids with a destroyed listener

// The window a tab's page is shown in, or null for anything that is not a tab.
export function tabHost (contents) {
  try {
    if (!contents || contents.isDestroyed() || contents.getType() !== 'webview') return null
    const host = contents.hostWebContents
    return host && !host.isDestroyed() ? host : null
  } catch {
    return null
  }
}

export function setupTabDialogs () {
  ipcMain.on(TAB_DIALOG_ANSWER, (event, message) => {
    const entry = open.get(message?.id)
    // Only the window the dialog was sent to can answer it.
    if (!entry || entry.hostId !== event.sender.id) return
    entry.finish(message.answer ?? null)
  })
}

/**
 * Shows dialog ({ kind, ...what the window draws }) over the tab whose page is
 * guest. Resolves with the window's answer, or null.
 */
export function askInTab (guest, dialog) {
  const host = tabHost(guest)
  if (!host) return Promise.resolve(null)
  return new Promise((resolve) => {
    const id = ++lastId
    open.set(id, {
      id,
      kind: dialog.kind,
      guestId: guest.id,
      host,
      hostId: host.id,
      finish (answer) {
        if (open.delete(id)) resolve(answer)
      }
    })
    watch(guest)
    watch(host)
    host.send(SHOW_TAB_DIALOG, { ...dialog, id, webContentsId: guest.id })
  })
}

/**
 * Takes down the dialogs over the tab or window with this webContents id,
 * answered with null. kinds, when given, picks which.
 */
export function closeTabDialogs (contentsId, kinds = null) {
  for (const entry of [...open.values()]) {
    if (entry.guestId !== contentsId && entry.hostId !== contentsId) continue
    if (kinds && !kinds.includes(entry.kind)) continue
    entry.finish(null)
    try {
      if (!entry.host.isDestroyed()) entry.host.send(CLOSE_TAB_DIALOG, { id: entry.id })
    } catch {}
  }
}

function watch (contents) {
  const id = contents.id
  if (watched.has(id)) return
  watched.add(id)
  contents.once('destroyed', () => {
    watched.delete(id)
    closeTabDialogs(id)
  })
}
