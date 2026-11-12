// What a page opens in a new tab or window, as Chrome opens it. The handler in
// context-menu.js runs over stubbed Electron, with a fake tab whose input and
// window opens are driven by hand.

import { expect } from 'chai'
import { EventEmitter } from 'events'
import esmock from 'esmock'
import { watchPageInput, takeInputGrant, INPUT_GRACE_MS } from '../src/page-input.js'

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
  return { shell, tab, opened, tabsOpened }
}

describe('a person opening links in new tabs', function () {
  it('opens every one, however quickly they come', async function () {
    const { tab, tabsOpened } = await loadMenus()
    for (let i = 1; i <= 5; i++) {
      tab.click()
      expect(tab.open({ url: `https://example.com/${i}` })).to.deep.equal({ action: 'deny' })
    }
    expect(tabsOpened()).to.have.length(5)
  })

  it('still limits what a page opens on its own', async function () {
    const { tab, tabsOpened } = await loadMenus()
    for (let i = 1; i <= 5; i++) tab.open({ url: `https://example.com/${i}` })
    expect(tabsOpened()).to.have.length(3)
  })

  it('lets one click open one tab, and counts any more the page opens with it', async function () {
    const { tab, tabsOpened } = await loadMenus()
    tab.click()
    for (let i = 1; i <= 6; i++) tab.open({ url: `https://example.com/${i}` })
    expect(tabsOpened()).to.have.length(4)
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
