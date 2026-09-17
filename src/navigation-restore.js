// navigationHistory.restore only works before a guest's first load, and a
// <webview> only gets a webContents once it has a src. So a tab with history
// is given a placeholder src carrying a token: the src is blanked as the guest
// attaches, and the history is restored in its place.
import { ipcMain } from 'electron'
import { createLogger } from './logger.js'

const log = createLogger('navigation-restore')
export const PLACEHOLDER = 'about:blank#peersky-restore='

const pending = new Map() // token -> { entries, index, url }
const results = new Map() // guest webContents id -> Promise<restored?>

export function registerNavigationRestore () {
  ipcMain.on('queue-navigation-restore', (event, { token, entries, index, url }) => {
    pending.set(token, { entries, index, url })
    event.returnValue = true
  })

  // Answers the renderer's check once the guest is up. A guest that was not
  // queued gets a direct attempt, which only works if nothing has loaded yet.
  ipcMain.handle('restore-navigation-history', async (_event, { webContentsId, entries, activeIndex }) => {
    if (results.has(webContentsId)) return { success: await results.get(webContentsId) }
    const { webContents } = await import('electron')
    const wc = webContents.fromId(webContentsId)
    if (!wc || wc.isDestroyed()) return { success: false }
    return { success: await restore(wc, { entries, index: activeIndex }) }
  })
}

// Call for every window that hosts webviews.
export function watchHost (host) {
  let queued = null
  host.on('will-attach-webview', (_event, _prefs, params) => {
    const token = typeof params.src === 'string' && params.src.startsWith(PLACEHOLDER) ? params.src.slice(PLACEHOLDER.length) : null
    queued = token ? pending.get(token) : null
    if (!queued) return
    pending.delete(token)
    params.src = ''
  })
  host.on('did-attach-webview', async (_event, guest) => {
    const job = queued
    queued = null
    if (!job) return
    // Recorded before it settles: the renderer asks at dom-ready, which comes
    // before the restored entry has finished loading.
    results.set(guest.id, restore(guest, job))
    guest.once('destroyed', () => results.delete(guest.id))
    const ok = await results.get(guest.id)
    if (!ok && !guest.isDestroyed()) guest.loadURL(job.url).catch(() => {})
  })
}

async function restore (wc, { entries, index }) {
  if (!Array.isArray(entries) || !entries.length) return false
  const clamped = Math.min(Math.max(index | 0, 0), entries.length - 1)
  try {
    await wc.navigationHistory.restore({ entries: entries.map(e => ({ url: e.url, title: e.title || '' })), index: clamped })
    return true
  } catch (error) {
    log.warn(`Could not restore navigation history for webContents ${wc.id}:`, error)
    return false
  }
}
