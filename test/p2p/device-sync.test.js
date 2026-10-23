import { expect } from 'chai'
import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import { mkdirSync } from 'fs'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { create as createSDK } from 'hyper-sdk'
import HyperDHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'
import HyperDHTmDNS from '@p2plabs/hyperdht-mdns'
import NoiseSecretStream from '@hyperswarm/secret-stream'
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

// On the local network, hyperdht-mdns 2 connects with a key made up for that
// network. A device's own key, which the list of devices goes by, is proven
// inside the channel, and only to another of the person's devices.
describe('private sync on the local network', function () {
  this.timeout(30000)

  let root
  const syncs = []

  beforeEach(async function () {
    root = await mkdtemp(path.join(os.tmpdir(), 'peersky-lan-sync-'))
  })

  afterEach(async function () {
    for (const sync of syncs.splice(0)) await sync.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })

  function lanDevice (name, identityKey, identityGate) {
    const swarm = new EventEmitter()
    // The store's network key: who this device is.
    swarm.keyPair = HyperDHT.keyPair()
    swarm.connections = new Set()
    const runtime = { swarm, join: () => ({ refresh: async () => {}, flushed: async () => true, destroy: async () => {} }) }
    const stateDirectory = path.join(root, name)
    mkdirSync(stateDirectory, { recursive: true })
    const sync = attachDeviceSync(runtime, {
      identityKey,
      stateDirectory,
      device: name === 'phone' ? 'phone' : 'desktop',
      openDrive: async () => null,
      ...(identityGate ? { identityGate } : {}),
      logger: { warn () {} }
    })
    syncs.push(sync)
    return { swarm, sync, id: swarm.keyPair.publicKey.toString('hex') }
  }

  // Two ends of a local network connection, each with a key of its own.
  async function connect (a, b) {
    const left = new NoiseSecretStream(true, null, { keyPair: HyperDHT.keyPair() })
    const right = new NoiseSecretStream(false, null, { keyPair: HyperDHT.keyPair() })
    left.rawStream.pipe(right.rawStream).pipe(left.rawStream)
    left.on('error', () => {})
    right.on('error', () => {})
    await Promise.all([left.opened, right.opened])
    a.swarm.emit('connection', left, { lan: true, ephemeral: true })
    b.swarm.emit('connection', right, { lan: true, ephemeral: true })
    return [left, right]
  }

  it('knows a device by the key it proved, not the connection key', async function () {
    const key = randomBytes(32)
    const proven = new Map()
    const gate = async (connection) => proven.get(connection) || null
    const desktop = lanDevice('desktop', key, gate)
    const phone = lanDevice('phone', key, gate)

    const left = new NoiseSecretStream(true, null, { keyPair: HyperDHT.keyPair() })
    const right = new NoiseSecretStream(false, null, { keyPair: HyperDHT.keyPair() })
    proven.set(left, { publicKey: phone.swarm.keyPair.publicKey, matches: [0] })
    proven.set(right, { publicKey: desktop.swarm.keyPair.publicKey, matches: [0] })
    left.rawStream.pipe(right.rawStream).pipe(left.rawStream)
    await Promise.all([left.opened, right.opened])
    desktop.swarm.emit('connection', left, { lan: true, ephemeral: true })
    phone.swarm.emit('connection', right, { lan: true, ephemeral: true })

    await until(() => desktop.sync.online.has(phone.id), 'the desktop to know the phone')
    await until(() => phone.sync.online.has(desktop.id), 'the phone to know the desktop')
    expect([...desktop.sync.online]).to.deep.equal([phone.id])
    expect(desktop.sync.online.has(left.remotePublicKey.toString('hex'))).to.equal(false)
  })

  it('does not talk on a local network connection nobody proved', async function () {
    const key = randomBytes(32)
    const gate = async () => null
    const desktop = lanDevice('desktop', key, gate)
    const phone = lanDevice('phone', key, gate)
    await connect(desktop, phone)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(desktop.sync.online.size).to.equal(0)
    expect(phone.sync.online.size).to.equal(0)
  })

  it('meets a device that finished proving first and opened sync before this side', async function () {
    if (typeof HyperDHTmDNS.identityGate !== 'function') this.skip()
    const key = randomBytes(32)
    const slow = (...args) => HyperDHTmDNS.identityGate(...args).then((result) => new Promise((resolve) => setTimeout(() => resolve(result), 300)))
    const desktop = lanDevice('desktop', key, HyperDHTmDNS.identityGate)
    const phone = lanDevice('phone', key, slow)
    await connect(desktop, phone)
    await until(() => desktop.sync.online.has(phone.id) && phone.sync.online.has(desktop.id), 'the two devices to know each other')
  })

  it('proves who it is only to the person\'s own devices', async function () {
    if (typeof HyperDHTmDNS.identityGate !== 'function') this.skip()
    const key = randomBytes(32)
    const results = []
    const gate = (...args) => HyperDHTmDNS.identityGate(...args).then((result) => {
      results.push(result)
      return result
    })
    const desktop = lanDevice('desktop', key, gate)
    const phone = lanDevice('phone', key, gate)
    const stranger = lanDevice('stranger', randomBytes(32), gate)

    await connect(desktop, phone)
    await until(() => desktop.sync.online.has(phone.id) && phone.sync.online.has(desktop.id), 'the two devices to know each other')

    const before = results.length
    await connect(stranger, desktop)
    await until(() => results.length === before + 2, 'both gates to finish')
    expect(results.slice(before)).to.deep.equal([null, null])
    expect(stranger.sync.online.size).to.equal(0)
    expect([...desktop.sync.online]).to.deep.equal([phone.id])
  })
})
