import { promises as fs, createReadStream, createWriteStream } from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { pipeline } from 'stream/promises'
import archiver from 'archiver'
import hypercoreCrypto from 'hypercore-crypto'
import { BACKUP_VERSION, MANIFEST_NAME, createBackupZip, extractBackupZip, readManifest, verifyManifest } from './backup-core.js'
import { decodeEncryptionPublicKey, getDeviceKeys, getPublicDeviceInfo } from './device-keys.js'
import { DEVICE_REGISTRY_FILE, assertIdentityImportAllowed, canonicalJson, computeIdentityId, normalizeDeviceType, reserveDeviceSlot } from './device-registry.js'

export const IDENTITY_TRANSFER_KIND = 'peersky-identity-transfer'
export const IDENTITY_PAYLOAD_NAME = 'identity-payload.bin'

function toHex (buf) {
  return Buffer.from(buf).toString('hex')
}

async function sha256File (filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function writeWrapperZip (outPath, manifest, payloadPath) {
  await fs.mkdir(path.dirname(outPath), { recursive: true })

  return new Promise((resolve, reject) => {
    const output = createWriteStream(outPath)
    const archive = archiver('zip', { zlib: { level: 6 } })

    output.on('close', () => resolve({ filePath: outPath, bytes: archive.pointer(), manifest }))
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    archive.append(JSON.stringify(manifest, null, 2), { name: MANIFEST_NAME })
    archive.file(payloadPath, { name: IDENTITY_PAYLOAD_NAME })
    archive.finalize().catch(reject)
  })
}

async function encryptFile (inputPath, outputPath, key, iv) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  await pipeline(createReadStream(inputPath), cipher, createWriteStream(outputPath))
  return cipher.getAuthTag()
}

async function decryptFile (inputPath, outputPath, key, iv, authTag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  await pipeline(createReadStream(inputPath), decipher, createWriteStream(outputPath))
}

function transferBody (transfer) {
  return {
    version: transfer.version,
    identityId: transfer.identityId,
    sourceSigningPublicKey: transfer.sourceSigningPublicKey,
    sourceEncryptionPublicKey: transfer.sourceEncryptionPublicKey,
    targetDeviceType: transfer.targetDeviceType,
    targetEncryptionPublicKey: transfer.targetEncryptionPublicKey,
    channel: transfer.channel,
    nonce: transfer.nonce,
    issuedAt: transfer.issuedAt,
    expiresAt: transfer.expiresAt,
    encryptedKey: transfer.encryptedKey,
    iv: transfer.iv,
    authTag: transfer.authTag,
    payloadSha256: transfer.payloadSha256
  }
}

export function isIdentityTransferManifest (manifest) {
  return manifest && manifest.kind === IDENTITY_TRANSFER_KIND
}

export async function createPairingSession (userDataDir, deviceType) {
  const keys = await getDeviceKeys(userDataDir)
  const publicInfo = getPublicDeviceInfo(keys)
  const topic = toHex(crypto.randomBytes(32))
  return {
    deviceType: normalizeDeviceType(deviceType),
    signingPublicKey: publicInfo.signingPublicKey,
    encryptionPublicKey: publicInfo.encryptionPublicKey,
    topic
  }
}

export function encodePairingString (session) {
  return Buffer.from(JSON.stringify(session)).toString('base64')
}

export function decodePairingString (str) {
  return JSON.parse(Buffer.from(str, 'base64').toString('utf-8'))
}

function generateTOTP (secretHex) {
  const secret = Buffer.from(secretHex, 'hex')
  const time = Math.floor(Date.now() / 60000) // 1 minute window
  const timeBuffer = Buffer.alloc(8)
  timeBuffer.writeBigUInt64BE(BigInt(time))
  const hmac = crypto.createHmac('sha1', secret)
  hmac.update(timeBuffer)
  const hash = hmac.digest()
  const offset = hash[hash.length - 1] & 0xf
  const code = (hash.readUInt32BE(offset) & 0x7fffffff) % 1000000
  return String(code).padStart(6, '0')
}

export function deriveVerificationCode (transfer) {
  return generateTOTP(transfer.channel)
}

export function verifyOTP (token, transfer) {
  return generateTOTP(transfer.channel) === token
}

export function verifyIdentityTransferSignature (transfer) {
  const message = Buffer.from(canonicalJson(transferBody(transfer)))
  return hypercoreCrypto.verify(
    message,
    Buffer.from(transfer.signature, 'hex'),
    Buffer.from(transfer.sourceSigningPublicKey, 'hex')
  )
}

