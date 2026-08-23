import { promises as fs } from 'fs'
import path from 'path'
import crypto from 'crypto'

export const IDENTITY_METADATA_FILE = 'peersky-identity.json'
export const DEVICE_TYPES = new Set(['desktop', 'mobile'])

export function canonicalJson (value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function normalizeDeviceType (type) {
  if (!DEVICE_TYPES.has(type)) {
    throw new Error('Device type must be desktop or mobile')
  }
  return type
}

export async function computeIdentityId (userDataDir) {
  const filePath = path.join(userDataDir, IDENTITY_METADATA_FILE)
  try {
    const metadata = JSON.parse(await fs.readFile(filePath, 'utf-8'))
    if (metadata.version !== 1 || !/^[0-9a-f]{64}$/.test(metadata.identityId)) {
      throw new Error('Identity metadata is invalid')
    }
    return metadata.identityId
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const metadata = {
    version: 1,
    identityId: crypto.randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString()
  }
  await fs.mkdir(userDataDir, { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(metadata, null, 2), { mode: 0o600 })
  return metadata.identityId
}
