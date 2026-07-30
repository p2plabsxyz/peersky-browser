import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises'

import { getDeviceKeys, getPublicDeviceInfo } from '../../src/backup/device-keys.js'
import { loadDeviceRegistry } from '../../src/backup/device-registry.js'
import {
  createIdentityTransferZip,
  decryptIdentityTransferZip,
  deriveVerificationCode,
  extractAndVerifyIdentityPayload
} from '../../src/backup/identity-transfer.js'
import { extractBackupZip, readManifest } from '../../src/backup/backup-core.js'

async function makeTempDir (prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

async function seedIdentityData (dir) {
  await writeFile(path.join(dir, 'peersky-ports.json'), JSON.stringify({ room: { seed: 'secret' } }))
  await writeFile(path.join(dir, 'peersky-chat-rooms.json'), JSON.stringify({ rooms: ['room'] }))
  await mkdir(path.join(dir, 'hyper'), { recursive: true })
  await writeFile(path.join(dir, 'hyper', 'core'), 'core-data')
}

describe('identity-transfer', function () {
  this.timeout(20000)

  it('creates a local encrypted identity zip that only the target device can decrypt', async function () {
    const source = await makeTempDir('peersky-id-src-')
    const target = await makeTempDir('peersky-id-target-')
    await seedIdentityData(source)

    const targetKeys = await getDeviceKeys(target)
    const targetInfo = getPublicDeviceInfo(targetKeys)
    const outPath = path.join(await makeTempDir('peersky-id-out-'), 'identity.zip')

    const created = await createIdentityTransferZip(source, outPath, {
      targetDeviceType: 'mobile',
      targetEncryptionPublicKey: targetInfo.encryptionPublicKey,
      peerskyVersion: 'test'
    })

    expect(created.bytes).to.be.greaterThan(0)
    expect(created.manifest.kind).to.equal('peersky-identity-transfer')

    const extracted = await makeTempDir('peersky-id-wrapper-')
    await extractBackupZip(outPath, extracted)
    const manifest = await readManifest(outPath)
    const innerZip = path.join(await makeTempDir('peersky-id-inner-'), 'inner.zip')
    const decrypted = await decryptIdentityTransferZip(target, extracted, manifest, innerZip)

    expect(decrypted.transfer.targetDeviceType).to.equal('mobile')
    expect(decrypted.verificationCode).to.equal(deriveVerificationCode(decrypted.transfer))

    const payloadDir = await makeTempDir('peersky-id-payload-')
    const innerManifest = await extractAndVerifyIdentityPayload(innerZip, payloadDir)
    expect(Object.keys(innerManifest.files)).to.include.members(['peersky-ports.json', 'peersky-devices.json'])

    const ports = JSON.parse(await readFile(path.join(payloadDir, 'peersky-ports.json'), 'utf-8'))
    expect(ports.room.seed).to.equal('secret')
  })

  it('allows overwriting a device slot when generating a new transfer', async function () {
    const source = await makeTempDir('peersky-id-limit-src-')
    const targetA = await makeTempDir('peersky-id-limit-a-')
    const targetB = await makeTempDir('peersky-id-limit-b-')
    await seedIdentityData(source)

    const targetAInfo = getPublicDeviceInfo(await getDeviceKeys(targetA))
    const targetBInfo = getPublicDeviceInfo(await getDeviceKeys(targetB))

    await createIdentityTransferZip(source, path.join(await makeTempDir('peersky-id-limit-out-a-'), 'identity.zip'), {
      targetDeviceType: 'mobile',
      targetEncryptionPublicKey: targetAInfo.encryptionPublicKey
    })

    await createIdentityTransferZip(source, path.join(await makeTempDir('peersky-id-limit-out-b-'), 'identity.zip'), {
      targetDeviceType: 'mobile',
      targetEncryptionPublicKey: targetBInfo.encryptionPublicKey
    })

    const registry = await loadDeviceRegistry(source)
    const mobileDevices = registry.devices.mobile
    const lastDevice = Array.isArray(mobileDevices) ? mobileDevices[mobileDevices.length - 1] : mobileDevices
    expect(lastDevice.encryptionPublicKey).to.equal(targetBInfo.encryptionPublicKey)
  })
})
