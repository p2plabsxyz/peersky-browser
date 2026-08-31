import { promises as fs } from 'fs'
import path from 'path'
import hypercoreCrypto from 'hypercore-crypto'

export const DEVICE_KEY_FILE = 'device-key.json'

function toHex (buf) {
  return Buffer.from(buf).toString('hex')
}

function fromHex (value, name) {
  if (!value || typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value)) {
    throw new Error(`Invalid ${name}`)
  }
  return Buffer.from(value, 'hex')
}

function serializeKeyPair (keyPair) {
  return {
    publicKey: toHex(keyPair.publicKey),
    secretKey: toHex(keyPair.secretKey)
  }
}

function deserializeKeyPair (keyPair, name) {
  if (!keyPair || typeof keyPair !== 'object') {
    throw new Error(`Invalid ${name}`)
  }
  return {
    publicKey: fromHex(keyPair.publicKey, `${name} public key`),
    secretKey: fromHex(keyPair.secretKey, `${name} secret key`)
  }
}

export async function getDeviceKeys (userDataDir) {
  const filePath = path.join(userDataDir, DEVICE_KEY_FILE)

  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8'))
    return {
      signing: deserializeKeyPair(parsed.signing, 'signing key'),
      encryption: deserializeKeyPair(parsed.encryption, 'encryption key')
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const keys = {
    version: 1,
    createdAt: new Date().toISOString(),
    signing: serializeKeyPair(hypercoreCrypto.keyPair()),
    encryption: serializeKeyPair(hypercoreCrypto.encryptionKeyPair())
  }

  await fs.mkdir(userDataDir, { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(keys, null, 2))
  await fs.chmod(filePath, 0o600).catch(() => {})

  return {
    signing: deserializeKeyPair(keys.signing, 'signing key'),
    encryption: deserializeKeyPair(keys.encryption, 'encryption key')
  }
}

export function getPublicDeviceInfo (keys) {
  return {
    signingPublicKey: toHex(keys.signing.publicKey),
    encryptionPublicKey: toHex(keys.encryption.publicKey)
  }
}

export function decodeEncryptionPublicKey (value) {
  const key = fromHex(value, 'encryption public key')
  if (key.byteLength !== 32) {
    throw new Error('Encryption public key must be 32 bytes')
  }
  return key
}
