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

class FakeHyperdrive {
  constructor (corestore, key, opts = {}) {
    this.core = { key, length: 0 }
    this.encryptionKey = opts.encryptionKey || null
    this.url = driveUrl(key)
    this.files = new Map()
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

  const module = await esmock('../../src/protocols/private-hyperdrive.js', {
    '../../src/backup/private-drive-key.js': {
      getOrCreatePrivateDriveKey: async () => Buffer.alloc(32, 7)
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
