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

  it('shows the release control as soon as a phone is paired', async () => {
    // The row starts hidden and only appeared on page load, so after pairing
    // the user had no visible way to release the slot and the desktop looked
    // stuck saying a phone was already paired.
    const page = await fs.readFile(new URL('../../src/pages/static/js/backup.js', import.meta.url), 'utf8')
    const refreshes = page.match(/refreshPairedMobile\(\)/g) || []
    expect(refreshes.length, 'refreshed in fewer places than there are ways to pair').to.be.at.least(4)

    // Both ways of handing an identity to a phone have to update it.
    const zip = page.slice(page.indexOf('api.createIdentityTransfer('), page.indexOf('Identity transfer failed'))
    expect(zip).to.contain('refreshPairedMobile()')
    const hyper = page.slice(page.indexOf("cidRow.style.display = ''"), page.indexOf('VERIFICATION CODE'))
    expect(hyper).to.contain('refreshPairedMobile()')
  })

  it('calls the bridge the page actually has', async () => {
    // backup.js reads window.electronAPI.backup. Calling a namespace that
    // does not exist threw, the catch hid the row, and the release control
    // was unreachable with no error shown anywhere.
    const page = await fs.readFile(new URL('../../src/pages/static/js/backup.js', import.meta.url), 'utf8')
    expect(page).to.contain('const api = window.electronAPI && window.electronAPI.backup')
    expect(page).to.contain('await api.getPairedMobile()')
    expect(page).to.contain('await api.forgetPairedMobile()')
    expect(page, 'a namespace this page does not define').to.not.contain('window.peersky.backup')

    // And the preload has to actually expose them, or api.* is undefined.
    const preload = await fs.readFile(new URL('../../src/pages/unified-preload.js', import.meta.url), 'utf8')
    for (const name of ['getPairedMobile', 'forgetPairedMobile']) {
      expect(preload, `${name} is not exposed`).to.contain(`${name}:`)
    }
  })

  it('ignores junk in place of a pairing code', async () => {
    for (const value of ['', 'not-a-pairing-code', undefined, null]) {
      expect(await assertMobilePairingAllowed(dir, value)).to.equal(null)
    }
  })
})
