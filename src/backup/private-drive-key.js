import path from 'path'
import crypto from 'crypto'
import { promises as fs } from 'fs'

export const PRIVATE_DRIVE_KEY_FILE = 'private-drive-key.json'

const KEY_PATTERN = /^[0-9a-f]{64}$/i

function keyPath (userDataDir) {
  return path.join(userDataDir, PRIVATE_DRIVE_KEY_FILE)
}

export async function getPrivateDriveKey (userDataDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(keyPath(userDataDir), 'utf8'))
    if (typeof parsed.key !== 'string' || !KEY_PATTERN.test(parsed.key)) return null
    return Buffer.from(parsed.key, 'hex')
  } catch {
    return null
  }
}

export async function createPrivateDriveKey (userDataDir) {
  const key = crypto.randomBytes(32)
  await fs.mkdir(userDataDir, { recursive: true })
  const temporary = `${keyPath(userDataDir)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: 1, key: key.toString('hex') }, null, 2), { mode: 0o600 })
    await fs.rename(temporary, keyPath(userDataDir))
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
  return key
}

export async function getOrCreatePrivateDriveKey (userDataDir) {
  const existing = await getPrivateDriveKey(userDataDir)
  if (existing) return existing
  return createPrivateDriveKey(userDataDir)
}

const DRIVE_ID_PATTERN = /^[0-9a-f]{64}$/

// A private drive another device made can have a key of its own, such as a
// phone's drive from before it was linked. The phone sends that key with the
// drive's address. It is kept in this file's entries, the same entries a
// backup of this file carries, so it travels wherever this desktop's key does.
export async function getPrivateDriveKeyFor (userDataDir, driveId) {
  const id = String(driveId || '').toLowerCase()
  if (!DRIVE_ID_PATTERN.test(id)) return null
  try {
    const parsed = JSON.parse(await fs.readFile(keyPath(userDataDir), 'utf8'))
    const entry = Array.isArray(parsed.entries) ? parsed.entries.find((item) => item?.driveId === id) : null
    if (typeof entry?.key !== 'string' || !KEY_PATTERN.test(entry.key)) return null
    return Buffer.from(entry.key, 'hex')
  } catch {
    return null
  }
}

export async function rememberPrivateDriveKeyFor (userDataDir, driveId, key) {
  const id = String(driveId || '').toLowerCase()
  const hex = String(key || '').toLowerCase()
  if (!DRIVE_ID_PATTERN.test(id) || !KEY_PATTERN.test(hex)) return false

  await getOrCreatePrivateDriveKey(userDataDir)
  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(keyPath(userDataDir), 'utf8'))
  } catch {
    parsed = null
  }
  // Never written over when it cannot be read: it holds this desktop's own key.
  if (!parsed || typeof parsed !== 'object' || typeof parsed.key !== 'string') return false

  const current = Array.isArray(parsed.entries) ? parsed.entries : []
  const previous = current.find((item) => item?.driveId === id)
  // A drive's key never changes, so the first one kept stays: a later
  // transfer cannot swap in one that would stop the drive opening here.
  if (typeof previous?.key === 'string' && KEY_PATTERN.test(previous.key)) return false
  const entries = current.filter((item) => item?.driveId !== id)
  entries.push({ ...(previous && typeof previous === 'object' ? previous : {}), driveId: id, key: hex })

  const temporary = `${keyPath(userDataDir)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify({ ...parsed, entries }, null, 2), { mode: 0o600 })
    await fs.rename(temporary, keyPath(userDataDir))
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
  return true
}
