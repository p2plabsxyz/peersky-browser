import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { mkdtemp, writeFile } from 'fs/promises'

import { isCrx, parseCrxBuffer, extractCrx } from '../../src/extensions/crx.js'

const ZIP_PAYLOAD = Buffer.from('PK pretend zip payload')

// CRX3: 'Cr24', version 3, header size, header bytes, then the ZIP.
function makeCrx3 (zip = ZIP_PAYLOAD, header = Buffer.alloc(24, 7)) {
  const prefix = Buffer.alloc(12)
  prefix.write('Cr24', 0, 'ascii')
  prefix.writeUInt32LE(3, 4)
  prefix.writeUInt32LE(header.length, 8)
  return Buffer.concat([prefix, header, zip])
}

// CRX2: 'Cr24', version 2, public key length, signature length, then the ZIP.
function makeCrx2 (zip = ZIP_PAYLOAD, pubKey = Buffer.alloc(16, 3), sig = Buffer.alloc(8, 4)) {
  const prefix = Buffer.alloc(16)
  prefix.write('Cr24', 0, 'ascii')
  prefix.writeUInt32LE(2, 4)
  prefix.writeUInt32LE(pubKey.length, 8)
  prefix.writeUInt32LE(sig.length, 12)
  return Buffer.concat([prefix, pubKey, sig, zip])
}

async function writeTemp (buffer, name = 'ext.crx') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'peersky-crx-'))
  const file = path.join(dir, name)
  await writeFile(file, buffer)
  return { dir, file }
}

describe('CRX extraction', function () {
  it('recognises a CRX file by magic, not extension', async function () {
    const { file } = await writeTemp(makeCrx3(), 'no-extension')
    expect(await isCrx(file)).to.equal(true)

    const { file: plain } = await writeTemp(Buffer.from('not a crx at all'), 'plain.bin')
    expect(await isCrx(plain)).to.equal(false)
  })

  it('parses CRX3 and returns the embedded ZIP', function () {
    const parsed = parseCrxBuffer(makeCrx3())
    expect(parsed.version).to.equal(3)
    expect(parsed.zipBuffer.equals(ZIP_PAYLOAD)).to.equal(true)
  })

  it('parses CRX2 and recovers the public key', function () {
    const parsed = parseCrxBuffer(makeCrx2())
    expect(parsed.version).to.equal(2)
    expect(parsed.zipBuffer.equals(ZIP_PAYLOAD)).to.equal(true)
    expect(parsed.publicKeyDer.length).to.equal(16)
  })

  it('rejects a file that is not a CRX', function () {
    expect(() => parseCrxBuffer(Buffer.from('definitely not a crx'))).to.throw('bad magic')
    expect(() => parseCrxBuffer(Buffer.alloc(4))).to.throw('too small')
  })

  // Regression: the installer used to pass file *contents* as the first
  // argument, which fs.readFile rejected because CRX bytes contain nulls.
  it('takes a path, a destination and a ZIP extractor, in that order', async function () {
    const { file } = await writeTemp(makeCrx3())
    const seen = []

    const result = await extractCrx(file, '/dest/dir', async (zipBuffer, dest) => {
      seen.push({ zipBuffer, dest })
    })

    expect(seen).to.have.length(1)
    expect(seen[0].dest).to.equal('/dest/dir')
    expect(seen[0].zipBuffer.equals(ZIP_PAYLOAD)).to.equal(true)
    expect(result).to.be.an('object')
  })

  it('refuses a Buffer where a path belongs', async function () {
    let threw = false
    try {
      await extractCrx(makeCrx3(), '/dest/dir', async () => {})
    } catch (_) {
      threw = true
    }
    expect(threw).to.equal(true)
  })
})
