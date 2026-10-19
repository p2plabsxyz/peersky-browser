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
  return { version: 1, devices: [], listings: {} }
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
    byteLength: item.type === 'file' && Number.isSafeInteger(item.byteLength) && item.byteLength >= 0 ? item.byteLength : 0
  }
}

function normalizeListing (listing) {
  if (!listing || typeof listing !== 'object' || !Array.isArray(listing.items)) return null
  return {
    items: listing.items.map(normalizeItem).filter(Boolean).slice(0, MAX_LISTED_ITEMS),
    truncated: listing.truncated === true,
    updatedAt: isTime(listing.updatedAt) ? listing.updatedAt : 0
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
  return { version: 1, devices: unique, listings }
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
  writeState(directory, {
    ...state,
    devices: [device, ...state.devices.filter((entry) => entry.id !== deviceId)]
  })
  return { added: driveIds.filter((drive) => !known.has(drive)) }
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

export function recordDriveListing (directory, driveId, { items = [], truncated = false, now = Date.now() } = {}) {
  const id = typeof driveId === 'string' ? driveId.toLowerCase() : ''
  if (!directory || !HEX_32.test(id)) return
  const state = readDeviceSyncState(directory)
  if (!state.devices.some((device) => device.drives.includes(id))) return
  writeState(directory, {
    ...state,
    listings: { ...state.listings, [id]: { items, truncated, updatedAt: now } }
  })
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
