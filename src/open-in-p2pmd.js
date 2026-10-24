/**
 * Files the operating system asks Peersky to open: Open With in Finder, the
 * "Open with P2PMD" menu item in Windows Explorer, Open With in a Linux file
 * manager. Each file becomes a new private P2PMD note with the file's text.
 *
 * Main reads the file and keeps its text here, in memory, under a random id.
 * The P2PMD page opens at peersky://p2p/p2pmd/?open=<id> and takes the text
 * once from hs://p2pmd?action=opened-file (hs-handler.js), so no path or text
 * goes through the address bar or the saved tabs.
 *
 * macOS hands files over as open-file events, which can arrive before a window
 * exists. Windows and Linux start a second process with the path in argv,
 * which the single-instance lock turns into second-instance, as for links
 * (launch-url.js).
 */

import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

// Passed before the path by the Windows menu item and the Linux P2PMD entry.
export const OPEN_IN_P2PMD_FLAG = '--open-in-p2pmd'

// Long enough for a slow first start, short enough that unread text does not
// sit in memory.
export const OPENED_FILE_TTL_MS = 10 * 60 * 1000

const P2PMD_OPEN_PAGE = 'peersky://p2p/p2pmd/?open='

// A URL scheme has at least two letters; C:\ is a drive.
const URL_SCHEME = /^[a-z][a-z0-9+.-]+:/i

/**
 * The paths a launch's argv asks Peersky to open. argv[0] is the executable,
 * and a dev run (electron .) has the app's own folder as its first argument.
 * Linux file managers can pass file:// URLs instead of paths. Other links are
 * left to launch-url.js, and flags are skipped.
 * @param {string[]} argv
 * @param {{ cwd?: string, devRun?: boolean }} [options] cwd is the launching
 *   process's, which second-instance passes along with its argv.
 * @returns {string[]}
 */
export function filesFromArgv (argv, { cwd = process.cwd(), devRun = false } = {}) {
  if (!Array.isArray(argv)) return []
  const files = []
  let appPathSkipped = !devRun
  for (const arg of argv.slice(1)) {
    if (typeof arg !== 'string' || arg === '' || arg.startsWith('-')) continue
    if (!appPathSkipped) {
      appPathSkipped = true
      continue
    }
    if (/^file:/i.test(arg)) {
      try {
        files.push(fileURLToPath(arg))
      } catch {}
      continue
    }
    if (URL_SCHEME.test(arg)) continue
    files.push(path.resolve(cwd || process.cwd(), arg))
  }
  return files
}

/**
 * The text in a file's bytes, or null when they are not text. Text is UTF-8,
 * or UTF-16 with a byte order mark as some Windows tools save it, and has no
 * NUL characters.
 * @param {Uint8Array} bytes
 * @returns {string|null}
 */
export function textFromBytes (bytes) {
  let encoding = 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
  else if (bytes.includes(0)) return null
  let text
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  return text.includes('\u0000') ? null : text
}

/**
 * Read a file for a new note. Resolves to { name, content }, or to
 * { name, error } where error is 'missing', 'not-a-file', 'too-big',
 * 'not-text' or 'unreadable'.
 * @param {string} filePath
 * @param {{ maxBytes: number }} options the most a note can hold
 */
export async function readFileForNote (filePath, { maxBytes }) {
  const name = path.basename(filePath)
  let stat
  try {
    stat = await fs.stat(filePath)
  } catch (error) {
    return { name, error: error?.code === 'ENOENT' ? 'missing' : 'unreadable' }
  }
  // Checked before opening: a pipe or a device would never finish reading.
  if (!stat.isFile()) return { name, error: 'not-a-file' }
  if (stat.size > maxBytes) return { name, error: 'too-big' }
  let bytes
  try {
    bytes = await fs.readFile(filePath)
  } catch {
    return { name, error: 'unreadable' }
  }
  // It may have grown since it was measured.
  if (bytes.length > maxBytes) return { name, error: 'too-big' }
  const content = textFromBytes(bytes)
  if (content === null) return { name, error: 'not-text' }
  return { name, content }
}

const waiting = new Map()

/**
 * Keep a read file until its P2PMD tab asks for it, or until it expires.
 * @param {{ name: string, content: string }} file
 * @param {{ ttlMs?: number }} [options]
 * @returns {string} the id to open P2PMD with
 */
export function keepOpenedFile ({ name, content }, { ttlMs = OPENED_FILE_TTL_MS } = {}) {
  const id = crypto.randomBytes(16).toString('hex')
  const timer = setTimeout(() => waiting.delete(id), ttlMs)
  timer.unref?.()
  waiting.set(id, { name, content, timer })
  return id
}

/**
 * The file kept under id, handed over once: asking again, or after it
 * expired, gets null.
 * @param {string} id
 * @returns {{ name: string, content: string } | null}
 */
export function takeOpenedFile (id) {
  const entry = typeof id === 'string' ? waiting.get(id) : undefined
  if (!entry) return null
  waiting.delete(id)
  clearTimeout(entry.timer)
  return { name: entry.name, content: entry.content }
}

/** The P2PMD page that makes a note from the file kept under id. */
export function p2pmdPageForOpenedFile (id) {
  return `${P2PMD_OPEN_PAGE}${encodeURIComponent(id)}`
}
