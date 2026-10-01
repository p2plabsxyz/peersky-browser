import electron from 'electron'
import { existsSync } from 'fs'
import path from 'path'
import { getBrowserSession } from '../session.js'
import { getPagesPath } from '../protocols/peersky-protocol.js'
import { createLogger } from '../logger.js'

const log = createLogger('backup:p2pmd-notes')

// A person's recent P2PMD notes, going to their phone and coming from it.
// P2PMD keeps its notes in its own page's storage, so its own page reads and
// writes them: notes-transfer.html, loaded where nobody sees it. Only keys,
// names and the text of hosted notes travel, never a drive address or a port
// (P2PMD's notes-transfer.js says why).

const NOTES_PAGE = 'peersky://p2p/p2pmd/notes-transfer.html'
const NOTES_PAGE_FILE = path.join('p2p', 'p2pmd', 'notes-transfer.html')
const NOTES_PAGE_TIMEOUT_MS = 15000

// Whether this P2PMD can go in a transfer and take one. Installs move each P2P
// app to its own latest main, which may not have the page yet.
export function p2pmdTakesTransfers () {
  try {
    return existsSync(path.join(getPagesPath(), NOTES_PAGE_FILE))
  } catch {
    return false
  }
}

// The notes for a phone, or null when there are none or P2PMD cannot say.
// Notes that go with their text are marked shared on this desktop as they
// leave, so it too looks for them on the phone before hosting them.
export async function exportP2pmdNotes () {
  if (!p2pmdTakesTransfers()) return null
  try {
    const notes = await onNotesPage('window.p2pmdNotes.export()')
    return notes && Array.isArray(notes.notes) && (notes.notes.length > 0 || notes.name) ? notes : null
  } catch (error) {
    log.warn(`P2PMD notes were not packed: ${error.message}`)
    return null
  }
}

// A phone's notes. P2PMD checks every field itself and replaces nothing.
export async function importP2pmdNotes (transfer) {
  if (!transfer || !p2pmdTakesTransfers()) return { ok: false, added: 0 }
  try {
    const result = await onNotesPage(`window.p2pmdNotes.import(${JSON.stringify(transfer)})`)
    return { ok: result?.ok === true, added: Number.isInteger(result?.added) ? result.added : 0 }
  } catch (error) {
    log.warn(`P2PMD notes from a phone were not taken: ${error.message}`)
    return { ok: false, added: 0 }
  }
}

// Runs one call on P2PMD's notes page, in the session P2PMD's tabs use, so it
// sees their storage. A view rather than a window: plenty here takes the
// first window it finds to be the browser's.
async function onNotesPage (call) {
  const { WebContentsView } = electron
  const view = new WebContentsView({
    webPreferences: {
      session: getBrowserSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const contents = view.webContents
  try {
    await withTimeout(contents.loadURL(NOTES_PAGE), 'P2PMD notes page did not load')
    return await withTimeout(contents.executeJavaScript(`(async () => {
      for (let i = 0; i < 50 && !window.p2pmdNotes; i++) await new Promise((resolve) => setTimeout(resolve, 100))
      if (!window.p2pmdNotes) throw new Error('P2PMD notes page is not ready')
      return ${call}
    })()`), 'P2PMD notes page did not answer')
  } finally {
    try { contents.close() } catch {}
  }
}

function withTimeout (promise, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), NOTES_PAGE_TIMEOUT_MS)
    })
  ]).finally(() => clearTimeout(timer))
}
