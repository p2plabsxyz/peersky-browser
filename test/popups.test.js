// What a page opens in a new tab or window, as Chrome opens it. The handler in
// context-menu.js runs over stubbed Electron, with a fake tab whose input and
// window opens are driven by hand.

import { expect } from 'chai'
import { EventEmitter } from 'events'
import { readFile } from 'fs/promises'
import esmock from 'esmock'
import { watchPageInput, takeInputGrant, INPUT_GRACE_MS } from '../src/page-input.js'

const tabBar = (await readFile(new URL('../src/pages/tab-bar.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
const settle = () => new Promise((resolve) => setImmediate(resolve))

function fakeTab (id = 7) {
  const tab = new EventEmitter()
  tab.id = id
  tab.getLastWebPreferences = () => ({ partition: 'persist:peersky' })
  tab.setWindowOpenHandler = (handler) => { tab.openHandler = handler }
  tab.click = () => {
    tab.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left' })
    tab.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left' })
  }
  tab.open = (details) => tab.openHandler({ features: '', frameName: '', disposition: 'foreground-tab', referrer: { url: '', policy: 'default' }, ...details })
  return tab
}

// A screen with a menu bar along its top.
const WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 }

// First loads queued for new tabs, as navigation-restore.js would take them.
const queuedLoads = []

const loadModule = () => esmock.strict('../src/context-menu.js', {
  electron: { Menu: class {}, MenuItem: class {}, clipboard: {}, dialog: {}, screen: { getDisplayMatching: () => ({ workArea: WORK_AREA }) } },
  '../src/external-scheme.js': { isExternalScheme: () => false, openExternalScheme () {} },
  '../src/extensions/index.js': { default: {} },
  '../src/devtools-dock.js': { openDockedDevTools () {} },
  '../src/navigation-restore.js': {
    queueFirstLoad (job) {
      queuedLoads.push(job)
      return `00000000-0000-4000-8000-${String(queuedLoads.length).padStart(12, '0')}`
    }
  }
})

async function loadMenus () {
  queuedLoads.length = 0
  const { attachContextMenus } = await loadModule()
  const shell = new EventEmitter()
  shell.id = 1
  shell.scripts = []
  shell.executeJavaScript = async (script) => { shell.scripts.push(script); return true }
  shell.setWindowOpenHandler = () => {}
  const browserWindow = { webContents: shell, getBounds: () => ({ x: 100, y: 80, width: 1280, height: 800 }) }
  const opened = []
  attachContextMenus(browserWindow, { open: (options) => opened.push(options), findWindowByWebContentsId: () => null })
  const tab = fakeTab()
  shell.emit('did-attach-webview', {}, tab)
  const tabsOpened = () => shell.scripts.filter((script) => script.includes('addTabFromLink'))
  // The options the window's tab strip was handed for each new tab.
  const tabOptions = () => tabsOpened().map((script) => JSON.parse(/addTabFromLink\([^,]+, \d+, (\{.*?\})\);/.exec(script)[1]))
  return { shell, tab, opened, tabsOpened, tabOptions }
}

describe('a person opening links in new tabs', function () {
  it('opens every one, however quickly they come', async function () {
    const { tab, tabsOpened } = await loadMenus()
    for (let i = 1; i <= 5; i++) {
      tab.click()
      expect(tab.open({ url: `https://example.com/${i}` })).to.deep.equal({ action: 'deny' })
    }
    await settle()
    expect(tabsOpened()).to.have.length(5)
  })

  it('still limits what a page opens on its own', async function () {
    const { tab, tabsOpened } = await loadMenus()
    for (let i = 1; i <= 5; i++) tab.open({ url: `https://example.com/${i}` })
    await settle()
    expect(tabsOpened()).to.have.length(3)
  })

  it('lets one click open one tab, and counts any more the page opens with it', async function () {
    const { tab, tabsOpened } = await loadMenus()
    tab.click()
    for (let i = 1; i <= 6; i++) tab.open({ url: `https://example.com/${i}` })
    await settle()
    expect(tabsOpened()).to.have.length(4)
  })
})

// Cmd+click and a middle click opened the tab in front, where Chrome leaves it
// behind the page.
describe('a link opened behind the page', function () {
  it('stays behind it for Cmd+click and a middle click', async function () {
    const { tab, tabOptions } = await loadMenus()
    tab.click()
    tab.open({ url: 'https://example.com/a', disposition: 'background-tab' })
    tab.click()
    tab.open({ url: 'https://example.com/b', disposition: 'background-tab', features: 'noopener' })
    await settle()
    expect(tabOptions().map((options) => options.background)).to.deep.equal([true, true])
  })

  it('comes to the front for a plain click and Cmd+Shift+click', async function () {
    const { tab, tabOptions } = await loadMenus()
    tab.click()
    tab.open({ url: 'https://example.com/a', disposition: 'foreground-tab' })
    await settle()
    expect(tabOptions()).to.deep.equal([{ background: false }])
  })

  it('is not selected, and leaves the address bar to the page', function () {
    const fromLink = tabBar.slice(tabBar.indexOf('  addTabFromLink ('), tabBar.indexOf('  findTabByWebContentsId ('))
    expect(fromLink).to.contain("const tabId = background ? this.addBackgroundTab(url, 'New Tab', tabData) : this.addTab(url, 'New Tab', tabData)")
    const behind = tabBar.slice(tabBar.indexOf('  addBackgroundTab ('), tabBar.indexOf('  // Create a new webview for a tab'))
    expect(behind).to.contain('this.addTabWithId(tabId, url, title, tabData)')
    expect(behind).to.not.contain('selectTab')
    expect(behind).to.not.contain("getElementById('url')")
  })
})

// Shift+click opened a bare 600 by 700 window, and window.open's own size and
// place were ignored.
describe('a link or page opening a window', function () {
  it('gets a browser window of its own for Shift+click', async function () {
    const { tab, opened } = await loadMenus()
    tab.click()
    expect(tab.open({ url: 'https://example.com/a', disposition: 'new-window' })).to.deep.equal({ action: 'deny' })
    expect(opened).to.deep.equal([{ url: 'https://example.com/a', newWindow: true, incognito: false }])
  })

  it('is a popup of the size and place window.open asked for', async function () {
    const { tab, opened } = await loadMenus()
    tab.click()
    const answer = tab.open({ url: 'https://example.com/a', disposition: 'new-window', features: 'width=500,height=400,left=40,top=60' })
    expect(answer.action).to.equal('allow')
    expect(answer.overrideBrowserWindowOptions).to.include({ width: 500, height: 400, useContentSize: true, x: 40, y: 60 })
    expect(opened).to.deep.equal([])
  })

  it('stays 600 by 700 where no size was asked for, wherever the opener is', async function () {
    const { tab } = await loadMenus()
    tab.click()
    const options = tab.open({ url: 'https://example.com/a', disposition: 'new-window', features: 'popup' }).overrideBrowserWindowOptions
    expect(options).to.include({ width: 600, height: 700 })
    expect(options).to.not.have.any.keys('x', 'y', 'useContentSize')
  })

  it('is kept on the screen', async function () {
    const { tab } = await loadMenus()
    tab.click()
    const options = tab.open({ url: 'about:blank', disposition: 'new-window', features: 'width=9000,height=300,left=-5000,top=5000' }).overrideBrowserWindowOptions
    expect(options).to.include({ width: 1440, height: 300, x: 0, y: 600 })
  })
})

// A POST form with target=_blank arrived as a GET, a target=_blank link sent
// no referrer, and a second window.open with the same name opened another tab.
describe('a new tab from a link or form', function () {
  const referrer = { url: 'https://example.com/form', policy: 'strict-origin-when-cross-origin' }
  const postBody = { data: [{ type: 'rawData', bytes: Buffer.from('b=2') }], contentType: 'application/x-www-form-urlencoded' }

  it('loads with the referrer and the POST body the page sent', async function () {
    const { tab, tabOptions } = await loadMenus()
    tab.click()
    tab.open({ url: 'https://example.com/echo', referrer, postBody })
    await settle()
    expect(queuedLoads).to.have.length(1)
    expect(queuedLoads[0].url).to.equal('https://example.com/echo')
    expect(queuedLoads[0].options).to.deep.equal({
      httpReferrer: referrer,
      postData: postBody.data,
      extraHeaders: 'content-type: application/x-www-form-urlencoded'
    })
    expect(tabOptions()).to.deep.equal([{ background: false, loadToken: '00000000-0000-4000-8000-000000000001' }])
  })

  it('keeps a multipart form whole', async function () {
    const { firstLoadOptions } = await loadModule()
    const options = firstLoadOptions({ postBody: { data: [{ type: 'rawData', bytes: Buffer.from('--x') }], contentType: 'multipart/form-data', boundary: 'x' } })
    expect(options.extraHeaders).to.equal('content-type: multipart/form-data; boundary=x')
  })

  it('sends no referrer the page did not, and needs no special load then', async function () {
    const { tab, tabOptions } = await loadMenus()
    tab.click()
    tab.open({ url: 'https://example.com/a', referrer: { url: '', policy: 'no-referrer' } })
    await settle()
    expect(queuedLoads).to.deep.equal([])
    expect(tabOptions()).to.deep.equal([{ background: false }])
  })

  it('opens a name once, and loads it again in the same tab', async function () {
    const { tab, tabsOpened } = await loadMenus()
    tab.click()
    tab.open({ url: 'https://example.com/1', frameName: 'results', referrer })
    await settle()
    expect(tabsOpened()).to.have.length(1)
    const named = Object.assign(new EventEmitter(), { id: 12, isDestroyed: () => false, loads: [], hostWebContents: null })
    named.loadURL = async (url, options) => { named.loads.push([url, options]) }
    queuedLoads[0].onAttach(named)

    tab.click()
    expect(tab.open({ url: 'https://example.com/2', frameName: 'results', referrer, postBody })).to.deep.equal({ action: 'deny' })
    await settle()
    expect(tabsOpened()).to.have.length(1)
    expect(named.loads).to.deep.equal([['https://example.com/2', firstLoadOptionsFor(referrer, postBody)]])

    named.emit('destroyed')
    tab.click()
    tab.open({ url: 'https://example.com/3', frameName: 'results' })
    await settle()
    expect(tabsOpened()).to.have.length(2)
  })

  it('brings the named tab to the front only after a click or key, as in Chrome', async function () {
    const { tab } = await loadMenus()
    tab.click()
    tab.open({ url: 'https://example.com/1', frameName: 'results' })
    await settle()
    const shown = []
    const host = { isDestroyed: () => false, executeJavaScript: async (script) => { shown.push(script) } }
    const named = Object.assign(new EventEmitter(), { id: 12, isDestroyed: () => false, hostWebContents: host, loadURL: async () => {} })
    queuedLoads[0].onAttach(named)

    tab.open({ url: 'https://example.com/2', frameName: 'results' })
    expect(shown).to.deep.equal([])
    tab.click()
    tab.open({ url: 'https://example.com/3', frameName: 'results' })
    expect(shown).to.have.length(1)
    expect(shown[0]).to.contain('tabBar?.findTabByWebContentsId?.(12)')
  })

  it('opens _blank and a noopener open in a new tab every time', async function () {
    const { tab, tabsOpened } = await loadMenus()
    tab.click()
    tab.open({ url: 'https://example.com/1', frameName: 'results', features: 'noopener' })
    tab.click()
    tab.open({ url: 'https://example.com/2', frameName: '_blank' })
    await settle()
    expect(tabsOpened()).to.have.length(2)
    // Neither is kept by a name.
    expect(queuedLoads).to.deep.equal([])
  })

  it('starts the tab on a placeholder its first load replaces', function () {
    const create = tabBar.slice(tabBar.indexOf('  createWebviewForTab ('), tabBar.indexOf('    webview.setAttribute(\'allowpopups\''))
    expect(create).to.contain("} else if (typeof loadToken === 'string' && /^[0-9a-f-]{36}$/i.test(loadToken)) {")
    expect(create).to.contain('src = `about:blank#peersky-load=$' + '{loadToken}`')
  })
})

describe('the first load of a tab a page opened', function () {
  it('takes the placeholder\'s place with what the page sent, and tells which tab it is', async function () {
    const mod = await esmock.strict('../src/navigation-restore.js', {
      electron: { ipcMain: { on () {}, handle () {} } },
      '../src/logger.js': { createLogger: () => ({ warn () {} }) }
    })
    const listeners = {}
    mod.watchHost({ on: (event, fn) => { listeners[event] = fn } })
    const attached = []
    const options = { httpReferrer: { url: 'https://example.com/', policy: 'strict-origin-when-cross-origin' } }
    const token = mod.queueFirstLoad({ url: 'https://example.com/echo', options, onAttach: (guest) => attached.push(guest.id) })
    const params = { src: mod.LOAD_PLACEHOLDER + token }
    listeners['will-attach-webview']({}, {}, params)
    expect(params.src).to.equal('')
    const loads = []
    await listeners['did-attach-webview']({}, { id: 5, loadURL: async (...args) => { loads.push(args) } })
    expect(loads).to.deep.equal([['https://example.com/echo', options]])
    expect(attached).to.deep.equal([5])

    // Used once.
    const again = { src: mod.LOAD_PLACEHOLDER + token }
    listeners['will-attach-webview']({}, {}, again)
    expect(again.src).to.equal(mod.LOAD_PLACEHOLDER + token)
  })
})

function firstLoadOptionsFor (referrer, postBody) {
  return { httpReferrer: referrer, postData: postBody.data, extraHeaders: `content-type: ${postBody.contentType}` }
}

describe('window.open features', function () {
  it('are read as Chrome reads them', async function () {
    const { popupBoundsFromFeatures } = await loadModule()
    expect(popupBoundsFromFeatures('width=500,height=400,left=40,top=60')).to.deep.equal({ width: 500, height: 400, x: 40, y: 60 })
    expect(popupBoundsFromFeatures('innerWidth=300, innerHeight = 200, screenX=10, screenY=20, menubar=no')).to.deep.equal({ width: 300, height: 200, x: 10, y: 20 })
    expect(popupBoundsFromFeatures('WIDTH=320px,height=50')).to.deep.equal({ width: 320, height: 100 })
    expect(popupBoundsFromFeatures('popup,noopener')).to.deep.equal({})
    expect(popupBoundsFromFeatures('')).to.deep.equal({})
  })
})

describe('input in a page', function () {
  it('is a click or a key the browser saw, used up by one open', function () {
    const tab = fakeTab()
    watchPageInput(tab)
    expect(takeInputGrant(tab)).to.equal(false)
    tab.emit('before-mouse-event', {}, { type: 'mouseMove' })
    tab.emit('before-mouse-event', {}, { type: 'mouseWheel' })
    tab.emit('before-input-event', {}, { type: 'keyUp', key: 'a' })
    expect(takeInputGrant(tab)).to.equal(false)
    tab.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'middle' })
    expect(takeInputGrant(tab)).to.equal(true)
    expect(takeInputGrant(tab)).to.equal(false)
    tab.emit('before-input-event', {}, { type: 'keyDown', key: 'Enter' })
    expect(takeInputGrant(tab)).to.equal(true)
  })

  it('only counts for a moment', function () {
    const tab = fakeTab()
    watchPageInput(tab)
    tab.click()
    expect(takeInputGrant(tab, Date.now() + INPUT_GRACE_MS + 1)).to.equal(false)
  })

  it('is never there for a page nobody watched', function () {
    expect(takeInputGrant(fakeTab())).to.equal(false)
  })
})
