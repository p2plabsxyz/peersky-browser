import { expect } from 'chai'
import { randomBytes } from 'crypto'
import { mkdirSync } from 'fs'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { create as createSDK } from 'hyper-sdk'
import createTestnet from 'hyperdht/testnet.js'
import Hyperdrive from 'hyperdrive'
import z32 from 'z32'
import { attachDeviceSync } from '../../src/protocols/device-sync.js'
import { readDeviceSyncState, resetDeviceSyncStateCache } from '../../src/protocols/device-sync-state.js'
import { startDesktopDeviceSync } from '../../src/protocols/desktop-device-sync.js'
import { makePrivateDriveFetcher } from '../../src/protocols/private-hyperdrive.js'
import { listPrivateHyperdrives, rememberPrivateHyperdrive } from '../../src/protocols/private-hyperdrive-registry.js'
import { isOwnedPrivateDrive } from '../../src/protocols/private-drive-ownership.js'

async function until (check, what, timeout = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

function state (directory) {
  resetDeviceSyncStateCache()
  return readDeviceSyncState(directory)
}

// A phone's side runs the same protocol (backend/hyper/device-sync.mjs in
// PeerSky Mobile); here it is played by this module, with a drive of its own
// under the profile's key.
describe('private sync with a linked phone', function () {
  this.timeout(120000)

  let root, testnet, desktopSdk, phoneSdk, desktopSync, phoneSync

  afterEach(async function () {
    await phoneSync?.close().catch(() => {})
    await desktopSync?.close().catch(() => {})
    await phoneSdk?.close().catch(() => {})
    await desktopSdk?.close().catch(() => {})
    await testnet?.destroy()
    if (root) await rm(root, { recursive: true, force: true })
    phoneSync = desktopSync = phoneSdk = desktopSdk = testnet = root = null
  })

  it('takes the phone\'s private files, keeps a copy, and lists its own to the phone', async function () {
    root = await mkdtemp(path.join(os.tmpdir(), 'peersky-desktop-sync-'))
    testnet = await createTestnet(3)
    const key = randomBytes(32)
    const userDataDir = path.join(root, 'profile')
    mkdirSync(userDataDir, { recursive: true })
    await writeFile(path.join(userDataDir, 'private-drive-key.json'), JSON.stringify({ version: 1, key: key.toString('hex') }))

    desktopSdk = await createSDK({ storage: path.join(root, 'hyper-private'), swarmOpts: { bootstrap: testnet.bootstrap }, autoJoin: true, doReplicate: true })
    const fetcher = makePrivateDriveFetcher(desktopSdk, userDataDir)
    const report = await fetcher.openByName('report.pdf')
    await rememberPrivateHyperdrive(userDataDir, { name: 'report.pdf', url: report.url, timestamp: Date.now(), encrypted: true })
    expect((await fetcher(`${report.url}report.pdf`, { method: 'PUT', body: Buffer.from('desktop report') })).status).to.equal(200)

    desktopSync = await startDesktopDeviceSync(desktopSdk, {
      userDataDir,
      openPrivateDrive: (url) => fetcher.openDrive(url),
      logger: { warn () {} }
    })
    expect(desktopSync).to.not.equal(null)

    phoneSdk = await createSDK({ storage: path.join(root, 'phone'), swarmOpts: { bootstrap: testnet.bootstrap }, autoJoin: false, doReplicate: true })
    const phoneDrive = new Hyperdrive(phoneSdk.corestore.namespace('hyperdrive-private'), null, { encryptionKey: key })
    await phoneDrive.ready()
    await phoneDrive.put('/hello.txt', Buffer.from('phone hello'))
    const opened = new Map()
    const phoneState = path.join(root, 'phone-documents')
    let metered = false
    phoneSync = attachDeviceSync(phoneSdk, {
      identityKey: key,
      stateDirectory: phoneState,
      device: 'phone',
      ownDrives: () => [{ id: phoneDrive.key.toString('hex') }],
      openDrive: async (id, driveKey) => {
        if (!opened.has(id)) {
          const drive = new Hyperdrive(phoneSdk.corestore.namespace(`linked-${id}`), Buffer.from(id, 'hex'), { encryptionKey: driveKey })
          opened.set(id, drive.ready().then(() => drive))
        }
        return opened.get(id)
      },
      isMetered: () => metered,
      logger: { warn () {} }
    })

    const phoneId = phoneDrive.key.toString('hex')
    const reportId = Buffer.from(report.key).toString('hex')
    const phoneHost = z32.encode(phoneDrive.key)

    await until(() => state(userDataDir).devices[0]?.type === 'phone', 'the desktop to meet the phone')
    await until(() => state(phoneState).devices[0]?.type === 'desktop', 'the phone to meet the desktop')

    // Taken the way Link Device takes a phone's drive: read-only, by name.
    const entries = await until(async () => {
      const listed = await listPrivateHyperdrives(userDataDir)
      return listed.find((entry) => entry.name === 'Private files from your phone') ? listed : null
    }, 'the phone drive in the registry')
    expect(entries.map((entry) => entry.name).sort()).to.deep.equal(['Private files from your phone', 'report.pdf'])
    expect(await isOwnedPrivateDrive(userDataDir, phoneId)).to.equal(false)
    expect(await isOwnedPrivateDrive(userDataDir, reportId)).to.equal(true)

    await until(() => state(phoneState).listings[reportId]?.items.some((item) => item.name === 'report.pdf'), 'the desktop file on the phone')
    await until(() => state(userDataDir).listings[phoneId]?.items.some((item) => item.name === 'hello.txt'), 'the phone file on the desktop')
    expect(await (await fetcher(`hyper://${phoneHost}/hello.txt`)).text()).to.equal('phone hello')

    // A new upload on the phone is listed and copied, unless on cellular.
    await phoneDrive.put('/photo.jpg', randomBytes(64 * 1024))
    const copy = await fetcher.openDrive(`hyper://${phoneHost}/`)
    await until(async () => await copy.has('/photo.jpg'), 'the desktop to copy the photo')
    metered = true
    phoneSync.announce()
    await new Promise((resolve) => setTimeout(resolve, 800))
    await phoneDrive.put('/video.mp4', randomBytes(256 * 1024))
    await until(() => state(userDataDir).listings[phoneId]?.items.some((item) => item.name === 'video.mp4'), 'the video in the list')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(await copy.has('/video.mp4')).to.equal(false)
    metered = false
    phoneSync.announce()
    await until(async () => await copy.has('/video.mp4'), 'the desktop to copy the video on Wi-Fi')

    // A new private drive here reaches the phone once announced.
    const notes = await fetcher.openByName('notes.txt')
    await rememberPrivateHyperdrive(userDataDir, { name: 'notes.txt', url: notes.url, timestamp: Date.now(), encrypted: true })
    await fetcher(`${notes.url}notes.txt`, { method: 'PUT', body: Buffer.from('desktop notes') })
    await desktopSync.drivesChanged()
    const notesId = Buffer.from(notes.key).toString('hex')
    await until(() => state(phoneState).listings[notesId]?.items.some((item) => item.name === 'notes.txt'), 'the new desktop drive on the phone')

    // With the phone gone, its files still open here.
    await phoneSync.close()
    phoneSync = null
    await phoneSdk.close()
    phoneSdk = null
    await until(() => desktopSync.online.size === 0, 'the desktop to see the phone go')
    const response = await fetcher(`hyper://${phoneHost}/photo.jpg`)
    expect(response.status).to.equal(200)
    expect((await response.arrayBuffer()).byteLength).to.equal(64 * 1024)
  })
})
