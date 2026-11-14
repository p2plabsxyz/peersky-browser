import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { mkdtemp, rm } from 'fs/promises'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import {
  forgetSyncedDevice,
  markDeviceFilesSeen,
  newDeviceFileCount,
  readDeviceSyncState,
  recordDeviceHello,
  recordDriveListing,
  resetDeviceSyncStateCache
} from '../../src/protocols/device-sync-state.js'
import { deviceSyncSnapshot } from '../../src/protocols/desktop-device-sync.js'
import { listDriveTop } from '../../src/protocols/device-sync.js'

const PHONE = 'd1'.repeat(32)
const DESKTOP = 'd2'.repeat(32)
const PHONE_DRIVE = 'e1'.repeat(32)
const DESKTOP_DRIVE = 'e2'.repeat(32)
const LATER_DRIVE = 'e3'.repeat(32)

const file = (name, seq) => ({ type: 'file', name, path: `/${name}`, byteLength: 1, seq })
const folder = (name, seq) => ({ type: 'directory', name, path: `/${name}/`, byteLength: 0, seq })

// What a phone wrote, as the desktop lists it: the same items, a longer drive.
function list (directory, drive, items, version, now) {
  recordDriveListing(directory, drive, { items, truncated: false, version, now })
}

function reopened (directory) {
  resetDeviceSyncStateCache()
  return readDeviceSyncState(directory)
}

