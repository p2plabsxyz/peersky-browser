// One identity, one phone. Two devices holding the same identity write the
// same chat feed and fork it, and the swarm only routes to one of them
// because they share a public key. The guard is on the desktop because that
// is the only device present when a transfer is made.
import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import {
  assertMobilePairingAllowed,
  clearPairedMobile,
  MOBILE_PAIRING_FILE,
  readPairedMobile,
  setPairedMobile
} from '../../src/backup/mobile-pairing.js'

const PHONE_A = 'a'.repeat(64)
const PHONE_B = 'b'.repeat(64)
const NONCE = '0'.repeat(32)

const pairing = (key, deviceType) =>
  `peersky-identity:${key}?nonce=${NONCE}&deviceType=${deviceType}`

let dir

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'peersky-mobile-pairing-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('mobile pairing cap', () => {
  it('allows the first phone and records it', async () => {
    const key = await assertMobilePairingAllowed(dir, pairing(PHONE_A, 'mobile'))
    expect(key).to.equal(PHONE_A)

    await setPairedMobile(dir, key)
    const paired = await readPairedMobile(dir)
    expect(paired.encryptionPublicKey).to.equal(PHONE_A)
    expect(paired.pairedAt).to.be.a('number')
  })

  it('refuses a second, different phone', async () => {
    await setPairedMobile(dir, PHONE_A)
    let error = null
    try {
      await assertMobilePairingAllowed(dir, pairing(PHONE_B, 'mobile'))
    } catch (caught) {
      error = caught
    }
    expect(error, 'a second phone was allowed').to.not.equal(null)
    expect(error.code).to.equal('MOBILE_ALREADY_PAIRED')
    expect(error.message).to.contain('Move to a new phone')
  })

  it('treats re-pairing the same phone as a retry, not a second device', async () => {
    await setPairedMobile(dir, PHONE_A)
    const key = await assertMobilePairingAllowed(dir, pairing(PHONE_A, 'mobile'))
    expect(key).to.equal(PHONE_A)
  })

  it('never caps desktops', async () => {
    // Desktops have the same single-writer problem, but capping them would
    // break restoring onto a replacement machine, which is the common case.
    await setPairedMobile(dir, PHONE_A)
    const key = await assertMobilePairingAllowed(dir, pairing(PHONE_B, 'desktop'))
    expect(key).to.equal(null)
  })

  it('frees the slot when the user moves to a new phone', async () => {
    await setPairedMobile(dir, PHONE_A)
    await clearPairedMobile(dir)
    expect(await readPairedMobile(dir)).to.equal(null)

    const key = await assertMobilePairingAllowed(dir, pairing(PHONE_B, 'mobile'))
    expect(key).to.equal(PHONE_B)
  })

  it('clearing an identity that was never paired is not an error', async () => {
    await clearPairedMobile(dir)
    expect(await readPairedMobile(dir)).to.equal(null)
  })

  it('ignores a malformed or truncated record rather than locking the user out', async () => {
    await fs.writeFile(path.join(dir, MOBILE_PAIRING_FILE), '{ not json')
    expect(await readPairedMobile(dir)).to.equal(null)

    await fs.writeFile(path.join(dir, MOBILE_PAIRING_FILE), JSON.stringify({ encryptionPublicKey: 'nope' }))
    expect(await readPairedMobile(dir)).to.equal(null)

    // A record it cannot read must not block pairing, or a corrupt file would
    // strand someone with no way to use their phone.
    expect(await assertMobilePairingAllowed(dir, pairing(PHONE_A, 'mobile'))).to.equal(PHONE_A)
  })

  it('ignores junk in place of a pairing code', async () => {
    for (const value of ['', 'not-a-pairing-code', undefined, null]) {
      expect(await assertMobilePairingAllowed(dir, value)).to.equal(null)
    }
  })
})
