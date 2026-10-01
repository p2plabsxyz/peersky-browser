import { promises as fs } from 'fs'
import path from 'path'
import crypto from 'crypto'
import z32 from 'z32'
import { listPrivateHyperdrives, rememberPrivateHyperdrive } from '../protocols/private-hyperdrive-registry.js'
import { isOwnedPrivateDrive, setPrivateDriveOwnership } from '../protocols/private-drive-ownership.js'
import { rememberPrivateDriveKeyFor } from './private-drive-key.js'

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
// The phone's PeerChat: its name, rooms and the link its devices share.
// PeerChat checks every field when it takes it (importChatTransfer).
export const PHONE_PEERCHAT_FILE = 'phone-peerchat.json'
// The phone's recent P2PMD notes. P2PMD checks every field when it takes them
// (p2pmd-notes.js), and only keys, names and text are ever in it.
export const PHONE_P2PMD_FILE = 'phone-p2pmd.json'
export const PHONE_PRIVATE_DRIVE_NAME = 'Private files from your phone'

const BOOKMARKS_FILE = 'bookmarks.json'
const PHONE_SYNC_FILES = new Set([PHONE_TABS_FILE, PHONE_BOOKMARKS_FILE, PHONE_PRIVATE_DRIVES_FILE, PHONE_PEERCHAT_FILE, PHONE_P2PMD_FILE])
const MAX_CHAT_ROOMS = 500
const MAX_NOTES = 5
const MAX_ENTRY_BYTES = 4 * 1024 * 1024
const MAX_TABS = 100
const MAX_BOOKMARKS = 1000
const MAX_PRIVATE_DRIVES = 8
const MAX_URL_LENGTH = 8192
const MAX_TITLE_LENGTH = 256
const HEX_DRIVE_ID = /^[0-9a-f]{64}$/
const HEX_DRIVE_KEY = /^[0-9a-f]{64}$/

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

  // Each drive comes with its key, so it opens here whichever key the phone
  // made it with. A phone that sends no key made it with this desktop's.
  const privateDrives = []
  for (const drive of listFrom(files[PHONE_PRIVATE_DRIVES_FILE], 'drives')) {
    const driveId = String(drive?.driveId || '').toLowerCase()
    if (!HEX_DRIVE_ID.test(driveId) || privateDrives.some((item) => item.driveId === driveId)) continue
    const key = String(drive?.key || '').toLowerCase()
    privateDrives.push(HEX_DRIVE_KEY.test(key) ? { driveId, key } : { driveId })
    if (privateDrives.length === MAX_PRIVATE_DRIVES) break
  }

  return {
    tabs,
    bookmarks,
    privateDrives,
    chat: readChat(files[PHONE_PEERCHAT_FILE]),
    notes: readNotes(files[PHONE_P2PMD_FILE])
  }
}

// Only its shape here, for the confirmation: how many notes, by key.
function readNotes (bytes) {
  if (!bytes) return null
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.notes)) return null
  const notes = parsed.notes
    .slice(0, MAX_NOTES)
    .filter((note) => typeof note?.key === 'string' && /^(?:hs:\/\/)?[a-z0-9]{32,256}$/i.test(note.key.trim()))
  return { ...parsed, notes }
}

// Only its shape here, for the confirmation: the rooms and the name.
function readChat (bytes) {
  if (!bytes) return null
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.rooms)) return null
  const username = typeof parsed.profile?.username === 'string' ? parsed.profile.username.slice(0, 50) : ''
  return { ...parsed, rooms: parsed.rooms.slice(0, MAX_CHAT_ROOMS), profile: username ? { ...parsed.profile, username } : null }
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
 * The phone's tabs that are not open on this desktop yet, in any window.
 * `windows` is each window's tab state, as the window manager collects it. A
 * page already open here is often one this desktop sent to the phone, coming
 * back, and the phone leaves out a tab it has open in the same way.
 */
export function tabsNotOpen (tabs, windows) {
  const open = new Set()
  for (const state of Object.values(windows || {})) {
    for (const tab of Array.isArray(state?.tabs) ? state.tabs : []) {
      if (typeof tab?.url === 'string') open.add(tab.url)
    }
  }
  return tabs.filter((tab) => !open.has(tab.url))
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

  // The phone's private drive opens here with the key it sends. It stays the
  // phone's: read-only on this desktop, the way a drive adopted from another
  // device always is. Every one is trusted again (privateHostnames); only one
  // this desktop did not know counts as added.
  const known = new Set((await listPrivateHyperdrives(userDataDir).catch(() => [])).map((entry) => entry.url))
  const privateHostnames = []
  let privateDrivesAdded = 0
  for (const drive of sync.privateDrives) {
    const hostname = z32.encode(Buffer.from(drive.driveId, 'hex'))
    const url = `hyper://${hostname}/`
    // A drive this desktop made stays its own, whatever a phone lists: it is
    // never renamed, made read-only here, or given another key.
    if (known.has(url) && await isOwnedPrivateDrive(userDataDir, drive.driveId)) continue
    if (!known.has(url)) privateDrivesAdded += 1
    if (drive.key) await rememberPrivateDriveKeyFor(userDataDir, drive.driveId, drive.key)
    await rememberPrivateHyperdrive(userDataDir, {
      name: PHONE_PRIVATE_DRIVE_NAME,
      url,
      timestamp: now,
      encrypted: true
    })
    await setPrivateDriveOwnership(userDataDir, drive.driveId, false)
    privateHostnames.push(hostname)
  }

  return { bookmarksAdded, privateHostnames, privateDrivesAdded }
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
