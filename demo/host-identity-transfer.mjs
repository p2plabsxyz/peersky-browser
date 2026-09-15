import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import { create as createSDK } from 'hyper-sdk'
import makeHyperFetch from 'hypercore-fetch'
import HyperDHTmDNS from '@p2plabs/hyperdht-mdns'
import { openPrivateDriveByName } from '../src/protocols/private-hyperdrive.js'
import { rememberPrivateHyperdrive } from '../src/protocols/private-hyperdrive-registry.js'
import { createIdentityTransferZip } from '../src/backup/identity-transfer.js'
import { _hyperPublishFile } from '../src/backup/hyper-backup.js'

const pairingCode = process.argv[2]
const driveName = process.argv[3] || 'demo'
const userDataDir = process.argv[4] || path.join(os.homedir(), 'Library', 'Application Support', 'peersky-browser')

if (!pairingCode || !pairingCode.trim().startsWith('peersky-identity:')) {
  console.error('Usage: node demo/host-identity-transfer.mjs "<peersky-identity:...code>...> [driveName] [userDataDir]')
  process.exit(1)
}

await fs.mkdir(userDataDir, { recursive: true })

const sdk = await createSDK({ storage: path.join(userDataDir, 'hyper-private'), autoJoin: true, doReplicate: true })
const lan = await HyperDHTmDNS.attachHyperSDK(sdk, {})
console.log(`[LAN] ${lan.host}:${lan.port}`)

let drive = null
try {
  const { listPrivateHyperdrives } = await import('../src/protocols/private-hyperdrive-registry.js')
  const existing = await listPrivateHyperdrives(userDataDir).catch(() => [])
  drive = existing.find((e) => e.name === driveName)
  if (drive) {
    console.log(`Existing encrypted drive '${driveName}' found:`, drive.url)
  }
} catch {}
if (!drive) {
  drive = await openPrivateDriveByName(sdk, driveName, { userDataDir, autoJoin: true })
  await drive.put('/hello.txt', Buffer.from(`Hello from the encrypted private drive '${driveName}'! Sealed for your phone.\n`))
  await drive.put('/notes.json', Buffer.from(JSON.stringify({ demo: true, created: new Date().toISOString(), encrypted: true }, null, 2)))
  await rememberPrivateHyperdrive(userDataDir, { name: driveName, url: drive.url, timestamp: Date.now(), encrypted: true })
  console.log('Encrypted drive created:', drive.url)
}

const transferZip = path.join(os.tmpdir(), `psb-identity-transfer-${Date.now()}.zip`)
const transfer = await createIdentityTransferZip(userDataDir, transferZip, {
  targetPairingPayload: pairingCode,
  peerskyVersion: 'desktop-demo',
  expiresInMs: 10 * 60 * 1000,
  includePrivate: true
})
console.log('Identity-transfer zip built (sealed for the pairing code)')
console.log('Verification code (SAS)  :', transfer.verificationCode)

const publisherFetch = await makeHyperFetch({ sdk, writable: true })
const published = await _hyperPublishFile(publisherFetch, sdk, transferZip, 'identity-transfer.zip')
console.log('\nPHONE SCAN OR PASTE THIS ADDRESS:')
console.log(published.address)
console.log('\nKeeping the transfer served — paste the address on the phone now (no timeout in this window).')

await new Promise(() => {})
