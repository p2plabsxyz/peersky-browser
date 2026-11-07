// A video opened in a tab, such as a torrent's .mkv, plays in Chromium's own
// media page. Its picture plays, but Chromium in Electron has no decoder for
// Dolby (AC-3, E-AC-3, TrueHD) or DTS sound, which most movie releases carry,
// so the video played silent with nothing saying why. When the file's start
// names one of those formats and the playing video decodes no sound, the page
// gets a short note saying so.

import { open } from 'fs/promises'
import { fileURLToPath } from 'url'

const VIDEO_PATH = /\.(mkv|mp4|m4v|mov|webm)$/i
const HEAD_BYTES = 256 * 1024

// Matroska codec IDs and MP4 sample entries, and how the note names each.
const FORMATS = [
  ['A_EAC3', 'Dolby Digital Plus (E-AC-3)'],
  ['A_AC3', 'Dolby Digital (AC-3)'],
  ['A_TRUEHD', 'Dolby TrueHD'],
  ['A_MLP', 'Dolby TrueHD'],
  ['A_DTS', 'DTS'],
  ['ec-3', 'Dolby Digital Plus (E-AC-3)'],
  ['ac-3', 'Dolby Digital (AC-3)'],
  ['mlpa', 'Dolby TrueHD'],
  ['dtsc', 'DTS'],
  ['dtsh', 'DTS'],
  ['dtsl', 'DTS'],
  ['dtse', 'DTS']
]

/** The sound format this engine cannot play that the file's start names, or null. */
export function unplayableSoundOf (bytes) {
  const text = Buffer.from(bytes).toString('latin1')
  let found = null
  let at = Infinity
  for (const [id, name] of FORMATS) {
    const index = text.indexOf(id)
    // The first audio track named is the one that plays.
    if (index !== -1 && index < at) {
      found = name
      at = index
    }
  }
  return found
}

export function soundNoteText (format) {
  return `This video's sound is ${format}, which PeerSky can't play yet, so it plays without sound. To hear it, open the file in another video player.`
}

// Shown once the video has played a moment, has drawn its picture and has
// decoded no sound at all, so a file whose first sound track plays gets none.
export function soundNoteScript (text) {
  return `(() => {
  const video = document.querySelector('body > video')
  if (!video || window.__peerskySoundNote) return
  window.__peerskySoundNote = true
  const timer = setInterval(() => {
    if (!video.isConnected) return clearInterval(timer)
    if (video.paused || video.currentTime < 1.5) return
    clearInterval(timer)
    if (!(video.webkitVideoDecodedByteCount > 0) || video.webkitAudioDecodedByteCount !== 0) return
    const note = document.createElement('div')
    note.id = 'peersky-sound-note'
    note.setAttribute('role', 'status')
    note.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);max-width:min(560px,calc(100% - 32px));box-sizing:border-box;padding:12px 40px 12px 16px;border-radius:10px;background:rgba(28,28,30,.92);color:#fff;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;z-index:2147483647;box-shadow:0 4px 18px rgba(0,0,0,.35)'
    note.textContent = ${JSON.stringify(text)}
    const close = document.createElement('button')
    close.setAttribute('aria-label', 'Close')
    close.textContent = '\\u00d7'
    close.style.cssText = 'position:absolute;top:6px;right:8px;border:0;background:none;color:#fff;font-size:20px;line-height:1;cursor:pointer;opacity:.8'
    close.addEventListener('click', () => note.remove())
    note.appendChild(close)
    document.body.appendChild(note)
  }, 500)
})()`
}

// Chromium's own media page: the video's type, not an HTML page, and a <video>
// alone in the body. A web page cannot pass for one, so no page's scripts run
// beside the reads below.
export const MEDIA_PAGE_CHECK = "document.contentType.startsWith('video/') && document.body !== null && document.body.children.length === 1 && document.body.firstElementChild.tagName === 'VIDEO'"

// The start of the file, read by the page itself: the request gate
// (protocols/request-gate.js) turns away the main process's own requests for
// a torrent's or a local file, and lets a torrent's file read itself. Latin-1
// keeps one character per byte.
export const HEAD_SCRIPT = `(async () => {
  const response = await fetch(location.href, { headers: { Range: 'bytes=0-${HEAD_BYTES - 1}' } })
  if (!response.ok || !response.body) return null
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  while (size < ${HEAD_BYTES}) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  reader.cancel().catch(() => {})
  const bytes = new Uint8Array(Math.min(size, ${HEAD_BYTES}))
  let at = 0
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - at)
    bytes.set(part, at)
    at += part.length
  }
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
  return text
})()`

// A local file the tab has opened is read from disk, as the page may not
// fetch it either.
async function readFileHead (url) {
  const file = await open(fileURLToPath(url), 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await file.read(buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

async function readHead (wc, url) {
  if (url.startsWith('file:')) return readFileHead(url)
  const text = await wc.executeJavaScript(HEAD_SCRIPT)
  return typeof text === 'string' ? Buffer.from(text.slice(0, HEAD_BYTES), 'latin1') : null
}

export function noteUnplayableSound (wc) {
  // Chromium's media page never fires did-finish-load: the video keeps the load going.
  wc.on('dom-ready', async () => {
    try {
      const url = wc.getURL()
      let pathname
      try { pathname = decodeURIComponent(new URL(url).pathname) } catch { return }
      if (!VIDEO_PATH.test(pathname)) return
      const isMediaPage = await wc.executeJavaScript(MEDIA_PAGE_CHECK)
      if (!isMediaPage || wc.isDestroyed() || wc.getURL() !== url) return
      const head = await readHead(wc, url)
      const format = head && unplayableSoundOf(head)
      if (!format || wc.isDestroyed() || wc.getURL() !== url) return
      await wc.executeJavaScript(soundNoteScript(soundNoteText(format)))
    } catch {}
  })
}
