import { expect } from 'chai'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import z32 from 'z32'
import archiver from 'archiver'
import { createWriteStream } from 'fs'
import { mkdtemp, readFile, writeFile } from 'fs/promises'

import {
  applyPhoneSync,
  isImportableUrl,
  mergeBookmarks,
  parsePhoneSync,
  PHONE_PRIVATE_DRIVE_NAME,
  readPhoneSyncZip,
  tabsNotOpen
} from '../../src/backup/phone-sync.js'
import { listPrivateHyperdrives, rememberPrivateHyperdrive } from '../../src/protocols/private-hyperdrive-registry.js'
import { isOwnedPrivateDrive } from '../../src/protocols/private-drive-ownership.js'
import { getOrCreatePrivateDriveKey, getPrivateDriveKeyFor } from '../../src/backup/private-drive-key.js'
import { buildPrivateDriveKeyExport } from '../../src/backup/private-drive-export.js'

async function makeTempDir (prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

const sha256 = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`

// The inner zip of a transfer from a phone, the way PeerSky Mobile packs it.
async function writePhoneZip (zipPath, { files, manifest }) {
  const output = createWriteStream(zipPath)
  const archive = archiver('zip', { zlib: { level: 6 } })
  const done = new Promise((resolve, reject) => {
    output.on('close', resolve)
    archive.on('error', reject)
  })
  archive.pipe(output)
  const listed = {}
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
    archive.append(bytes, { name })
    listed[name] = sha256(bytes)
  }
  archive.append(JSON.stringify(manifest || { version: '1.0.0', source: 'mobile', files: listed }), { name: 'manifest.json' })
  await archive.finalize()
  await done
  return listed
}

describe('phone-sync', function () {
  this.timeout(20000)

  it('reads what a phone sent, checked against its manifest', async function () {
    const dir = await makeTempDir('peersky-phone-sync-')
    const zipPath = path.join(dir, 'inner.zip')
    await writePhoneZip(zipPath, {
      files: {
        'phone-tabs.json': { version: 1, tabs: [{ url: 'https://example.com/a', title: 'A' }, { url: 'peersky://home', title: 'Home' }] },
        'phone-bookmarks.json': { version: 1, bookmarks: [{ url: 'hyper://blog.example/', title: 'Blog', createdAt: 1700000000000 }] },
        'phone-private-drives.json': { version: 1, drives: [{ driveId: 'E'.repeat(64) }, { driveId: 'nope' }] }
      }
    })

    const sync = await readPhoneSyncZip(zipPath)
    expect(sync.tabs).to.deep.equal([{ url: 'https://example.com/a', title: 'A' }])
    expect(sync.bookmarks).to.deep.equal([{ url: 'hyper://blog.example/', title: 'Blog', createdAt: 1700000000000 }])
    expect(sync.privateDrives).to.deep.equal([{ driveId: 'e'.repeat(64) }])
  })

  it('refuses anything a phone does not send, or that does not match its checksum', async function () {
    const dir = await makeTempDir('peersky-phone-sync-bad-')

    const unknown = path.join(dir, 'unknown.zip')
    await writePhoneZip(unknown, { files: { 'tabs.json': '{}' } })
    await expectRejection(readPhoneSyncZip(unknown), /unknown entry from the phone: tabs\.json/)

    const tampered = path.join(dir, 'tampered.zip')
    await writePhoneZip(tampered, {
      files: { 'phone-tabs.json': '{"tabs":[]}' },
      manifest: { version: '1.0.0', source: 'mobile', files: { 'phone-tabs.json': sha256(Buffer.from('something else')) } }
    })
    await expectRejection(readPhoneSyncZip(tampered), /Checksum mismatch for phone-tabs\.json/)

    const desktop = path.join(dir, 'desktop.zip')
    await writePhoneZip(desktop, {
      files: { 'phone-tabs.json': '{}' },
      manifest: { version: '1.0.0', files: {} }
    })
    await expectRejection(readPhoneSyncZip(desktop), /did not come from a phone/)

    const large = path.join(dir, 'large.zip')
    await writePhoneZip(large, { files: { 'phone-bookmarks.json': 'x'.repeat(5 * 1024 * 1024) } })
    await expectRejection(readPhoneSyncZip(large), /too large/)
  })

  it('keeps only addresses a desktop can open, once each, with tidy titles', function () {
    const sync = parsePhoneSync({
      'phone-tabs.json': Buffer.from(JSON.stringify({
        tabs: [
          { url: 'https://a.example/', title: '  Spaced\n  out  ' },
          { url: 'https://a.example/', title: 'Again' },
          { url: 'javascript:alert(1)', title: 'No' },
          { url: 'ipfs://bafy/', title: '' },
          { url: 'https://b.example/' }
        ]
      }))
    })
    expect(sync.tabs).to.deep.equal([
      { url: 'https://a.example/', title: 'Spaced out' },
      { url: 'ipfs://bafy/', title: 'ipfs://bafy/' },
      { url: 'https://b.example/', title: 'https://b.example/' }
    ])
    expect(isImportableUrl('file:///etc/passwd')).to.equal(false)
    expect(isImportableUrl(`https://x.example/${'a'.repeat(9000)}`)).to.equal(false)
  })

  it('adds new bookmarks after the desktop\'s own and leaves those alone', function () {
    const existing = [{ url: 'https://a.example/', title: 'Mine', favicon: 'icon', dateAdded: '2025-01-01T00:00:00.000Z' }]
    const { bookmarks, added } = mergeBookmarks(existing, [
      { url: 'https://a.example/', title: 'Phone title', createdAt: 1 },
      { url: 'https://b.example/', title: 'B', createdAt: 1700000000000 },
      { url: 'https://c.example/', title: 'C', createdAt: null }
    ], Date.parse('2026-09-29T00:00:00.000Z'))

    expect(added).to.equal(2)
    expect(bookmarks).to.deep.equal([
      existing[0],
      { url: 'https://b.example/', title: 'B', dateAdded: new Date(1700000000000).toISOString() },
      { url: 'https://c.example/', title: 'C', dateAdded: '2026-09-29T00:00:00.000Z' }
    ])
  })

  it('keeps the key a phone sends with its drive, and passes it on in exports', async function () {
    const sync = parsePhoneSync({
      'phone-private-drives.json': Buffer.from(JSON.stringify({
        drives: [
          { driveId: 'a'.repeat(64), key: 'B'.repeat(64) },
          { driveId: 'c'.repeat(64), key: 'not a key' },
          { driveId: 'd'.repeat(64) }
        ]
      }))
    })
    expect(sync.privateDrives).to.deep.equal([
      { driveId: 'a'.repeat(64), key: 'b'.repeat(64) },
      { driveId: 'c'.repeat(64) },
      { driveId: 'd'.repeat(64) }
    ])

    const userData = await makeTempDir('peersky-phone-sync-key-')
    const own = await getOrCreatePrivateDriveKey(userData)
    await applyPhoneSync(userData, { tabs: [], bookmarks: [], privateDrives: sync.privateDrives })

    expect((await getPrivateDriveKeyFor(userData, 'a'.repeat(64))).toString('hex')).to.equal('b'.repeat(64))
    expect(await getPrivateDriveKeyFor(userData, 'd'.repeat(64))).to.equal(null)
    // This desktop's own key is left as it was.
    expect((await getOrCreatePrivateDriveKey(userData)).equals(own)).to.equal(true)

    // A phone or desktop this profile goes to next opens the drive with it too.
    const exported = JSON.parse((await buildPrivateDriveKeyExport(userData, 0)).toString('utf8'))
    expect(exported.key).to.equal(own.toString('hex'))
    expect(exported.entries.find((entry) => entry.driveId === 'a'.repeat(64)).key).to.equal('b'.repeat(64))
    expect(exported.entries.find((entry) => entry.driveId === 'd'.repeat(64))).to.not.have.property('key')

    // A key kept for a drive is never swapped for another.
    await applyPhoneSync(userData, { tabs: [], bookmarks: [], privateDrives: [{ driveId: 'a'.repeat(64), key: 'c'.repeat(64) }] })
    expect((await getPrivateDriveKeyFor(userData, 'a'.repeat(64))).toString('hex')).to.equal('b'.repeat(64))
  })

  it('never touches a private drive this desktop made, whatever a phone lists', async function () {
    const userData = await makeTempDir('peersky-phone-sync-own-')
    const driveId = 'f'.repeat(64)
    const url = `hyper://${z32.encode(Buffer.from(driveId, 'hex'))}/`
    await rememberPrivateHyperdrive(userData, { name: 'mine', url, timestamp: 1, encrypted: true })

    const applied = await applyPhoneSync(userData, { tabs: [], bookmarks: [], privateDrives: [{ driveId, key: 'e'.repeat(64) }] })
    expect(applied).to.deep.include({ privateHostnames: [], privateDrivesAdded: 0 })
    expect(await listPrivateHyperdrives(userData)).to.deep.equal([{ name: 'mine', url, timestamp: 1, encrypted: true }])
    expect(await isOwnedPrivateDrive(userData, driveId)).to.equal(true)
    expect(await getPrivateDriveKeyFor(userData, driveId)).to.equal(null)
  })

  it('leaves out a phone tab already open here, in any window', function () {
    const phoneTabs = [
      { url: 'https://sent.example/?from=desktop', title: 'Sent from here' },
      { url: 'https://other-window.example/', title: 'Open elsewhere' },
      { url: 'https://new.example/', title: 'New' }
    ]
    const windows = {
      first: { tabs: [{ url: 'peersky://home/' }, { url: 'https://sent.example/?from=desktop', isSuspended: true }] },
      second: { tabs: [{ url: 'https://other-window.example/' }] },
      broken: null
    }

    expect(tabsNotOpen(phoneTabs, windows)).to.deep.equal([{ url: 'https://new.example/', title: 'New' }])
    // With no windows to ask, every tab opens.
    expect(tabsNotOpen(phoneTabs, null)).to.deep.equal(phoneTabs)
  })

  it('puts the bookmarks and the private drive in place, and doing it twice adds nothing', async function () {
    const userData = await makeTempDir('peersky-phone-sync-apply-')
    await writeFile(path.join(userData, 'bookmarks.json'), JSON.stringify([
      { url: 'https://a.example/', title: 'Mine', dateAdded: '2025-01-01T00:00:00.000Z' }
    ]))
    const driveId = 'e'.repeat(64)
    const sync = {
      tabs: [{ url: 'https://t.example/', title: 'T' }],
      bookmarks: [
        { url: 'https://a.example/', title: 'Dupe', createdAt: 1 },
        { url: 'https://b.example/', title: 'B', createdAt: 1700000000000 }
      ],
      privateDrives: [{ driveId }]
    }

    const first = await applyPhoneSync(userData, sync, { now: 1750000000000 })
    const hostname = z32.encode(Buffer.from(driveId, 'hex'))
    expect(first).to.deep.equal({ bookmarksAdded: 1, privateHostnames: [hostname], privateDrivesAdded: 1 })

    const bookmarks = JSON.parse(await readFile(path.join(userData, 'bookmarks.json'), 'utf8'))
    expect(bookmarks.map((bookmark) => bookmark.url)).to.deep.equal(['https://a.example/', 'https://b.example/'])

    const drives = await listPrivateHyperdrives(userData)
    expect(drives).to.deep.equal([{
      name: PHONE_PRIVATE_DRIVE_NAME,
      url: `hyper://${hostname}/`,
      timestamp: 1750000000000,
      encrypted: true
    }])
    // The phone's drive: readable here, written only on the phone.
    expect(await isOwnedPrivateDrive(userData, driveId)).to.equal(false)

    const second = await applyPhoneSync(userData, sync, { now: 1750000001000 })
    expect(second.bookmarksAdded).to.equal(0)
    // Trusted again for this run, but not counted: it was already here.
    expect(second.privateHostnames).to.deep.equal([hostname])
    expect(second.privateDrivesAdded).to.equal(0)
    expect(JSON.parse(await readFile(path.join(userData, 'bookmarks.json'), 'utf8'))).to.have.length(2)
    expect(await listPrivateHyperdrives(userData)).to.have.length(1)
  })

  it('starts a bookmarks file when there is none, and never writes over one it cannot read', async function () {
    const fresh = await makeTempDir('peersky-phone-sync-fresh-')
    const sync = { tabs: [], bookmarks: [{ url: 'https://b.example/', title: 'B', createdAt: 1 }], privateDrives: [] }
    expect((await applyPhoneSync(fresh, sync)).bookmarksAdded).to.equal(1)
    expect(JSON.parse(await readFile(path.join(fresh, 'bookmarks.json'), 'utf8'))).to.have.length(1)

    const broken = await makeTempDir('peersky-phone-sync-broken-')
    await writeFile(path.join(broken, 'bookmarks.json'), '{ not json')
    await expectRejection(applyPhoneSync(broken, sync), /could not be read/)
    expect(await readFile(path.join(broken, 'bookmarks.json'), 'utf8')).to.equal('{ not json')
  })
})

async function expectRejection (promise, pattern) {
  let error = null
  try {
    await promise
  } catch (caught) {
    error = caught
  }
  expect(error, 'expected a rejection').to.be.an('error')
  expect(error.message).to.match(pattern)
}
