import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import { create as createSDK } from 'hyper-sdk'
import hypercoreCrypto from 'hypercore-crypto'
import { openPrivateDriveByName } from '../src/protocols/private-hyperdrive.js'
import { rememberPrivateHyperdrive } from '../src/protocols/private-hyperdrive-registry.js'
import { getPrivateDriveKey } from '../src/backup/private-drive-key.js'
import { createIdentityTransferZip, decryptIdentityTransferZip, extractAndVerifyIdentityPayload, isIdentityTransferManifest } from '../src/backup/identity-transfer.js'
import { extractBackupZip, readManifest } from '../src/backup/backup-core.js'

const freeze = process.argv[2] === 'freeze'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-adopt-repro-'))
const profileDir = path.join(root, 'profile')
await fs.mkdir(profileDir, { recursive: true })

const sdk = await createSDK({ storage: path.join(profileDir, 'hyper-private'), autoJoin: true, doReplicate: true })
const drive = await openPrivateDriveByName(sdk, 'demo', { userDataDir: profileDir, autoJoin: true })
await drive.put('/hello.txt', Buffer.from('Hello phone! content-repro ' + Date.now() + '\n'))
await rememberPrivateHyperdrive(profileDir, { name: 'demo', url: drive.url, timestamp: Date.now(), encrypted: true })
if (freeze) await sdk.close()

const targetKeys = hypercoreCrypto.encryptionKeyPair()
const targetSigning = hypercoreCrypto.keyPair()
const pairing = `peersky-identity:${Buffer.from(targetKeys.publicKey).toString('hex')}?nonce=${Buffer.from(hypercoreCrypto.randomBytes(16)).toString('hex')}&deviceType=mobile`
const zipPath = path.join(root, 'transfer.zip')
await createIdentityTransferZip(profileDir, zipPath, { targetPairingPayload: pairing, peerskyVersion: 'repro', expiresInMs: 10 * 60 * 1000, includePrivate: true })
console.log(`${freeze ? 'FROZEN' : 'LIVE '} store -> zip built; url ${drive.url}`)

const payloadDir = path.join(root, 'payload')
await fs.mkdir(payloadDir, { recursive: true })
await extractBackupZip(zipPath, payloadDir)
const outerManifest = await readManifest(zipPath)
if (!isIdentityTransferManifest(outerManifest)) throw new Error('not identity manifest')

const receiverDir = path.join(root, 'receiver')
await fs.mkdir(receiverDir, { recursive: true })
await fs.writeFile(path.join(receiverDir, 'device-key.json'), JSON.stringify({
  version: 1,
  createdAt: new Date().toISOString(),
  signing: { publicKey: targetSigning.publicKey.toString('hex'), secretKey: targetSigning.secretKey.toString('hex') },
  encryption: { publicKey: targetKeys.publicKey.toString('hex'), secretKey: targetKeys.secretKey.toString('hex') }
}))
const innerZip = path.join(root, 'inner.zip')
await decryptIdentityTransferZip(receiverDir, payloadDir, outerManifest, innerZip)
const innerDir = path.join(root, 'inner')
await fs.mkdir(innerDir, { recursive: true })
await extractAndVerifyIdentityPayload(innerZip, innerDir)
console.log('  inner files:', (await fs.readdir(innerDir)).join(', '))

const adoptedSdk = await createSDK({
  storage: path.join(innerDir, 'hyper-private'),
  autoJoin: false,
  doReplicate: false,
  corestoreOpts: { allowBackup: true }
})
const key = await getPrivateDriveKey(innerDir)
console.log('  shipped key:', key?.toString('hex').slice(0, 8) + '…')
const driveIdHex = Buffer.from(drive.key).toString('hex')
const Hyperdrive = (await import('hyperdrive')).default
const adoptedDrive = new Hyperdrive(adoptedSdk.corestore, Buffer.from(driveIdHex, 'hex'), { encryptionKey: key })
await adoptedDrive.ready()
const names = []
try {
  for await (const c of await adoptedDrive.readdir('/')) names.push(c)
} catch (e) { console.log('  readdir error:', e.message) }
console.log('  listing:', JSON.stringify(names))
if (names.includes('hello.txt')) {
  const entry = await adoptedDrive.get('/hello.txt')
  let buf = null
  try { buf = await entry; if (buf && buf.value) buf = buf.value.buffer || buf.value } catch (e) {}
  console.log('  hello.txt bytes:', buf ? JSON.stringify(buf.toString()) : '(none)')
}
process.exit(0)
