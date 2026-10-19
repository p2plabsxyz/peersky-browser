import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  canSeal,
  readSealedJson,
  sealFilesAtRest,
  setSealerForTests,
  writeSealedJson
} from '../../src/backup/sealed-file.js'
import {
  getOrCreatePrivateDriveKey,
  getPrivateDriveKey,
  PRIVATE_DRIVE_KEY_FILE,
  rememberPrivateDriveKeyFor
} from '../../src/backup/private-drive-key.js'
import {
  listPrivateHyperdrives,
  PRIVATE_HYPERDRIVE_REGISTRY_FILE,
  rememberPrivateHyperdrive
} from '../../src/protocols/private-hyperdrive-registry.js'
import {
  DEVICE_SYNC_FILE,
  readDeviceSyncState,
  recordDeviceHello,
  recordDriveListing,
  resetDeviceSyncStateCache
} from '../../src/protocols/device-sync-state.js'

// The private drive key sat in a plain file: whoever could read the profile
// folder could copy it and open every private drive, and act as one of the
// person's devices. The names of private files sat in plain files too.
// Safe storage stands in here for the Keychain, DPAPI or the keyring: what it
// locks only it can open.
function fakeSafeStorage ({ available = true, backend = 'keychain' } = {}) {
  const secret = Buffer.from('this-computer-only')
  const xor = (bytes) => Buffer.from(bytes.map((b, i) => b ^ secret[i % secret.length]))
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (text) => Buffer.concat([Buffer.from('v10'), xor(Buffer.from(text, 'utf8'))]),
    decryptString: (bytes) => {
      if (bytes.subarray(0, 3).toString() !== 'v10') throw new Error('Not ours')
      return xor(bytes.subarray(3)).toString('utf8')
    }
  }
}

