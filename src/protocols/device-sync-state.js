import { join } from 'path'
import { readSealedJsonSync, writeSealedJsonSync } from '../backup/sealed-file.js'
import { DEVICE_TYPES, MAX_ANNOUNCED_DRIVES } from './device-sync-protocol.js'

// The person's other devices this desktop has met, and what is in the private
// drives they write, so the Hyperdrive app can list their files with nobody
// online. Kept in the profile folder, outside any store: nothing in it is a
// key, only network keys, drive addresses and file names, and those names
// are locked with the system's safe storage. The same file as
// backend/hyper/device-sync-state.mjs keeps on the phone.
export const DEVICE_SYNC_FILE = 'device-sync.json'
export const MAX_SYNCED_DEVICES = 16
export const MAX_LISTED_ITEMS = 100

const HEX_32 = /^[0-9a-f]{64}$/
const MAX_NAME_LENGTH = 255
const MAX_PATH_LENGTH = 1024

const cache = new Map()

function emptyState () {
  return { version: 1, devices: [], listings: {}, seenAt: 0 }
}

function isTime (value) {
  return Number.isSafeInteger(value) && value >= 0
}

function normalizeDevice (entry) {
  if (!entry || typeof entry !== 'object') return null
  const id = typeof entry.id === 'string' ? entry.id.toLowerCase() : ''
  if (!HEX_32.test(id) || !DEVICE_TYPES.includes(entry.type)) return null
  const drives = Array.isArray(entry.drives)
    ? [...new Set(entry.drives.filter((drive) => typeof drive === 'string' && HEX_32.test(drive)))].slice(0, MAX_ANNOUNCED_DRIVES)
    : []
  const lastSeen = isTime(entry.lastSeen) ? entry.lastSeen : 0
  return {
    id,
    type: entry.type,
    firstSeen: isTime(entry.firstSeen) ? entry.firstSeen : lastSeen,
    lastSeen,
    drives
  }
}

function normalizeItem (item) {
  if (!item || typeof item !== 'object') return null
  if (item.type !== 'file' && item.type !== 'directory') return null
  if (typeof item.name !== 'string' || !item.name || item.name.length > MAX_NAME_LENGTH) return null
  if (typeof item.path !== 'string' || !item.path.startsWith('/') || item.path.length > MAX_PATH_LENGTH) return null
  return {
    type: item.type,
    name: item.name,
    path: item.path,
    byteLength: item.type === 'file' && Number.isSafeInteger(item.byteLength) && item.byteLength >= 0 ? item.byteLength : 0,
    // When this desktop first saw it written, or 0 for what was there before.
    addedAt: isTime(item.addedAt) ? item.addedAt : 0
  }
}

function normalizeListing (listing) {
  if (!listing || typeof listing !== 'object' || !Array.isArray(listing.items)) return null
  return {
    items: listing.items.map(normalizeItem).filter(Boolean).slice(0, MAX_LISTED_ITEMS),
    truncated: listing.truncated === true,
    updatedAt: isTime(listing.updatedAt) ? listing.updatedAt : 0,
    // How long the drive was when it was listed. What it writes after that is
    // new; null for a listing from before this was kept.
    version: isTime(listing.version) ? listing.version : null
  }
}

function normalizeState (parsed) {
  if (!parsed || parsed.version !== 1) return emptyState()
  const devices = Array.isArray(parsed.devices)
    ? parsed.devices.map(normalizeDevice).filter(Boolean)
    : []
  const unique = [...new Map(devices.map((device) => [device.id, device])).values()]
    .sort((left, right) => right.lastSeen - left.lastSeen)
    .slice(0, MAX_SYNCED_DEVICES)
  // Only the drives a device still lists keep their files here.
  const wanted = new Set(unique.flatMap((device) => device.drives))
  const listings = {}
  if (parsed.listings && typeof parsed.listings === 'object') {
    for (const [driveId, listing] of Object.entries(parsed.listings)) {
      if (!wanted.has(driveId)) continue
      const normalized = normalizeListing(listing)
      if (normalized) listings[driveId] = normalized
    }
  }
  return { version: 1, devices: unique, listings, seenAt: isTime(parsed.seenAt) ? parsed.seenAt : 0 }
}

export function readDeviceSyncState (directory) {
  if (!directory) return emptyState()
  if (cache.has(directory)) return cache.get(directory)
  let state = emptyState()
  try {
    const filePath = join(directory, DEVICE_SYNC_FILE)
    // What each device's private drives hold, by name and size, so locked
    // like the key (sealed-file.js). One that cannot be opened is only a
    // listing, and is heard again from the devices.
    const read = readSealedJsonSync(filePath)
    if (read) state = normalizeState(read.value)
  } catch {}
  cache.set(directory, state)
  return state
}

function writeState (directory, state) {
  const normalized = normalizeState(state)
  try {
    writeSealedJsonSync(join(directory, DEVICE_SYNC_FILE), normalized)
  } catch {
    return readDeviceSyncState(directory)
  }
  cache.set(directory, normalized)
  return normalized
}

