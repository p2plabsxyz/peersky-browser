import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'fs/promises'

import { getDeviceKeys, getPublicDeviceInfo } from '../../src/backup/device-keys.js'
import { validateUploadEnvelope } from '../../src/backup/backup-envelope.js'
import { computeIdentityId } from '../../src/backup/identity-metadata.js'
import {
  createIdentityTransferZip,
  decodePairingString,
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

function mobilePairingPayload (publicKey, nonce = '0123456789abcdef0123456789abcdef') {
  return `peersky-identity:${publicKey}?nonce=${nonce}&deviceType=mobile`
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
      targetPairingPayload: mobilePairingPayload(targetInfo.encryptionPublicKey),
      peerskyVersion: 'test'
    })

    expect(created.bytes).to.be.greaterThan(0)
    expect(created.manifest.kind).to.equal('peersky-identity-transfer')
    expect((await validateUploadEnvelope(outPath)).kind).to.equal('peersky-identity-transfer')

    const extracted = await makeTempDir('peersky-id-wrapper-')
    await extractBackupZip(outPath, extracted)
    const manifest = await readManifest(outPath)
    const innerZip = path.join(await makeTempDir('peersky-id-inner-'), 'inner.zip')
    const decrypted = await decryptIdentityTransferZip(target, extracted, manifest, innerZip)

    expect(decrypted.transfer.targetDeviceType).to.equal('mobile')
    expect(decrypted.verificationCode).to.equal(deriveVerificationCode(decrypted.transfer))

    const payloadDir = await makeTempDir('peersky-id-payload-')
    const innerManifest = await extractAndVerifyIdentityPayload(innerZip, payloadDir)
    expect(Object.keys(innerManifest.files)).to.include.members(['peersky-ports.json', 'peersky-identity.json'])

    const ports = JSON.parse(await readFile(path.join(payloadDir, 'peersky-ports.json'), 'utf-8'))
    expect(ports.room.seed).to.equal('secret')
  })

  it('derives the same verification code as PeerSky Mobile', function () {
    const transfer = {
      sourceSigningPublicKey: '11'.repeat(32),
      targetEncryptionPublicKey: '22'.repeat(32),
      nonce: '33'.repeat(16)
    }
    expect(deriveVerificationCode(transfer)).to.equal('BE0D93')
    expect(deriveVerificationCode(transfer)).to.match(/^[0-9A-F]{6}$/)
  })

  it('takes device type from the receiver pairing payload', function () {
    const payload = mobilePairingPayload('44'.repeat(32))
    expect(decodePairingString(payload)).to.deep.include({
      deviceType: 'mobile',
      encryptionPublicKey: '44'.repeat(32)
    })
    expect(() => decodePairingString(
      `peersky-identity:${'44'.repeat(32)}?nonce=${'55'.repeat(16)}`
    )).to.throw(/device type/i)
    expect(() => decodePairingString('44'.repeat(32))).to.throw(/device pairing code/i)
  })

  it('stores a stable random identity id', async function () {
    const source = await makeTempDir('peersky-id-stable-')
    const first = await computeIdentityId(source)
    const second = await computeIdentityId(source)
    expect(first).to.equal(second)
    expect(first).to.match(/^[0-9a-f]{64}$/)
  })

  it('does not apply a mobile-specific transfer size limit', async function () {
    const source = await makeTempDir('peersky-id-size-src-')
    const target = await makeTempDir('peersky-id-size-target-')
    await seedIdentityData(source)
    await writeFile(
      path.join(source, 'hyper', 'large-core'),
      Buffer.alloc(50 * 1024 * 1024 + 1)
    )
    const targetInfo = getPublicDeviceInfo(await getDeviceKeys(target))
    const outPath = path.join(await makeTempDir('peersky-id-size-out-'), 'identity.zip')

    const created = await createIdentityTransferZip(source, outPath, {
      targetPairingPayload: mobilePairingPayload(targetInfo.encryptionPublicKey)
    })

    expect(created.bytes).to.be.greaterThan(100)
    expect((await stat(outPath)).size).to.equal(created.bytes)
  })
})
