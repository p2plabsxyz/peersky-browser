/**
 * A page's alert(), confirm() and prompt() come up over its tab and name the
 * page's origin, as in Chrome. Electron showed nothing for prompt() and
 * answered null, and showed alert() and confirm() in a sheet over the whole
 * window that named no site.
 *
 * The page's preload asks here and waits for the answer, so the page waits
 * while the dialog is open, as in Chrome (pages/unified-preload.js). The
 * window draws it (pages/tab-dialogs.js). Also as in Chrome:
 * - a tab not on screen gets no confirm() or prompt(): they answer false and
 *   null at once. Its alert() does not wait, and comes up with the tab.
 * - from a page's second dialog on, the person can stop it making more, until
 *   the tab goes to another page.
 * - a dialog goes when its tab goes to another page or closes.
 *
 * The preload runs in a tab's top frame only, so a frame inside the page still
 * gets Electron's own dialog.
 */
import { ipcMain } from 'electron'
import { askInTab, closeTabDialogs, tabHost } from './tab-dialogs.js'

export const PAGE_DIALOG = 'page-dialog'
const KINDS = ['alert', 'confirm', 'prompt']

// Chrome's: no longer shown, so a page cannot fill the screen with one.
export const MESSAGE_LIMIT = 3000
export const VALUE_LIMIT = 2000

// By the webContents id of a tab's page: dialogs shown on its current page,
// whether the person stopped them, and whether one is open.
const pages = new Map()

/**
 * Chrome's title: "example.com says" for a web page, the scheme too for any
 * other address with a host, and "This page says" for a file or a page with
 * no origin of its own.
 */
export function dialogTitle (origin) {
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return 'This page says'
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return `${parsed.host} says`
  if (parsed.protocol === 'file:' || !parsed.host) return 'This page says'
  return `${parsed.protocol}//${parsed.host} says`
}

export function clip (text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function pageFor (guest) {
  const id = guest.id
  let page = pages.get(id)
  if (page) return page
  page = { shown: 0, stopped: false, open: false }
  pages.set(id, page)
  guest.on('did-start-navigation', (details) => {
    if (details?.isMainFrame && !details.isSameDocument) closeTabDialogs(id, KINDS)
  })
  guest.on('did-navigate', () => {
    page.shown = 0
    page.stopped = false
  })
  guest.once('destroyed', () => pages.delete(id))
  return page
}

/**
 * What the page gets: { ok, value } for its answer, with stopped once the
 * person stopped its dialogs, background when its tab was not on screen, later
 * for an alert shown when the tab comes up, and native for a page that is not
 * a tab's, which keeps Electron's dialog.
 */
export async function answerPageDialog ({ sender: guest, senderFrame: frame }, request) {
  if (!tabHost(guest) || !frame || frame.parent) return { native: true }
  const kind = KINDS.includes(request?.type) ? request.type : null
  if (!kind) return { ok: false }
  const page = pageFor(guest)
  if (page.stopped) return { ok: false, stopped: true }
  if (page.open) return { ok: false }
  const offerStop = page.shown > 0
  page.open = true
  let answer
  try {
    answer = await askInTab(guest, {
      kind,
      title: dialogTitle(frame.origin),
      message: clip(String(request.message ?? ''), MESSAGE_LIMIT),
      ...(kind === 'prompt' && { value: clip(String(request.value ?? ''), VALUE_LIMIT) }),
      offerStop
    })
  } finally {
    page.open = false
  }
  if (!answer) return { ok: false }
  if (answer.background) return { ok: false, background: true }
  page.shown++
  if (answer.later) return { ok: true, later: true }
  const stopped = offerStop && answer.stop === true
  if (stopped) page.stopped = true
  const ok = answer.ok === true
  return {
    ok,
    ...(kind === 'prompt' && ok && { value: String(answer.value ?? '') }),
    ...(stopped && { stopped })
  }
}

export function setupPageDialogs () {
  ipcMain.on(PAGE_DIALOG, (event, request) => {
    answerPageDialog(event, request)
      .catch(() => ({ ok: false }))
      .then((reply) => {
        try {
          event.returnValue = reply
        } catch {}
      })
  })
}
