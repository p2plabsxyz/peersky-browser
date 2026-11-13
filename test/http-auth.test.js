// A site that asked for a sign-in (HTTP Basic or Digest) showed its 401:
// Electron cancels a challenge nothing answers, and the extension host
// cancelled the ones no extension answered. Chrome asks the person, over the
// tab, and so does PeerSky now.

import { expect } from 'chai'
import { EventEmitter } from 'events'
import { readFile } from 'fs/promises'
import esmock from 'esmock'

const source = async (file) => (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')

function contents (id, { type = 'webview', host = null, session = {} } = {}) {
  const wc = new EventEmitter()
  wc.id = id
  wc.session = session
  wc.sent = []
  wc.destroyed = false
  wc.isDestroyed = () => wc.destroyed
  wc.getType = () => type
  wc.hostWebContents = host
  wc.send = (channel, message) => wc.sent.push([channel, message])
  wc.destroy = () => {
    wc.destroyed = true
    wc.emit('destroyed')
  }
  return wc
}

// A tab: a window, and the page shown in it.
function tab (id = 2, session = {}) {
  const host = contents(1, { type: 'window' })
  return { host, guest: contents(id, { host, session }) }
}

describe('dialogs over a tab', function () {
  let dialogs, ipc

  beforeEach(async function () {
    ipc = new EventEmitter()
    dialogs = await esmock.strict('../src/tab-dialogs.js', { electron: { ipcMain: ipc } })
    dialogs.setupTabDialogs()
  })

  const answer = (sender, id, value) => ipc.emit('tab-dialog-answer', { sender }, { id, answer: value })

  it('asks the window that holds the tab, naming the tab', async function () {
    const { host, guest } = tab(7)
    const asked = dialogs.askInTab(guest, { kind: 'sign-in', origin: 'https://example.com' })
    expect(host.sent).to.have.length(1)
    const [channel, shown] = host.sent[0]
    expect(channel).to.equal('tab-dialog-show')
    expect(shown).to.include({ kind: 'sign-in', origin: 'https://example.com', webContentsId: 7 })
    answer(host, shown.id, { username: 'a', password: 'b' })
    expect(await asked).to.deep.equal({ username: 'a', password: 'b' })
  })

  it('takes an answer from that window only', async function () {
    const { host, guest } = tab()
    const asked = dialogs.askInTab(guest, { kind: 'sign-in' })
    const { id } = host.sent[0][1]
    answer(contents(99, { type: 'window' }), id, { username: 'x', password: 'y' })
    answer(guest, id, { username: 'x', password: 'y' })
    answer(host, id, null)
    expect(await asked).to.equal(null)
  })

  it('answers null when the tab closes, and takes the dialog down', async function () {
    const { host, guest } = tab()
    const asked = dialogs.askInTab(guest, { kind: 'sign-in' })
    const { id } = host.sent[0][1]
    guest.destroy()
    expect(await asked).to.equal(null)
    expect(host.sent[1]).to.deep.equal(['tab-dialog-close', { id }])
  })

  it('answers null when the window goes', async function () {
    const { host, guest } = tab()
    const asked = dialogs.askInTab(guest, { kind: 'sign-in' })
    host.destroy()
    expect(await asked).to.equal(null)
  })

  it('shows nothing for what is not a tab', async function () {
    const win = contents(3, { type: 'window' })
    expect(await dialogs.askInTab(win, { kind: 'sign-in' })).to.equal(null)
    expect(win.sent).to.deep.equal([])
    const { host, guest } = tab()
    host.destroyed = true
    expect(await dialogs.askInTab(guest, { kind: 'sign-in' })).to.equal(null)
  })

  it('takes down only the kinds asked for', async function () {
    const { host, guest } = tab()
    const signIn = dialogs.askInTab(guest, { kind: 'sign-in' })
    const other = dialogs.askInTab(guest, { kind: 'other' })
    dialogs.closeTabDialogs(guest.id, ['sign-in'])
    expect(await signIn).to.equal(null)
    answer(host, host.sent[1][1].id, 'kept')
    expect(await other).to.equal('kept')
  })
})

describe('signing in to a site', function () {
  let auth, app, asked, closed, hosts, pages

  async function load () {
    app = new EventEmitter()
    asked = []
    closed = []
    hosts = new Map()
    pages = new Map()
    auth = await esmock.strict('../src/http-auth.js', {
      electron: { app, webContents: { fromId: (id) => pages.get(id) } },
      '@p2plabs/peersky-chrome-extensions': { ElectronChromeExtensions: { fromSession: (session) => hosts.get(session) } },
      '../src/tab-dialogs.js': {
        tabHost: (wc) => (wc && !wc.isDestroyed() && wc.getType() === 'webview' ? wc.hostWebContents : null),
        askInTab: (guest, dialog) => new Promise((resolve) => asked.push({ guest, dialog, resolve })),
        closeTabDialogs: (id, kinds) => closed.push([id, kinds])
      }
    })
  }

  beforeEach(load)

  const settle = () => new Promise((resolve) => setImmediate(resolve))

  describe('what the dialog names', function () {
    it('the origin that asked, never the path', function () {
      expect(auth.signInRequest('https://example.com:8443/a/b?c=d')).to.deep.equal({ origin: 'https://example.com:8443', notPrivate: false })
    })

    it('notes that plain http is not private', function () {
      expect(auth.signInRequest('http://example.com/x')).to.deep.equal({ origin: 'http://example.com', notPrivate: true })
    })

    it('counts this machine as private, as Chrome does', function () {
      for (const url of ['http://localhost:8080/', 'http://127.0.0.1/', 'http://127.1.2.3/', 'http://[::1]:3000/', 'http://app.localhost/']) {
        expect(auth.signInRequest(url).notPrivate, url).to.equal(false)
      }
    })

    it('nothing for an address no sign-in comes from', function () {
      expect(auth.signInRequest('peersky://home')).to.equal(null)
      expect(auth.signInRequest('not a url')).to.equal(null)
      expect(auth.signInRequest(undefined)).to.equal(null)
    })
  })

  describe('one dialog for one protected space', function () {
    it('shares it between the requests that hit it together', async function () {
      const { guest } = tab()
      const info = { scheme: 'basic', realm: 'Files' }
      const first = auth.askToSignIn(guest, 'http://example.com/a.png', info)
      const second = auth.askToSignIn(guest, 'http://example.com/b.png', info)
      expect(asked).to.have.length(1)
      expect(asked[0].dialog).to.deep.equal({ kind: 'sign-in', origin: 'http://example.com', notPrivate: true })
      asked[0].resolve({ username: 'me', password: 'pw' })
      expect(await first).to.deep.equal({ username: 'me', password: 'pw' })
      expect(await second).to.deep.equal({ username: 'me', password: 'pw' })
    })

    it('asks again once answered, so wrong credentials get another try', async function () {
      const { guest } = tab()
      const info = { scheme: 'basic', realm: 'Files' }
      const first = auth.askToSignIn(guest, 'http://example.com/', info)
      asked[0].resolve({ username: 'me', password: 'wrong' })
      await first
      auth.askToSignIn(guest, 'http://example.com/', info)
      expect(asked).to.have.length(2)
    })

    it('asks separately for another realm, another site or another tab', function () {
      const { guest } = tab(2)
      const other = tab(3).guest
      auth.askToSignIn(guest, 'http://example.com/', { scheme: 'basic', realm: 'A' })
      auth.askToSignIn(guest, 'http://example.com/', { scheme: 'basic', realm: 'B' })
      auth.askToSignIn(guest, 'https://example.com/', { scheme: 'basic', realm: 'A' })
      auth.askToSignIn(other, 'http://example.com/', { scheme: 'basic', realm: 'A' })
      expect(asked).to.have.length(4)
    })

    it('gives nothing for Cancel or an answer that is not a sign-in', async function () {
      const { guest } = tab()
      const cancelled = auth.askToSignIn(guest, 'http://example.com/', { realm: 'A' })
      asked[0].resolve(null)
      expect(await cancelled).to.equal(null)
      const odd = auth.askToSignIn(guest, 'http://example.com/', { realm: 'A' })
      asked[1].resolve({ username: 1, password: {} })
      expect(await odd).to.equal(null)
    })

    it('ends when the tab goes to another page, not for a change within the page', function () {
      const { guest } = tab(5)
      auth.askToSignIn(guest, 'http://example.com/', { realm: 'A' })
      guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
      guest.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
      expect(closed).to.deep.equal([])
      guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      expect(closed).to.deep.equal([[5, ['sign-in']]])
    })
  })

  describe("the app's login event", function () {
    function login (wc, authInfo = { isProxy: false, scheme: 'basic', realm: 'A', host: 'example.com', port: 80 }) {
      const event = { prevented: false, preventDefault () { this.prevented = true } }
      const calls = []
      app.emit('login', event, wc, { url: 'http://example.com/private' }, authInfo, (...args) => calls.push(args))
      return { event, calls }
    }

    it('is heard before the extension host', function () {
      app.on('login', function host () {})
      auth.setupHttpAuth()
      expect(app.listeners('login')[0].name).to.equal('onLogin')
    })

    it('asks over the tab in a session with no extension host, as a private window', async function () {
      auth.setupHttpAuth()
      const { guest } = tab()
      const { event, calls } = login(guest)
      expect(event.prevented).to.equal(true)
      expect(asked).to.have.length(1)
      asked[0].resolve({ username: 'me', password: 'pw' })
      await settle()
      expect(calls).to.deep.equal([['me', 'pw']])
    })

    it('cancels the challenge on Cancel, so the page gets the 401', async function () {
      auth.setupHttpAuth()
      const { calls } = login(tab().guest)
      asked[0].resolve(null)
      await settle()
      expect(calls).to.deep.equal([[]])
    })

    it("leaves a proxy's challenge as it was", function () {
      auth.setupHttpAuth()
      const { event, calls } = login(tab().guest, { isProxy: true, scheme: 'basic', realm: 'VPN', host: 'proxy.example', port: 8080 })
      expect(event.prevented).to.equal(false)
      expect(calls).to.deep.equal([])
      expect(asked).to.deep.equal([])
    })

    it('leaves what is not a tab, and a request with no page, as they were', function () {
      auth.setupHttpAuth()
      for (const wc of [contents(9, { type: 'window' }), null]) {
        const { event, calls } = login(wc)
        expect(event.prevented).to.equal(false)
        expect(calls).to.deep.equal([])
      }
      expect(asked).to.deep.equal([])
    })

    it("leaves the browser's session to the extension host, with the dialog as its fallback", function () {
      auth.setupHttpAuth()
      const session = {}
      const webRequest = { notifyOnAuthRequired: async () => ({}) }
      hosts.set(session, { api: { webRequest } })
      const original = webRequest.notifyOnAuthRequired
      const { event, calls } = login(tab(2, session).guest)
      expect(event.prevented).to.equal(false)
      expect(calls).to.deep.equal([])
      expect(webRequest.notifyOnAuthRequired).to.not.equal(original)
      const wrapped = webRequest.notifyOnAuthRequired
      login(tab(3, session).guest)
      expect(webRequest.notifyOnAuthRequired, 'wrapped once').to.equal(wrapped)
    })
  })

  describe('after extensions had their say', function () {
    let webRequest, result, guest

    beforeEach(function () {
      result = {}
      webRequest = { notifyOnAuthRequired: async () => result }
      auth.fallBackToSignIn({ api: { webRequest } })
      guest = tab(4).guest
      pages.set(4, guest)
    })

    const challenge = (extra = {}) => ({ url: 'https://example.com/', webContentsId: 4, isProxy: false, scheme: 'digest', realm: 'R', ...extra })

    it("takes an extension's credentials and asks nothing", async function () {
      result = { authCredentials: { username: 'ext', password: 'pw' } }
      expect(await webRequest.notifyOnAuthRequired(challenge())).to.deep.equal(result)
      expect(asked).to.deep.equal([])
    })

    it("takes an extension's cancel and asks nothing", async function () {
      result = { cancel: true }
      expect(await webRequest.notifyOnAuthRequired(challenge())).to.deep.equal({ cancel: true })
      expect(asked).to.deep.equal([])
    })

    it('asks the person when no extension answered', async function () {
      const answered = webRequest.notifyOnAuthRequired(challenge())
      await settle()
      expect(asked).to.have.length(1)
      expect(asked[0].guest).to.equal(guest)
      expect(asked[0].dialog).to.deep.equal({ kind: 'sign-in', origin: 'https://example.com', notPrivate: false })
      asked[0].resolve({ username: 'me', password: 'pw' })
      expect(await answered).to.deep.equal({ authCredentials: { username: 'me', password: 'pw' } })
    })

    it('hands back what the extensions said when the person cancels', async function () {
      const answered = webRequest.notifyOnAuthRequired(challenge())
      await settle()
      asked[0].resolve(null)
      expect(await answered).to.deep.equal({})
    })

    it('leaves proxies, and pages that are not tabs, alone', async function () {
      expect(await webRequest.notifyOnAuthRequired(challenge({ isProxy: true }))).to.deep.equal({})
      expect(await webRequest.notifyOnAuthRequired(challenge({ webContentsId: 77 }))).to.deep.equal({})
      expect(await webRequest.notifyOnAuthRequired(challenge({ webContentsId: undefined }))).to.deep.equal({})
      expect(asked).to.deep.equal([])
    })
  })
})

describe('the sign-in dialog in the window', function () {
  let page, shell, main
  before(async function () {
    page = await source('../src/pages/tab-dialogs.js')
    shell = await source('../src/pages/index.html')
    main = await source('../src/main.js')
  })

  it('is loaded by every window, with its styles', function () {
    expect(shell).to.contain('<script src="./tab-dialogs.js"></script>')
    expect(shell).to.contain('@import url("browser://theme/tab-dialogs.css");')
  })

  it('is set up when the app starts', function () {
    expect(main).to.contain('setupTabDialogs()')
    expect(main).to.contain('setupHttpAuth()')
  })

  it('puts text from sites in as text only', function () {
    expect(page).to.not.match(/innerHTML|insertAdjacentHTML|outerHTML/)
    expect(page).to.contain('element.textContent = text')
  })

  it('asks for a username and a masked password, filled in with nothing', function () {
    const signIn = page.slice(page.indexOf('function signIn ('))
    expect(signIn).to.contain("field(form, 'Username', 'text')")
    expect(signIn).to.contain("field(form, 'Password', 'password')")
    expect(signIn).to.contain("'Your connection to this site is not private'")
    expect(page).to.contain("input.autocomplete = 'off'")
    expect(signIn, 'nothing typed is kept').to.contain("password.value = ''")
  })

  it('answers Cancel and Escape with nothing', function () {
    const signIn = page.slice(page.indexOf('function signIn ('))
    expect(signIn).to.contain("cancel.addEventListener('click', () => done(null))")
    expect(signIn).to.contain('keys(form, () => done(null))')
    expect(page).to.contain("if (event.key === 'Escape') {")
  })

  it('is on screen only while its tab is', function () {
    expect(page).to.contain("tab.styleWatch.observe(webview, { attributes: true, attributeFilter: ['style'] })")
    expect(page).to.contain("return webview.isConnected && webview.style.display !== 'none'")
    expect(page).to.contain('tab.layer.hidden = !visible')
  })
})
