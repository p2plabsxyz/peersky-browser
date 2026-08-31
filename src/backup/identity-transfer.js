import { promises as fs, createReadStream, createWriteStream } from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import archiver from 'archiver'
import hypercoreCrypto from 'hypercore-crypto'
import { BACKUP_VERSION, MANIFEST_NAME, createBackupZip, extractBackupZip, readManifest, verifyManifest } from './backup-core.js'
import { decryptFile, encryptFile } from './crypto-file.js'
import { decodeEncryptionPublicKey, getDeviceKeys, getPublicDeviceInfo } from './device-keys.js'
import { canonicalJson, computeIdentityId, normalizeDeviceType } from './identity-metadata.js'

export const IDENTITY_TRANSFER_KIND = 'peersky-identity-transfer'
export const IDENTITY_PAYLOAD_NAME = 'identity-payload.bin'
const MAX_TRANSFER_TTL_MS = 15 * 60 * 1000

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
  const tempPath = outPath + '.tmp'
  const output = createWriteStream(tempPath)
  const archive = archiver('zip', { zlib: { level: 6 } })
  const completed = new Promise((resolve, reject) => {
    output.on('close', resolve)
    output.on('error', reject)
    archive.on('error', reject)
  })

  archive.pipe(output)
  archive.append(JSON.stringify(manifest, null, 2), { name: MANIFEST_NAME })
  archive.file(payloadPath, { name: IDENTITY_PAYLOAD_NAME })

  try {
    await archive.finalize()
    await completed
    await fs.rename(tempPath, outPath)
    return { filePath: outPath, bytes: archive.pointer(), manifest }
  } catch (error) {
    archive.abort()
    output.destroy()
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
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
  return {
    deviceType: normalizeDeviceType(deviceType),
    signingPublicKey: publicInfo.signingPublicKey,
    encryptionPublicKey: publicInfo.encryptionPublicKey,
    nonce: toHex(crypto.randomBytes(16))
  }
}

export function encodePairingString (session) {
  const params = new URLSearchParams({
    deviceType: normalizeDeviceType(session.deviceType),
    nonce: session.nonce
  })
  return `peersky-identity:${session.encryptionPublicKey}?${params}`
}

export function decodePairingString (str) {
  if (typeof str !== 'string' || !str.startsWith('peersky-identity:')) {
    throw new Error('Use the device pairing code shown by the receiving device')
  }
  const withoutScheme = str.slice('peersky-identity:'.length)
  const [encryptionPublicKey, query = ''] = withoutScheme.split('?')
  const params = new URLSearchParams(query)
  const nonce = params.get('nonce')

  if (!nonce || !/^[0-9a-f]{32}$/i.test(nonce)) {
    throw new Error('Pairing payload has an invalid nonce')
  }
  return {
    deviceType: normalizeDeviceType(params.get('deviceType')),
    encryptionPublicKey: toHex(decodeEncryptionPublicKey(encryptionPublicKey)),
    nonce: nonce.toLowerCase()
  }
}

export function deriveVerificationCode (transfer) {
  if (!/^[0-9a-f]{64}$/i.test(transfer.sourceSigningPublicKey) ||
      !/^[0-9a-f]{64}$/i.test(transfer.targetEncryptionPublicKey) ||
      !/^[0-9a-f]{32}$/i.test(transfer.nonce)) {
    throw new Error('Identity transfer has invalid verification fields')
  }
  const input = Buffer.concat([
    Buffer.from(transfer.sourceSigningPublicKey, 'hex'),
    Buffer.from(transfer.targetEncryptionPublicKey, 'hex'),
    Buffer.from(transfer.nonce, 'hex')
  ])
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 6).toUpperCase()
}

export function verifyOTP (token, transfer) {
  return deriveVerificationCode(transfer) === token
}

export function verifyIdentityTransferSignature (transfer) {
  try {
    const message = Buffer.from(canonicalJson(transferBody(transfer)))
    return hypercoreCrypto.verify(
      message,
      Buffer.from(transfer.signature, 'hex'),
      Buffer.from(transfer.sourceSigningPublicKey, 'hex')
    )
  } catch {
    return false
  }
}