/**
 * A device that proved itself and said what it is. Returns the drives it
 * listed that had not been heard of from it before.
 */
export function recordDeviceHello (directory, { id, type, drives = [], now = Date.now() }) {
  const deviceId = typeof id === 'string' ? id.toLowerCase() : ''
  if (!directory || !HEX_32.test(deviceId) || !DEVICE_TYPES.includes(type)) return { added: [] }
  const state = readDeviceSyncState(directory)
  const previous = state.devices.find((device) => device.id === deviceId)
  const driveIds = [...new Set(drives.filter((drive) => HEX_32.test(drive)))].slice(0, MAX_ANNOUNCED_DRIVES)
  const known = new Set(previous?.drives || [])
  const device = {
    id: deviceId,
    type,
    firstSeen: previous?.firstSeen || now,
    lastSeen: now,
    drives: driveIds
  }
  const added = driveIds.filter((drive) => !known.has(drive))
  // A drive a known device starts listing was made since, so all of it is
  // new here: an empty listing from before it says so. What a device has the
  // first time it is met was there already, and is not.
  const listings = { ...state.listings }
  if (previous) {
    for (const drive of added) {
      if (!listings[drive]) listings[drive] = { items: [], truncated: false, updatedAt: 0, version: 0 }
    }
  }
  writeState(directory, {
    ...state,
    devices: [device, ...state.devices.filter((entry) => entry.id !== deviceId)],
    listings
  })
  return { added }
}

/** When a device was last connected, kept as it goes offline. */
export function recordDeviceSeen (directory, id, now = Date.now()) {
  const deviceId = typeof id === 'string' ? id.toLowerCase() : ''
  const state = readDeviceSyncState(directory)
  if (!state.devices.some((device) => device.id === deviceId)) return
  writeState(directory, {
    ...state,
    devices: state.devices.map((device) => device.id === deviceId ? { ...device, lastSeen: now } : device)
  })
}

/**
 * What is at the top of a drive now. An item written since the drive was last
 * listed is marked with the time it was seen, which the Hyperdrive app and
 * the home page count as new until they are looked at. `seq` is where each
 * item sits in the drive and `version` how long the drive was, both from
 * listDriveTop: an older item that only now comes into a listing cut short at
 * a hundred is not new.
 */
export function recordDriveListing (directory, driveId, { items = [], truncated = false, version = null, now = Date.now() } = {}) {
  const id = typeof driveId === 'string' ? driveId.toLowerCase() : ''
  if (!directory || !HEX_32.test(id)) return
  const state = readDeviceSyncState(directory)
  if (!state.devices.some((device) => device.drives.includes(id))) return
  const previous = state.listings[id]
  const since = previous && isTime(previous.version) ? previous.version : null
  const before = new Map((previous?.items || []).map((item) => [`${item.type}:${item.path}`, item]))
  const listed = (Array.isArray(items) ? items : []).map((item) => {
    const written = since !== null && isTime(item?.seq) && item.seq >= since
    const addedAt = written ? now : before.get(`${item?.type}:${item?.path}`)?.addedAt || 0
    return { ...item, addedAt }
  })
  writeState(directory, {
    ...state,
    listings: { ...state.listings, [id]: { items: listed, truncated, updatedAt: now, version: isTime(version) ? version : null } }
  })
}

// Each drive once, as the devices list them now.
function listedItems (state) {
  const drives = new Set(state.devices.flatMap((device) => device.drives))
  return [...drives].flatMap((drive) => state.listings[drive]?.items || [])
}

/** How many files and folders the person's other devices added since they last looked. */
export function newDeviceFileCount (directory) {
  const state = readDeviceSyncState(directory)
  return listedItems(state).filter((item) => item.addedAt > state.seenAt).length
}

/** The Hyperdrive app showed the files: none of them is new any more. */
export function markDeviceFilesSeen (directory, now = Date.now()) {
  if (!directory) return false
  const state = readDeviceSyncState(directory)
  const items = listedItems(state)
  if (!items.some((item) => item.addedAt > state.seenAt)) return false
  // Past every mark too, so a clock set back cannot bring them back.
  const seenAt = items.reduce((latest, item) => Math.max(latest, item.addedAt), Math.max(state.seenAt, now))
  writeState(directory, { ...state, seenAt })
  return true
}

/** Takes a device off the list, with what it listed. It comes back when it connects again. */
export function forgetSyncedDevice (directory, id) {
  const deviceId = typeof id === 'string' ? id.toLowerCase() : ''
  const state = readDeviceSyncState(directory)
  if (!state.devices.some((device) => device.id === deviceId)) return false
  writeState(directory, { ...state, devices: state.devices.filter((device) => device.id !== deviceId) })
  return true
}

/** Every drive another device listed, with the device that listed it last. */
export function syncedDriveOwners (directory) {
  const owners = new Map()
  // Oldest first, so the device seen most recently wins a drive two list.
  for (const device of [...readDeviceSyncState(directory).devices].reverse()) {
    for (const drive of device.drives) owners.set(drive, device)
  }
  return owners
}

export function resetDeviceSyncStateCache () {
  cache.clear()
}
