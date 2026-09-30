import { expect } from 'chai'

import {
  clearPairingNonces,
  forgetPairingNonce,
  isLivePairingNonce,
  rememberPairingNonce
} from '../../src/backup/pairing-sessions.js'

describe('pairing-sessions', function () {
  afterEach(function () {
    clearPairingNonces()
  })

  it('knows the codes it has shown, for an hour', function () {
    const nonce = 'ab'.repeat(16)
    expect(isLivePairingNonce(nonce, 1000)).to.equal(false)
    expect(rememberPairingNonce(nonce.toUpperCase(), 1000)).to.equal(true)
    expect(isLivePairingNonce(nonce, 1000 + 59 * 60 * 1000)).to.equal(true)
    expect(isLivePairingNonce(nonce, 1000 + 61 * 60 * 1000)).to.equal(false)
  })

  it('a code answers one transfer', function () {
    const nonce = 'cd'.repeat(16)
    rememberPairingNonce(nonce)
    forgetPairingNonce(nonce)
    expect(isLivePairingNonce(nonce)).to.equal(false)
  })

  it('keeps only the latest few, and ignores anything that is not a nonce', function () {
    const nonces = Array.from({ length: 20 }, (_, index) => index.toString(16).padStart(32, '0'))
    for (const nonce of nonces) rememberPairingNonce(nonce, 5000)
    expect(isLivePairingNonce(nonces[0], 5000)).to.equal(false)
    expect(isLivePairingNonce(nonces[19], 5000)).to.equal(true)

    expect(rememberPairingNonce('not-a-nonce')).to.equal(false)
    expect(isLivePairingNonce('')).to.equal(false)
    expect(isLivePairingNonce(undefined)).to.equal(false)
  })
})
