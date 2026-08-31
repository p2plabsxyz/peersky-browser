import { promises as fs, createReadStream, createWriteStream } from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import archiver from 'archiver'
import { BACKUP_VERSION, MANIFEST_NAME, createBackupZip } from './backup-core.js'
import { decryptFile, deriveScryptKey, encryptFile } from './crypto-file.js'
import { computeIdentityId } from './identity-metadata.js'

export const ENCRYPTED_BACKUP_KIND = 'peersky-encrypted-backup'
export const ENCRYPTED_BACKUP_PAYLOAD = 'backup-payload.bin'

const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1 }

function sha256File (filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function validatePassphrase (passphrase, creating = false) {
  if (typeof passphrase !== 'string' || !passphrase) {
    throw new Error('Backup passphrase is required')
  }
  if (creating && passphrase.length < 12) {
    throw new Error('Backup passphrase must be at least 12 characters')
  }
}

function validateEncryptionMetadata (encryption) {
  if (!encryption || encryption.algorithm !== 'aes-256-gcm' || encryption.kdf !== 'scrypt') {
    throw new Error('Unsupported backup encryption')
  }
  const { N, r, p } = encryption
  if (!Number.isInteger(N) || N < 16384 || N > 1048576 || (N & (N - 1)) !== 0) {
    throw new Error('Invalid scrypt cost in backup')
  }
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) {
    throw new Error('Invalid scrypt parameters in backup')
  }
  if (!/^[0-9a-f]{32}$/i.test(encryption.salt) || !/^[0-9a-f]{24}$/i.test(encryption.iv) || !/^[0-9a-f]{32}$/i.test(encryption.authTag)) {
    throw new Error('Invalid backup encryption metadata')
  }
}

async function writeEncryptedWrapper (outPath, manifest, payloadPath) {
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
  archive.file(payloadPath, { name: ENCRYPTED_BACKUP_PAYLOAD })

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

export function isEncryptedBackupManifest (manifest) {
  return manifest && manifest.kind === ENCRYPTED_BACKUP_KIND
}

export function validateEncryptedBackupManifest (manifest) {
  if (!isEncryptedBackupManifest(manifest) || manifest.version !== BACKUP_VERSION) {
    throw new Error('Invalid encrypted backup manifest')
  }
  validateEncryptionMetadata(manifest.encryption)
  if (!/^[0-9a-f]{64}$/i.test(manifest.payloadSha256 || '')) {
    throw new Error('Encrypted backup payload hash is invalid')
  }
  if (!Array.isArray(manifest.contents) || manifest.contents.some((name) => typeof name !== 'string' || !name)) {
    throw new Error('Encrypted backup contents are invalid')
  }
  return true
}

export async function createEncryptedBackupZip (userDataDir, outPath, options = {}) {
  validatePassphrase(options.passphrase, true)
  await computeIdentityId(userDataDir)
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'peersky-encrypted-backup-'))

  try {
    const innerZip = path.join(tempDir, 'backup.zip')
    const payloadPath = path.join(tempDir, ENCRYPTED_BACKUP_PAYLOAD)
    const inner = await createBackupZip(userDataDir, innerZip, options)
    const salt = crypto.randomBytes(16)
    const iv = crypto.randomBytes(12)
    const key = await deriveScryptKey(options.passphrase, salt, SCRYPT_OPTIONS)
    const authTag = await encryptFile(innerZip, payloadPath, key, iv)
    key.fill(0)

    const manifest = {
      version: BACKUP_VERSION,
      kind: ENCRYPTED_BACKUP_KIND,
      peerskyVersion: options.peerskyVersion || '',
      createdAt: new Date().toISOString(),
      contents: Object.keys(inner.manifest.files),
      encryption: {
        algorithm: 'aes-256-gcm',
        kdf: 'scrypt',
        N: SCRYPT_OPTIONS.N,
        r: SCRYPT_OPTIONS.r,
        p: SCRYPT_OPTIONS.p,
        salt: salt.toString('hex'),
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex')
      },
      payloadSha256: await sha256File(payloadPath)
    }

    return await writeEncryptedWrapper(outPath, manifest, payloadPath)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function decryptEncryptedBackupZip (extractedDir, manifest, outZipPath, passphrase) {
  if (!isEncryptedBackupManifest(manifest)) {
    throw new Error('Backup is not a passphrase-encrypted backup')
  }
  validatePassphrase(passphrase)
  validateEncryptionMetadata(manifest.encryption)

  const payloadPath = path.join(extractedDir, ENCRYPTED_BACKUP_PAYLOAD)
  const actualHash = await sha256File(payloadPath)
  if (actualHash !== manifest.payloadSha256) {
    throw new Error('Encrypted backup payload checksum mismatch')
  }

  const encryption = manifest.encryption
  const key = await deriveScryptKey(
    passphrase,
    Buffer.from(encryption.salt, 'hex'),
    encryption
  )
  try {
    await decryptFile(
      payloadPath,
      outZipPath,
      key,
      Buffer.from(encryption.iv, 'hex'),
      Buffer.from(encryption.authTag, 'hex')
    )
  } catch (error) {
    await fs.rm(outZipPath, { force: true }).catch(() => {})
    if (error.code === 'ERR_OSSL_BAD_DECRYPT' || /authenticate/i.test(error.message)) {
      throw new Error('Backup passphrase is incorrect or the backup is damaged')
    }
    throw error
  } finally {
    key.fill(0)
  }
}
