import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import z32 from 'z32'
import {
  deviceSyncSnapshot,
  listOwnSyncDrives,
  startDesktopDeviceSync,
  takeLinkedDrive
} from '../../src/protocols/desktop-device-sync.js'
import { isPeerskyAppPage } from '../../src/backup/ipc-caller.js'
import { recordDeviceHello, recordDriveListing, resetDeviceSyncStateCache } from '../../src/protocols/device-sync-state.js'
import { listPrivateHyperdrives, rememberPrivateHyperdrive } from '../../src/protocols/private-hyperdrive-registry.js'
import { isOwnedPrivateDrive, setPrivateDriveOwnership } from '../../src/protocols/private-drive-ownership.js'
import { getPrivateDriveKeyFor } from '../../src/backup/private-drive-key.js'
import { PHONE_PRIVATE_DRIVE_NAME } from '../../src/backup/phone-sync.js'

const OWN = 'a1'.repeat(32)
const PLAIN = 'a2'.repeat(32)
const PHONE_DRIVE = 'b1'.repeat(32)
const PROFILE_KEY = 'c1'.repeat(32)

function urlOf (id) {
  return `hyper://${z32.encode(Buffer.from(id, 'hex'))}/`
}

async function profile () {
  resetDeviceSyncStateCache()
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'peersky-device-sync-'))
  await writeFile(path.join(userDataDir, 'private-drive-key.json'), JSON.stringify({ version: 1, key: PROFILE_KEY }))
  return userDataDir
}

