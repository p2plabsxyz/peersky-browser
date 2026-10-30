import { expect } from 'chai'
import { readFile } from 'fs/promises'
import { gateRequest, stampVetted, requireVetted, takeNavigationStamp, takeListingProof, mayUsePrivateDrive, frameUrlOf, listingToken, LISTING_HEADER, LISTING_PARAM } from '../../src/protocols/request-gate.js'

const main = await readFile(new URL('../../src/main.js', import.meta.url), 'utf8')

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
    for (const url of ['hs://somekey/', 'hyper://abc/chat.html', 'ipfs://bafy/', 'https://example.com/']) {
      expect(fetchFrom(url, 'https://example.com/').action, url).to.equal('allow')
    }
  })
})

describe('request gate: torrent pages and files', () => {
  const hash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
  const file = `bt://${hash}/Folder/notes.txt`
  const inTorrent = `bt://${hash}/Folder/index.html`
  const pages = [`bt://${hash}/`, `magnet:?xt=urn:btih:${hash}`, 'webtorrent:http://192.168.1.1/admin']

  it('opens any of them in a tab, from anywhere', () => {
    for (const url of [file, ...pages]) {
      expect(fetchFrom(url, 'https://example.com/', 'GET', { resourceType: 'mainFrame' }).action, url).to.equal('allow')
    }
  })

  it('lets no other page read a downloaded file, or fetch anything through a torrent link', () => {
    for (const url of [file, `bittorrent://${hash}/a.mp4`, ...pages]) {
      for (const resourceType of ['xhr', 'image', 'media', 'subFrame']) {
        expect(fetchFrom(url, 'https://evil.example/', 'GET', { resourceType }).action, `${url} as ${resourceType}`).to.equal('block')
      }
      expect(fetchFrom(url, 'file:///tmp/evil.html').action, url).to.equal('block')
      expect(fetchFrom(url, 'hyper://abc/').action, url).to.equal('block')
    }
    expect(fetchFrom(file, `bt://${'a'.repeat(40)}/x.html`, 'GET', { initiatorOrigin: 'null' }).action, 'another torrent').to.equal('block')
  })

  it("lets a torrent's own files load one another", () => {
    expect(fetchFrom(file, inTorrent, 'GET', { resourceType: 'media', initiatorOrigin: 'null' }).action).to.equal('allow')
    expect(fetchFrom(file, `bt://${hash}/`, 'GET', { initiatorOrigin: `bt://${hash}` }).action).to.equal('allow')
    expect(fetchFrom(file, inTorrent, 'POST', { initiatorOrigin: 'null' }).action).to.equal('block')
  })

  it('keeps a page inside a torrent away from the torrent API', () => {
    const list = 'bt://api?action=api&api=list'
    expect(fetchFrom(list, inTorrent, 'GET', { initiatorOrigin: 'null' }).action).to.equal('block')
    expect(fetchFrom(list, `bt://${hash}/`, 'GET', { initiatorOrigin: `bt://${hash}` }).action).to.equal('allow')
  })

  it('stamps a file request, so a service worker cannot fetch one past the gate', async () => {
    expect(stampVetted({ url: file, method: 'GET', resourceType: 'mainFrame', requestHeaders: {} })).to.have.property('x-peersky-vetted')
    expect(stampVetted({ url: pages[0], method: 'GET', resourceType: 'mainFrame', requestHeaders: {} })).to.equal(null)
    const serve = requireVetted(async () => new Response('the file'))
    expect((await serve(new Request(file))).status).to.equal(403)
    expect((await serve(new Request(file, { headers: stampVetted({ url: file, method: 'GET', requestHeaders: {} }) }))).status).to.equal(200)
  })

  it('gives bt:// no service workers, which could answer for a torrent page', () => {
    expect(main).to.match(/const BT_PROTOCOL = \{\s*\.\.\.P2P_PROTOCOL,\s*allowServiceWorkers: false\s*\}/)
    expect(main).to.include("{ scheme: 'bt', privileges: BT_PROTOCOL }")
    expect(main).to.include("{ scheme: 'bittorrent', privileges: BT_PROTOCOL }")
  })
})

