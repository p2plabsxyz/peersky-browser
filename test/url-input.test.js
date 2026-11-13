// "abcd: asd" parsed as the scheme "abcd", so it navigated nowhere instead of
// searching.

import { expect } from 'chai'
import { isURL, looksLikeDomain, isLoopbackAddress, NAVIGABLE_SCHEMES, isSearchTemplate } from '../src/utils.js'
import { readFile } from 'fs/promises'
import { readFileSync } from 'fs'
import vm from 'vm'

const navBox = await readFile(new URL('../src/pages/nav-box.js', import.meta.url), 'utf8')

describe('telling a typed URL from a search', function () {
  describe('text that merely contains a colon', function () {
    it('is a search, not a scheme', function () {
      expect(isURL('abcd: asd')).to.equal(false)
      expect(isURL('note: buy milk')).to.equal(false)
      expect(isURL('what is foo: bar')).to.equal(false)
    })

    it('still is when the colon is spaced out, as it always was', function () {
      expect(isURL('abcd : asd')).to.equal(false)
    })

    it('is a search however many colons it has', function () {
      expect(isURL('a: b: c')).to.equal(false)
    })
  })

  describe('real addresses keep working', function () {
    it('accepts the web schemes', function () {
      expect(isURL('https://example.com')).to.equal(true)
      expect(isURL('http://example.com/a?b=1#c')).to.equal(true)
    })

    it('accepts every scheme the browser serves', function () {
      for (const scheme of NAVIGABLE_SCHEMES) {
        expect(isURL(`${scheme}//host/path`), scheme).to.equal(true)
      }
    })

    // A space in a known scheme is encoded, so it is a typo not a phrase.
    it('keeps a known scheme navigable even with a space in the path', function () {
      expect(isURL('https://example.com/a b')).to.equal(true)
    })

    // The OS handles these, so they must not become searches.
    it('leaves app schemes alone so the OS still gets them', function () {
      expect(isURL('mailto:someone@example.com')).to.equal(true)
      expect(isURL('itms-apps://itunes.apple.com/app/id1')).to.equal(true)
      expect(isURL('abcd:asd')).to.equal(true)
    })
  })

  describe('the rest of the address bar is unchanged', function () {
    it('treats a bare domain as a domain', function () {
      expect(looksLikeDomain('example.com')).to.equal(true)
      expect(isURL('example.com')).to.equal(false)
    })

    it('treats a phrase as a search', function () {
      expect(isURL('hello world')).to.equal(false)
      expect(looksLikeDomain('hello world')).to.equal(false)
    })

    // localhost:3000 also parses as a scheme, so it is matched before isURL.
    it('still recognises loopback authorities', function () {
      expect(isLoopbackAddress('localhost:3000')).to.equal(true)
      expect(isLoopbackAddress('127.0.0.1:8080')).to.equal(true)
      expect(isLoopbackAddress('[::1]:9229')).to.equal(true)
    })
  })

  // The set must cover everything main.js registers.
  describe('the navigable scheme set', function () {
    it('covers every scheme registered as privileged', async function () {
      const { readFile } = await import('fs/promises')
      const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8')
      const block = main.slice(main.indexOf('registerSchemesAsPrivileged'))
      const registered = [...block.slice(0, block.indexOf('])')).matchAll(/scheme:\s*'([^']+)'/g)].map((m) => m[1])
      expect(registered.length, 'found the privileged scheme list').to.be.greaterThan(5)
      for (const scheme of registered) {
        expect(NAVIGABLE_SCHEMES.has(`${scheme}:`), `${scheme}: is registered but not navigable`).to.equal(true)
      }
    })

    it('includes the web schemes Chromium serves', function () {
      for (const scheme of ['http:', 'https:', 'about:']) {
        expect(NAVIGABLE_SCHEMES.has(scheme), scheme).to.equal(true)
      }
    })
  })
})

