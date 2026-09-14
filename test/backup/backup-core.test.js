import { expect } from 'chai'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import z32 from 'z32'
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'fs/promises'

import {
  createBackupZip,
  extractBackupZip,
  readManifest,
  verifyManifest,
  buildManifest
} from '../../src/backup/backup-core.js'
import {
  buildPrivateDriveKeyExport,
  decodeDriveId
} from '../../src/backup/private-drive-export.js'

async function makeTempDir (prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32 (buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// Build a raw STORED zip with a single entry whose name is used verbatim,
// allowing a genuine path-traversal entry that real zip writers would sanitize.
function buildRawZip (entryName, content) {
  const name = Buffer.from(entryName, 'utf-8')
  const data = Buffer.from(content, 'utf-8')
  const crc = crc32(data)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 6)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)

  const localBlock = Buffer.concat([local, name, data])
  const centralBlock = Buffer.concat([central, name])

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(centralBlock.length, 12)
  end.writeUInt32LE(localBlock.length, 16)

  return Buffer.concat([localBlock, centralBlock, end])
}

async function seedUserData (dir) {
  await writeFile(path.join(dir, 'tabs.json'), JSON.stringify({ windows: [{ tabs: ['peersky://home'] }] }))
  await writeFile(path.join(dir, 'lastOpened.json'), JSON.stringify({ x: 1 }))
  await mkdir(path.join(dir, 'ipfs', 'blocks'), { recursive: true })
  await writeFile(path.join(dir, 'ipfs', 'blocks', 'block-a'), 'block-a-content')
  await writeFile(path.join(dir, 'ipfs', 'libp2p-key'), 'fake-key')
  await mkdir(path.join(dir, 'hyper'), { recursive: true })
  await writeFile(path.join(dir, 'hyper', 'core'), 'hyper-core-content')
  await writeFile(path.join(dir, 'hyper', 'LOCK'), 'locked')
  await mkdir(path.join(dir, 'hyper-private'), { recursive: true })
  await writeFile(path.join(dir, 'hyper-private', 'private-core'), 'private-hyper-content')
  await writeFile(path.join(dir, 'privateHyperdrives.json'), JSON.stringify([{
    name: 'private-file.txt',
    url: `hyper://${'a'.repeat(52)}/`,
    timestamp: 1
  }]))
  // Lock files that must be excluded from the bundle
  await writeFile(path.join(dir, 'ipfs', 'LOCK'), 'locked')
  await writeFile(path.join(dir, 'ipfs', 'repo.lock'), 'locked')
}

