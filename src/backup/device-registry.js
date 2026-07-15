import { promises as fs } from 'fs'
import path from 'path'
import crypto from 'crypto'
import hypercoreCrypto from 'hypercore-crypto'
import { getPublicDeviceInfo } from './device-keys.js'

export const DEVICE_REGISTRY_FILE = 'peersky-devices.json'
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
  const hash = crypto.createHash('sha256')
  const names = ['peersky-ports.json', 'peersky-chat-rooms.json']
  let found = false

  for (const name of names) {
    try {
      const data = await fs.readFile(path.join(userDataDir, name))
      hash.update(name)
      hash.update(data)
      found = true
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  if (!found) hash.update('peersky-empty-identity')
  return hash.digest('hex')
}

function registryPath (userDataDir) {
  return path.join(userDataDir, DEVICE_REGISTRY_FILE)
}

function registryBody (registry) {
  return {
    version: registry.version,
    identityId: registry.identityId,
    ownerSigningPublicKey: registry.ownerSigningPublicKey,
    devices: registry.devices,
    updatedAt: registry.updatedAt
  }
}

export function signRegistry (registry, signingSecretKey) {
  const message = Buffer.from(canonicalJson(registryBody(registry)))
  return Buffer.from(hypercoreCrypto.sign(message, signingSecretKey)).toString('hex')
}

export function verifyRegistry (registry) {
  if (!registry || typeof registry !== 'object' || !registry.signature) return false
  const message = Buffer.from(canonicalJson(registryBody(registry)))
  return hypercoreCrypto.verify(
    message,
    Buffer.from(registry.signature, 'hex'),
    Buffer.from(registry.ownerSigningPublicKey, 'hex')
  )
}

export async function loadDeviceRegistry (userDataDir) {
  try {
    const registry = JSON.parse(await fs.readFile(registryPath(userDataDir), 'utf-8'))
    if (!verifyRegistry(registry)) throw new Error('Device registry signature is invalid')
    return registry
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function saveDeviceRegistry (userDataDir, registry, signingSecretKey) {
  const signed = {
    ...registry,
    signature: signRegistry(registry, signingSecretKey)
  }
  await fs.writeFile(registryPath(userDataDir), JSON.stringify(signed, null, 2))
  return signed
}

export async function reserveDeviceSlot (userDataDir, keys, identityId, deviceType, targetEncryptionPublicKey) {
  const normalizedType = normalizeDeviceType(deviceType)
  const publicInfo = getPublicDeviceInfo(keys)
  const existing = await loadDeviceRegistry(userDataDir)
  const registry = existing || {
    version: 1,
    identityId,
    ownerSigningPublicKey: publicInfo.signingPublicKey,
    devices: {
      desktop: null,
      mobile: null
    },
    updatedAt: null
  }

  if (registry.identityId !== identityId) {
    throw new Error('Device registry belongs to a different identity')
  }
  if (registry.ownerSigningPublicKey !== publicInfo.signingPublicKey) {
    throw new Error('Only the registry owner can pair new devices for this identity')
  }

  registry.devices[normalizedType] = {
    encryptionPublicKey: targetEncryptionPublicKey,
    pairedAt: new Date().toISOString()
  }
  registry.updatedAt = new Date().toISOString()

  return saveDeviceRegistry(userDataDir, registry, keys.signing.secretKey)
}

export async function assertIdentityImportAllowed (userDataDir, transfer) {
  const registry = await loadDeviceRegistry(userDataDir)
  if (!registry || registry.identityId !== transfer.identityId) return true

  return true
}
