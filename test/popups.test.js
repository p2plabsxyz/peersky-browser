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

async function loadMenus () {
  const { attachContextMenus } = await esmock.strict('../src/context-menu.js', {
    electron: { Menu: class {}, MenuItem: class {}, clipboard: {}, dialog: {} },
    '../src/external-scheme.js': { isExternalScheme: () => false, openExternalScheme () {} },
    '../src/extensions/index.js': { default: {} },
    '../src/devtools-dock.js': { openDockedDevTools () {} }
  })
  const shell = new EventEmitter()
  shell.id = 1
  shell.scripts = []
  shell.executeJavaScript = async (script) => { shell.scripts.push(script); return true }
  shell.setWindowOpenHandler = () => {}
  const browserWindow = { webContents: shell }
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
