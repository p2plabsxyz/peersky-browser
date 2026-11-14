// A page's "leave site?" handler was never asked: Enter in the address bar and
// Reload did nothing, and Cmd+W closed the tab without a word.

import { expect } from 'chai'
import { EventEmitter } from 'events'
import { readFile } from 'fs/promises'
import esmock from 'esmock'
import { watchPageInput, hasBeenUsed } from '../src/page-input.js'

const read = async (file) => (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
const tabBar = await read('../src/pages/tab-bar.js')
const actions = await read('../src/actions.js')
const main = await read('../src/main.js')
const renderer = await read('../src/renderer.js')

async function load ({ answer = 0 } = {}) {
  const asked = []
  const handlers = new Map()
  const tabs = new Map()
  const window = { isDestroyed: () => false }
  const mod = await esmock.strict('../src/leave-site.js', {
    electron: {
      BrowserWindow: { fromWebContents: (host) => (host?.id === 1 ? window : null) },
      dialog: {
        showMessageBoxSync (parent, options) {
          asked.push({ parent, options })
          return answer
        }
      },
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      webContents: { fromId: (id) => tabs.get(id) || null }
    }
  })
  mod.registerTabClosing()
  const host = { id: 1, isDestroyed: () => false, sent: [], send (...args) { host.sent.push(args) } }
  const fakeTab = (id = 7) => {
    const tab = new EventEmitter()
    Object.assign(tab, { id, hostWebContents: host, closed: [], getType: () => 'webview', isDestroyed: () => false })
    tab.close = (options) => { tab.closed.push(options) }
    tabs.set(id, tab)
    mod.watchLeaving(tab)
    return tab
  }
  const unload = (tab) => {
    let left = false
    tab.emit('will-prevent-unload', { preventDefault: () => { left = true } })
    return left
  }
  const askToClose = (id, sender = host) => handlers.get('close-tab-asking-page')({ sender }, id)
  const use = (tab) => tab.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left' })
  return { mod, asked, window, host, fakeTab, unload, askToClose, use }
}

describe('a page that asks before it is left', function () {
  it('gets Chrome\'s question, on its window', async function () {
    const { asked, window, fakeTab, unload } = await load({ answer: 0 })
    expect(unload(fakeTab())).to.equal(true)
    expect(asked).to.have.length(1)
    expect(asked[0].parent).to.equal(window)
    expect(asked[0].options).to.include({ message: 'Leave site?', detail: 'Changes that you made may not be saved.', defaultId: 0, cancelId: 1 })
    expect(asked[0].options.buttons).to.deep.equal(['Leave', 'Stay'])
  })

  it('is left only when the person says Leave, and its tab shows its own address again', async function () {
    const { fakeTab, unload, host } = await load({ answer: 1 })
    expect(unload(fakeTab())).to.equal(false)
    expect(host.sent).to.deep.equal([['tab-stayed', 7]])
  })

  it('keeps its page when the person stays as its tab closes, as a window does', async function () {
    const { fakeTab } = await load()
    const tab = fakeTab()
    const decide = (proceed) => {
      let kept = false
      tab.emit('-before-unload-fired', { preventDefault: () => { kept = true } }, proceed)
      return kept
    }
    expect(decide(false)).to.equal(true)
    expect(decide(true)).to.equal(false)
  })

  it('is asked when its tab is closed, and the tab goes once the page lets it', async function () {
    const { fakeTab, askToClose, use } = await load({ answer: 0 })
    const tab = fakeTab()
    use(tab)
    const closing = askToClose(7)
    await Promise.resolve()
    expect(tab.closed).to.deep.equal([{ waitForBeforeUnload: true }])
    tab.emit('close')
    expect(await closing).to.equal(true)
  })

  it('keeps its tab when the person says Stay', async function () {
    const { fakeTab, askToClose, use, unload } = await load({ answer: 1 })
    const tab = fakeTab()
    use(tab)
    const closing = askToClose(7)
    await Promise.resolve()
    unload(tab)
    expect(await closing).to.equal(false)
  })

  it('is not asked when nobody has clicked or typed in it, as in Chrome', async function () {
    const { fakeTab, askToClose } = await load()
    const tab = fakeTab()
    expect(await askToClose(7)).to.equal(true)
    expect(tab.closed).to.deep.equal([])
  })

  it('belongs to its own window: another cannot close it', async function () {
    const { fakeTab, askToClose, use } = await load()
    const tab = fakeTab()
    use(tab)
    expect(await askToClose(7, { id: 2 })).to.equal(false)
    expect(tab.closed).to.deep.equal([])
    expect(await askToClose(99)).to.equal(true)
  })
})

describe('a page someone has used', function () {
  const fakePage = () => {
    const page = new EventEmitter()
    watchPageInput(page)
    return page
  }

  it('is one clicked or typed in since it loaded', function () {
    const page = fakePage()
    expect(hasBeenUsed(page)).to.equal(false)
    page.emit('before-mouse-event', {}, { type: 'mouseMove' })
    page.emit('before-input-event', {}, { type: 'keyDown', key: 'w', meta: true })
    page.emit('before-input-event', {}, { type: 'keyDown', key: 'Escape' })
    expect(hasBeenUsed(page)).to.equal(false)
    page.emit('before-input-event', {}, { type: 'keyDown', key: 'a' })
    expect(hasBeenUsed(page)).to.equal(true)
    page.emit('did-navigate')
    expect(hasBeenUsed(page)).to.equal(false)
    page.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left' })
    expect(hasBeenUsed(page)).to.equal(true)
  })
})

describe('closing a tab', function () {
  it('asks its page first, from the close button, the menus and the tab menu', function () {
    expect(tabBar).to.contain('  askToCloseTab (tabId) {')
    expect(tabBar).to.match(/closeButton\.addEventListener\('click', \(e\) => \{\s+e\.stopPropagation\(\)\s+this\.askToCloseTab\(tabId\)/)
    expect(actions.match(/tabBar\.askToCloseTab\(activeTab\.id\)/g)).to.have.length(2)
    expect(main).to.contain('watchLeaving(wc)')
    expect(main).to.contain('registerTabClosing()')
  })

  it('takes the tab away only once main says the page let go', function () {
    const ask = tabBar.slice(tabBar.indexOf('  askToCloseTab (tabId) {'), tabBar.indexOf('  closeTab (tabId) {'))
    expect(ask).to.contain("ipcRenderer.invoke('close-tab-asking-page', webContentsId)")
    expect(ask).to.contain('if (close) this.closeTab(tabId)')
  })

  it('shows the page the person stayed on in the address bar', function () {
    const stayed = tabBar.slice(tabBar.indexOf('  stayedOnPage (webContentsId) {'), tabBar.indexOf('  addTabToTheRight ('))
    expect(stayed).to.contain('this.updateTab(tab.id, { url })')
    expect(stayed).to.contain("this.dispatchEvent(new CustomEvent('tab-navigated', { detail: { tabId: tab.id, url } }))")
    expect(renderer).to.contain('tabBar?.stayedOnPage?.(webContentsId)')
  })
})
