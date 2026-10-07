import crypto from 'crypto'
import z32 from 'z32'
import { listPrivateHyperdrives } from '../protocols/private-hyperdrive-registry.js'
import { getOrCreatePrivateDriveKey, getPrivateDriveKeyFor } from './private-drive-key.js'

export const PRIVATE_DRIVE_KEY_FILE = 'private-drive-key.json'

// forPhone: a phone is receiving this, so the key goes even when there are no
// private drives yet. The phone encrypts its own private uploads with it, and
// that is what lets this desktop open them too.
export async function buildPrivateDriveKeyExport (userDataDir, now = Date.now(), options = {}) {
  let entries
  try {
    entries = await listPrivateHyperdrives(userDataDir)
  } catch {
    return null
  }

  // A drive with a key of its own, such as a phone's, carries it: the device
  // this goes to opens that drive with it rather than with this desktop's key.
  const drives = []
  for (const entry of entries) {
    const driveId = decodeDriveId(entry.url)
    if (!driveId) continue
    const driveKey = await getPrivateDriveKeyFor(userDataDir, driveId)
    drives.push({ driveId, createdAt: entry.timestamp || null, ...(driveKey ? { key: driveKey.toString('hex') } : {}) })
  }
  if (drives.length === 0 && !options.forPhone) return null

  const key = await getOrCreatePrivateDriveKey(userDataDir)
  const deviceOnly = process.env.PEERSKY_PRIVATE_DEVICE_ONLY === '1'

  return Buffer.from(JSON.stringify({
    version: 3,
    createdAt: new Date(now).toISOString(),
    key: key.toString('hex'),
    ...(drives.length > 0 ? { driveId: drives[0].driveId } : {}),
    encrypted: !deviceOnly,
    announce: !deviceOnly,
    source: 'desktop',
    entries: drives
  }, null, 2))
}

export function decodeDriveId (url) {
  let hostname
  try {
    hostname = new URL(url).hostname
  } catch {
    return null
  }

  try {
    if (/^[a-z0-9]{52}$/i.test(hostname)) {
      return Buffer.from(z32.decode(hostname.toLowerCase())).toString('hex')
    }
    if (/^[0-9a-f]{64}$/i.test(hostname)) {
      return hostname.toLowerCase()
    }
  } catch {}

  return null
}

export function hashPrivateDriveKeyExport (bytes) {
  const hash = crypto.createHash('sha256')
  hash.update(bytes)
  return hash.digest('hex')
}
