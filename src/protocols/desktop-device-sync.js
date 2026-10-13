import z32 from 'z32'
import { attachDeviceSync } from './device-sync.js'
import { readDeviceSyncState } from './device-sync-state.js'
import { getPrivateDriveKey, rememberPrivateDriveKeyFor } from '../backup/private-drive-key.js'
import { decodeDriveId } from '../backup/private-drive-export.js'
import { PHONE_PRIVATE_DRIVE_NAME } from '../backup/phone-sync.js'
import { listPrivateHyperdrives, rememberPrivateHyperdrive } from './private-hyperdrive-registry.js'
import { isOwnedPrivateDrive, setPrivateDriveOwnership } from './private-drive-ownership.js'
import { LINKED_PRIVATE_DRIVE_NAME } from './private-drive-errors.js'
import { privateFileUrl } from './private-hyperdrive.js'

// This desktop's side of the private sync with the person's other devices: it
// meets them under a topic made from this profile's private drive key, tells
// them which private drives it made, and takes a phone's private drive the
// way a phone's Link Device send does, read-only here, with a copy of every
// file kept so they open with the phone asleep.

function urlOf (driveId) {
  return `hyper://${z32.encode(Buffer.from(driveId, 'hex'))}/`
}

/** The encrypted private drives this desktop made, which it lists to the others. */
export async function listOwnSyncDrives (userDataDir) {
  const entries = await listPrivateHyperdrives(userDataDir).catch(() => [])
  const own = []
  for (const entry of entries) {
    if (!entry.encrypted) continue
    const id = decodeDriveId(entry.url)
    if (!id || own.some((drive) => drive.id === id)) continue
    if (!await isOwnedPrivateDrive(userDataDir, id)) continue
    own.push({ id })
  }
  return own
}

/**
 * A drive another of the person's devices listed: kept read-only here, under
 * the name a phone's drive gets from Link Device, with its own key when it
 * has one. A drive this desktop made stays its own, whatever another device
 * says. Safe to run again for the same drive.
 */
export async function takeLinkedDrive (userDataDir, { id, key = null, identityKey = null, device = 'phone', now = Date.now() }) {
  const url = urlOf(id)
  const known = (await listPrivateHyperdrives(userDataDir).catch(() => [])).find((entry) => entry.url === url)
  if (known && await isOwnedPrivateDrive(userDataDir, id)) return false
  if (key && (!identityKey || !Buffer.from(key).equals(Buffer.from(identityKey)))) {
    await rememberPrivateDriveKeyFor(userDataDir, id, Buffer.from(key).toString('hex'))
  }
  if (!known) {
    await rememberPrivateHyperdrive(userDataDir, {
      name: device === 'phone' ? PHONE_PRIVATE_DRIVE_NAME : LINKED_PRIVATE_DRIVE_NAME,
      url,
      timestamp: now,
      encrypted: true
    })
  }
  await setPrivateDriveOwnership(userDataDir, id, false)
  return true
}

/**
 * Starts the sync on the private store's SDK, or returns null when this
 * profile has no private drive key yet: then there is nothing to meet under,
 * and nothing private to share.
 */
export async function startDesktopDeviceSync (sdk, { userDataDir, openPrivateDrive, trustHostname = () => {}, logger = console, attach = attachDeviceSync } = {}) {
  const identityKey = await getPrivateDriveKey(userDataDir)
  if (!identityKey || !sdk) return null
  let ownDrives = await listOwnSyncDrives(userDataDir)
  const sync = attach(sdk, {
    identityKey,
    stateDirectory: userDataDir,
    device: 'desktop',
    ownDrives: () => ownDrives,
    openDrive: async (id, key, { device } = {}) => {
      if (!await takeLinkedDrive(userDataDir, { id, key, identityKey, device })) return null
      const url = urlOf(id)
      trustHostname(new URL(url).hostname)
      return openPrivateDrive(url)
    },
    mirror: true,
    logger
  })
  if (!sync) return null
  return {
    get online () {
      return sync.online
    },
    // A private drive was made here: the other devices hear of it now.
    async drivesChanged () {
      ownDrives = await listOwnSyncDrives(userDataDir)
      sync.announce()
    },
    refresh: () => sync.refresh(),
    nudge: () => sync.nudge(),
    close: () => sync.close()
  }
}

/**
 * The devices this desktop has met and the files at the top of their private
 * drives, for the Hyperdrive app. Addresses are in the z-base-32 form the
 * desktop opens.
 */
export function deviceSyncSnapshot (userDataDir, online = new Set()) {
  const state = readDeviceSyncState(userDataDir)
  return {
    devices: state.devices.map((device) => ({
      id: device.id,
      type: device.type,
      online: online.has(device.id),
      firstSeen: device.firstSeen,
      lastSeen: device.lastSeen
    })),
    files: state.devices.flatMap((device) => device.drives.flatMap((driveId) => {
      const listing = state.listings[driveId]
      if (!listing) return []
      return listing.items.map((item) => ({
        type: item.type,
        name: item.name,
        byteLength: item.byteLength,
        deviceId: device.id,
        deviceType: device.type,
        url: privateFileUrl(urlOf(driveId), item.path)
      }))
    }))
  }
}
