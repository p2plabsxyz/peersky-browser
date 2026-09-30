import { promises as fs } from 'fs'
import path from 'path'
import crypto from 'crypto'
import z32 from 'z32'
import { rememberPrivateHyperdrive } from '../protocols/private-hyperdrive-registry.js'
import { setPrivateDriveOwnership } from '../protocols/private-drive-ownership.js'

// What PeerSky Mobile sends to a desktop: its open tabs, its bookmarks and
// favourites, and the address of its private drive. It arrives as an ordinary
// identity transfer, sealed to this desktop and signed by the phone, and the
// decrypted payload says it came from a phone. None of it replaces anything
// here: the bookmarks are added to this desktop's, the tabs open asleep, and
// the phone's private drive becomes readable here.
export const PHONE_SYNC_SOURCE = 'mobile'
export const PHONE_TABS_FILE = 'phone-tabs.json'
export const PHONE_BOOKMARKS_FILE = 'phone-bookmarks.json'
export const PHONE_PRIVATE_DRIVES_FILE = 'phone-private-drives.json'
export const PHONE_PRIVATE_DRIVE_NAME = 'Private files from your phone'

const BOOKMARKS_FILE = 'bookmarks.json'
const PHONE_SYNC_FILES = new Set([PHONE_TABS_FILE, PHONE_BOOKMARKS_FILE, PHONE_PRIVATE_DRIVES_FILE])
const MAX_ENTRY_BYTES = 4 * 1024 * 1024
const MAX_TABS = 100
const MAX_BOOKMARKS = 1000
const MAX_PRIVATE_DRIVES = 8
const MAX_URL_LENGTH = 8192
const MAX_TITLE_LENGTH = 256
const HEX_DRIVE_ID = /^[0-9a-f]{64}$/

export function isPhoneSyncManifest (manifest) {
  return Boolean(manifest && typeof manifest === 'object' && manifest.source === PHONE_SYNC_SOURCE)
}

// Only addresses a desktop can open. peersky:// pages on the phone are its own.
export function isImportableUrl (url) {
  if (typeof url !== 'string' || !url || url.length > MAX_URL_LENGTH) return false
  return /^(?:https?|hyper|ipfs|ipns):\/\/[^\s]+$/i.test(url)
}

/**
 * Reads the inner zip of a decrypted phone transfer. Nothing is unpacked to
 * disk: each entry is small, named in the manifest with its checksum, and read
 * into memory with a hard cap, since a sender who knows this desktop's code
 * can put anything in it.
 */
export async function readPhoneSyncZip (zipPath) {
  const unzipper = await import('unzipper')
  const directory = await unzipper.Open.file(zipPath)
  const entries = new Map(directory.files.map((entry) => [entry.path, entry]))

  const manifestEntry = entries.get('manifest.json')
  if (!manifestEntry) throw new Error('What the phone sent is missing its manifest')
  let manifest
  try {
    manifest = JSON.parse((await readEntry(manifestEntry)).toString('utf8'))
  } catch {
    throw new Error('What the phone sent is damaged')
  }
  if (!isPhoneSyncManifest(manifest) || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('This transfer did not come from a phone')
  }

  const files = {}
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!PHONE_SYNC_FILES.has(name)) throw new Error(`Refusing unknown entry from the phone: ${name}`)
    const entry = entries.get(name)
    if (!entry) throw new Error(`What the phone sent is missing ${name}`)
    const bytes = await readEntry(entry)
    const actual = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
    if (actual !== expected) throw new Error(`Checksum mismatch for ${name}`)
    files[name] = bytes
  }

  return parsePhoneSync(files)
}

