import { expect } from 'chai'
import esmock from 'esmock'
import { mkdtempSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import Corestore from 'corestore'
import z32 from 'z32'
import { listOwnPrivateDrives, listOwnPrivateFiles } from '../../src/protocols/own-private-files.js'
import { makePrivateDriveFetcher } from '../../src/protocols/private-hyperdrive.js'
import { rememberPrivateHyperdrive } from '../../src/protocols/private-hyperdrive-registry.js'
import { setPrivateDriveOwnership } from '../../src/protocols/private-drive-ownership.js'
import { PHONE_PRIVATE_DRIVE_NAME } from '../../src/backup/phone-sync.js'

function driveUrl (id) {
  return `hyper://${z32.encode(Buffer.from(id, 'hex'))}/`
}

// After a restart the Hyperdrive app had only the private files of the
// person's other devices to show. Its own are in the private drives it made,
// which the registry keeps, so they are listed again from there: the real
// Corestore, Hyperdrive and private store, with no network.
describe('the private files this desktop shared', function () {
  this.timeout(30000)
  let root, profile, storage, store

  beforeEach(function () {
    root = mkdtempSync(path.join(os.tmpdir(), 'peersky-own-private-'))
    profile = path.join(root, 'profile')
    storage = path.join(root, 'hyper-private')
    store = new Corestore(storage)
  })

  afterEach(async function () {
    await store?.close().catch(() => {})
    store = null
    // Windows can hold a closed store's files a moment longer.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  function fetcherOn (corestore) {
    return makePrivateDriveFetcher({ corestore, joinCore () {} }, profile)
  }

  // As the Hyperdrive app does it: a drive named after the upload, recorded,
  // then each file put at its path.
  async function upload (fetcher, name, files, timestamp) {
    const drive = await fetcher.openByName(name)
    const base = driveUrl(drive.key.toString('hex'))
    await rememberPrivateHyperdrive(profile, { name, url: base, timestamp, encrypted: true })
    for (const [filePath, text] of Object.entries(files)) {
      const url = base + filePath.split('/').map(encodeURIComponent).join('/')
      expect((await fetcher(url, { method: 'PUT', body: Buffer.from(text) })).status).to.equal(200)
    }
    return base
  }

  it('lists them again after a restart, newest first, at addresses that open them', async function () {
    let fetcher = fetcherOn(store)
    const report = await upload(fetcher, 'report 1.pdf', { 'report 1.pdf': 'the report' }, 1000)
    const trip = await upload(fetcher, 'Trip', { 'Trip/a.jpg': 'a', 'Trip/b.jpg': 'b' }, 2000)
    // Two files picked at once go in the drive named after the first.
    const notes = await upload(fetcher, 'one.txt', { 'one.txt': '1', 'two.txt': '22' }, 3000)

    await store.close()
    store = new Corestore(storage)
    fetcher = fetcherOn(store)

    const files = await listOwnPrivateFiles(profile, { openDrive: (url) => fetcher.openDrive(url) })
    expect(files).to.deep.equal([
      { type: 'file', name: 'two.txt', byteLength: 2, url: `${notes}two.txt`, timestamp: 3000 },
      { type: 'file', name: 'one.txt', byteLength: 1, url: `${notes}one.txt`, timestamp: 3000 },
      { type: 'directory', name: 'Trip', byteLength: 0, url: `${trip}Trip/`, timestamp: 2000 },
      { type: 'file', name: 'report 1.pdf', byteLength: 10, url: `${report}report%201.pdf`, timestamp: 1000 }
    ])
    expect(await (await fetcher(files[3].url)).text()).to.equal('the report')
    // A folder opens as a list of what is in it, with links under the folder.
    const folder = await (await fetcher(files[2].url)).text()
    expect(folder).to.contain(`href="${trip}Trip/a.jpg"`)
    expect(await (await fetcher(`${trip}Trip/a.jpg`)).text()).to.equal('a')
  })

  it('leaves out the drives of other devices and those a restore brought here', async function () {
    const fetcher = fetcherOn(store)
    const own = await upload(fetcher, 'mine.txt', { 'mine.txt': 'mine' }, 1)
    const phone = 'b1'.repeat(32)
    const restored = 'b2'.repeat(32)
    const linked = 'b3'.repeat(32)
    await rememberPrivateHyperdrive(profile, { name: PHONE_PRIVATE_DRIVE_NAME, url: driveUrl(phone), timestamp: 4, encrypted: true })
    await setPrivateDriveOwnership(profile, phone, false)
    await rememberPrivateHyperdrive(profile, { name: 'photos', url: driveUrl(restored), timestamp: 3, encrypted: true })
    await setPrivateDriveOwnership(profile, restored, false)
    // Named as a linked device's, though nothing says whose it is.
    await rememberPrivateHyperdrive(profile, { name: 'Private files from a linked device', url: driveUrl(linked), timestamp: 2, encrypted: true })

    expect((await listOwnPrivateDrives(profile)).map((entry) => entry.url)).to.deep.equal([own])
    const opened = []
    const files = await listOwnPrivateFiles(profile, {
      openDrive: (url) => {
        opened.push(url)
        return fetcher.openDrive(url)
      }
    })
    expect(opened).to.deep.equal([own])
    expect(files.map((file) => file.name)).to.deep.equal(['mine.txt'])
  })

  it('stops at the most it lists, and leaves out a drive that will not open', async function () {
    const fetcher = fetcherOn(store)
    const broken = await upload(fetcher, 'broken.txt', { 'broken.txt': 'x' }, 3)
    await upload(fetcher, 'a.txt', { 'a.txt': 'a' }, 2)
    await upload(fetcher, 'b.txt', { 'b.txt': 'b' }, 1)
    const warnings = []
    const openDrive = (url) => url === broken ? Promise.reject(new Error('no')) : fetcher.openDrive(url)
    const logger = { warn: (message) => warnings.push(message) }

    expect((await listOwnPrivateFiles(profile, { openDrive, logger })).map((file) => file.name)).to.deep.equal(['a.txt', 'b.txt'])
    expect(warnings).to.have.length(1)
    expect((await listOwnPrivateFiles(profile, { openDrive, logger, maxItems: 1 })).map((file) => file.name)).to.deep.equal(['a.txt'])

    // One that never answers is waited on for a while, not for good.
    const hanging = (url) => url === broken ? new Promise(() => {}) : fetcher.openDrive(url)
    const files = await listOwnPrivateFiles(profile, { openDrive: hanging, logger, openTimeMs: 200 })
    expect(files.map((file) => file.name)).to.deep.equal(['a.txt', 'b.txt'])
  })

  it('has nothing to list for a profile with no private uploads', async function () {
    let opened = 0
    const files = await listOwnPrivateFiles(profile, { openDrive: () => { opened++ } })
    expect(files).to.deep.equal([])
    expect(opened).to.equal(0)
  })

  it('answers the Hyperdrive app alone', async function () {
    const handlers = new Map()
    const { setupDeviceSyncIpc } = await esmock.strict('../../src/protocols/device-sync-ipc.js', {
      '../../src/protocols/hyper-handler.js': {
        getDeviceSyncSnapshot: () => ({ devices: [], files: [] }),
        getOwnPrivateFiles: async () => [{ type: 'file', name: 'mine.txt' }]
      }
    }, { electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } } })
    setupDeviceSyncIpc()
    const list = handlers.get('private-files-list')
    expect(await list({ senderFrame: { url: 'peersky://p2p/hyperdrive/' } })).to.deep.equal({ files: [{ type: 'file', name: 'mine.txt' }] })
    expect(await list({ senderFrame: { url: 'peersky://p2p/hyperdrive/index.html' } })).to.have.property('files')
    // Another P2P app shares the Hyperdrive app's host, and still hears nothing.
    for (const url of ['peersky://p2p/peerchat/', 'peersky://p2p/hyperdrive-evil/', 'peersky://p2p/', 'hyper://p2p/hyperdrive/', 'peersky://settings/', undefined]) {
      let error = null
      await Promise.resolve().then(() => list({ senderFrame: { url } })).catch((caught) => { error = caught })
      expect(error?.message, String(url)).to.equal('Forbidden')
    }
    const { readFile } = await import('fs/promises')
    const preload = await readFile(new URL('../../src/pages/unified-preload.js', import.meta.url), 'utf8')
    expect(preload).to.contain("list: () => ipcRenderer.invoke('private-files-list')")
  })
})
