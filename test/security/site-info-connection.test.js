import { expect } from 'chai'
import esmock from 'esmock'
import { connectionFor, connectionForPage, failedAddressOf } from '../../src/utils.js'
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

// An error page showed peersky://error.html/?code=... in the address bar, and a
// site whose certificate failed showed "Connection is secure".
describe('an error page', function () {
  const failed = 'https://self-signed.example/a?b=1'
  const page = 'peersky://error.html/?' + new URLSearchParams({ code: '-202', name: 'CertAuthorityInvalidError', msg: 'ERR_CERT_AUTHORITY_INVALID', url: failed })

  it('stands for the address that failed', function () {
    expect(failedAddressOf(page)).to.equal(failed)
  })

  it('stands for no address the browser would not load, and other pages for none', function () {
    expect(failedAddressOf('peersky://error.html/?url=' + encodeURIComponent('javascript:alert(1)'))).to.equal(null)
    expect(failedAddressOf('peersky://error.html/?code=-105')).to.equal(null)
    expect(failedAddressOf('peersky://home')).to.equal(null)
    expect(failedAddressOf('https://example.com/error.html?url=https://a.example/')).to.equal(null)
    expect(failedAddressOf(undefined)).to.equal(null)
  })

  it('is not secure', function () {
    expect(connectionForPage(page)).to.deep.equal({ secure: false, label: 'Not secure' })
    expect(isSecurePageUrl(page)).to.equal(false)
    expect(connectionForPage('https://example.com/')).to.deep.equal({ secure: true, label: 'Connection is secure' })
    expect(isSecurePageUrl('peersky://settings')).to.equal(true)
  })

  it('tells about the site that failed in the site panel', async function () {
    const handlers = new Map()
    const { setupSiteInfoIpc } = await esmock.strict('../../src/site-info-ipc.js', {
      electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, BrowserWindow: { fromWebContents: () => null } },
      '../../src/permissions.js': {
        MANAGED_PERMISSIONS: [],
        getPermissionsForOrigin: () => ({}),
        setPermission () {},
        resetPermissionsForOrigin () {},
        isValidOrigin: () => true,
        permissionOriginFromUrl: (url) => new URL(url).origin,
        permissionsShownFor: () => []
      },
      '../../src/extensions/index.js': { default: { listExtensions: async () => [] } },
      '../../src/session.js': { getIncognitoSession: () => null }
    })
    setupSiteInfoIpc({ cookies: { get: async () => [] } })
    const info = await handlers.get('site-info-get')({ sender: {} }, page)
    expect(info.hostname).to.equal('self-signed.example')
    expect(info.origin).to.equal('https://self-signed.example')
    expect(info.connection).to.deep.equal({ secure: false, label: 'Not secure' })
  })

  it('is what the window shows in the address bar while the tab is on it', async function () {
    const { readFile } = await import('fs/promises')
    const renderer = (await readFile(new URL('../../src/renderer.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
    expect(renderer).to.contain('const shownAddress = (url) => failedAddressOf(url) || url')
    expect(renderer.match(/nav\.setStyledUrl\(shownAddress\(url\), url\)/g)).to.have.length(2)
  })
})
