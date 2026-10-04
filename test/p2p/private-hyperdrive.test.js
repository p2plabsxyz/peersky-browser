import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
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
    expect(read).to.match(/if \(!context\.private && !hasBody && resp\.status === 500\) \{\s+const text = await resp\.clone\(\)\.text\(\)\.catch\(\(\) => ''\)\s+if \(isUnreadableDriveError\(text\)\) \{\s+if \(await adoptLinkedPrivateDrive\(new URL\(url\)\.hostname\)\) return handleHyperRequest\(req\)/)
    // \s+, not \n: Windows checks the source out with CRLF line endings.
    expect(read).to.match(/return new Response\(PRIVATE_DRIVE_ERROR, \{\s+status: 403,/)
  })
})
