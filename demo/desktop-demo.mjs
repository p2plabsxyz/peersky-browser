import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { create as createSDK } from 'hyper-sdk'
import makeHyperFetch from 'hypercore-fetch'
import hypercoreCrypto from 'hypercore-crypto'
import HyperDHTmDNS from '@p2plabs/hyperdht-mdns'
import { createIdentityTransferZip, decryptIdentityTransferZip, extractAndVerifyIdentityPayload, isIdentityTransferManifest } from '../src/backup/identity-transfer.js'
import { getPrivateDriveKey } from '../src/backup/private-drive-key.js'
import { openPrivateDriveByName, makePrivateDriveFetcher } from '../src/protocols/private-hyperdrive.js'
import { rememberPrivateHyperdrive } from '../src/protocols/private-hyperdrive-registry.js'
import { _hyperPublishFile, _hyperFetchToFile } from '../src/backup/hyper-backup.js'
import { extractBackupZip, readManifest } from '../src/backup/backup-core.js'

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const run = promisify(execFile)

async function banner (title) {
  console.log('')
  console.log('='.repeat(72))
  console.log(`   ${title}`)
  console.log('='.repeat(72))
}

async function unzipListing (zipPath) {
  const { stdout } = await run('unzip', ['-l', zipPath])
  return stdout.trim()
}

// A stand-in "receiving device" (normally the phone from Settings -> Link Device).
const targetKeys = hypercoreCrypto.encryptionKeyPair()
const targetSigning = hypercoreCrypto.keyPair()
const targetPairing = `peersky-identity:${Buffer.from(targetKeys.publicKey).toString('hex')}?deviceType=mobile&nonce=${Buffer.from(hypercoreCrypto.randomBytes(16)).toString('hex')}`

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'peersky-desktop-demo-'))
const profileDir = path.join(root, 'profile')
await fs.mkdir(profileDir, { recursive: true })

await banner('1. Boot the announced, replicating private hyper-sdk (PR #223)')
let sdk = await createSDK({ storage: path.join(profileDir, 'hyper-private'), autoJoin: true, doReplicate: true })
console.log('   hyper-sdk private runtime: autoJoin=true, doReplicate=true (ciphertext-only on the DHT)')

await banner('2. Create an encrypted private drive and write files (~/hello.txt)')
let demoDrive = await openPrivateDriveByName(sdk, 'demo', { userDataDir: profileDir, autoJoin: true })
console.log('   drive url          :', demoDrive.url)
console.log('   private-drive-key.json =', JSON.parse(await fs.readFile(path.join(profileDir, 'private-drive-key.json'), 'utf8')))
await demoDrive.put('/hello.txt', Buffer.from('Hello from the encrypted private drive! Desktop -> adopted client.\n'))
await demoDrive.put('/notes.json', Buffer.from(JSON.stringify({ demo: true, 'PR #223': 'real 32-byte key shipped' }, null, 2)))
await rememberPrivateHyperdrive(profileDir, { name: 'demo', url: demoDrive.url, timestamp: Date.now(), encrypted: true })

await banner('3. Read the file back through the keyed private fetcher (same runtime the browser uses)')
let keyedFetch = makePrivateDriveFetcher(sdk, profileDir)
keyedFetch.register(new URL(demoDrive.url).hostname, demoDrive)
const readBack = await keyedFetch(demoDrive.url)
console.log('   GET', demoDrive.url, '-> status', readBack.status)
console.log('   body:', JSON.stringify(await readBack.text()))

await banner('4. Freeze the corestore, then build the identity-transfer zip (includePrivate=true)')
await sdk.close()
const transferZip = path.join(root, 'identity-transfer.zip')
const transfer = await createIdentityTransferZip(profileDir, transferZip, {
  targetPairingPayload: targetPairing,
  peerskyVersion: 'demo-desktop',
  expiresInMs: 10 * 60 * 1000,
  includePrivate: true
})
console.log('   verification code     :', transfer.verificationCode)
console.log('   inner zip contents:')
console.log((await unzipListing(transferZip)).split('\n').map((l) => '     ' + l).join('\n'))

console.log('\n   (the source device comes back online: the adopting client replicates from it, exactly like a real phone link)')
sdk = await createSDK({ storage: path.join(profileDir, 'hyper-private'), autoJoin: true, doReplicate: true })
demoDrive = await openPrivateDriveByName(sdk, 'demo', { userDataDir: profileDir, autoJoin: true })
keyedFetch = makePrivateDriveFetcher(sdk, profileDir)
keyedFetch.register(new URL(demoDrive.url).hostname, demoDrive)
const lan = await HyperDHTmDNS.attachHyperSDK(sdk, {})
console.log('   [LAN]', `${lan.host}:${lan.port}`, '| source drive back online:', demoDrive.url)

await banner('5. Publish the encrypted transfer to a hyper:// identity URL')
const publisherStorage = path.join(root, 'publisher')
await fs.mkdir(publisherStorage, { recursive: true })
const publisherSdk = await createSDK({ storage: publisherStorage })
try {
  await HyperDHTmDNS.attachHyperSDK(publisherSdk, { lan })
  console.log('   [LAN] sharing', `${lan.host}:${lan.port}`)
} catch (err) {
  console.log('   [LAN] unavailable:', err.message)
}
const publisherFetch = await makeHyperFetch({ sdk: publisherSdk, writable: true })
const published = await _hyperPublishFile(publisherFetch, publisherSdk, transferZip, 'identity-transfer.zip')
console.log('   identity URL          :', published.address)

