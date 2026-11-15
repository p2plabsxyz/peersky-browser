// Chrome's tab shortcuts: Cmd+Shift+T did nothing, nor did Cmd+1 to Cmd+9,
// Cmd+Shift+R, Ctrl+Tab on a Mac, Cmd+Shift+] and [, or Escape on a page
// still loading.

import { expect } from 'chai'
import { readFile } from 'fs/promises'
import vm from 'vm'
import esmock from 'esmock'
import { reservedTabShortcut, tabBarCall } from '../src/tab-shortcuts.js'

const source = async (file) => (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')

const key = (fields) => ({ type: 'keyDown', key: '', code: '', shift: false, control: false, alt: false, meta: false, isComposing: false, ...fields })

describe('keys a page never keeps', function () {
  it('Cmd+Shift+T on a Mac and Ctrl+Shift+T elsewhere reopen the tab closed last', function () {
    const reopen = { method: 'reopenClosedTab', args: [] }
    expect(reservedTabShortcut(key({ key: 'T', code: 'KeyT', meta: true, shift: true }), 'darwin')).to.deep.equal(reopen)
    expect(reservedTabShortcut(key({ key: 'T', code: 'KeyT', control: true, shift: true }), 'linux')).to.deep.equal(reopen)
    expect(reservedTabShortcut(key({ key: 'T', code: 'KeyT', control: true, shift: true }), 'win32')).to.deep.equal(reopen)
    expect(reservedTabShortcut(key({ key: 'T', code: 'KeyT', control: true, shift: true }), 'darwin')).to.equal(null)
    expect(reservedTabShortcut(key({ key: 't', code: 'KeyT', meta: true }), 'darwin'), 'Cmd+T is New Tab').to.equal(null)
  })

  it('go by the key that types T, or its place on a layout with no Latin letters', function () {
    const reopen = (fields) => reservedTabShortcut(key({ meta: true, shift: true, ...fields }), 'darwin')?.method
    expect(reopen({ key: 't', code: 'KeyK' }), 'Dvorak T').to.equal('reopenClosedTab')
    expect(reopen({ key: 'y', code: 'KeyT' }), 'Dvorak Y on the T key').to.equal(undefined)
    expect(reopen({ key: 'Е', code: 'KeyT' }), 'Russian').to.equal('reopenClosedTab')
  })

  it('Ctrl+Tab and Ctrl+Shift+Tab go to the next tab and the one before, on a Mac too', function () {
    for (const platform of ['darwin', 'linux', 'win32']) {
      expect(reservedTabShortcut(key({ key: 'Tab', code: 'Tab', control: true }), platform)).to.deep.equal({ method: 'selectAdjacentTab', args: [1] })
      expect(reservedTabShortcut(key({ key: 'Tab', code: 'Tab', control: true, shift: true }), platform)).to.deep.equal({ method: 'selectAdjacentTab', args: [-1] })
    }
  })

  it('Cmd+Option+Right and Left, and Cmd+Shift+] and [, do on a Mac', function () {
    const step = (fields, platform = 'darwin') => reservedTabShortcut(key(fields), platform)?.args?.[0]
    expect(step({ key: 'ArrowRight', code: 'ArrowRight', meta: true, alt: true })).to.equal(1)
    expect(step({ key: 'ArrowLeft', code: 'ArrowLeft', meta: true, alt: true })).to.equal(-1)
    expect(step({ key: '}', code: 'BracketRight', meta: true, shift: true })).to.equal(1)
    expect(step({ key: ']', code: 'BracketRight', meta: true, shift: true })).to.equal(1)
    expect(step({ key: '{', code: 'BracketLeft', meta: true, shift: true })).to.equal(-1)
    expect(step({ key: ']', code: 'BracketRight', meta: true }), 'Cmd+] is Forward').to.equal(undefined)
    expect(step({ key: '}', code: 'BracketRight', control: true, shift: true }, 'win32')).to.equal(undefined)
    expect(step({ key: 'ArrowRight', code: 'ArrowRight', control: true, alt: true }, 'linux')).to.equal(undefined)
  })

  it('leaves the rest to the page first, as Chrome does', function () {
    for (const fields of [
      { key: '1', code: 'Digit1', meta: true },
      { key: 'r', code: 'KeyR', meta: true },
      { key: 'R', code: 'KeyR', meta: true, shift: true },
      { key: 'Escape', code: 'Escape' },
      { key: 'a', code: 'KeyA' }
    ]) {
      expect(reservedTabShortcut(key(fields), 'darwin'), JSON.stringify(fields)).to.equal(null)
    }
    expect(reservedTabShortcut(key({ type: 'keyUp', key: 'T', code: 'KeyT', meta: true, shift: true }), 'darwin')).to.equal(null)
  })
})

// Escape stopped the page before the page had the key, which cut short the
// loads of a page that used Escape to close its own dialog.
describe('Escape on a page still loading', function () {
  let pressEscape
  before(async function () {
    const preload = await source('../src/pages/unified-preload.js')
    const start = preload.indexOf("window.addEventListener('keydown', (event) => {\n  if (!event.isTrusted || event.key !== 'Escape'")
    expect(start).to.be.above(-1)
    const block = preload.slice(start, preload.indexOf('\n})\n', start) + 4)
    pressEscape = async (init = {}) => {
      const sent = []
      let listener = null
      const window = { addEventListener: (type, fn) => { if (type === 'keydown') listener = fn } }
      vm.runInNewContext(block, { window, setTimeout, ipcRenderer: { send: (channel) => sent.push(channel) } })
      listener({ isTrusted: true, key: 'Escape', isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, defaultPrevented: false, ...init })
      await new Promise((resolve) => setTimeout(resolve, 5))
      return sent
    }
  })

  it('stops the page when the page did not use it', async function () {
    expect(await pressEscape()).to.deep.equal(['peersky-stop-loading'])
  })

  it('leaves a page that used it loading', async function () {
    expect(await pressEscape({ defaultPrevented: true })).to.deep.equal([])
  })

  it('is Escape alone, pressed by the person', async function () {
    for (const held of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey', 'isComposing']) {
      expect(await pressEscape({ [held]: true }), held).to.deep.equal([])
    }
    expect(await pressEscape({ isTrusted: false })).to.deep.equal([])
    expect(await pressEscape({ key: 'a' })).to.deep.equal([])
  })

  it("stops only a tab's own page, from its top frame, while it loads", async function () {
    const main = await source('../src/main.js')
    const handler = main.slice(main.indexOf("ipcMain.on('peersky-stop-loading'"), main.indexOf("ipcMain.on('group-action'"))
    expect(handler).to.contain("tab.getType() !== 'webview'")
    expect(handler).to.contain('if (event.senderFrame?.parent) return')
    expect(handler).to.contain('if (tab.isLoadingMainFrame()) tab.stop()')
  })
})

describe('the shortcuts in a tab and in the menu', function () {
  let main, actionsSource
  before(async function () {
    main = await source('../src/main.js')
    actionsSource = await source('../src/actions.js')
  })

  it("take a tab's reserved keys before its page has them", function () {
    const handler = main.slice(main.indexOf("  wc.on('before-input-event', (event, input) => {"), main.indexOf('// A page is a process of its own'))
    expect(handler).to.not.contain('stop()')
    expect(handler).to.contain('const shortcut = reservedTabShortcut(input)')
    expect(handler.indexOf('event.preventDefault()')).to.be.above(handler.indexOf('if (!shortcut) return'))
    expect(handler).to.contain('runOnShell(tabBarCall(shortcut.method, ...shortcut.args))')
  })

  it('call the tab bar of whichever layout the window has', function () {
    const calls = []
    const document = { querySelector: (selector) => (selector === '#tabbar' ? { reloadActiveTab: (...args) => calls.push(args) } : null) }
    vm.runInNewContext(tabBarCall('reloadActiveTab', { ignoreCache: true }), { document, console })
    vm.runInNewContext(tabBarCall('missingMethod', 1), { document, console })
    expect(calls).to.deep.equal([[{ ignoreCache: true }]])
    expect(actionsSource).to.contain("import { tabBarCall } from './tab-shortcuts.js'")
  })

  async function loadActions (platform) {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: platform })
    try {
      const executed = []
      const focusedWindow = { webContents: { executeJavaScript: (script) => { executed.push(script); return Promise.resolve() } } }
      const module = await esmock.strict('../src/actions.js', {
        electron: {
          app: { name: 'Peersky', getVersion: () => '0.0.0' },
          BrowserWindow: { getFocusedWindow: () => focusedWindow },
          webContents: { fromId: () => null }
        },
        '../src/history-nav.js': { goBackActiveTab () {}, goForwardActiveTab () {} },
        '../src/devtools-dock.js': { toggleDockedDevTools () {} }
      })
      return { actions: module.createActions({ all: [] }), template: module.createMenuTemplate({ all: [] }), executed }
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  }

  const everyItem = (template) => template.flatMap(function walk (item) { return item.submenu ? item.submenu.flatMap(walk) : [item] })

  for (const platform of ['darwin', 'linux']) {
    it(`are in the menu on ${platform}, each key once`, async function () {
      const { template } = await loadActions(platform)
      const items = everyItem(template)
      const find = (accelerator) => items.filter((item) => item.accelerator === accelerator)
      const wanted = ['CommandOrControl+Shift+T', 'CommandOrControl+Shift+R',
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `CommandOrControl+${n}`),
        ...(platform === 'darwin'
          ? ['Control+Tab', 'Control+Shift+Tab', 'Command+Shift+]', 'Command+Shift+[']
          : ['F5', 'Shift+F5', 'Control+F5'])]
      for (const accelerator of wanted) expect(find(accelerator), accelerator).to.have.length(1)
      const file = template.find((menu) => menu.label === 'File').submenu
      expect(file.find((item) => item.label === 'Reopen Closed Tab').accelerator).to.equal('CommandOrControl+Shift+T')
      const view = template.find((menu) => menu.label === 'View').submenu
      expect(view.find((item) => item.label === 'Force Reload').accelerator).to.equal('CommandOrControl+Shift+R')
      expect(find('CommandOrControl+1')[0].visible, 'shown in no menu, as in Chrome').to.equal(false)
    })
  }

  it('reach the tab bar of the window in front', async function () {
    const { actions, executed } = await loadActions('darwin')
    actions.ReopenClosedTab.click()
    actions.ForceReload.click()
    actions.SelectTab3.click()
    actions.SelectLastTab.click()
    actions.NextTabControl.click()
    actions.PreviousTabBracket.click()
    expect(executed[0]).to.contain('tabBar.reopenClosedTab()')
    expect(executed[1]).to.contain('tabBar.reloadActiveTab({"ignoreCache":true})')
    expect(executed[2]).to.contain('tabBar.selectTabByNumber(3)')
    expect(executed[3]).to.contain('tabBar.selectTabByNumber(9)')
    expect(executed[4]).to.contain('tabBar.selectAdjacentTab(1)')
    expect(executed[5]).to.contain('tabBar.selectAdjacentTab(-1)')
  })
})

