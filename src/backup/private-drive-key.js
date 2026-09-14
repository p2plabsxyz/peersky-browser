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
