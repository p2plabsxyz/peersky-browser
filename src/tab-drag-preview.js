// A dragged tab is a DOM element, so it vanishes at the window edge. Once a
// drag leaves the strip, this small always-on-top window carries a copy of the
// tab instead: one card copying its colours, favicon and title.
import { BrowserWindow, ipcMain } from 'electron'
import { getPartition } from './session.js'

export const PAD = 12 // room around the card for its shadow

const SCHEMES = ['http', 'https', 'data', 'blob', 'peersky', 'ipfs', 'ipns', 'hyper', 'hs', 'file']
const SAFE_URL = new RegExp(`^(${SCHEMES.join('|')}):`, 'i')

function text (value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// A value straight from getComputedStyle; drop anything that could end the rule.
function cssValue (value, fallback) {
  const v = String(value ?? '').replace(/[<>{};]/g, '').trim()
  return v || fallback
}

function cssUrl (url) {
  if (!SAFE_URL.test(url || '')) return 'none'
  return `url("${url.replace(/[\\"\s]/g, c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))}")`
}

export function previewWindowSize ({ width, height }) {
  return { width: Math.ceil(width) + PAD * 2, height: Math.ceil(height) + PAD * 2 }
}

export function previewPage (spec) {
  const title = spec.showTitle === false ? '' : `<span class="title">${text(spec.title)}</span>`
  return `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${SCHEMES.map(s => s + ':').join(' ')}; style-src 'unsafe-inline'">
<style>
html, body { margin: 0; background: transparent; overflow: hidden; }
.card {
  position: absolute; left: ${PAD}px; top: ${PAD}px;
  width: ${Math.ceil(spec.width)}px; height: ${Math.ceil(spec.height)}px; box-sizing: border-box;
  display: flex; align-items: center; gap: 8px; padding: 0 10px; overflow: hidden; white-space: nowrap;
  background: ${cssValue(spec.background, '#2b2b2b')}; color: ${cssValue(spec.color, '#eee')};
  font: ${cssValue(spec.fontSize, '13px')} ${cssValue(spec.fontFamily, 'sans-serif')};
  border-radius: ${cssValue(spec.borderRadius, '8px')};
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35); opacity: 0.95;
}
.icon { flex: none; width: 16px; height: 16px; background: ${cssUrl(spec.favicon)} center / contain no-repeat; }
.title { overflow: hidden; text-overflow: ellipsis; }
</style>
<div class="card"><div class="icon"></div>${title}</div>`
}

let preview = null

function destroy () {
  if (preview && !preview.isDestroyed()) preview.destroy()
  preview = null
}

async function prepare (sender, spec) {
  destroy()
  const win = new BrowserWindow({
    ...previewWindowSize(spec),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: { partition: getPartition(), sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  preview = win
  win.setIgnoreMouseEvents(true)
  win.setAlwaysOnTop(true, 'pop-up-menu')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  sender.removeListener('destroyed', destroy)
  sender.once('destroyed', destroy)
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(previewPage(spec)))
  } catch (_) {
    if (preview === win) destroy()
    return false
  }
  return preview === win && !win.isDestroyed()
}

// x, y: where the tab's top-left corner is on screen.
function move ({ x, y }) {
  if (!preview || preview.isDestroyed()) return
  preview.setPosition(Math.round(x) - PAD, Math.round(y) - PAD)
  if (!preview.isVisible()) preview.showInactive()
}

export function registerTabDragPreview () {
  ipcMain.handle('tab-drag-preview-prepare', (event, spec) => prepare(event.sender, spec))
  ipcMain.on('tab-drag-preview', (_event, msg) => {
    if (msg?.type === 'move') move(msg)
    else if (msg?.type === 'hide' && preview && !preview.isDestroyed()) preview.hide()
    else if (msg?.type === 'end') destroy()
  })
}
