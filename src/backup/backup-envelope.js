import crypto from 'crypto'
import { MANIFEST_NAME, readManifest } from './backup-core.js'
import {
  ENCRYPTED_BACKUP_PAYLOAD,
  isEncryptedBackupManifest,
  validateEncryptedBackupManifest
} from './encrypted-backup.js'
import {
  IDENTITY_PAYLOAD_NAME,
  isIdentityTransferManifest,
  validateIdentityTransferManifest
} from './identity-transfer.js'

async function hashEntry (entry) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of entry.stream()) hash.update(chunk)
  return hash.digest('hex')
}

export async function validateUploadEnvelope (zipPath) {
  const manifest = await readManifest(zipPath)
  let payloadName
  let payloadSha256

  if (isEncryptedBackupManifest(manifest)) {
    validateEncryptedBackupManifest(manifest)
    payloadName = ENCRYPTED_BACKUP_PAYLOAD
    payloadSha256 = manifest.payloadSha256
  } else if (isIdentityTransferManifest(manifest)) {
    validateIdentityTransferManifest(manifest)
    payloadName = IDENTITY_PAYLOAD_NAME
    payloadSha256 = manifest.identityTransfer.payloadSha256
  } else {
    throw new Error('Refusing to publish an unencrypted backup')
  }

  const unzipper = await import('unzipper')
  const directory = await unzipper.Open.file(zipPath)
  const files = directory.files.filter((entry) => entry.type !== 'Directory')
  const allowedNames = new Set([MANIFEST_NAME, payloadName])
  if (files.length !== allowedNames.size || files.some((entry) => !allowedNames.has(entry.path))) {
    throw new Error('Backup upload envelope contains unexpected files')
  }

  const payload = files.find((entry) => entry.path === payloadName)
  if (!payload || await hashEntry(payload) !== payloadSha256) {
    throw new Error('Backup upload payload checksum mismatch')
  }

  return manifest
}
