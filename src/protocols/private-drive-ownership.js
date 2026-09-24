import crypto from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { decodeDriveId } from '../backup/private-drive-export.js'
import { listPrivateHyperdrives } from './private-hyperdrive-registry.js'

export const PRIVATE_DRIVE_OWNERSHIP_FILE = 'private-drive-owners.json'

const HEX_DRIVE_ID = /^[0-9a-f]{64}$/

function ownershipPath (userDataDir) {
  return path.join(userDataDir, PRIVATE_DRIVE_OWNERSHIP_FILE)
}

export async function readPrivateDriveOwnership (userDataDir) {
  if (!userDataDir) return {}
  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(ownershipPath(userDataDir), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

  const ownership = {}
  for (const [driveId, record] of Object.entries(parsed)) {
    const normalized = String(driveId).toLowerCase()
    if (!HEX_DRIVE_ID.test(normalized)) continue
    if (!record || typeof record !== 'object' || typeof record.owned !== 'boolean') continue
    ownership[normalized] = { owned: record.owned }
  }
  return ownership
}

export async function isOwnedPrivateDrive (userDataDir, driveId) {
  const normalized = String(driveId || '').toLowerCase()
  if (!HEX_DRIVE_ID.test(normalized)) return true
  const ownership = await readPrivateDriveOwnership(userDataDir)
  const record = ownership[normalized]
  return record ? record.owned === true : true
}

export async function setPrivateDriveOwnership (userDataDir, driveId, owned) {
  const normalized = String(driveId || '').toLowerCase()
  if (!HEX_DRIVE_ID.test(normalized)) return false
  const ownership = await readPrivateDriveOwnership(userDataDir)
  ownership[normalized] = { owned: owned === true }
  await fs.mkdir(userDataDir, { recursive: true })

  const destination = ownershipPath(userDataDir)
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(ownership, null, 2), { mode: 0o600 })
    await fs.rename(temporary, destination)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
  return true
}

export async function currentPrivateDriveIds (userDataDir) {
  try {
    const entries = await listPrivateHyperdrives(userDataDir)
    return new Set(entries.map((entry) => decodeDriveId(entry.url)).filter(Boolean))
  } catch {
    return new Set()
  }
}