// Electron gives every file:// page the same origin, so a downloaded page
// could read ~/.ssh with a fetch, a frame or a popup.
describe('request gate: local files', () => {
  const key = 'file:///Users/me/.ssh/id_rsa'
  const load = (url, resourceType, extra = {}) => gateRequest({
    url,
    method: 'GET',
    resourceType,
    initiatorOrigin: 'file://',
    frameUrl: 'file:///Users/me/Downloads/page.html',
    source: 'tab',
    ...extra
  }).action

  it('opens a file in a tab, and not in a popup a page opened', () => {
    expect(load(key, 'mainFrame')).to.equal('allow')
    expect(load(key, 'mainFrame', { source: 'other' })).to.equal('block')
    expect(load(key, 'mainFrame', { source: undefined })).to.equal('block')
    expect(load(key, 'mainFrame', { method: 'POST' })).to.equal('block')
  })

  it('lets no page fetch, frame or embed a local file, beside it or not', () => {
    for (const resourceType of ['xhr', 'subFrame', 'object', 'other', 'ping']) {
      expect(load(key, resourceType), resourceType).to.equal('block')
      expect(load('file:///Users/me/Downloads/data.json', resourceType), `${resourceType} beside the page`).to.equal('block')
      expect(load('file:///Users/me/.ssh/', resourceType), `${resourceType} of a folder`).to.equal('block')
    }
  })

  it('lets a page show images, media and fonts, run .js files and use .css files', () => {
    for (const [url, resourceType] of [
      ['file:///Users/me/site/logo.png', 'image'],
      ['file:///Users/me/site/clip.mp4', 'media'],
      ['file:///Users/me/site/font.woff2', 'font'],
      ['file:///Users/me/site/app.js', 'script'],
      ['file:///Users/me/site/lib/mod.mjs?v=2', 'script'],
      ['file:///Users/me/site/style.css', 'stylesheet']
    ]) {
      expect(load(url, resourceType), url).to.equal('allow')
    }
  })

  it('loads no other file as a script or a stylesheet, which a JSON module import or a stray global would read', () => {
    for (const url of ['file:///Users/me/.docker/config.json', 'file:///Users/me/project/.env', key, 'file:///Users/me/notes.txt', 'file:///Users/me/app.js/']) {
      expect(load(url, 'script'), url).to.equal('block')
      expect(load(url, 'stylesheet'), url).to.equal('block')
    }
  })

  it("trusts no page for its address, which history.pushState can set to a folder's", () => {
    const folderAddress = { frameUrl: 'file:///Users/me/.ssh/' }
    expect(load(key, 'xhr', folderAddress)).to.equal('block')
    expect(load('file:///Users/me/.ssh/?__publishManifest=1', 'xhr', folderAddress)).to.equal('block')
  })

  it('lets a folder listing read the files under its folder with its token, and nothing else', () => {
    const token = listingToken('file:///Users/me/site/')
    const withToken = (url, value = token) => `${url}${url.includes('?') ? '&' : '?'}${LISTING_PARAM}=${value}`
    const listing = { frameUrl: 'file:///Users/me/site/' }
    expect(load(withToken('file:///Users/me/site/?__publishManifest=1'), 'xhr', listing)).to.equal('allow')
    expect(load(withToken('file:///Users/me/site/a/b%20c.png'), 'xhr', listing)).to.equal('allow')
    expect(load(withToken(key), 'xhr', listing), 'another folder').to.equal('block')
    expect(load(withToken('file:///Users/me/site2/x.txt'), 'xhr', listing), 'a folder starting the same').to.equal('block')
    expect(load(withToken('file:///Users/me/site/..%2F.ssh%2Fid_rsa'), 'xhr', listing), 'an encoded ..').to.equal('block')
    expect(load(withToken('file:///Users/me/site/a%5C..%5C..%5C.ssh%5Cid_rsa'), 'xhr', listing), 'backslashes').to.equal('block')
    expect(load(withToken('file:///Users/me/site/x.txt', 'f'.repeat(64)), 'xhr', listing), 'a made-up token').to.equal('block')
    expect(load(withToken('file:///Users/me/site/x.txt'), 'xhr', { ...listing, method: 'PUT' }), 'a write').to.equal('block')
    expect(listingToken('file:///Users/me/site'), 'with or without the slash').to.equal(token)
  })

  it('lets the browser window load its own files', () => {
    for (const resourceType of ['mainFrame', 'script', 'xhr', 'image']) {
      expect(load('file:///Applications/PeerSky.app/Contents/Resources/app/src/pages/index.html', resourceType, { source: 'shell' }), resourceType).to.equal('allow')
    }
  })

  it('is told by main.js where each request comes from', () => {
    expect(main).to.include('source: requestSourceOf(details)')
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

  it('asks an app added under peersky://myapps, like any other site', () => {
    expect(fetchFrom('hyper://localhost/?key=blog', 'peersky://myapps/notes/', 'POST')).to.deep.equal({ action: 'ask', caller: 'peersky://myapps/notes/' })
    const fromOrigin = gateRequest({ url: 'hyper://abc/x', method: 'PUT', resourceType: 'xhr', initiatorOrigin: 'peersky://myapps' })
    expect(fromOrigin).to.deep.equal({ action: 'ask', caller: 'peersky://myapps' })
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

// Electron hands a protocol handler no Sec-Fetch headers, so the gate marks a
// tab loading a hyper:// page for the handler to tell from a page's fetch.
describe('request gate: navigation stamp', () => {
  const drive = `hyper://${'d'.repeat(52)}/note.txt`
  const stamp = (details) => stampVetted({ url: drive, method: 'GET', requestHeaders: {}, ...details })

  it('marks only a tab loading a hyper:// page', () => {
    expect(stamp({ resourceType: 'mainFrame' })).to.have.property('x-peersky-navigation')
    expect(stamp({ resourceType: 'subFrame' })).to.equal(null)
    expect(stamp({ resourceType: 'xhr' })).to.equal(null)
    expect(stamp({ resourceType: 'image' })).to.equal(null)
    expect(stamp({ resourceType: 'mainFrame', url: 'https://example.com/' })).to.equal(null)
    expect(stamp({ resourceType: 'mainFrame', method: 'POST' })).to.not.have.property('x-peersky-navigation')
  })

  it('replaces a stamp the page sent with the real one', () => {
    const headers = stamp({ resourceType: 'mainFrame', requestHeaders: { 'X-Peersky-Navigation': 'guess', 'x-peersky-vetted': 'guess' } })
    expect(Object.keys(headers).filter((name) => name.toLowerCase().startsWith('x-peersky'))).to.deep.equal(['x-peersky-navigation'])
    expect(headers['x-peersky-navigation']).to.not.equal('guess')
  })

  it('reads the stamp once and takes it off', () => {
    const request = new Request(drive, { headers: stamp({ resourceType: 'mainFrame' }) })
    expect(takeNavigationStamp(request)).to.equal(true)
    expect(request.headers.has('x-peersky-navigation')).to.equal(false)
    expect(takeNavigationStamp(new Request(drive, { headers: { 'x-peersky-navigation': 'guess' } }))).to.equal(false)
    expect(takeNavigationStamp(new Request(drive))).to.equal(false)
  })
})

describe('request gate: who may use a private drive', () => {
  const drive = `hyper://${'d'.repeat(52)}/note.txt`
  const may = (initiatorOrigin, navigation) => mayUsePrivateDrive({ url: drive, initiatorOrigin, navigation })

  it('lets the browser, its own pages and a tab opening it in', () => {
    expect(may(undefined), 'the browser itself').to.equal(true)
    expect(may('peersky://p2p'), 'a browser page').to.equal(true)
    expect(may(`hyper://${'d'.repeat(52)}`), 'its own page').to.equal(true)
    expect(may('https://site.example', true), 'a tab opening a link').to.equal(true)
  })

  it('keeps every other page out', () => {
    expect(may('https://site.example')).to.equal(false)
    expect(may(`hyper://${'e'.repeat(52)}`)).to.equal(false)
    expect(may('file://')).to.equal(false)
    expect(may('chrome-extension://abcdefghijklmnop')).to.equal(false)
    expect(may('null'), 'an opaque origin').to.equal(false)
    expect(may('')).to.equal(false)
  })

  it('keeps out an app added under peersky://myapps, which came from somewhere else', () => {
    expect(may('peersky://myapps')).to.equal(false)
    expect(may('peersky://MyApps'), 'in any case').to.equal(false)
    expect(mayUsePrivateDrive({ url: 'hyper://localhost/?key=p2pmd&visibility=private', initiatorOrigin: 'peersky://myapps' }), 'making one by name').to.equal(false)
    expect(mayUsePrivateDrive({ url: 'hyper://localhost/?key=p2pmd&visibility=private', initiatorOrigin: 'peersky://p2p' }), 'P2PMD making its own').to.equal(true)
  })

  it('lets in a folder listing PeerSky made, which proves itself with its token, and no page that only claims to be one', () => {
    const folder = 'file:///Users/me/site/'
    const proof = (value) => new Request(drive, { headers: value === undefined ? {} : { [LISTING_HEADER]: value } })
    const request = proof(`${folder}?${LISTING_PARAM}=${listingToken(folder)}`)
    expect(takeListingProof(request), 'the listing').to.equal(true)
    expect(request.headers.has(LISTING_HEADER), 'the header is taken off').to.equal(false)
    expect(takeListingProof(proof(`${folder}?${LISTING_PARAM}=${'f'.repeat(64)}`)), 'a made-up token').to.equal(false)
    expect(takeListingProof(proof(folder)), 'no token').to.equal(false)
    expect(takeListingProof(proof(`https://evil.example/?${LISTING_PARAM}=${listingToken(folder)}`)), 'not a file URL').to.equal(false)
    expect(takeListingProof(proof('not a url')), 'not a URL').to.equal(false)
    expect(takeListingProof(proof()), 'no header').to.equal(false)

    expect(mayUsePrivateDrive({ url: drive, initiatorOrigin: 'file://', listing: true })).to.equal(true)
    expect(mayUsePrivateDrive({ url: drive, initiatorOrigin: 'file://' }), 'any other local page').to.equal(false)
  })
})

// Reading the frame of a request whose frame was torn down throws. In the gate
// that cancelled ordinary requests, and in the log line after a block it threw
// before the request was answered, which left it hanging.
describe('request gate: a frame torn down mid-request', () => {
  const gone = { get url () { throw new Error('Render frame was disposed before WebFrameMain could be accessed') } }

  it('reads as no frame, so ordinary requests pass and writes are still refused', () => {
    expect(frameUrlOf({ frame: gone })).to.equal('')
    const judge = (url, method) => gateRequest({ url, method, resourceType: 'xhr', frameUrl: frameUrlOf({ frame: gone }) }).action
    expect(judge('https://example.com/app.js', 'GET')).to.equal('allow')
    expect(judge('hyper://abc/x', 'PUT')).to.equal('block')
  })

  it('is how main.js reads every request frame', () => {
    expect(main).to.not.match(/details\.frame\?*\.url/)
    expect(main.match(/frameUrlOf\(details\)/g)).to.have.lengthOf(2)
  })
})