describe('files a linked device adds count as new until they are seen', function () {
  let directory = null
  beforeEach(async function () {
    resetDeviceSyncStateCache()
    directory = await mkdtemp(path.join(os.tmpdir(), 'peersky-new-files-'))
  })
  afterEach(async function () {
    resetDeviceSyncStateCache()
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = null
  })

  it('counts what a device writes after it was first listed, not what it had', function () {
    recordDeviceHello(directory, { id: PHONE, type: 'phone', drives: [PHONE_DRIVE], now: 1 })
    // Linking is not uploading: what the phone had when the two met is not new.
    list(directory, PHONE_DRIVE, [file('old.jpg', 3), folder('Trip', 5)], 8, 100)
    expect(newDeviceFileCount(directory)).to.equal(0)

    // The phone shares two files and then a folder.
    list(directory, PHONE_DRIVE, [file('b.jpg', 10), file('a.jpg', 9), file('old.jpg', 3), folder('Trip', 5)], 11, 200)
    expect(newDeviceFileCount(directory)).to.equal(2)
    list(directory, PHONE_DRIVE, [folder('Party', 12), file('b.jpg', 10), file('a.jpg', 9), file('old.jpg', 3), folder('Trip', 5)], 14, 300)
    expect(newDeviceFileCount(directory)).to.equal(3)

    const snapshot = deviceSyncSnapshot(directory)
    expect(snapshot.files.map((entry) => [entry.name, entry.new])).to.deep.equal([
      ['Party', true], ['b.jpg', true], ['a.jpg', true], ['old.jpg', false], ['Trip', false]
    ])
    // Kept on disk, so they are still new after a restart.
    expect(reopened(directory).listings[PHONE_DRIVE].items.map((item) => item.addedAt)).to.deep.equal([300, 200, 200, 0, 0])
    expect(newDeviceFileCount(directory)).to.equal(3)
  })

  it('is seen once the app shows the list, and only what came before', function () {
    recordDeviceHello(directory, { id: PHONE, type: 'phone', drives: [PHONE_DRIVE], now: 1 })
    list(directory, PHONE_DRIVE, [file('old.jpg', 3)], 4, 100)
    list(directory, PHONE_DRIVE, [file('new.jpg', 4), file('old.jpg', 3)], 5, 200)
    expect(markDeviceFilesSeen(directory, 250)).to.equal(true)
    expect(newDeviceFileCount(directory)).to.equal(0)
    expect(deviceSyncSnapshot(directory).files.every((entry) => entry.new === false)).to.equal(true)
    // Nothing new: nothing written.
    expect(markDeviceFilesSeen(directory, 260)).to.equal(false)
    expect(reopened(directory).seenAt).to.equal(250)

    list(directory, PHONE_DRIVE, [file('newer.jpg', 5), file('new.jpg', 4), file('old.jpg', 3)], 6, 300)
    expect(newDeviceFileCount(directory)).to.equal(1)
    expect(deviceSyncSnapshot(directory).files.map((entry) => entry.new)).to.deep.equal([true, false, false])
  })

  it('stays seen if the clock is set back after a file came', function () {
    recordDeviceHello(directory, { id: PHONE, type: 'phone', drives: [PHONE_DRIVE], now: 1 })
    list(directory, PHONE_DRIVE, [], 1, 100)
    list(directory, PHONE_DRIVE, [file('a.jpg', 1)], 2, 5000)
    markDeviceFilesSeen(directory, 1000)
    expect(newDeviceFileCount(directory)).to.equal(0)
    expect(reopened(directory).seenAt).to.equal(5000)
  })

  it('does not count an older file that only now fits in a listing cut short at a hundred', function () {
    recordDeviceHello(directory, { id: PHONE, type: 'phone', drives: [PHONE_DRIVE], now: 1 })
    recordDriveListing(directory, PHONE_DRIVE, { items: [file('a.jpg', 2)], truncated: true, version: 50, now: 100 })
    // One deleted makes room for one listed before it: old.jpg sat at 7.
    recordDriveListing(directory, PHONE_DRIVE, { items: [file('a.jpg', 2), file('old.jpg', 7)], truncated: true, version: 51, now: 200 })
    expect(newDeviceFileCount(directory)).to.equal(0)
  })

  it('counts a file shared again under the same name', function () {
    recordDeviceHello(directory, { id: PHONE, type: 'phone', drives: [PHONE_DRIVE], now: 1 })
    list(directory, PHONE_DRIVE, [file('scan.pdf', 2)], 3, 100)
    list(directory, PHONE_DRIVE, [file('scan.pdf', 3)], 4, 200)
    expect(newDeviceFileCount(directory)).to.equal(1)
  })

  it('counts all of a drive a known device starts listing later', function () {
    recordDeviceHello(directory, { id: DESKTOP, type: 'desktop', drives: [DESKTOP_DRIVE], now: 1 })
    list(directory, DESKTOP_DRIVE, [file('report.pdf', 2)], 3, 100)
    // Another desktop makes a drive for each private upload.
    recordDeviceHello(directory, { id: DESKTOP, type: 'desktop', drives: [LATER_DRIVE, DESKTOP_DRIVE], now: 2 })
    expect(newDeviceFileCount(directory)).to.equal(0)
    list(directory, LATER_DRIVE, [folder('Slides', 2), file('notes.txt', 1)], 3, 200)
    expect(newDeviceFileCount(directory)).to.equal(2)
    // Saying hello again with the same drives changes nothing.
    recordDeviceHello(directory, { id: DESKTOP, type: 'desktop', drives: [LATER_DRIVE, DESKTOP_DRIVE], now: 3 })
    list(directory, LATER_DRIVE, [folder('Slides', 2), file('notes.txt', 1)], 3, 300)
    expect(newDeviceFileCount(directory)).to.equal(2)
  })

  it('does not count a device met for the first time, with every drive it has', function () {
    recordDeviceHello(directory, { id: PHONE, type: 'phone', drives: [PHONE_DRIVE, LATER_DRIVE], now: 1 })
    list(directory, PHONE_DRIVE, [file('a.jpg', 1)], 2, 100)
    list(directory, LATER_DRIVE, [file('b.jpg', 1)], 2, 100)
    expect(newDeviceFileCount(directory)).to.equal(0)
  })

  it('reads a listing kept by an older PeerSky as seen, and counts from the next one', function () {
    recordDeviceHello(directory, { id: PHONE, type: 'phone', drives: [PHONE_DRIVE], now: 1 })
    // 1.0.1 kept no version and no marks.
    recordDriveListing(directory, PHONE_DRIVE, { items: [{ type: 'file', name: 'a.jpg', path: '/a.jpg', byteLength: 1 }], now: 50 })
    expect(reopened(directory).listings[PHONE_DRIVE].version).to.equal(null)
    list(directory, PHONE_DRIVE, [file('b.jpg', 9), file('a.jpg', 1)], 10, 100)
    expect(newDeviceFileCount(directory)).to.equal(0)
    list(directory, PHONE_DRIVE, [file('c.jpg', 10), file('b.jpg', 9), file('a.jpg', 1)], 11, 200)
    expect(newDeviceFileCount(directory)).to.equal(1)
  })

  it('drops the count of a device taken off the list, and counts a drive two devices list once', function () {
    recordDeviceHello(directory, { id: PHONE, type: 'phone', drives: [PHONE_DRIVE], now: 1 })
    recordDeviceHello(directory, { id: DESKTOP, type: 'desktop', drives: [], now: 1 })
    list(directory, PHONE_DRIVE, [], 1, 100)
    list(directory, PHONE_DRIVE, [file('a.jpg', 1), file('b.jpg', 2)], 3, 200)
    recordDeviceHello(directory, { id: DESKTOP, type: 'desktop', drives: [PHONE_DRIVE], now: 2 })
    expect(newDeviceFileCount(directory)).to.equal(2)
    forgetSyncedDevice(directory, PHONE)
    expect(newDeviceFileCount(directory)).to.equal(2)
    forgetSyncedDevice(directory, DESKTOP)
    expect(newDeviceFileCount(directory)).to.equal(0)
    expect(markDeviceFilesSeen(directory, 300)).to.equal(false)
  })

  it('takes no marks a stored file made up', function () {
    recordDeviceHello(directory, { id: PHONE, type: 'phone', drives: [PHONE_DRIVE], now: 1 })
    list(directory, PHONE_DRIVE, [{ ...file('a.jpg', 1), addedAt: -5 }, { ...file('b.jpg', 1), addedAt: 'soon' }], null, 100)
    const items = reopened(directory).listings[PHONE_DRIVE].items
    expect(items.map((item) => item.addedAt)).to.deep.equal([0, 0])
    expect(items.every((item) => !('seq' in item))).to.equal(true)
  })
})

