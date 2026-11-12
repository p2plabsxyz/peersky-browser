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

const loadModule = () => esmock.strict('../src/context-menu.js', {
  electron: { Menu: class {}, MenuItem: class {}, clipboard: {}, dialog: {}, screen: { getDisplayMatching: () => ({ workArea: WORK_AREA }) } },
  '../src/external-scheme.js': { isExternalScheme: () => false, openExternalScheme () {} },
  '../src/extensions/index.js': { default: {} },
  '../src/devtools-dock.js': { openDockedDevTools () {} }
})

async function loadMenus () {
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
    expect(fromLink).to.contain("const tabId = background ? this.addBackgroundTab(url, 'New Tab') : this.addTab(url, 'New Tab')")
    const behind = tabBar.slice(tabBar.indexOf('  addBackgroundTab ('), tabBar.indexOf('  // Create a new webview for a tab'))
    expect(behind).to.contain('this.addTabWithId(tabId, url, title)')
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