await banner('6. A receiving device fetches it back over the DHT/LAN and verifies the hash')
const fetchDir = path.join(root, 'fetcher')
await fs.mkdir(fetchDir, { recursive: true })
const fetcherSdk = await createSDK({ storage: fetchDir })
const fetcherFetch = await makeHyperFetch({ sdk: fetcherSdk, writable: true })
const fetchedZip = path.join(root, 'fetched.zip')
await _hyperFetchToFile(fetcherFetch, async () => {}, published.address, fetchedZip, () => {})
const srcHash = sha256(await fs.readFile(transferZip))
const dstHash = sha256(await fs.readFile(fetchedZip))
console.log('   sha256 original:', srcHash)
console.log('   sha256 fetched :', dstHash)
console.log('   ' + (srcHash === dstHash ? 'MATCH -> transfer is intact end to end' : 'MISMATCH'))

await banner('7. Adopt on the receiving side: open hyper-private with the shipped key and read the file')
const receiverDir = path.join(root, 'receiver')
await fs.mkdir(receiverDir, { recursive: true })
await fs.writeFile(path.join(receiverDir, 'device-key.json'), JSON.stringify({
  version: 1,
  createdAt: new Date().toISOString(),
  signing: { publicKey: targetSigning.publicKey.toString('hex'), secretKey: targetSigning.secretKey.toString('hex') },
  encryption: { publicKey: targetKeys.publicKey.toString('hex'), secretKey: targetKeys.secretKey.toString('hex') }
}, null, 2))
const payloadDir = path.join(root, 'payload')
await fs.mkdir(payloadDir, { recursive: true })
await extractBackupZip(fetchedZip, payloadDir)
const outerManifest = await readManifest(fetchedZip)
if (!isIdentityTransferManifest(outerManifest)) throw new Error('Outer zip is not an identity-transfer envelope')
const innerZip = path.join(root, 'adopted-profile.zip')
await decryptIdentityTransferZip(receiverDir, payloadDir, outerManifest, innerZip)
const innerDir = path.join(root, 'payload-inner')
await fs.mkdir(innerDir, { recursive: true })
const manifest = await extractAndVerifyIdentityPayload(innerZip, innerDir)
console.log('   manifest kind:', manifest.kind, '| files:', Object.keys(manifest.files).filter((f) => f.includes('private') || f.includes('hyper')).join(', '))
const record = JSON.parse(await fs.readFile(path.join(innerDir, 'private-drive-key.json'), 'utf8'))
console.log('   shipped private-drive-key.json record:')
console.log('     ' + JSON.stringify({ version: record.version, encrypted: record.encrypted, announce: record.announce, key: record.key.slice(0, 8) + '…', entries: record.entries.map((e) => e.driveId.slice(0, 8) + '…') }))
const registry = JSON.parse(await fs.readFile(path.join(innerDir, 'privateHyperdrives.json'), 'utf8'))
console.log('   adopted registry:', JSON.stringify(registry.map((e) => ({ name: e.name, url: e.url })), null, 2))

await banner('8. Rebuild the private drive from the shipped key alone (the copied corestore is discarded)')
await fs.rm(path.join(innerDir, 'hyper-private'), { recursive: true, force: true })
const adoptedDir = path.join(root, 'adopted')
await fs.mkdir(adoptedDir, { recursive: true })
await fs.copyFile(path.join(innerDir, 'private-drive-key.json'), path.join(adoptedDir, 'private-drive-key.json'))
await fs.copyFile(path.join(innerDir, 'privateHyperdrives.json'), path.join(adoptedDir, 'privateHyperdrives.json'))
console.log('   shipped key + registry copied onto the adopting device; corestore rebuilt fresh')
const adoptedSdk = await createSDK({ storage: path.join(adoptedDir, 'hyper-private'), autoJoin: true, doReplicate: true })
await HyperDHTmDNS.attachHyperSDK(adoptedSdk, { lan })
console.log('   key loaded from shipped file (not the local store):', (await getPrivateDriveKey(adoptedDir))?.toString('hex').slice(0, 8) + '…')
const adoptedFetcher = makePrivateDriveFetcher(adoptedSdk, adoptedDir)
let adoptedRead = null
let adoptedText = ''
for (let attempt = 1; attempt <= 8; attempt++) {
  adoptedRead = await adoptedFetcher(demoDrive.url)
  adoptedText = await adoptedRead.text()
  if (adoptedText.includes('hello.txt')) break
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
console.log('   GET', demoDrive.url, '-> status', adoptedRead.status)
console.log('   file content:', JSON.stringify(adoptedText))
const adoptedFile = await adoptedFetcher(demoDrive.url + 'hello.txt')
console.log('   GET', demoDrive.url + 'hello.txt', '-> status', adoptedFile.status)
console.log('   hello.txt body:', JSON.stringify(await adoptedFile.text()))

await banner('DONE')
console.log('   identity URL available for the phone import step:')
console.log('   ' + published.address)

if (lan) await lan.destroy().catch(() => {})
await publisherSdk.close().catch(() => {})
await fetcherSdk.close().catch(() => {})
await adoptedSdk.close().catch(() => {})
process.exit(0)