describe('backup-core', function () {
  this.timeout(20000)

  it('creates a zip, round-trips, and verifies checksums', async function () {
    const userData = await makeTempDir('peersky-bk-src-')
    await seedUserData(userData)

    const outPath = path.join(await makeTempDir('peersky-bk-out-'), 'backup.zip')
    const result = await createBackupZip(userData, outPath, { peerskyVersion: '9.9.9' })

    const info = await stat(outPath)
    expect(info.isFile()).to.equal(true)
    expect(info.size).to.be.greaterThan(0)
    expect(result.uncompressedBytes).to.be.greaterThan(0)
    expect(result.manifest.peerskyVersion).to.equal('9.9.9')
    expect(Object.keys(result.manifest.files)).to.include.members(['tabs.json', 'hyper'])
    expect(result.manifest.files).not.to.have.property('ipfs')
    expect(result.manifest.files).not.to.have.property('hyper-private')
    expect(result.manifest.files).not.to.have.property('privateHyperdrives.json')

    const manifest = await readManifest(outPath)
    expect(manifest.files).to.deep.equal(result.manifest.files)

    const dest = await makeTempDir('peersky-bk-dest-')
    await extractBackupZip(outPath, dest)
    await verifyManifest(dest, manifest)

    const restoredTab = await readFile(path.join(dest, 'tabs.json'), 'utf-8')
    const originalTab = await readFile(path.join(userData, 'tabs.json'), 'utf-8')
    expect(restoredTab).to.equal(originalTab)

    let ipfsExists = true
    try {
      await stat(path.join(dest, 'ipfs'))
    } catch {
      ipfsExists = false
    }
    expect(ipfsExists).to.equal(false)
  })

  it('includes private Hyperdrive data only when explicitly requested', async function () {
    const userData = await makeTempDir('peersky-bk-private-src-')
    await seedUserData(userData)
    const outPath = path.join(await makeTempDir('peersky-bk-private-out-'), 'backup.zip')

    const result = await createBackupZip(userData, outPath, { includePrivate: true })

    expect(result.manifest.files).to.have.property('hyper-private')
    expect(result.manifest.files).to.have.property('privateHyperdrives.json')

    const dest = await makeTempDir('peersky-bk-private-dest-')
    await extractBackupZip(outPath, dest)
    await verifyManifest(dest, result.manifest)
    expect(await readFile(path.join(dest, 'hyper-private', 'private-core'), 'utf8'))
      .to.equal('private-hyper-content')
  })

  it('allows identity transfers to explicitly exclude private Hyperdrive data', async function () {
    const userData = await makeTempDir('peersky-bk-private-transfer-src-')
    await seedUserData(userData)
    const outPath = path.join(await makeTempDir('peersky-bk-private-transfer-out-'), 'backup.zip')

    const result = await createBackupZip(userData, outPath, {
      isIdentityTransfer: true,
      targetDeviceType: 'mobile',
      includePrivate: false
    })

    expect(result.manifest.files).not.to.have.property('hyper-private')
    expect(result.manifest.files).not.to.have.property('privateHyperdrives.json')
  })

  it('excludes lock files from the manifest and bundle', async function () {
    const userData = await makeTempDir('peersky-bk-lock-')
    await seedUserData(userData)

    const manifest = await buildManifest(userData, '1.0.0')
    expect(manifest.files).not.to.have.property('ipfs')

    const outPath = path.join(await makeTempDir('peersky-bk-lockout-'), 'backup.zip')
    await createBackupZip(userData, outPath, {})
    const dest = await makeTempDir('peersky-bk-lockdest-')
    await extractBackupZip(outPath, dest)

    let lockExists = true
    try {
      await stat(path.join(dest, 'hyper', 'LOCK'))
    } catch {
      lockExists = false
    }
    expect(lockExists).to.equal(false)
  })

  it('rejects zip entries with path traversal', async function () {
    const evilZip = path.join(await makeTempDir('peersky-bk-evil-'), 'evil.zip')
    await writeFile(evilZip, buildRawZip('../escaped.txt', 'pwned'))

    const dest = await makeTempDir('peersky-bk-evildest-')
    let threw = false
    try {
      await extractBackupZip(evilZip, dest)
    } catch (err) {
      threw = true
      expect(err.message).to.match(/traversal/i)
    }
    expect(threw).to.equal(true)
  })

  it('detects checksum mismatch when a file is tampered after extraction', async function () {
    const userData = await makeTempDir('peersky-bk-tamper-')
    await seedUserData(userData)

    const outPath = path.join(await makeTempDir('peersky-bk-tamperout-'), 'backup.zip')
    await createBackupZip(userData, outPath)
    const manifest = await readManifest(outPath)

    const dest = await makeTempDir('peersky-bk-tamperdest-')
    await extractBackupZip(outPath, dest)

    // Tamper with a file after extraction
    await writeFile(path.join(dest, 'tabs.json'), '{"corrupted": true}')

    let threw = false
    try {
      await verifyManifest(dest, manifest)
    } catch (err) {
      threw = true
      expect(err.message).to.match(/checksum mismatch/i)
      expect(err.message).to.include('tabs.json')
    }
    expect(threw).to.equal(true)
  })

  it('rejects manifest with invalid structure', async function () {
    const dest = await makeTempDir('peersky-bk-badmanifest-')

    let threw = false
    try {
      await verifyManifest(dest, null)
    } catch (err) {
      threw = true
      expect(err.message).to.match(/invalid/i)
    }
    expect(threw).to.equal(true)
  })
})