export async function createIdentityTransferZip (userDataDir, outPath, options = {}) {
  let targetKeyHex = options.targetEncryptionPublicKey
  let targetNonce = null

  if (targetKeyHex && targetKeyHex.startsWith('peersky-identity:')) {
    const withoutScheme = targetKeyHex.slice('peersky-identity:'.length)
    const [pathPart, queryPart] = withoutScheme.split('?')
    targetKeyHex = pathPart
    if (queryPart) {
      const params = new URLSearchParams(queryPart)
      targetNonce = params.get('nonce')
    }
  }

  const targetDeviceType = normalizeDeviceType(options.targetDeviceType)
  const targetEncryptionPublicKey = toHex(decodeEncryptionPublicKey(targetKeyHex))
  const expiresInMs = Number.isFinite(options.expiresInMs) ? options.expiresInMs : 10 * 60 * 1000
  const keys = await getDeviceKeys(userDataDir)
  const publicInfo = getPublicDeviceInfo(keys)
  const identityId = await computeIdentityId(userDataDir)
  const registryPath = path.join(userDataDir, DEVICE_REGISTRY_FILE)
  let previousRegistry = null
  let hadRegistry = true

  try {
    previousRegistry = await fs.readFile(registryPath)
  } catch (error) {
    if (error.code === 'ENOENT') {
      hadRegistry = false
    } else {
      throw error
    }
  }

  await reserveDeviceSlot(userDataDir, keys, identityId, targetDeviceType, targetEncryptionPublicKey)

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'peersky-identity-transfer-'))
  let created = false
  try {
    const innerZip = path.join(tempDir, 'identity.zip')
    const payloadPath = path.join(tempDir, IDENTITY_PAYLOAD_NAME)
    await createBackupZip(userDataDir, innerZip, {
      peerskyVersion: options.peerskyVersion || '',
      isIdentityTransfer: true,
      targetDeviceType
    })

    const contentKey = crypto.randomBytes(32)
    const iv = crypto.randomBytes(12)
    const authTag = await encryptFile(innerZip, payloadPath, contentKey, iv)
    const encryptedKey = hypercoreCrypto.encrypt(contentKey, Buffer.from(targetEncryptionPublicKey, 'hex'))

    const issuedAt = Date.now()
    const transfer = {
      version: 1,
      identityId,
      sourceSigningPublicKey: publicInfo.signingPublicKey,
      sourceEncryptionPublicKey: publicInfo.encryptionPublicKey,
      targetDeviceType,
      targetEncryptionPublicKey,
      channel: toHex(crypto.randomBytes(32)),
      nonce: targetNonce || toHex(crypto.randomBytes(16)),
      issuedAt,
      expiresAt: issuedAt + expiresInMs,
      encryptedKey: toHex(encryptedKey),
      iv: toHex(iv),
      authTag: toHex(authTag),
      payloadSha256: await sha256File(payloadPath)
    }
    const signature = toHex(hypercoreCrypto.sign(Buffer.from(canonicalJson(transferBody(transfer))), keys.signing.secretKey))
    const signedTransfer = { ...transfer, signature }
    const manifest = {
      version: BACKUP_VERSION,
      kind: IDENTITY_TRANSFER_KIND,
      peerskyVersion: options.peerskyVersion || '',
      createdAt: new Date().toISOString(),
      identityTransfer: signedTransfer
    }

    const result = await writeWrapperZip(outPath, manifest, payloadPath)
    created = true

    return result
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    if (!created) {
      if (hadRegistry) {
        await fs.writeFile(registryPath, previousRegistry).catch(() => {})
      } else {
        await fs.rm(registryPath, { force: true }).catch(() => {})
      }
    }
  }
}

export async function decryptIdentityTransferZip (userDataDir, extractedDir, manifest, outZipPath) {
  if (!isIdentityTransferManifest(manifest)) {
    throw new Error('Backup is not an identity transfer')
  }

  const transfer = manifest.identityTransfer
  if (!transfer || typeof transfer !== 'object') {
    throw new Error('Identity transfer metadata is missing')
  }
  if (Date.now() > transfer.expiresAt) {
    throw new Error('Identity transfer has expired')
  }
  if (!verifyIdentityTransferSignature(transfer)) {
    throw new Error('Identity transfer signature is invalid')
  }

  const keys = await getDeviceKeys(userDataDir)
  const publicInfo = getPublicDeviceInfo(keys)
  if (transfer.targetEncryptionPublicKey !== publicInfo.encryptionPublicKey) {
    throw new Error('Identity transfer is encrypted for a different device')
  }

  await assertIdentityImportAllowed(userDataDir, transfer)

  const payloadPath = path.join(extractedDir, IDENTITY_PAYLOAD_NAME)
  const actualHash = await sha256File(payloadPath)
  if (actualHash !== transfer.payloadSha256) {
    throw new Error('Identity transfer payload checksum mismatch')
  }

  const contentKey = hypercoreCrypto.decrypt(Buffer.from(transfer.encryptedKey, 'hex'), keys.encryption)
  if (!contentKey) {
    throw new Error('Could not decrypt identity transfer key')
  }

  await decryptFile(
    payloadPath,
    outZipPath,
    contentKey,
    Buffer.from(transfer.iv, 'hex'),
    Buffer.from(transfer.authTag, 'hex')
  )

  return {
    transfer,
    verificationCode: deriveVerificationCode(transfer)
  }
}

export async function extractAndVerifyIdentityPayload (zipPath, destDir) {
  await extractBackupZip(zipPath, destDir)
  const manifest = await readManifest(zipPath)
  await verifyManifest(destDir, manifest)
  return manifest
}