describe('desktop device sync', function () {
  let userDataDir = null
  afterEach(async function () {
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true })
    userDataDir = null
  })

  it('lists only the encrypted private drives this desktop made', async function () {
    userDataDir = await profile()
    await rememberPrivateHyperdrive(userDataDir, { name: 'report.pdf', url: urlOf(OWN), timestamp: 3, encrypted: true })
    // A device-only drive from before encryption, and a phone's drive.
    await rememberPrivateHyperdrive(userDataDir, { name: 'old', url: urlOf(PLAIN), timestamp: 2, encrypted: false })
    await rememberPrivateHyperdrive(userDataDir, { name: PHONE_PRIVATE_DRIVE_NAME, url: urlOf(PHONE_DRIVE), timestamp: 1, encrypted: true })
    await setPrivateDriveOwnership(userDataDir, PHONE_DRIVE, false)
    expect(await listOwnSyncDrives(userDataDir)).to.deep.equal([{ id: OWN }])
  })

  it('takes a phone\'s drive read-only, under the name Link Device gives it, once', async function () {
    userDataDir = await profile()
    const identityKey = Buffer.from(PROFILE_KEY, 'hex')
    expect(await takeLinkedDrive(userDataDir, { id: PHONE_DRIVE, key: identityKey, identityKey, device: 'phone', now: 10 })).to.equal(true)
    expect(await takeLinkedDrive(userDataDir, { id: PHONE_DRIVE, key: identityKey, identityKey, device: 'phone', now: 20 })).to.equal(true)
    const entries = await listPrivateHyperdrives(userDataDir)
    expect(entries).to.deep.equal([{ name: PHONE_PRIVATE_DRIVE_NAME, url: urlOf(PHONE_DRIVE), timestamp: 10, encrypted: true }])
    expect(await isOwnedPrivateDrive(userDataDir, PHONE_DRIVE)).to.equal(false)
    // Under the profile's own key, no key of its own is kept for it.
    expect(await getPrivateDriveKeyFor(userDataDir, PHONE_DRIVE)).to.equal(null)
  })

  it('keeps the key of a drive made under another one, and names a desktop\'s drive as a linked device\'s', async function () {
    userDataDir = await profile()
    const identityKey = Buffer.from(PROFILE_KEY, 'hex')
    const ownKey = Buffer.from('d4'.repeat(32), 'hex')
    await takeLinkedDrive(userDataDir, { id: PHONE_DRIVE, key: ownKey, identityKey, device: 'desktop' })
    expect((await getPrivateDriveKeyFor(userDataDir, PHONE_DRIVE)).toString('hex')).to.equal('d4'.repeat(32))
    expect((await listPrivateHyperdrives(userDataDir))[0].name).to.equal('Private files from a linked device')
  })

  it('never takes over a drive this desktop made, whatever another device lists', async function () {
    userDataDir = await profile()
    await rememberPrivateHyperdrive(userDataDir, { name: 'mine', url: urlOf(OWN), timestamp: 1, encrypted: true })
    const before = await readFile(path.join(userDataDir, 'privateHyperdrives.json'), 'utf8')
    expect(await takeLinkedDrive(userDataDir, { id: OWN, key: Buffer.from(PROFILE_KEY, 'hex'), identityKey: Buffer.from(PROFILE_KEY, 'hex'), device: 'phone' })).to.equal(false)
    expect(await readFile(path.join(userDataDir, 'privateHyperdrives.json'), 'utf8')).to.equal(before)
    expect(await isOwnedPrivateDrive(userDataDir, OWN)).to.equal(true)
  })

  it('starts nothing for a profile without a private key, and hands the sync the profile\'s key', async function () {
    userDataDir = await mkdtemp(path.join(os.tmpdir(), 'peersky-device-sync-'))
    let attached = null
    const attach = (sdk, options) => {
      attached = options
      return { online: new Set(), announce () {}, refresh () {}, close: async () => {} }
    }
    expect(await startDesktopDeviceSync({}, { userDataDir, openPrivateDrive: async () => null, attach })).to.equal(null)
    expect(attached).to.equal(null)

    await writeFile(path.join(userDataDir, 'private-drive-key.json'), JSON.stringify({ version: 1, key: PROFILE_KEY }))
    await rememberPrivateHyperdrive(userDataDir, { name: 'mine', url: urlOf(OWN), timestamp: 1, encrypted: true })
    const sync = await startDesktopDeviceSync({}, { userDataDir, openPrivateDrive: async (url) => url, attach })
    expect(sync).to.not.equal(null)
    expect(attached.device).to.equal('desktop')
    expect(attached.mirror).to.equal(true)
    expect(attached.identityKey.toString('hex')).to.equal(PROFILE_KEY)
    expect(attached.ownDrives()).to.deep.equal([{ id: OWN }])
    // A phone's drive opens through the private store, after it is taken.
    expect(await attached.openDrive(PHONE_DRIVE, attached.identityKey, { device: 'phone' })).to.equal(urlOf(PHONE_DRIVE))
    // One of this desktop's own is never opened as someone else's.
    expect(await attached.openDrive(OWN, attached.identityKey, { device: 'phone' })).to.equal(null)
  })

  it('lists the devices met and their files, with links the private store reads', async function () {
    userDataDir = await profile()
    const phone = '7e'.repeat(32)
    recordDeviceHello(userDataDir, { id: phone, type: 'phone', drives: [PHONE_DRIVE], now: 5 })
    recordDriveListing(userDataDir, PHONE_DRIVE, {
      items: [
        { type: 'file', name: 'a, b?.jpg', path: '/a, b?.jpg', byteLength: 9 },
        { type: 'directory', name: 'Trip', path: '/Trip/' }
      ]
    })
    const snapshot = deviceSyncSnapshot(userDataDir, new Set([phone]))
    expect(snapshot.devices).to.deep.equal([{ id: phone, type: 'phone', online: true, firstSeen: 5, lastSeen: 5 }])
    const base = urlOf(PHONE_DRIVE).slice(0, -1)
    expect(snapshot.files).to.deep.equal([
      { type: 'file', name: 'a, b?.jpg', byteLength: 9, deviceId: phone, deviceType: 'phone', url: `${base}/a,%20b%3F.jpg` },
      { type: 'directory', name: 'Trip', byteLength: 0, deviceId: phone, deviceType: 'phone', url: `${base}/Trip/` }
    ])
    // decodeURI, as the private store reads it, gives the name back.
    expect(decodeURI(new URL(snapshot.files[0].url).pathname)).to.equal('/a, b%3F.jpg')
  })

  it('answers the Hyperdrive app alone', function () {
    const isHyperdriveApp = (url) => isPeerskyAppPage(url, 'p2p', 'hyperdrive')
    expect(isHyperdriveApp('peersky://p2p/hyperdrive/')).to.equal(true)
    expect(isHyperdriveApp('peersky://p2p/hyperdrive/index.html')).to.equal(true)
    expect(isHyperdriveApp('peersky://p2p/peerchat/')).to.equal(false)
    expect(isHyperdriveApp('peersky://p2p/hyperdrive-evil/')).to.equal(false)
    expect(isHyperdriveApp('hyper://p2p/hyperdrive/')).to.equal(false)
    expect(isHyperdriveApp('https://example.com/hyperdrive/')).to.equal(false)
    expect(isHyperdriveApp(undefined)).to.equal(false)
  })
})
