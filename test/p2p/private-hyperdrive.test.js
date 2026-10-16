import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { Readable } from 'stream'
import z32 from 'z32'

function driveUrl (key) {
  return `hyper://${z32.encode(key)}/`
}

// Drives another device writes, by key: the files their peers hold, which
// arrive here on update().
const remoteDrives = new Map()

class FakeHyperdrive {
  constructor (corestore, key, opts = {}) {
    const peers = remoteDrives.get(key.toString('hex'))
    this.core = {
      key,
      length: 0,
      updates: 0,
      findingPeers: () => () => {},
      update: async () => {
        this.core.updates += 1
        if (!peers) return false
        for (const [name, buffer] of peers) this.files.set(name, buffer)
        this.core.length = peers.size
        return true
      }
    }
    this.writable = !peers
    this.encryptionKey = opts.encryptionKey || null
    this.url = driveUrl(key)
    this.files = new Map()
    FakeHyperdrive.last = this
  }

  async ready () {}

  async put (drivePath, buffer) {
    this.files.set(drivePath, buffer)
  }

  async putEntry (drivePath, opts = {}) {
    this.files.set(drivePath, Buffer.alloc(0))
  }

  async entry (drivePath) {
    if (drivePath === '/') throw new Error('Invalid filename: /')
    if (!this.files.has(drivePath)) return null
    const buffer = this.files.get(drivePath)
    return { value: { blob: buffer.length ? { byteLength: buffer.length } : null } }
  }

  async * readdir (drivePath) {
    const prefix = drivePath === '/' ? '' : `${drivePath.replace(/\/$/, '')}/`
    for (const name of this.files.keys()) {
      if (!name.startsWith(prefix)) continue
      const rest = name.slice(prefix.length)
      if (rest && !rest.includes('/')) yield rest
    }
  }

  async get (drivePath) {
    return this.files.get(drivePath) || null
  }

  createReadStream (drivePath, { start = 0, end } = {}) {
    const buffer = this.files.get(drivePath) || Buffer.alloc(0)
    return Readable.from([buffer.subarray(start, end === undefined ? buffer.length : end + 1)])
  }
}

async function load (registryEntries, options = {}) {
  const userDataDir = options.userDataDir || '/tmp/user-data'
  const namespace = sinon.stub().returns({})
  const joined = []
  const sdk = {
    corestore: { namespace },
    joinCore: sinon.stub().callsFake((core) => joined.push(core))
  }

  // Keys of drives other devices sent with keys of their own, by drive id.
  const driveKeys = options.driveKeys || new Map()
  const module = await esmock('../../src/protocols/private-hyperdrive.js', {
    '../../src/backup/private-drive-key.js': {
      getOrCreatePrivateDriveKey: async () => Buffer.alloc(32, 7),
      getPrivateDriveKeyFor: async (_dir, driveId) => driveKeys.get(driveId) || null
    },
    '../../src/protocols/private-hyperdrive-registry.js': {
      listPrivateHyperdrives: async () => registryEntries
    }
  }, {
    hyperdrive: {
      default: FakeHyperdrive
    }
  })

  const fetcher = module.makePrivateDriveFetcher(sdk, userDataDir)
  const readFile = async (url, drivePath) => {
    const response = await fetcher(`${url}${drivePath}`)
    return { status: response.status, body: await response.text() }
  }
  const writeFile = async (url, drivePath, body) => {
    const response = await fetcher(`${url}${drivePath}`, { method: 'PUT', body })
    return response.status
  }

  return { module, sdk, namespace, joined, fetcher, readFile, writeFile }
}