describe('private files locked with safe storage', function () {
  let dir

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-sealed-'))
    setSealerForTests(fakeSafeStorage())
    resetDeviceSyncStateCache()
  })

  afterEach(function () {
    setSealerForTests(undefined)
    resetDeviceSyncStateCache()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes the private drive key locked, so the file shows no key', async function () {
    const key = await getOrCreatePrivateDriveKey(dir)
    const onDisk = fs.readFileSync(path.join(dir, PRIVATE_DRIVE_KEY_FILE), 'utf8')
    expect(onDisk).to.not.include(key.toString('hex'))
    expect(onDisk).to.include('peersky-sealed')
    expect((await getPrivateDriveKey(dir)).equals(key)).to.equal(true)
    expect(fs.statSync(path.join(dir, PRIVATE_DRIVE_KEY_FILE)).mode & 0o777).to.equal(0o600)
  })

  it('reads a key written before locking came in, and locks it at once', async function () {
    const hex = 'ab'.repeat(32)
    fs.writeFileSync(path.join(dir, PRIVATE_DRIVE_KEY_FILE), JSON.stringify({ version: 1, key: hex }))
    expect((await getPrivateDriveKey(dir)).toString('hex')).to.equal(hex)
    const onDisk = fs.readFileSync(path.join(dir, PRIVATE_DRIVE_KEY_FILE), 'utf8')
    expect(onDisk).to.not.include(hex)
    expect((await getPrivateDriveKey(dir)).toString('hex')).to.equal(hex)
  })

  it('never makes a new key over a locked one it cannot open', async function () {
    const key = await getOrCreatePrivateDriveKey(dir)
    const before = fs.readFileSync(path.join(dir, PRIVATE_DRIVE_KEY_FILE), 'utf8')
    // Safe storage that answers with nothing it locked, as after the
    // Keychain item was removed.
    setSealerForTests({ ...fakeSafeStorage(), decryptString: () => { throw new Error('denied') } })
    let error
    try {
      await getOrCreatePrivateDriveKey(dir)
    } catch (caught) {
      error = caught
    }
    expect(error?.code).to.equal('SEALED_FILE_LOCKED')
    expect(fs.readFileSync(path.join(dir, PRIVATE_DRIVE_KEY_FILE), 'utf8')).to.equal(before)
    setSealerForTests(fakeSafeStorage())
    expect((await getPrivateDriveKey(dir)).equals(key)).to.equal(true)
  })

  it('makes one key when two first uses come at once', async function () {
    const [a, b] = await Promise.all([getOrCreatePrivateDriveKey(dir), getOrCreatePrivateDriveKey(dir)])
    expect(a.equals(b)).to.equal(true)
  })

  it('keeps the keys other devices sent, locked too', async function () {
    const driveId = 'cd'.repeat(32)
    const otherKey = 'ef'.repeat(32)
    expect(await rememberPrivateDriveKeyFor(dir, driveId, otherKey)).to.equal(true)
    const onDisk = fs.readFileSync(path.join(dir, PRIVATE_DRIVE_KEY_FILE), 'utf8')
    expect(onDisk).to.not.include(otherKey)
    expect(onDisk).to.not.include(driveId)
  })

  it('locks the names of private drives', async function () {
    await rememberPrivateHyperdrive(dir, {
      url: `hyper://${'a'.repeat(52)}/`,
      name: 'passport-scan.jpg',
      timestamp: Date.now(),
      encrypted: true
    })
    const onDisk = fs.readFileSync(path.join(dir, PRIVATE_HYPERDRIVE_REGISTRY_FILE), 'utf8')
    expect(onDisk).to.not.include('passport-scan')
    expect((await listPrivateHyperdrives(dir))[0].name).to.equal('passport-scan.jpg')
  })

  it('locks the names and sizes of the files on your other devices', function () {
    const driveId = '12'.repeat(32)
    recordDeviceHello(dir, { id: '56'.repeat(32), type: 'phone', drives: [driveId] })
    recordDriveListing(dir, driveId, { items: [{ name: 'tax-return-2025.pdf', path: '/tax-return-2025.pdf', byteLength: 14000, type: 'file' }] })
    const onDisk = fs.readFileSync(path.join(dir, DEVICE_SYNC_FILE), 'utf8')
    expect(onDisk).to.not.include('tax-return')
    resetDeviceSyncStateCache()
    expect(JSON.stringify(readDeviceSyncState(dir))).to.include('tax-return-2025.pdf')
  })

  it('locks files from before at startup, and leaves locked ones alone', async function () {
    const hex = '34'.repeat(32)
    fs.writeFileSync(path.join(dir, PRIVATE_DRIVE_KEY_FILE), JSON.stringify({ version: 1, key: hex }))
    fs.writeFileSync(path.join(dir, PRIVATE_HYPERDRIVE_REGISTRY_FILE), JSON.stringify([]))
    expect(await sealFilesAtRest(dir, [PRIVATE_DRIVE_KEY_FILE, PRIVATE_HYPERDRIVE_REGISTRY_FILE, DEVICE_SYNC_FILE]))
      .to.deep.equal([PRIVATE_DRIVE_KEY_FILE, PRIVATE_HYPERDRIVE_REGISTRY_FILE])
    expect(fs.readFileSync(path.join(dir, PRIVATE_DRIVE_KEY_FILE), 'utf8')).to.not.include(hex)
    expect(await sealFilesAtRest(dir, [PRIVATE_DRIVE_KEY_FILE])).to.deep.equal([])
  })

  it('stays plain where the system has no real safe storage', async function () {
    for (const sealer of [null, fakeSafeStorage({ available: false }), fakeSafeStorage({ backend: 'basic_text' })]) {
      setSealerForTests(sealer)
      expect(canSeal()).to.equal(false)
      await writeSealedJson(path.join(dir, 'x.json'), { a: 1 })
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'x.json'), 'utf8'))).to.deep.equal({ a: 1 })
      expect((await readSealedJson(path.join(dir, 'x.json'))).sealed).to.equal(false)
    }
  })
})