describe('a drive\'s listing says where each item sits', function () {
  let store = null
  let directory = null
  afterEach(async function () {
    await store?.close()
    if (directory) await rm(directory, { recursive: true, force: true })
    store = null
    directory = null
  })

  it('puts what is written after a listing at its version or later', async function () {
    directory = await mkdtemp(path.join(os.tmpdir(), 'peersky-listing-seq-'))
    store = new Corestore(directory)
    const drive = new Hyperdrive(store)
    await drive.ready()
    await drive.put('/old.txt', Buffer.from('old'))
    await drive.put('/Trip/day1.jpg', Buffer.from('jpg'))
    const first = await listDriveTop(drive, { keepSeq: true })
    expect(first.version).to.equal(drive.version)
    expect(first.items.every((item) => item.seq < first.version)).to.equal(true)

    await drive.put('/new.txt', Buffer.from('new'))
    const second = await listDriveTop(drive, { keepSeq: true })
    expect(second.items.find((item) => item.name === 'new.txt').seq).to.be.at.least(first.version)
    expect(second.items.find((item) => item.name === 'old.txt').seq).to.be.below(first.version)

    // Without keepSeq, as the list of this desktop's own files reads it.
    const plain = await listDriveTop(drive)
    expect(plain.items.every((item) => !('seq' in item))).to.equal(true)
    await drive.close()
  })
})