describe('private-drive-export', function () {
  it('decodes a z32 hyperdrive hostname to its 64-hex drive id', async function () {
    const driveId = crypto.randomBytes(32).toString('hex')
    const hostname = z32.encode(Buffer.from(driveId, 'hex')).toLowerCase()
    expect(decodeDriveId(`hyper://${hostname}/`)).to.equal(driveId.toLowerCase())
    expect(decodeDriveId(`hyper://${driveId}/`)).to.equal(driveId.toLowerCase())
    expect(decodeDriveId('hyper://not-a-valid-key/')).to.equal(null)
  })

  it('exports a deterministic v3 key record for the newest private drive', async function () {
    const userData = await makeTempDir('peersky-bk-keyexport-')
    await mkdir(path.join(userData, 'hyper-private'), { recursive: true })
    await writeFile(path.join(userData, 'hyper-private', 'core'), 'core')
    const driveId = crypto.randomBytes(32).toString('hex')
    await writeFile(path.join(userData, 'privateHyperdrives.json'), JSON.stringify([
      { name: 'older', url: `hyper://${'a'.repeat(52)}/`, timestamp: 1 },
      { name: 'newest', url: `hyper://${driveId}/`, timestamp: 2 }
    ]))

    const bytes = await buildPrivateDriveKeyExport(userData, 1700000000000)
    expect(bytes).to.not.equal(null)

    const record = JSON.parse(bytes.toString('utf-8'))
    expect(record.version).to.equal(3)
    expect(record.key).to.match(/^[0-9a-f]{64}$/)
    expect(record.driveId).to.equal(driveId.toLowerCase())
    expect(record.encrypted).to.equal(true)
    expect(record.announce).to.equal(true)
    expect(record.source).to.equal('desktop')
    expect(record.createdAt).to.equal(new Date(1700000000000).toISOString())
    expect(record.entries).to.have.length(2)
    expect(record.entries[0].driveId).to.equal(driveId.toLowerCase())
    expect(record.entries[1].driveId).to.equal(Buffer.from(z32.decode('a'.repeat(52))).toString('hex'))
  })

  it('returns null when the registry has no decodable drive', async function () {
    const userData = await makeTempDir('peersky-bk-keyexport-none-')
    await writeFile(path.join(userData, 'privateHyperdrives.json'), JSON.stringify([
      { name: 'broken', url: 'hyper://not-a-valid-key/', timestamp: 1 }
    ]))

    expect(await buildPrivateDriveKeyExport(userData)).to.equal(null)
  })

  it('bundles private-drive-key.json with the private corestore on request', async function () {
    const userData = await makeTempDir('peersky-bk-bundle-')
    await seedUserData(userData)
    const driveId = crypto.randomBytes(32).toString('hex')
    await writeFile(path.join(userData, 'privateHyperdrives.json'), JSON.stringify([
      { name: 'private-file.txt', url: `hyper://${driveId}/`, timestamp: 1 }
    ]))

    const outPath = path.join(await makeTempDir('peersky-bk-bundleout-'), 'backup.zip')
    const result = await createBackupZip(userData, outPath, { includePrivate: true })

    expect(result.manifest.files).to.have.property('private-drive-key.json')

    const dest = await makeTempDir('peersky-bk-bundledest-')
    await extractBackupZip(outPath, dest)
    await verifyManifest(dest, result.manifest)

    const record = JSON.parse(await readFile(path.join(dest, 'private-drive-key.json'), 'utf-8'))
    expect(record.driveId).to.equal(driveId.toLowerCase())
    expect(record.announce).to.equal(true)
    expect(record.source).to.equal('desktop')
  })

  it('never bundles the key record when private data is excluded', async function () {
    const userData = await makeTempDir('peersky-bk-nokey-')
    await seedUserData(userData)

    const outPath = path.join(await makeTempDir('peersky-bk-nokeyout-'), 'backup.zip')
    const result = await createBackupZip(userData, outPath, {
      isIdentityTransfer: true,
      targetDeviceType: 'mobile',
      includePrivate: false
    })

    expect(result.manifest.files).not.to.have.property('private-drive-key.json')
  })
})