// Pressing Enter closed the suggestions, then the history search that was still
// in flight came back and reopened them over the page that had just loaded.
describe('the address bar suggestions', function () {
  const search = navBox.slice(navBox.indexOf('_handleAutocompleteInput (value)'), navBox.indexOf('_handleAutocompleteKeydown (e)'))
  const dismiss = navBox.slice(navBox.indexOf('_dismissAutocomplete () {'))

  it('ignores a search that lands after the query moved on', function () {
    expect(search).to.contain('const epoch = this._autocompleteEpoch')
    expect(search).to.contain('if (epoch !== this._autocompleteEpoch) return')
  })

  it('checks that before it stores or shows anything', function () {
    expect(search.indexOf('if (epoch !== this._autocompleteEpoch) return')).to.be.below(search.indexOf('this._autocompleteResults = filteredResults'))
    expect(search.indexOf('if (epoch !== this._autocompleteEpoch) return')).to.be.below(search.indexOf('this._showAutocomplete()'))
  })

  it('moves the epoch on for new input and when navigating away', function () {
    expect(search).to.contain('this._autocompleteEpoch++')
    expect(dismiss).to.contain('this._autocompleteEpoch++')
  })

  // Picked with the down key, then cut down to github.com/p2plabsxyz/peerchat/,
  // Enter still opened the picked .../pulls/10.
  it('lets go of a picked suggestion as soon as the address is edited', function () {
    expect(search).to.match(/if \(this\._autocompleteSelectedIndex !== -1\) \{\s+this\._autocompleteSelectedIndex = -1\s+this\._updateAutocompleteSelection\(\)/)
    // Before the search waits, not after it comes back.
    expect(search.indexOf('this._autocompleteSelectedIndex = -1')).to.be.below(search.indexOf('setTimeout('))
  })

  it('opens a suggestion on Enter only while the address bar still shows it', function () {
    const keys = navBox.slice(navBox.indexOf('_handleAutocompleteKeydown (e)'), navBox.indexOf('_renderAutocompleteResults ()'))
    expect(keys).to.contain("if (selected && this.querySelector('#url')?.value === selected.url) {")
  })
})

// A custom search goes wherever its template points, in the open tab: a
// javascript: template ran its code in whatever page was open.
describe('a custom search template', function () {
  it('may be a web or P2P address', function () {
    for (const template of [
      'https://example.com/search?q=%s',
      'http://127.0.0.1:8888/search?q=%s',
      'hyper://search.example/?q=%s',
      'ipfs://bafy/search?q=%s',
      'hs://abc/?q=%s'
    ]) expect(isSearchTemplate(template), template).to.equal(true)
  })

  it('may not run code or read files', function () {
    for (const template of [
      'javascript:alert(document.cookie)//%s',
      ' JavaScript:alert(1)//%s',
      'data:text/html,<script>alert(1)</script>%s',
      'file:///etc/passwd?%s',
      'blob:https://example.com/x?%s',
      'peersky://settings?%s',
      '',
      'not a url %s'
    ]) expect(isSearchTemplate(template), template).to.equal(false)
  })

  it('the Settings page refuses the same templates', async function () {
    const page = await readFile(new URL('../src/pages/static/js/settings.js', import.meta.url), 'utf8')
    expect(page).to.include("['https:', 'http:', 'hyper:', 'ipfs:', 'ipns:', 'hs:'].includes(protocol)")
  })
})

// peersky://history redirects to the History extension's page, which Chromium
// does not follow from a page, so the tab stayed where it was.
describe('typing peersky://history', function () {
  it('opens the History page in the tab', async function () {
    const { EventEmitter } = await import('events')
    const { followHistoryRedirect, isHistoryRedirect } = await import('../src/history-address.js')
    const view = 'chrome-extension://njgdkbplnabflgninlgehplmlcfabmdp/view.html'
    const wc = new EventEmitter()
    const loaded = []
    wc.loadURL = async (url) => { loaded.push(url) }
    followHistoryRedirect(wc)
    wc.emit('did-start-navigation', { url: 'peersky://history/', isMainFrame: true, isSameDocument: false })
    let prevented = false
    wc.emit('will-redirect', { url: view, isMainFrame: true, preventDefault: () => { prevented = true } })
    expect(prevented).to.equal(true)
    expect(loaded).to.deep.equal([view])
    expect(isHistoryRedirect('peersky://history', view)).to.equal(true)
  })

  it('leaves every other redirect alone, a site sending a tab to an extension too', async function () {
    const { EventEmitter } = await import('events')
    const { followHistoryRedirect, isHistoryRedirect } = await import('../src/history-address.js')
    const view = 'chrome-extension://njgdkbplnabflgninlgehplmlcfabmdp/view.html'
    const wc = new EventEmitter()
    const loaded = []
    wc.loadURL = async (url) => { loaded.push(url) }
    followHistoryRedirect(wc)
    wc.emit('did-start-navigation', { url: 'https://example.com/', isMainFrame: true, isSameDocument: false })
    let prevented = false
    wc.emit('will-redirect', { url: view, isMainFrame: true, preventDefault: () => { prevented = true } })
    expect(prevented).to.equal(false)
    expect(loaded).to.deep.equal([])
    expect(isHistoryRedirect('peersky://history', 'https://example.com/')).to.equal(false)
    expect(isHistoryRedirect('peersky://history/x', view)).to.equal(false)
  })

  it('is followed for every tab', async function () {
    const main = (await readFile(new URL('../src/main.js', import.meta.url), 'utf8'))
    expect(main).to.match(/if \(wc\.getType\(\) === 'webview'\) \{\s+followHistoryRedirect\(wc\)/)
  })
})

// node.js went to https://node.js/ and an error page: anything with a dot was
// taken for a site. Chrome searches unless the last label is a real top-level
// domain.
describe('a word with a dot in it', function () {
  it('is a search unless its ending is a real top-level domain, as in Chrome', function () {
    for (const text of ['node.js', 'index.html', 'jquery.min.js', 'notes.txt', 'x.invalid', 'co.uk', '3.14', '1.2.3']) {
      expect(looksLikeDomain(text), text).to.equal(false)
    }
  })

  it('is a site when it is one', function () {
    for (const text of ['example.com', 'EXAMPLE.COM', 'www.example.co.uk', 'foo.github.io', 'readme.md', 'example.com.', '例子.中国', 'xn--fsqu00a.xn--fiqs8s', 'en.wikipedia.org/wiki/Node.js']) {
      expect(looksLikeDomain(text), text).to.equal(true)
    }
  })

  // They went to the search engine, which also learned the device's name.
  it('is a device on the local network when its ending is a private one', function () {
    for (const text of ['nas.local', 'homeassistant.local', 'printer.lan', 'router.home', 'app.internal', 'x.test', 'server.corp', 'wiki.intranet', 'nas.home.arpa', 'NAS.LOCAL']) {
      expect(looksLikeDomain(text), text).to.equal(true)
    }
    for (const text of ['local', 'notes.locals', 'my local.lan', 'user@nas.local']) {
      expect(looksLikeDomain(text), text).to.equal(false)
    }
  })

  it('is a site with a port or a slash at the end, as Chrome takes it', function () {
    for (const text of ['node.js:3000', 'node.js/', 'node.js/docs/']) {
      expect(looksLikeDomain(text), text).to.equal(true)
    }
    expect(looksLikeDomain('node.js/docs')).to.equal(false)
    expect(looksLikeDomain('a.b:c')).to.equal(false)
    expect(looksLikeDomain('example.com:99999')).to.equal(false)
  })

  it('reads user@host as a mail address to search for', function () {
    expect(looksLikeDomain('someone@example.com')).to.equal(false)
  })
})

describe('the addresses that always worked', function () {
  let warn
  beforeEach(function () { warn = console.warn; console.warn = () => {} })
  afterEach(function () { console.warn = warn })

  const go = async (text) => (await import('../src/utils.js')).handleURL(text)

  it('IP addresses, with or without a port', async function () {
    expect(looksLikeDomain('192.168.1.1')).to.equal(true)
    expect(await go('192.168.1.5:8080')).to.equal('https://192.168.1.5:8080')
    expect(looksLikeDomain('[2001:db8::1]:80')).to.equal(true)
    expect(looksLikeDomain('0.1.2.3')).to.equal(false)
  })

  it('a host with a port, which used to be taken for a scheme', async function () {
    expect(isURL('example.com:8080')).to.equal(false)
    expect(await go('example.com:8080/path')).to.equal('https://example.com:8080/path')
  })

  it('localhost and the names under it, over http', async function () {
    expect(await go('localhost:3000')).to.equal('http://localhost:3000')
    expect(await go('app.localhost:5173/x')).to.equal('http://app.localhost:5173/x')
  })

  it('an address with its scheme, whatever its ending', async function () {
    expect(await go('http://node.js')).to.equal('http://node.js')
    expect(await go('https://example.com/a b')).to.equal('https://example.com/a b')
    expect(await go('mailto:someone@example.com')).to.equal('mailto:someone@example.com')
  })

  it('the P2P schemes and ENS names', async function () {
    for (const address of ['hyper://abc/', 'ipfs://bafy/', 'ipns://example.eth', 'hs://abc', 'bt://abc', 'magnet:?xt=urn:btih:abc', 'web3://0xabc']) {
      expect(await go(address), address).to.equal(address)
    }
    expect(await go('vitalik.eth')).to.equal('ipns://vitalik.eth')
  })

  it('a search for anything else', async function () {
    expect(await go('node.js')).to.match(/^https:\/\/duckduckgo\.com\/.*node\.js/)
  })
})

// A javascript: address pasted into the address bar ran in the open page.
// Chrome takes javascript: off pasted and dropped text.
describe('text pasted or dropped into the address bar', function () {
  const start = navBox.indexOf('function stripJavascriptSchemes (text) {')
  const strip = vm.runInNewContext(`(${navBox.slice(start, navBox.indexOf('\n}\n', start) + 2)})`)

  it('loses any javascript: at its start', function () {
    expect(strip('javascript:alert(document.cookie)')).to.equal('alert(document.cookie)')
    expect(strip(' \n JavaScript:javascript:  alert(1)')).to.equal('alert(1)')
    expect(strip('\u0001javascript:x')).to.equal('x')
    expect(strip('javascript:')).to.equal('')
  })

  it('keeps everything else as it is', function () {
    expect(strip('https://example.com/?q=javascript:x')).to.equal('https://example.com/?q=javascript:x')
    expect(strip(' node.js ')).to.equal(' node.js ')
    expect(strip('jav ascript:x')).to.equal('jav ascript:x')
  })

  it('is how a paste and a drop come in', function () {
    const events = navBox.slice(navBox.indexOf('  attachEvents () {'), navBox.indexOf('  navigate (action) {'))
    expect(events).to.contain("urlInput.addEventListener('paste', (event) => {")
    expect(events).to.contain('const safe = stripJavascriptSchemes(text)')
    expect(events).to.contain("document.execCommand('insertText', false, safe)")
    expect(events).to.contain('const url = stripJavascriptSchemes(textUrl).trim()')
  })
})

// After Enter in the address bar the keys stayed there, so Space, the arrow
// keys and the page's own shortcuts never reached the page.
describe('an address entered in the address bar', function () {
  const renderer = readSource('renderer.js')

  it('gives the page the keys, as in Chrome', function () {
    const start = renderer.indexOf('function focusActivePage () {')
    const source = renderer.slice(start, renderer.indexOf('\n}\n', start) + 2)
    const calls = []
    const webview = { focus: () => calls.push('page') }
    const input = { blur: () => calls.push('address bar lets go') }
    vm.runInNewContext(`${source}; focusActivePage()`, {
      tabBar: { getActiveWebview: () => webview },
      document: { querySelector: (selector) => (selector === '#url' ? input : null) }
    })
    expect(calls).to.deep.equal(['address bar lets go', 'page'])
  })

  it('does so once the tab is on its way there', function () {
    expect(renderer).to.match(/nav\.addEventListener\('navigate', async \(\{ detail \}\) => \{\s+const \{ url \} = detail\s+await navigateTo\(url\)\s+focusActivePage\(\)/)
  })

  // The window listened for Enter in the address bar too, so every address
  // was loaded twice: the first load started and was cut off by the second.
  it('is loaded once, from the address bar\'s own navigate event', function () {
    const navBox = readSource('pages/nav-box.js')
    expect(navBox).to.match(/urlInput\.addEventListener\('keypress', \(event\) => \{\s+if \(event\.key === 'Enter'\) \{[\s\S]*?this\.dispatchEvent\(new CustomEvent\('navigate'/)
    expect(renderer).to.not.match(/addEventListener\('keypress'/)
  })
})

function readSource (name) {
  return readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
}