export function parsePhoneSync (files) {
  const tabs = []
  const seenTabs = new Set()
  for (const tab of listFrom(files[PHONE_TABS_FILE], 'tabs')) {
    const entry = normalizeEntry(tab)
    if (!entry || seenTabs.has(entry.url)) continue
    seenTabs.add(entry.url)
    tabs.push(entry)
    if (tabs.length === MAX_TABS) break
  }

  const bookmarks = []
  const seenBookmarks = new Set()
  for (const bookmark of listFrom(files[PHONE_BOOKMARKS_FILE], 'bookmarks')) {
    const entry = normalizeEntry(bookmark)
    if (!entry || seenBookmarks.has(entry.url)) continue
    seenBookmarks.add(entry.url)
    const createdAt = Number(bookmark.createdAt)
    bookmarks.push({ ...entry, createdAt: Number.isSafeInteger(createdAt) && createdAt > 0 ? createdAt : null })
    if (bookmarks.length === MAX_BOOKMARKS) break
  }

  const privateDrives = []
  for (const drive of listFrom(files[PHONE_PRIVATE_DRIVES_FILE], 'drives')) {
    const driveId = String(drive?.driveId || '').toLowerCase()
    if (!HEX_DRIVE_ID.test(driveId) || privateDrives.some((item) => item.driveId === driveId)) continue
    privateDrives.push({ driveId })
    if (privateDrives.length === MAX_PRIVATE_DRIVES) break
  }

  return { tabs, bookmarks, privateDrives }
}

/**
 * Adds the phone's bookmarks after this desktop's own. A bookmark already
 * here, by address, is left exactly as it is.
 */
export function mergeBookmarks (existing, incoming, now = Date.now()) {
  const bookmarks = Array.isArray(existing) ? [...existing] : []
  const known = new Set(bookmarks.map((bookmark) => bookmark?.url))
  let added = 0
  for (const bookmark of incoming) {
    if (known.has(bookmark.url)) continue
    known.add(bookmark.url)
    bookmarks.push({
      url: bookmark.url,
      title: bookmark.title,
      dateAdded: new Date(bookmark.createdAt || now).toISOString()
    })
    added += 1
  }
  return { bookmarks, added }
}

/**
 * Puts what the phone sent in place, apart from the tabs, which need a
 * window and are opened by the caller. Safe to run twice: a bookmark or drive
 * already here is not added again.
 */
export async function applyPhoneSync (userDataDir, sync, { now = Date.now() } = {}) {
  let bookmarksAdded = 0
  if (sync.bookmarks.length > 0) {
    const current = await readBookmarks(userDataDir)
    const merged = mergeBookmarks(current, sync.bookmarks, now)
    if (merged.added > 0) await writeJsonAtomic(path.join(userDataDir, BOOKMARKS_FILE), merged.bookmarks)
    bookmarksAdded = merged.added
  }

  // The phone encrypts its private drive with the key this desktop gave it,
  // so it opens here. It stays the phone's: read-only on this desktop, the way
  // a drive adopted from another device always is.
  const privateHostnames = []
  for (const drive of sync.privateDrives) {
    const hostname = z32.encode(Buffer.from(drive.driveId, 'hex'))
    await rememberPrivateHyperdrive(userDataDir, {
      name: PHONE_PRIVATE_DRIVE_NAME,
      url: `hyper://${hostname}/`,
      timestamp: now,
      encrypted: true
    })
    await setPrivateDriveOwnership(userDataDir, drive.driveId, false)
    privateHostnames.push(hostname)
  }

  return { bookmarksAdded, privateHostnames }
}

async function readBookmarks (userDataDir) {
  let text
  try {
    text = await fs.readFile(path.join(userDataDir, BOOKMARKS_FILE), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  // Writing over a file that could not be read would lose whatever is in it.
  if (!Array.isArray(parsed)) throw new Error('This desktop\'s bookmarks could not be read, so nothing was added')
  return parsed
}

async function writeJsonAtomic (destination, value) {
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2))
    await fs.rename(temporary, destination)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
}

function listFrom (bytes, field) {
  if (!bytes) return []
  try {
    const parsed = JSON.parse(bytes.toString('utf8'))
    return Array.isArray(parsed?.[field]) ? parsed[field] : []
  } catch {
    return []
  }
}

function normalizeEntry (item) {
  if (!item || typeof item !== 'object' || !isImportableUrl(item.url)) return null
  const title = typeof item.title === 'string'
    ? Array.from(item.title.replace(/\s+/g, ' ').trim()).slice(0, MAX_TITLE_LENGTH).join('')
    : ''
  return { url: item.url, title: title || item.url }
}

function readEntry (entry) {
  if (entry.type !== 'File' || entry.uncompressedSize > MAX_ENTRY_BYTES) {
    return Promise.reject(new Error('An entry from the phone is too large'))
  }
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const stream = entry.stream()
    stream.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_ENTRY_BYTES) {
        stream.destroy()
        reject(new Error('An entry from the phone is too large'))
        return
      }
      chunks.push(chunk)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}
