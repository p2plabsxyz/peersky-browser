import { decodeDriveId } from '../backup/private-drive-export.js'
import { PHONE_PRIVATE_DRIVE_NAME } from '../backup/phone-sync.js'
import { listDriveTop } from './device-sync.js'
import { LINKED_PRIVATE_DRIVE_NAME } from './private-drive-errors.js'
import { readPrivateDriveOwnership } from './private-drive-ownership.js'
import { privateFileUrl } from './private-hyperdrive.js'
import { listPrivateHyperdrives } from './private-hyperdrive-registry.js'

// The private files this desktop shared, for the Hyperdrive app. Each private
// upload goes in a drive named after it, which the registry keeps, so the
// files are listed again from the drives after a restart, newest first, the
// way the phone keeps its own uploads under Recent. The phone shows the same
// files from this desktop, under From your devices.

// As many as the phone keeps under Recent.
export const MAX_OWN_PRIVATE_FILES = 100
// The drives are on this computer. One that takes longer than this to open or
// to list is left out rather than holding up the rest.
const OPEN_TIME_MS = 10000
const LIST_TIME_MS = 5000

function withTimeout (promise, ms, what) {
  let timer = null
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

/**
 * The private drives this desktop made, newest first. A drive another device
 * writes, such as a phone's, or one a restore brought here, is read-only here
 * and not this desktop's own.
 */
export async function listOwnPrivateDrives (userDataDir) {
  const entries = await listPrivateHyperdrives(userDataDir)
  const ownership = await readPrivateDriveOwnership(userDataDir)
  return entries.filter((entry) => {
    if (entry.name === PHONE_PRIVATE_DRIVE_NAME || entry.name === LINKED_PRIVATE_DRIVE_NAME) return false
    const id = decodeDriveId(entry.url)
    return Boolean(id) && ownership[id]?.owned !== false
  })
}

/**
 * The files and folders at the top of each of those drives, with the address
 * the private store opens them at and when the drive was last shared to.
 * Drives are opened one at a time, through `openDrive`, which must share its
 * opens with the reads of the same drives: a Hyperdrive takes its core for
 * itself, and a second one on it waits for good.
 *
 * @param {string} userDataDir
 * @param {object} options
 * @param {(url: string) => Promise<object>} options.openDrive
 */
export async function listOwnPrivateFiles (userDataDir, {
  openDrive,
  maxItems = MAX_OWN_PRIVATE_FILES,
  listTop = listDriveTop,
  openTimeMs = OPEN_TIME_MS,
  listTimeMs = LIST_TIME_MS,
  logger = console
} = {}) {
  const files = []
  for (const entry of await listOwnPrivateDrives(userDataDir)) {
    if (files.length >= maxItems) break
    let listed
    try {
      const drive = await withTimeout(Promise.resolve(openDrive(entry.url)), openTimeMs, 'Opening a private drive')
      if (!drive) continue
      listed = await listTop(drive, { maxItems: maxItems - files.length, timeoutMs: listTimeMs })
    } catch (error) {
      logger.warn?.(`[private files] One of this desktop's private drives was left out: ${error?.message || error}`)
      continue
    }
    for (const item of listed.items) {
      files.push({
        type: item.type,
        name: item.name,
        byteLength: item.byteLength,
        url: privateFileUrl(entry.url, item.path),
        timestamp: entry.timestamp
      })
    }
  }
  return files.slice(0, maxItems)
}