describe('private Hyperdrive keyed fetcher', function () {
  it('reopens a locally created drive through the namespace it was written under', async function () {
    const key = crypto.randomBytes(32)
    const url = driveUrl(key)
    const { namespace, writeFile, readFile } = await load([
      { name: 'demo', url, timestamp: 1, encrypted: true }
    ])

    expect(await writeFile(url, '/hello.txt', 'hello')).to.equal(200)
    const result = await readFile(url, '/hello.txt')

    expect(result.status).to.equal(200)
    expect(result.body).to.equal('hello')
    expect(namespace.calledWithExactly('demo')).to.equal(true)
  })

  it('falls back to the key-derived namespace for drives missing from the registry', async function () {
    const key = crypto.randomBytes(32)
    const url = driveUrl(key)
    const { namespace, writeFile } = await load([])

    await writeFile(url, '/hello.txt', 'hello')

    expect(namespace.calledWithExactly(key.toString('hex'))).to.equal(true)
  })

  it('announces and passes the profile key for encrypted registry entries', async function () {
    const key = crypto.randomBytes(32)
    const url = driveUrl(key)
    const { sdk, joined, writeFile } = await load([
      { name: 'enc', url, timestamp: 1, encrypted: true }
    ])

    await writeFile(url, '/hello.txt', 'hello')

    expect(sdk.joinCore.called).to.equal(true)
    expect(joined).to.have.length(1)
  })

  it('keeps legacy entries unencrypted and device-only', async function () {
    const key = crypto.randomBytes(32)
    const url = driveUrl(key)
    const { sdk, writeFile } = await load([
      { name: 'legacy', url, timestamp: 1, encrypted: false }
    ])

    await writeFile(url, '/hello.txt', 'hello')

    expect(sdk.joinCore.called).to.equal(false)
  })

  it('rejects writes to a private drive adopted from another device', async function () {
    const key = crypto.randomBytes(32)
    const url = driveUrl(key)
    const driveId = key.toString('hex')
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'peersky-own-'))
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(path.join(userDataDir, 'private-drive-owners.json'), JSON.stringify({
      [driveId]: { owned: false }
    }))

    try {
      const { fetcher } = await load([
        { name: 'shared', url, timestamp: 1, encrypted: true }
      ], { userDataDir })

      const put = await fetcher(`${url}note.txt`, { method: 'PUT', body: 'nope' })
      expect(put.status).to.equal(403)

      const del = await fetcher(`${url}note.txt`, { method: 'DELETE' })
      expect(del.status).to.equal(403)

      const listing = await fetcher(url)
      expect(listing.status).to.equal(200)
      expect(await listing.text()).to.include('Read-only')
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  it('asks the peers of a drive another device writes for a file not here yet', async function () {
    const key = crypto.randomBytes(32)
    const url = driveUrl(key)
    remoteDrives.set(key.toString('hex'), new Map([['/note.txt', Buffer.from('from the phone')]]))

    try {
      const { fetcher } = await load([
        { name: 'PeerSky Mobile', url, timestamp: 1, encrypted: true }
      ])

      const response = await fetcher(`${url}note.txt`)
      expect(response.status).to.equal(200)
      expect(await response.text()).to.equal('from the phone')
      expect(FakeHyperdrive.last.core.updates).to.equal(1)
    } finally {
      remoteDrives.delete(key.toString('hex'))
    }
  })

  it('says a file is missing once the peers of such a drive have been asked', async function () {
    const key = crypto.randomBytes(32)
    const url = driveUrl(key)
    remoteDrives.set(key.toString('hex'), new Map())

    try {
      const { fetcher } = await load([
        { name: 'PeerSky Mobile', url, timestamp: 1, encrypted: true }
      ])

      const response = await fetcher(`${url}missing.txt`)
      expect(response.status).to.equal(404)
      expect(FakeHyperdrive.last.core.updates).to.equal(1)
    } finally {
      remoteDrives.delete(key.toString('hex'))
    }
  })

  it('opens a drive another device sent with its own key using that key', async function () {
    const key = crypto.randomBytes(32)
    const url = driveUrl(key)
    const phoneKey = Buffer.alloc(32, 9)
    const { fetcher } = await load([
      { name: 'PeerSky Mobile', url, timestamp: 1, encrypted: true }
    ], { driveKeys: new Map([[key.toString('hex'), phoneKey]]) })

    await fetcher(url)
    expect(FakeHyperdrive.last.encryptionKey.equals(phoneKey)).to.equal(true)

    // Any other encrypted drive still opens with this desktop's key.
    const other = driveUrl(crypto.randomBytes(32))
    const { fetcher: second } = await load([{ name: 'mine', url: other, timestamp: 1, encrypted: true }])
    await second(other)
    expect(FakeHyperdrive.last.encryptionKey.equals(Buffer.alloc(32, 7))).to.equal(true)
  })

  it('asks a drive\'s peers once for several missing files, and not again straight after', async function () {
    const key = crypto.randomBytes(32)
    const url = driveUrl(key)
    remoteDrives.set(key.toString('hex'), new Map())

    try {
      const { fetcher } = await load([
        { name: 'PeerSky Mobile', url, timestamp: 1, encrypted: true }
      ])

      const together = await Promise.all([fetcher(`${url}a.txt`), fetcher(`${url}b.txt`)])
      expect(together.map((response) => response.status)).to.deep.equal([404, 404])
      expect((await fetcher(`${url}c.txt`)).status).to.equal(404)
      expect(FakeHyperdrive.last.core.updates).to.equal(1)
    } finally {
      remoteDrives.delete(key.toString('hex'))
    }
  })

  it('answers a missing file in a drive made here without asking the network', async function () {
    const key = crypto.randomBytes(32)
    const url = driveUrl(key)
    const { fetcher, writeFile } = await load([
      { name: 'mine', url, timestamp: 1, encrypted: true }
    ])

    await writeFile(url, '/hello.txt', 'hello')
    const response = await fetcher(`${url}missing.txt`)
    expect(response.status).to.equal(404)
    expect(FakeHyperdrive.last.core.updates).to.equal(0)
  })

  it('keeps writes enabled for drives created on this device', async function () {
    const key = crypto.randomBytes(32)
    const url = driveUrl(key)
    const { writeFile, readFile } = await load([
      { name: 'mine', url, timestamp: 1, encrypted: true }
    ])

    expect(await writeFile(url, '/hello.txt', 'hello')).to.equal(200)
    const result = await readFile(url, '/hello.txt')
    expect(result.status).to.equal(200)
    expect(result.body).to.equal('hello')
  })
})

// A linked phone's private drive made since it last synced reached this desktop
// only as an address. Read from the public store it was ciphertext, and the
// page showed the decoding error. Now that error alone means a private drive:
// the profile key is tried on it, it is kept as a linked device's if the key
// fits, and otherwise it is said to be private.
describe('a private drive this desktop learns of by reading it', () => {
  it('counts only a decoding error as a private drive', async () => {
    const { isUnreadableDriveError, PRIVATE_DRIVE_ERROR, LINKED_PRIVATE_DRIVE_NAME } = await import('../../src/protocols/private-drive-errors.js')
    expect(isUnreadableDriveError('Error: Decoded message is not valid\n    at decode (messages.js:135)')).to.equal(true)
    expect(isUnreadableDriveError({ code: 'DECODING_ERROR', message: 'DECODING_ERROR: Decoding error' })).to.equal(true)
    // What the phone showed for a desktop's private drive, before this.
    expect(isUnreadableDriveError('HypercoreError: DECODING_ERROR: Groups are not supported (discovery key: znzb49addd)\n    at Hypercore._decode')).to.equal(true)
    expect(isUnreadableDriveError('HypercoreError: DECODING_ERROR: Unknown wire type: 6 (discovery key: 33ureiaiir)\n    at Hyperdrive._open')).to.equal(true)
    expect(isUnreadableDriveError('Peers Not Found')).to.equal(false)
    expect(isUnreadableDriveError('File not found')).to.equal(false)
    expect(isUnreadableDriveError(undefined)).to.equal(false)
    expect(PRIVATE_DRIVE_ERROR).to.equal('This drive is private. Only devices linked to the one that made it can open it.')
    expect(LINKED_PRIVATE_DRIVE_NAME).to.equal('Private files from a linked device')
  })

  it('tries a key on the copy the public store holds, with nothing kept for a key that does not fit', async function () {
    const { create } = await import('hyper-sdk')
    const { default: Hyperdrive } = await import('hyperdrive')
    const { default: hypercoreCrypto } = await import('hypercore-crypto')
    const { decodesWithKey } = await import('../../src/protocols/private-hyperdrive.js')
    const root = mkdtempSync(path.join(os.tmpdir(), 'peersky-linked-'))
    const swarmOpts = { bootstrap: [], port: 0 }
    const phone = await create({ storage: path.join(root, 'phone'), swarmOpts, autoJoin: false })
    const desktop = await create({ storage: path.join(root, 'public'), swarmOpts, autoJoin: false })
    const privateStore = await create({ storage: path.join(root, 'private'), swarmOpts, autoJoin: false })
    const left = phone.corestore.replicate(true)
    const right = desktop.corestore.replicate(false)
    left.pipe(right).pipe(left)
    try {
      const key = crypto.randomBytes(32)
      // The public store reads it without a key: the first block is ciphertext.
      // That is random bytes, which now and then read as a header after all and
      // leave nothing to test, so a drive like that is made again.
      let made = null
      let seen = null
      let failure = null
      for (let attempt = 0; !failure && attempt < 20; attempt++) {
        if (seen) await seen.close()
        made = new Hyperdrive(phone.corestore.namespace(`private-${attempt}`), null, { encryptionKey: key })
        await made.ready()
        await made.put('/app-icon.png', Buffer.from('picture bytes'))
        seen = new Hyperdrive(desktop.corestore.namespace(`seen-${attempt}`), made.key)
        await seen.ready()
        await seen.core.get(0, { timeout: 5000 })
        failure = await seen.db.getHeader({ wait: false }).then(() => null, (error) => error)
      }
      expect(failure?.code, String(failure)).to.equal('DECODING_ERROR')
      // Once that block is here, as after a restart, opening the drive fails,
      // and the drive that failed keeps its core: no other Hyperdrive opens.
      const held = desktop.corestore.get({ key: made.key })
      await held.ready()
      await seen.close()
      const stuck = new Hyperdrive(desktop.corestore.namespace('stuck'), made.key)
      const openFailure = await stuck.ready().then(() => null, (error) => error)
      expect(openFailure?.code).to.equal('DECODING_ERROR')

      const probe = (encryptionKey) => Promise.race([
        decodesWithKey(desktop.corestore, made.key, encryptionKey, 5000),
        new Promise((resolve) => setTimeout(() => resolve('waited'), 8000))
      ])
      expect(await probe(crypto.randomBytes(32))).to.equal(false)
      expect(await probe(key)).to.equal(true)
      // And the private store was never asked: a drive opened there to try a
      // key would stay there.
      expect(await privateStore.corestore.storage.hasCore(hypercoreCrypto.discoveryKey(made.key))).to.equal(false)
    } finally {
      left.destroy()
      right.destroy()
      await Promise.allSettled([phone.close(), desktop.close(), privateStore.close()])
      // Windows can hold a closed store's files a moment longer.
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  it('tries the profile key on the public copy, keeps the drive read-only, and reads it again privately', async () => {
    const { readFile } = await import('fs/promises')
    const handler = await readFile(new URL('../../src/protocols/hyper-handler.js', import.meta.url), 'utf8')
    const adopt = handler.slice(handler.indexOf('function adoptLinkedPrivateDrive'), handler.indexOf('// Handle general hyper:// requests'))
    // One try per drive, however many of its files a page asks for at once.
    expect(adopt).to.match(/if \(!adoptingLinkedDrives\.has\(hostname\)\) \{\s+const adopting = tryLinkedPrivateDrive\(hostname\)\.catch\(\(\) => false\)/)
    expect(adopt).to.contain('if (privateDeviceOnly) return false')
    expect(adopt).to.contain('if (!await decodesWithKey(sdk.corestore, key, profileKey, LINKED_DRIVE_PROBE_MS)) return false')
    expect(adopt).to.not.contain('openPrivateDriveByHostname')
    expect(adopt).to.not.contain('getDrive(')
    expect(adopt).to.contain('name: LINKED_PRIVATE_DRIVE_NAME')
    expect(adopt).to.contain('await setPrivateDriveOwnership(userDataDir, key.toString(\'hex\'), false)')
    expect(adopt).to.contain('privateDriveHostnames.add(hostname)')

    const read = handler.slice(handler.indexOf('async function handleHyperRequest'))
    expect(read).to.match(/if \(!context\.private && !hasBody && resp\.status === 500\) \{\s+const text = await resp\.clone\(\)\.text\(\)\.catch\(\(\) => ''\)\s+if \(isUnreadableDriveError\(text\)\) \{\s+if \(await adoptLinkedPrivateDrive\(new URL\(url\)\.hostname\)\) return handleHyperRequest\(req, \{ navigation \}\)/)
    // \s+, not \n: Windows checks the source out with CRLF line endings.
    expect(read).to.match(/return new Response\(PRIVATE_DRIVE_ERROR, \{\s+status: 403,/)
  })
})

// An upload asks for its private drive by name. Asked again while a reader or
// an earlier upload had it open, it opened a second Hyperdrive, which waits for
// the first to let go of the core, so the upload hung for good.
describe('a private drive asked for by name while it is open', function () {
  this.timeout(30000)
  let root
  let store

  beforeEach(async function () {
    const { default: Corestore } = await import('corestore')
    root = mkdtempSync(path.join(os.tmpdir(), 'peersky-by-name-'))
    store = new Corestore(path.join(root, 'store'))
  })

  afterEach(async function () {
    await store.close().catch(() => {})
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  // The real Hyperdrive and Corestore: the wait is theirs.
  async function makeFetcher (registryEntries) {
    const module = await esmock('../../src/protocols/private-hyperdrive.js', {
      '../../src/backup/private-drive-key.js': {
        getOrCreatePrivateDriveKey: async () => Buffer.alloc(32, 7),
        getPrivateDriveKeyFor: async () => null
      },
      '../../src/protocols/private-hyperdrive-registry.js': {
        listPrivateHyperdrives: async () => registryEntries
      },
      '../../src/protocols/private-drive-ownership.js': {
        isOwnedPrivateDrive: async () => true
      }
    })
    return module.makePrivateDriveFetcher({ corestore: store, joinCore () {} }, root)
  }

  const settle = (promise) => Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('still waiting for the drive')), 5000))
  ])

  it('hands a second upload the drive the first one opened', async function () {
    const fetcher = await makeFetcher([])
    const first = await settle(fetcher.openByName('photos'))
    expect(await settle(fetcher.openByName('photos'))).to.equal(first)
  })

  it('hands an upload the drive a reader opened, still writable', async function () {
    const earlier = await makeFetcher([])
    const made = await settle(earlier.openByName('notes'))
    const url = driveUrl(made.key)
    await made.put('/old.txt', Buffer.from('old'))
    await made.close()

    // As after a restart: a restored tab reads the drive before the upload.
    const fetcher = await makeFetcher([{ name: 'notes', url, timestamp: 1, encrypted: true }])
    expect(await (await settle(fetcher(`${url}old.txt`))).text()).to.equal('old')
    const drive = await settle(fetcher.openByName('notes'))
    expect(driveUrl(drive.key)).to.equal(url)
    expect((await settle(fetcher(`${url}new.txt`, { method: 'PUT', body: 'new' }))).status).to.equal(200)
    expect(await (await settle(fetcher(`${url}new.txt`))).text()).to.equal('new')
  })

  // A folder has no entry of its own, so the link to a shared folder said
  // "File not found", and the drive's list linked everything from the top.
  it('opens a folder as a list of what is in it, linked under the folder', async function () {
    const fetcher = await makeFetcher([])
    const drive = await settle(fetcher.openByName('Trip'))
    const url = driveUrl(drive.key)
    for (const [name, text] of [['Trip/a.jpg', 'a'], ['Trip/b, c.jpg', 'b'], ['Trip/inner/d.txt', 'd']]) {
      const address = url + name.split('/').map(encodeURIComponent).join('/')
      expect((await settle(fetcher(address, { method: 'PUT', body: text }))).status).to.equal(200)
    }

    const top = await (await settle(fetcher(url))).text()
    expect(top).to.contain(`href="${url}Trip"`)
    const folder = await settle(fetcher(`${url}Trip/`))
    expect(folder.status).to.equal(200)
    const listing = await folder.text()
    expect(listing).to.contain(`href="${url}Trip/a.jpg"`)
    expect(listing).to.contain(`href="${url}Trip/inner"`)
    expect(await (await settle(fetcher(`${url}Trip/a.jpg`))).text()).to.equal('a')
    // Every link in the list opens what it names.
    for (const [, href] of listing.matchAll(/href="([^"]+)"/g)) {
      expect((await settle(fetcher(href.replace(/&amp;/g, '&')))).status, href).to.equal(200)
    }
    expect((await settle(fetcher(`${url}Nothing/`))).status).to.equal(404)
  })

  // As hypercore-fetch names a folder it lists, so a tab opening a private
  // folder gets the Hyperdrive app's views, its links without a slash too.
  it('names a folder it lists by its address with the slash, and a file by none', async function () {
    const fetcher = await makeFetcher([])
    const drive = await settle(fetcher.openByName('Goa'))
    const url = driveUrl(drive.key)
    for (const name of ['Goa Trip/a.jpg', 'Goa Trip/inner/b.jpg']) {
      const address = url + name.split('/').map(encodeURIComponent).join('/')
      expect((await settle(fetcher(address, { method: 'PUT', body: 'x' }))).status).to.equal(200)
    }

    expect((await settle(fetcher(url))).headers.get('Link')).to.equal(`<${url}>; rel="canonical"`)
    for (const address of [`${url}Goa%20Trip/`, `${url}Goa%20Trip`]) {
      expect((await settle(fetcher(address))).headers.get('Link'), address).to.equal(`<${url}Goa%20Trip/>; rel="canonical"`)
    }
    expect((await settle(fetcher(`${url}Goa%20Trip/inner`))).headers.get('Link')).to.equal(`<${url}Goa%20Trip/inner/>; rel="canonical"`)
    expect((await settle(fetcher(`${url}Goa%20Trip/a.jpg`))).headers.get('Link')).to.equal(null)
  })
})

// A private file went whole to every read, so a private video could not seek
// and the Hyperdrive app's views read a whole photo for its first 128 KB. It
// is sent in parts now, as a public file is, and keeps when it was written,
// as hypercore-fetch keeps it for public files.
describe('a private file read in parts, and when it was written', function () {
  this.timeout(30000)
  const bytes = Buffer.alloc(200 * 1024)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
  let root, store, fetcher, drive, url

  beforeEach(async function () {
    const { default: Corestore } = await import('corestore')
    root = mkdtempSync(path.join(os.tmpdir(), 'peersky-private-parts-'))
    store = new Corestore(path.join(root, 'store'))
    const module = await esmock('../../src/protocols/private-hyperdrive.js', {
      '../../src/backup/private-drive-key.js': {
        getOrCreatePrivateDriveKey: async () => Buffer.alloc(32, 7),
        getPrivateDriveKeyFor: async () => null
      },
      '../../src/protocols/private-hyperdrive-registry.js': {
        listPrivateHyperdrives: async () => []
      },
      '../../src/protocols/private-drive-ownership.js': {
        isOwnedPrivateDrive: async () => true
      }
    })
    fetcher = module.makePrivateDriveFetcher({ corestore: store, joinCore () {} }, root)
    drive = await fetcher.openByName('Videos')
    url = driveUrl(drive.key)
    expect((await fetcher(`${url}clip.mp4`, { method: 'PUT', body: bytes })).status).to.equal(200)
  })

  afterEach(async function () {
    await store.close().catch(() => {})
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  const get = (name, headers = {}, method = 'GET') => fetcher(`${url}${name}`, { method, headers })
  const bodyOf = async (response) => Buffer.from(await response.arrayBuffer())

  it('sends a whole file with its length, and a range of it as 206 with those bytes alone', async function () {
    const whole = await get('clip.mp4')
    expect(whole.status).to.equal(200)
    expect(whole.headers.get('Accept-Ranges')).to.equal('bytes')
    expect(whole.headers.get('Content-Length')).to.equal(String(bytes.length))
    expect(whole.headers.get('Content-Type')).to.equal('video/mp4')
    expect((await bodyOf(whole)).equals(bytes)).to.equal(true)

    for (const [range, start, end] of [
      // The first 128 KB, as the views read a photo for its details.
      ['bytes=0-131071', 0, 131071],
      // Across two of the drive's blocks.
      ['bytes=65530-65545', 65530, 65545],
      // A video seeked near its end.
      ['bytes=204000-', 204000, bytes.length - 1],
      ['bytes=-100', bytes.length - 100, bytes.length - 1],
      // Past the end is cut to it.
      ['bytes=204700-999999', 204700, bytes.length - 1]
    ]) {
      const part = await get('clip.mp4', { Range: range })
      expect(part.status, range).to.equal(206)
      expect(part.headers.get('Content-Range'), range).to.equal(`bytes ${start}-${end}/${bytes.length}`)
      expect(part.headers.get('Content-Length'), range).to.equal(String(end - start + 1))
      expect((await bodyOf(part)).equals(bytes.subarray(start, end + 1)), range).to.equal(true)
    }
  })

  it('says 416 for a range past the end, and sends the whole file for one it cannot read', async function () {
    for (const range of [`bytes=${bytes.length}-`, 'bytes=-0']) {
      const refused = await get('clip.mp4', { Range: range })
      expect(refused.status, range).to.equal(416)
      expect(refused.headers.get('Content-Range'), range).to.equal(`bytes */${bytes.length}`)
    }
    for (const range of ['bytes=10-5', 'bytes=0-1,4-5', 'items=0-5', 'bytes=-']) {
      const whole = await get('clip.mp4', { Range: range })
      expect(whole.status, range).to.equal(200)
      expect((await bodyOf(whole)).length, range).to.equal(bytes.length)
    }

    expect((await fetcher(`${url}empty.txt`, { method: 'PUT', body: Buffer.alloc(0) })).status).to.equal(200)
    const empty = await get('empty.txt')
    expect(empty.status).to.equal(200)
    expect(empty.headers.get('Content-Length')).to.equal('0')
    expect((await bodyOf(empty)).length).to.equal(0)
    expect((await get('empty.txt', { Range: 'bytes=0-' })).status).to.equal(416)
  })

  it('answers HEAD with what GET would send, without the bytes', async function () {
    const head = await get('clip.mp4', {}, 'HEAD')
    expect(head.status).to.equal(200)
    expect(head.headers.get('Content-Length')).to.equal(String(bytes.length))
    expect(head.headers.get('Accept-Ranges')).to.equal('bytes')
    expect(head.headers.get('Last-Modified')).to.be.a('string')
    expect((await bodyOf(head)).length).to.equal(0)

    const part = await get('clip.mp4', { Range: 'bytes=0-9' }, 'HEAD')
    expect(part.status).to.equal(206)
    expect(part.headers.get('Content-Range')).to.equal(`bytes 0-9/${bytes.length}`)
    expect(part.headers.get('Content-Length')).to.equal('10')
    expect((await bodyOf(part)).length).to.equal(0)

    const folder = await fetcher(url, { method: 'HEAD' })
    expect(folder.status).to.equal(200)
    expect(folder.headers.get('Link')).to.equal(`<${url}>; rel="canonical"`)
    expect((await bodyOf(folder)).length).to.equal(0)
  })

  it('keeps when a private file was written, and sends it back as Last-Modified', async function () {
    const sent = 'Tue, 02 Jan 2024 10:00:00 GMT'
    await fetcher(`${url}trip.jpg`, { method: 'PUT', body: 'jpg', headers: { 'Last-Modified': sent } })
    expect((await drive.entry('/trip.jpg')).value.metadata).to.deep.equal({ mtime: Date.parse(sent) })
    expect((await get('trip.jpg')).headers.get('Last-Modified')).to.equal(sent)

    // No time, or one that is not a date: the time of the write.
    const before = Date.now()
    await fetcher(`${url}now.jpg`, { method: 'PUT', body: 'jpg', headers: { 'Last-Modified': 'yesterday' } })
    const { mtime } = (await drive.entry('/now.jpg')).value.metadata
    expect(mtime).to.be.within(before, Date.now())
    expect((await get('now.jpg')).headers.get('Last-Modified')).to.equal(new Date(mtime).toUTCString())

    // A file written before this has no time, and none is made up for it.
    await drive.put('/old.jpg', Buffer.from('old'))
    expect((await get('old.jpg')).headers.get('Last-Modified')).to.equal(null)

    // The views list each file with its time.
    const { listDriveFiles } = await import('../../src/protocols/hyperdrive-views.js')
    const { entries } = await listDriveFiles(drive, '/')
    expect(entries.find((entry) => entry.path === '/trip.jpg').mtime).to.equal(Date.parse(sent))
    expect(entries.find((entry) => entry.path === '/old.jpg').mtime).to.equal(null)
  })
})
