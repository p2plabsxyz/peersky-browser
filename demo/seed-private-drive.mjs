import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import { execSync } from 'child_process'
import { create as createSDK } from 'hyper-sdk'
import { openPrivateDriveByName } from '../src/protocols/private-hyperdrive.js'
import { rememberPrivateHyperdrive } from '../src/protocols/private-hyperdrive-registry.js'

const driveName = process.argv[2] || 'demo'
const userDataDir = process.argv[3] || path.join(os.homedir(), 'Library', 'Application Support', 'peersky-browser')

try {
  const procs = execSync('pgrep -fl "Peersky Browser" || true').toString()
  if (procs.trim()) {
    console.error(`Aborting: the app looks like it is running (${procs.trim().split('\n')[0]})`)
    console.error('Close the app first, then re-run this script.')
    process.exit(1)
  }
} catch {}

await fs.mkdir(userDataDir, { recursive: true })
const sdk = await createSDK({ storage: path.join(userDataDir, 'hyper-private'), autoJoin: true, doReplicate: true })
const drive = await openPrivateDriveByName(sdk, driveName, { userDataDir, autoJoin: true })
await drive.put('/hello.txt', Buffer.from(`Hello from the encrypted private drive '${driveName}'! Created for the identity-transfer demo.\n`))
await drive.put('/notes.json', Buffer.from(JSON.stringify({ demo: true, created: new Date().toISOString(), encrypted: true }, null, 2)))
await rememberPrivateHyperdrive(userDataDir, { name: driveName, url: drive.url, timestamp: Date.now(), encrypted: true })
console.log('Encrypted private drive ready in the app profile:')
console.log('  url     :', drive.url)
console.log('  data dir:', userDataDir)
await sdk.close()
