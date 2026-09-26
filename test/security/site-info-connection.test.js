import { expect } from 'chai'
import { connectionFor } from '../../src/utils.js'
import { isSecurePageUrl } from '../../src/pages/static/js/site-info-popup.js'

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

/**
 * peersky://home blanks its own address bar so the search placeholder shows
 * through. That blank string used to be what drove the shield as well, so the
 * home page reported "not secure" with a crossed-out shield. The address to
 * display and the page that is loaded have to stay separate values.
 */
describe('site-info shield on the home page', function () {
  it('treats the home page as secure', function () {
    expect(isSecurePageUrl('peersky://home')).to.equal(true)
    expect(isSecurePageUrl('peersky://home/')).to.equal(true)
  })

  it('reports a blank address as not secure, which is why it must not drive the shield', function () {
    expect(isSecurePageUrl('')).to.equal(false)
  })

  it('still crosses out plain http', function () {
    expect(isSecurePageUrl('http://example.com')).to.equal(false)
  })
})