// The tab bar's own code, run on a stand-in tab bar.
describe('the tab bar', function () {
  let TabBar, navigations

  before(async function () {
    const code = await source('../src/pages/tab-bar.js')
    navigations = new Map()
    const sandbox = {
      HTMLElement: class {},
      customElements: { define: (_name, cls) => { sandbox.TabBar = cls } },
      document: { getElementById: () => null, querySelector: () => null },
      require: (name) => (name === 'electron'
        ? { ipcRenderer: { sendSync: (channel, id) => (channel === 'get-tab-navigation' ? navigations.get(id) ?? null : null) } }
        : {}),
      URL,
      console
    }
    vm.runInNewContext(code, sandbox)
    TabBar = sandbox.TabBar
  })

  function bar (urls, { active = 0, pinned = [], groups = {}, liveGroups = [] } = {}) {
    const b = Object.create(TabBar.prototype)
    b.tabs = urls.map((url, i) => ({ id: `t${i}`, url, title: `Title ${i}` }))
    b.webviews = new Map(b.tabs.map((tab, i) => [tab.id, { getWebContentsId: () => 100 + i }]))
    b.activeTabId = b.tabs[active]?.id ?? null
    b.pinnedTabs = new Set(pinned)
    b.tabGroupAssignments = new Map(Object.entries(groups))
    b.tabGroups = new Map(liveGroups.map((id) => [id, { id }]))
    b.tabCounter = 50
    b.added = []
    b.selectTab = (id) => { b.activeTabId = id }
    b.addTabWithId = (id, url, title, data) => {
      b.tabs.push({ id, url, title })
      b.added.push({ id, url, title, navigation: data.navigation })
      return id
    }
    b.moveTabToPosition = (id, position) => {
      const [tab] = b.tabs.splice(b.tabs.findIndex((t) => t.id === id), 1)
      b.tabs.splice(Math.max(0, Math.min(position, b.tabs.length)), 0, tab)
    }
    b.addTabToGroup = (id, groupId) => b.tabGroupAssignments.set(id, groupId)
    b.normalizeGroupLayout = () => {}
    b.updateGroupedTabsUI = () => {}
    b.saveTabsState = () => {}
    return b
  }

  // Closes like closeTab does, as far as the closed tabs go.
  function close (b, id) {
    const index = b.tabs.findIndex((tab) => tab.id === id)
    b.rememberClosedTab(b.tabs[index], index)
    b.tabs.splice(index, 1)
  }

  // Empties what earlier tests left, taking out the tabs that brings back.
  function forgetAll (b) {
    for (let id = b.reopenClosedTab(); id; id = b.reopenClosedTab()) {
      b.tabs.splice(b.tabs.findIndex((tab) => tab.id === id), 1)
    }
  }

  it('reopens the tab closed last, then the one before, again and again, then nothing', function () {
    const b = bar(['https://a.example/', 'https://b.example/', 'https://c.example/'])
    forgetAll(b)
    close(b, 't1')
    close(b, 't2')
    const urlOf = (id) => b.tabs.find((tab) => tab.id === id).url
    expect(urlOf(b.reopenClosedTab())).to.equal('https://c.example/')
    expect(urlOf(b.reopenClosedTab())).to.equal('https://b.example/')
    expect(b.reopenClosedTab()).to.equal(null)
  })

  it('shows the tab it brings back, where it was', function () {
    const b = bar(['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/'])
    forgetAll(b)
    close(b, 't1')
    const id = b.reopenClosedTab()
    expect(b.activeTabId).to.equal(id)
    expect(b.tabs.map((tab) => tab.url)).to.deep.equal(['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/'])
  })

  it('brings back its pages for Back and Forward', function () {
    const b = bar(['https://a.example/', 'https://b.example/', 'https://c.example/'])
    forgetAll(b)
    const history = { entries: [{ url: 'https://b.example/1', title: 'one' }, { url: 'https://b.example/', title: 'two' }], activeIndex: 1 }
    navigations.set(101, history)
    close(b, 't1')
    b.reopenClosedTab()
    expect(b.added.at(-1).navigation).to.deep.equal(history)
  })

  it("takes a sleeping tab's pages as they were kept, and opens a page with none at its address", function () {
    const b = bar(['https://a.example/', 'https://b.example/', 'https://c.example/'])
    forgetAll(b)
    const kept = { entries: [{ url: 'https://c.example/', title: 'c' }], activeIndex: 0 }
    b.tabs[2].savedNavigation = kept
    b.webviews.delete('t2')
    navigations.set(101, { entries: [{ url: 'about:blank', title: '' }], activeIndex: 0 })
    close(b, 't2')
    close(b, 't1')
    b.reopenClosedTab()
    expect(b.added.at(-1)).to.include({ url: 'https://b.example/', navigation: null })
    b.reopenClosedTab()
    expect(b.added.at(-1).navigation).to.equal(kept)
  })

  it('keeps the last 25, as Chrome does', function () {
    const b = bar(Array.from({ length: 31 }, (_, i) => `https://site${i}.example/`))
    forgetAll(b)
    for (let i = 1; i <= 30; i++) close(b, `t${i}`)
    const back = []
    for (let id = b.reopenClosedTab(); id; id = b.reopenClosedTab()) back.push(b.tabs.find((tab) => tab.id === id).url)
    expect(back).to.have.length(25)
    expect(back[0]).to.equal('https://site30.example/')
    expect(back[24]).to.equal('https://site6.example/')
  })

  it('puts a pinned tab back among the pinned, and a tab back in its group while the group is there', function () {
    const b = bar(['https://p.example/', 'https://g.example/', 'https://x.example/', 'https://y.example/'],
      { pinned: ['t0'], groups: { t1: 'g1', t2: 'gone' }, liveGroups: ['g1'] })
    forgetAll(b)
    close(b, 't0')
    close(b, 't1')
    close(b, 't2')
    const ungrouped = b.reopenClosedTab()
    expect(b.tabGroupAssignments.has(ungrouped), 'its group was gone').to.equal(false)
    const grouped = b.reopenClosedTab()
    expect(b.tabGroupAssignments.get(grouped)).to.equal('g1')
    const pinned = b.reopenClosedTab()
    expect(b.pinnedTabs.has(pinned)).to.equal(true)
    expect(b.tabs[0].id).to.equal(pinned)
  })

  it('picks a tab by its number, and the last one for 9', function () {
    const b = bar(['a', 'b', 'c'].map((name) => `https://${name}.example/`))
    b.selectTabByNumber(2)
    expect(b.activeTabId).to.equal('t1')
    b.selectTabByNumber(9)
    expect(b.activeTabId).to.equal('t2')
    b.selectTabByNumber(5)
    expect(b.activeTabId, 'no fifth tab').to.equal('t2')
  })

  it('goes to the next tab and the one before, round the ends', function () {
    const b = bar(['a', 'b', 'c'].map((name) => `https://${name}.example/`), { active: 2 })
    b.selectAdjacentTab(1)
    expect(b.activeTabId).to.equal('t0')
    b.selectAdjacentTab(-1)
    expect(b.activeTabId).to.equal('t2')
    const one = bar(['https://a.example/'])
    one.selectAdjacentTab(1)
    expect(one.activeTabId).to.equal('t0')
  })

  it('reloads without the cache for Cmd+Shift+R, and tries a failed address again', function () {
    const b = bar(['https://a.example/'])
    const calls = []
    let current = 'https://a.example/'
    b.getActiveWebview = () => ({
      getURL: () => current,
      reload: () => calls.push('reload'),
      reloadIgnoringCache: () => calls.push('reloadIgnoringCache'),
      // A failed address is tried again in place of its error page.
      executeJavaScript: (code) => {
        calls.push(code.includes('location.replace("https://down.example/")') ? 'retry https://down.example/' : code)
        return Promise.resolve()
      }
    })
    b.navigateActiveTab = (url) => calls.push(`navigate ${url}`)
    b.reloadActiveTab()
    b.reloadActiveTab({ ignoreCache: true })
    current = 'peersky://error.html?url=https%3A%2F%2Fdown.example%2F'
    b.reloadActiveTab({ ignoreCache: true })
    expect(calls).to.deep.equal(['reload', 'reloadIgnoringCache', 'retry https://down.example/'])
  })

  it('remembers a tab as it closes, and not when the window goes with its last tab', async function () {
    const code = await source('../src/pages/tab-bar.js')
    const closeTab = code.slice(code.indexOf('  closeTab (tabId) {'), code.indexOf('  // What Cmd+Shift+T needs'))
    expect(closeTab.indexOf('this.rememberClosedTab(this.tabs[tabIndex], tabIndex)')).to.be.above(closeTab.indexOf("ipcRenderer.send('close-window')"))
    expect(closeTab.indexOf('this.rememberClosedTab(')).to.be.below(closeTab.indexOf('this.tabs.splice(tabIndex, 1)'))
    expect(code, 'kept in memory only').to.contain('const closedTabs = []')
    expect(code.slice(code.indexOf('  getTabsStateForSaving () {'), code.indexOf('  rememberFavicon ('))).to.not.contain('closedTabs')
  })
})
