import { expect } from 'chai'
import { assertCaller, isPeerskyPage } from '../../src/backup/ipc-caller.js'

describe('backup and onboarding callers', function () {
  it('lets only the named peersky pages through', function () {
    expect(isPeerskyPage('peersky://backup/', 'backup')).to.equal(true)
    expect(isPeerskyPage('peersky://backup', 'backup')).to.equal(true)
    expect(isPeerskyPage('peersky://onboarding/', 'backup', 'onboarding')).to.equal(true)

    expect(isPeerskyPage('peersky://settings/', 'backup')).to.equal(false)
    expect(isPeerskyPage('https://backup/', 'backup')).to.equal(false)
    expect(isPeerskyPage('hyper://backup/', 'backup')).to.equal(false)
    expect(isPeerskyPage('peersky://backup.evil/', 'backup')).to.equal(false)
    expect(isPeerskyPage('not a url', 'backup')).to.equal(false)
    expect(isPeerskyPage(undefined, 'backup')).to.equal(false)
  })

  it('refuses a call from any other page, or one with no frame', function () {
    expect(() => assertCaller({ senderFrame: { url: 'peersky://backup/' } }, 'backup')).to.not.throw()
    expect(() => assertCaller({ senderFrame: { url: 'https://example.com/' } }, 'backup')).to.throw('Forbidden')
    expect(() => assertCaller({ senderFrame: null }, 'backup')).to.throw('Forbidden')
    expect(() => assertCaller(undefined, 'onboarding')).to.throw('Forbidden')
  })
})
