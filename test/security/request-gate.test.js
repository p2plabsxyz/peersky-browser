import { expect } from 'chai'
import { gateRequest, stampVetted, requireVetted } from '../../src/protocols/request-gate.js'

const fetchFrom = (url, callerUrl, method = 'GET', extra = {}) =>
  gateRequest({ url, method, resourceType: 'xhr', frameUrl: callerUrl, ...extra })

describe('request gate: control APIs', () => {
  const btList = 'bt://api?action=api&api=list'
  const magnetApi = 'magnet:?xt=urn:btih:deadbeef&action=api&api=start'
  const hsResume = 'hs://p2pmd/?action=resume'
  const chatJoin = 'hyper://chat/?action=join'

  it('blocks other pages, including local files and other internal pages', () => {
    for (const url of [btList, magnetApi, hsResume, chatJoin]) {
      expect(fetchFrom(url, 'https://evil.example/', 'POST').action, url).to.equal('block')
      expect(fetchFrom(url, 'file:///tmp/evil.html', 'POST').action, url).to.equal('block')
      expect(fetchFrom(url, 'peersky://settings/', 'POST').action, url).to.equal('block')
      expect(fetchFrom(url, undefined, 'POST').action, url).to.equal('block')
    }
  })

  it('lets each API through from its own pages', () => {
    expect(fetchFrom(btList, 'peersky://bt-manager/').action).to.equal('allow')
    expect(fetchFrom(magnetApi, 'bt://deadbeef/', 'POST').action).to.equal('allow')
    expect(fetchFrom(hsResume, 'peersky://p2p/p2pmd/', 'POST').action).to.equal('allow')
    expect(fetchFrom(chatJoin, 'peersky://p2p/peerchat/', 'POST').action).to.equal('allow')
    expect(fetchFrom(btList, 'peersky://p2p/p2pmd/').action).to.equal('block')
  })

  it('judges the initiator origin before the frame URL', () => {
    const verdict = fetchFrom(hsResume, 'about:blank', 'POST', { initiatorOrigin: 'peersky://p2p' })
    expect(verdict.action).to.equal('allow')
    const spoof = fetchFrom(hsResume, 'peersky://p2p/p2pmd/', 'POST', { initiatorOrigin: 'https://evil.example' })
    expect(spoof.action).to.equal('block')
  })

  it('allows a top-level GET, whose result the caller cannot read', () => {
    const nav = { resourceType: 'mainFrame' }
    expect(fetchFrom('hyper://chat/?action=net-status', 'https://example.com/', 'GET', nav).action).to.equal('allow')
    expect(fetchFrom(chatJoin, 'https://evil.example/', 'POST', nav).action).to.equal('block')
  })

  it('leaves ordinary p2p content alone', () => {
    for (const url of ['bt://deadbeef/', 'hs://somekey/', 'hyper://abc/chat.html', 'ipfs://bafy/', 'https://example.com/']) {
      expect(fetchFrom(url, 'https://example.com/').action, url).to.equal('allow')
    }
  })
})

describe('request gate: p2p writes', () => {
  it('lets reads through from anywhere', () => {
    expect(fetchFrom('hyper://abc/index.html', 'https://example.com/').action).to.equal('allow')
    expect(fetchFrom('ipfs://bafy/', 'https://example.com/', 'HEAD').action).to.equal('allow')
  })

  it('asks for the calling site before a web page writes', () => {
    for (const [url, method] of [['hyper://localhost/?key=blog', 'POST'], ['hyper://abc/index.html', 'PUT'], ['hyper://abc/x', 'DELETE'], ['ipfs://bafy/', 'POST'], ['ipns://k51/', 'PUT']]) {
      expect(fetchFrom(url, 'https://site.example/app/', method), url).to.deep.equal({ action: 'ask', caller: 'https://site.example/app/' })
    }
    expect(fetchFrom('hyper://abc/x', 'file:///Users/me/app.html', 'PUT')).to.deep.equal({ action: 'ask', caller: 'file:///Users/me/app.html' })
  })

  it('trusts the browser pages and defers extensions to their manifest', () => {
    expect(fetchFrom('hyper://localhost/?key=site', 'peersky://p2p/hyperdrive/', 'POST').action).to.equal('allow')
    expect(fetchFrom('ipfs://bafy/', 'chrome-extension://abcdefghijklmnop/popup.html', 'PUT')).to.deep.equal({
      action: 'extension', extensionId: 'abcdefghijklmnop', scheme: 'ipfs'
    })
  })

  it('blocks writes whose caller cannot be named', () => {
    expect(fetchFrom('hyper://abc/x', undefined, 'PUT').action).to.equal('block')
  })
})

describe('request gate: vetted stamp', () => {
  const echo = requireVetted(async (request) => new Response(request.headers.get('x-peersky-vetted') ?? 'no stamp'))

  it('stamps only sensitive requests', () => {
    expect(stampVetted({ url: 'hyper://abc/', method: 'GET', requestHeaders: {} })).to.equal(null)
    expect(stampVetted({ url: 'hyper://abc/', method: 'PUT', requestHeaders: {} })).to.have.property('x-peersky-vetted')
  })

  it('refuses sensitive requests that skipped webRequest, like a service worker fetch', async () => {
    const res = await echo(new Request('hs://p2pmd/?action=resume', { method: 'POST', body: '{}' }))
    expect(res.status).to.equal(403)
  })

  it('refuses a stamp the page forged, even alongside a real one', async () => {
    const forged = await echo(new Request('hyper://abc/x', { method: 'PUT', body: 'x', headers: { 'X-Peersky-Vetted': 'guess' } }))
    expect(forged.status).to.equal(403)
    const headers = stampVetted({ url: 'hyper://abc/x', method: 'PUT', requestHeaders: { 'X-Peersky-Vetted': 'guess' } })
    expect(Object.keys(headers).filter((k) => k.toLowerCase() === 'x-peersky-vetted')).to.have.lengthOf(1)
  })

  it('passes stamped requests through with the stamp removed', async () => {
    const headers = stampVetted({ url: 'hyper://abc/x', method: 'PUT', requestHeaders: {} })
    const res = await echo(new Request('hyper://abc/x', { method: 'PUT', body: 'x', headers }))
    expect(res.status).to.equal(200)
    expect(await res.text()).to.equal('no stamp')
  })

  it('passes ordinary reads without a stamp', async () => {
    const res = await echo(new Request('hyper://abc/index.html'))
    expect(res.status).to.equal(200)
  })
})
