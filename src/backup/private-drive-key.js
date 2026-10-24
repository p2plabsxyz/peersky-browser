import path from 'path'
import crypto from 'crypto'
import { canSeal, readSealedJson, writeSealedJson } from './sealed-file.js'

export const PRIVATE_DRIVE_KEY_FILE = 'private-drive-key.json'

const KEY_PATTERN = /^[0-9a-f]{64}$/i

function keyPath (userDataDir) {
  return path.join(userDataDir, PRIVATE_DRIVE_KEY_FILE)
}

// The file is locked with the system's safe storage (sealed-file.js). One
// written before that, or put back by a restore, is read as it is and locked
// at once. A locked file that cannot be opened throws: making a new key in its
// place would lose every private drive.
async function readKeyFile (userDataDir) {
  const read = await readSealedJson(keyPath(userDataDir))
  if (!read) return null
  if (!read.sealed && canSeal() && read.value && typeof read.value === 'object') {
    await writeSealedJson(keyPath(userDataDir), read.value)
  }
  return read.value
}

export async function getPrivateDriveKey (userDataDir) {
  let parsed
  try {
    parsed = await readKeyFile(userDataDir)
  } catch (error) {
    if (error.code === 'SEALED_FILE_LOCKED') throw error
    return null
  }
  if (typeof parsed?.key !== 'string' || !KEY_PATTERN.test(parsed.key)) return null
  return Buffer.from(parsed.key, 'hex')
}

export async function createPrivateDriveKey (userDataDir) {
  const key = crypto.randomBytes(32)
  await writeSealedJson(keyPath(userDataDir), { version: 1, key: key.toString('hex') })
  return key
}

// Two first uses at once must not each make a key: the drive made with the
// one that loses would never open again.
const creating = new Map()

export async function getOrCreatePrivateDriveKey (userDataDir) {
  const existing = await getPrivateDriveKey(userDataDir)
  if (existing) return existing
  if (!creating.has(userDataDir)) {
    const made = createPrivateDriveKey(userDataDir).finally(() => creating.delete(userDataDir))
    creating.set(userDataDir, made)
  }
  return creating.get(userDataDir)
}

/**
 * Takes the key the person's other devices share in place of this desktop's,
 * so it meets them and opens their private drives. Only when this desktop has
 * no key yet, or `mayReplace` says nothing here needs the one it has: a drive
 * made with it would not open under another. A key file that cannot be read
 * is never written over. Returns true when the key changed.
 */
export async function adoptPrivateDriveKey (userDataDir, key, { mayReplace = async () => false } = {}) {
  const hex = String(key || '').toLowerCase()
  if (!KEY_PATTERN.test(hex)) return false
  let parsed
  try {
    parsed = await readKeyFile(userDataDir)
  } catch {
    return false
  }
  const current = typeof parsed?.key === 'string' && KEY_PATTERN.test(parsed.key) ? parsed.key.toLowerCase() : null
  if (current === hex) return false
  if (current && !await mayReplace()) return false
  const kept = parsed && typeof parsed === 'object' ? parsed : {}
  await writeSealedJson(keyPath(userDataDir), { ...kept, version: 1, key: hex })
  return true
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
    const parsed = await readKeyFile(userDataDir)
    const entry = Array.isArray(parsed?.entries) ? parsed.entries.find((item) => item?.driveId === id) : null
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
    parsed = await readKeyFile(userDataDir)
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

  await writeSealedJson(keyPath(userDataDir), { ...parsed, entries })
  return true
}