export function validateIdentityTransferManifest (manifest) {
  if (!isIdentityTransferManifest(manifest) || manifest.version !== BACKUP_VERSION) {
    throw new Error('Invalid identity transfer manifest')
  }

  const transfer = manifest.identityTransfer
  if (!transfer || transfer.version !== 1 ||
      !/^[0-9a-f]{64}$/i.test(transfer.identityId || '') ||
      !/^[0-9a-f]{64}$/i.test(transfer.sourceEncryptionPublicKey || '') ||
      !/^[0-9a-f]{64}$/i.test(transfer.channel || '') ||
      !/^[0-9a-f]{160}$/i.test(transfer.encryptedKey || '') ||
      !/^[0-9a-f]{24}$/i.test(transfer.iv || '') ||
      !/^[0-9a-f]{32}$/i.test(transfer.authTag || '') ||
      !/^[0-9a-f]{64}$/i.test(transfer.payloadSha256 || '') ||
      !/^[0-9a-f]{128}$/i.test(transfer.signature || '')) {
    throw new Error('Identity transfer encryption metadata is invalid')
  }
  if (typeof transfer.issuedAt !== 'number' || typeof transfer.expiresAt !== 'number' ||
      transfer.expiresAt <= transfer.issuedAt ||
      transfer.expiresAt - transfer.issuedAt > MAX_TRANSFER_TTL_MS) {
    throw new Error('Identity transfer timestamps are invalid')
  }
  normalizeDeviceType(transfer.targetDeviceType)
  deriveVerificationCode(transfer)
  if (!verifyIdentityTransferSignature(transfer)) {
    throw new Error('Identity transfer signature is invalid')
  }
  return true
}

export async function createIdentityTransferZip (userDataDir, outPath, options = {}) {
  const pairing = decodePairingString(options.targetPairingPayload || options.targetEncryptionPublicKey)
  const targetDeviceType = pairing.deviceType
  const targetEncryptionPublicKey = pairing.encryptionPublicKey
  const expiresInMs = Number.isFinite(options.expiresInMs) ? options.expiresInMs : 10 * 60 * 1000
  if (expiresInMs <= 0 || expiresInMs > MAX_TRANSFER_TTL_MS) {
    throw new Error('Identity transfer expiry must be between 1 ms and 15 minutes')
  }
  const keys = await getDeviceKeys(userDataDir)
  const publicInfo = getPublicDeviceInfo(keys)
  const identityId = await computeIdentityId(userDataDir)

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'peersky-identity-transfer-'))
  try {
    const innerZip = path.join(tempDir, 'identity.zip')
    const payloadPath = path.join(tempDir, IDENTITY_PAYLOAD_NAME)
    await createBackupZip(userDataDir, innerZip, {
      peerskyVersion: options.peerskyVersion || '',
      isIdentityTransfer: true,
      targetDeviceType,
      includePrivate: options.includePrivate !== false
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
      nonce: pairing.nonce,
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
    result.verificationCode = deriveVerificationCode(transfer)
    return result
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
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
  if (typeof transfer.issuedAt !== 'number' || typeof transfer.expiresAt !== 'number') {
    throw new Error('Identity transfer is missing timestamps')
  }
  const now = Date.now()
  if (now > transfer.expiresAt) {
    throw new Error('Identity transfer has expired')
  }
  if (now < transfer.issuedAt - 60000) {
    throw new Error('Identity transfer is issued in the future')
  }
  if (transfer.expiresAt - transfer.issuedAt > MAX_TRANSFER_TTL_MS) {
    throw new Error('Identity transfer TTL exceeds maximum allowed duration')
  }
  normalizeDeviceType(transfer.targetDeviceType)
  if (!verifyIdentityTransferSignature(transfer)) {
    throw new Error('Identity transfer signature is invalid')
  }

  const keys = await getDeviceKeys(userDataDir)
  const publicInfo = getPublicDeviceInfo(keys)
  if (transfer.targetEncryptionPublicKey !== publicInfo.encryptionPublicKey) {
    throw new Error('Identity transfer is encrypted for a different device')
  }

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
