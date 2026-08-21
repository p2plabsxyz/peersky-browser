import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises'

import { extractBackupZip, readManifest } from '../../src/backup/backup-core.js'
import {
  createEncryptedBackupZip,
  decryptEncryptedBackupZip,
  isEncryptedBackupManifest
} from '../../src/backup/encrypted-backup.js'
import { extractAndVerifyIdentityPayload } from '../../src/backup/identity-transfer.js'

async function makeTempDir (prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

describe('encrypted-backup', function () {
  this.timeout(30000)

  it('encrypts a full backup with a passphrase and restores it', async function () {
    const source = await makeTempDir('peersky-encrypted-src-')
    await writeFile(path.join(source, 'tabs.json'), '{"tabs":["peersky://home"]}')
    await mkdir(path.join(source, 'hyper', 'db'), { recursive: true })
    await writeFile(path.join(source, 'hyper', 'db', 'corestore-secret'), 'HYPER_PRIVATE_KEY_BYTES')
    const outPath = path.join(await makeTempDir('peersky-encrypted-out-'), 'backup.zip')

    await createEncryptedBackupZip(source, outPath, {
      passphrase: 'correct horse battery staple'
    })
    const manifest = await readManifest(outPath)
    expect(isEncryptedBackupManifest(manifest)).to.equal(true)
    expect(manifest.files).to.equal(undefined)
    expect((await readFile(outPath)).includes(Buffer.from('HYPER_PRIVATE_KEY_BYTES'))).to.equal(false)

    const wrapperDir = await makeTempDir('peersky-encrypted-wrapper-')
    await extractBackupZip(outPath, wrapperDir)
    const innerZip = path.join(await makeTempDir('peersky-encrypted-inner-'), 'inner.zip')
    await decryptEncryptedBackupZip(wrapperDir, manifest, innerZip, 'correct horse battery staple')

    const restoredDir = await makeTempDir('peersky-encrypted-restored-')
    const innerManifest = await extractAndVerifyIdentityPayload(innerZip, restoredDir)
    expect(innerManifest.files).to.have.property('tabs.json')
    expect(innerManifest.files).to.have.property('hyper')
    expect(innerManifest.files).to.have.property('peersky-identity.json')
    expect(await readFile(path.join(restoredDir, 'hyper', 'db', 'corestore-secret'), 'utf-8')).to.equal('HYPER_PRIVATE_KEY_BYTES')
  })

  it('rejects an incorrect passphrase', async function () {
    const source = await makeTempDir('peersky-encrypted-wrong-src-')
    await writeFile(path.join(source, 'tabs.json'), '{}')
    const outPath = path.join(await makeTempDir('peersky-encrypted-wrong-out-'), 'backup.zip')
    await createEncryptedBackupZip(source, outPath, { passphrase: 'a sufficiently long passphrase' })
    const manifest = await readManifest(outPath)
    const wrapperDir = await makeTempDir('peersky-encrypted-wrong-wrapper-')
    await extractBackupZip(outPath, wrapperDir)

    let error
    try {
      await decryptEncryptedBackupZip(wrapperDir, manifest, path.join(wrapperDir, 'inner.zip'), 'wrong passphrase')
    } catch (caught) {
      error = caught
    }
    expect(error?.message).to.match(/incorrect|damaged/i)
  })
})
