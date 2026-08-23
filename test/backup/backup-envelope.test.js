import { expect } from 'chai'
import { createWriteStream } from 'fs'
import { mkdtemp, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { finished } from 'stream/promises'
import archiver from 'archiver'

import { validateUploadEnvelope } from '../../src/backup/backup-envelope.js'
import { readManifest } from '../../src/backup/backup-core.js'
import { ENCRYPTED_BACKUP_PAYLOAD, createEncryptedBackupZip } from '../../src/backup/encrypted-backup.js'

async function makeTempDir (prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

async function writeWrapper (outPath, manifest, payload, extraEntry) {
  const output = createWriteStream(outPath)
  const archive = archiver('zip')
  archive.pipe(output)
  archive.append(JSON.stringify(manifest), { name: 'manifest.json' })
  archive.append(payload, { name: ENCRYPTED_BACKUP_PAYLOAD })
  if (extraEntry) archive.append('plaintext', { name: extraEntry })
  await archive.finalize()
  await finished(output)
}

async function createEncryptedFixture () {
  const source = await makeTempDir('peersky-envelope-src-')
  const outPath = path.join(await makeTempDir('peersky-envelope-out-'), 'backup.zip')
  await writeFile(path.join(source, 'tabs.json'), '{}')
  await createEncryptedBackupZip(source, outPath, {
    passphrase: 'correct horse battery staple'
  })
  return { manifest: await readManifest(outPath), outPath }
}

describe('backup upload envelope', function () {
  this.timeout(30000)

  it('accepts a complete passphrase-encrypted backup', async function () {
    const { outPath } = await createEncryptedFixture()
    const manifest = await validateUploadEnvelope(outPath)

    expect(manifest.kind).to.equal('peersky-encrypted-backup')
  })

  it('rejects plaintext files added beside the encrypted payload', async function () {
    const { manifest } = await createEncryptedFixture()
    const outPath = path.join(await makeTempDir('peersky-envelope-extra-'), 'backup.zip')
    await writeWrapper(outPath, manifest, Buffer.from('ciphertext'), 'hyper/db/corestore-secret')

    let error
    try {
      await validateUploadEnvelope(outPath)
    } catch (caught) {
      error = caught
    }
    expect(error?.message).to.match(/unexpected files/i)
  })

  it('rejects an encrypted payload that does not match its manifest', async function () {
    const { manifest } = await createEncryptedFixture()
    const outPath = path.join(await makeTempDir('peersky-envelope-hash-'), 'backup.zip')
    await writeWrapper(outPath, manifest, Buffer.from('not the encrypted payload'))

    let error
    try {
      await validateUploadEnvelope(outPath)
    } catch (caught) {
      error = caught
    }
    expect(error?.message).to.match(/checksum mismatch/i)
  })
})
