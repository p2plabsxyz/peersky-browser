import { expect } from 'chai'
import { connectionFor } from '../../src/utils.js'

describe('site-info connection labels', function () {
  it('marks http as not secure', function () {
    expect(connectionFor('http:')).to.deep.equal({
      secure: false,
      label: 'Not secure'
    })
  })

  it('keeps https wording about TLS', function () {
    expect(connectionFor('https:').label).to.equal('Connection is secure')
    expect(connectionFor('https:').secure).to.equal(true)
  })

  it('uses protocol names for p2p schemes instead of https wording', function () {
    expect(connectionFor('ipfs:').label).to.equal('IPFS')
    expect(connectionFor('ipns:').label).to.equal('IPFS')
    expect(connectionFor('hyper:').label).to.equal('Hypercore')
    expect(connectionFor('bt:').label).to.equal('BitTorrent')
    expect(connectionFor('peersky:').label).to.equal('PeerSky page')
    expect(connectionFor('hs:').label).to.equal('Holesail')
    expect(connectionFor('pubsub:').label).to.equal('PubSub')
  })

  it('covers other navigable schemes that used to fall through', function () {
    expect(connectionFor('about:').secure).to.equal(true)
    expect(connectionFor('browser:').label).to.equal('PeerSky page')
    expect(connectionFor('blob:').secure).to.equal(true)
    expect(connectionFor('data:').secure).to.equal(false)
  })
})
