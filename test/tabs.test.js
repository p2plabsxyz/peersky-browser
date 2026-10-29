// Tab bar behaviour: dragging between windows, the floating drag preview, the
// hover card, switching layouts, and media autoplay.

import { expect } from 'chai'
import { readFile } from 'fs/promises'
import { EventEmitter } from 'events'
import esmock from 'esmock'
import sinon from 'sinon'

// Windows checks the repo out with CRLF line endings, and some checks below
// span a line break.
const source = async (file) => (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
const tabBar = await source('../src/pages/tab-bar.js')
const windows = await source('../src/window-manager.js')
const renderer = await source('../src/renderer.js')
const main = await source('../src/main.js')
const vertical = await source('../src/pages/vertical-tabs.js')
const verticalCss = await source('../src/pages/theme/vertical-tabs.css')

// The preview module creates windows, so electron is stubbed out.
const preview = await esmock.strict('../src/tab-drag-preview.js', {
  electron: { BrowserWindow: class {}, ipcMain: { handle () {}, on () {} } },
  '../src/session.js': { getPartition: () => 'persist:test' }
})
const previewSource = await source('../src/tab-drag-preview.js')

// A tab dragged onto another window opened a new window instead of joining it.
describe('dragging a tab onto another window', function () {
  it('asks which window is under the drop point before tearing off', function () {
    expect(tabBar).to.contain('this.moveTabOut(idsToMove[0], e.screenX, e.screenY)')
    expect(tabBar).to.contain("ipcRenderer.invoke('window-at-point'")
    expect(tabBar).to.contain('if (targetId === null) return this.moveTabToNewWindow(tabId)')
  })

  it('resolves the point against every other window, never the source', function () {
    const handler = windows.slice(windows.indexOf("'window-at-point'"), windows.indexOf("'move-tab-to-window'"))
    expect(handler).to.contain('win.webContents.id === event.sender.id) continue')
    expect(handler).to.contain('win.getBounds()')
  })

  it('hands the tab to the target and focuses it', function () {
    const handler = windows.slice(windows.indexOf("'move-tab-to-window'"), windows.indexOf("'new-window-with-split-tabs'"))
    expect(handler).to.contain("send('add-tab-at-point', tab)")
    expect(handler).to.contain('target.window.focus()')
    expect(renderer).to.contain("ipcRenderer.on('add-tab-at-point'")
  })

  it('inserts at the drop position, not at the end', function () {
    const start = tabBar.indexOf('insertTabAtPoint (')
    const insert = tabBar.slice(start, start + 1500)
    expect(insert).to.contain('cx < r.left + r.width / 2')
    expect(insert).to.contain('cy < r.top + r.height / 2')
    expect(insert).to.contain('this.moveTabToPosition(tabId, index)')
  })
})

// Private and normal windows took each other's tabs, so a private page carried
// on in the saved session, its history and its tabs.json entry.
describe('dragging a tab between private and normal windows', function () {
  let manager, handlers, listeners

  beforeEach(async function () {
    ({ manager, handlers, listeners } = await loadWindowManager())
  })

  // Every window sits on the same spot, so the point is over all of them.
  const open = (incognito) => {
    const win = manager.open({ url: 'peersky://home', incognito })
    win.window.getBounds = () => ({ x: 0, y: 0, width: 800, height: 600 })
    return win
  }
  const from = (win) => ({ sender: win.window.webContents })

  it('offers only a window of the same kind', function () {
    const normal = open(false)
    const priv = open(true)
    const otherNormal = open(false)
    const otherPrivate = open(true)
    const windowAtPoint = handlers.get('window-at-point')

    expect(windowAtPoint(from(normal), { x: 10, y: 10 })).to.equal(otherNormal.window.webContents.id)
    expect(windowAtPoint(from(priv), { x: 10, y: 10 })).to.equal(otherPrivate.window.webContents.id)
  })

  it('finds no window when only the other kind is under the point', function () {
    const normal = open(false)
    const priv = open(true)
    const windowAtPoint = handlers.get('window-at-point')

    expect(windowAtPoint(from(normal), { x: 10, y: 10 })).to.equal(null)
    expect(windowAtPoint(from(priv), { x: 10, y: 10 })).to.equal(null)
  })

  it('gives a tab sent to the other kind a window of its own kind', function () {
    const priv = open(true)
    const normal = open(false)
    const tab = { url: 'https://example.com/', title: 'Example', navigation: { entries: [], index: 0 } }

    listeners.get('move-tab-to-window')(from(priv), { targetId: normal.window.webContents.id, ...tab })

    expect(normal.window.webContents.send.called, 'the normal window took a private tab').to.equal(false)
    expect(manager.all).to.have.lengthOf(3)
    expect(manager.all.at(-1).incognito).to.equal(true)
  })
})

/** A WindowManager over stubbed Electron, for driving its IPC handlers. */
async function loadWindowManager () {
  const handlers = new Map()
  const listeners = new Map()
  let nextId = 1
  class FakeBrowserWindow extends EventEmitter {
    constructor () {
      super()
      const webContents = new EventEmitter()
      webContents.id = nextId++
      webContents.isDestroyed = () => false
      webContents.send = sinon.stub()
      this.webContents = webContents
      this.isDestroyed = () => false
      this.loadFile = () => {}
      this.setVibrancy = () => {}
      this.setBackgroundMaterial = () => {}
      this.focus = () => {}
      this.close = () => {}
    }

    static getAllWindows () { return [] }
    static fromWebContents () { return null }
  }
  const { default: WindowManager } = await esmock.strict('../src/window-manager.js', {
    electron: {
      app: { getPath: () => '.test-tab-drag', isPackaged: true, on: () => {} },
      BrowserWindow: FakeBrowserWindow,
      ipcMain: {
        on: (channel, handler) => listeners.set(channel, handler),
        handle: (channel, handler) => handlers.set(channel, handler),
        removeListener: () => {}
      },
      webContents: { getAllWebContents: () => [] },
      session: { defaultSession: {} }
    },
    'fs-extra': { default: { pathExists: async () => false, readFileSync: () => '[]', existsSync: () => false } },
    'scoped-fs': { default: class {} },
    '../src/context-menu.js': { attachContextMenus: () => {}, setWindowManager: () => {} },
    '../src/extensions/index.js': { default: { addWindow: () => {} } },
    '../src/session.js': { getPartition: () => '', getIncognitoSession: () => null, INCOGNITO_PARTITION: 'peersky-incognito' },
    '../src/permissions.js': { clearIncognitoPermissions: () => {} },
    '../src/tab-drag-preview.js': { registerTabDragPreview: () => {} },
    '../src/navigation-restore.js': { watchHost: () => {} },
    '../src/settings-manager.js': { default: { settings: {} } },
    '../src/logger.js': { createLogger: () => ({ info () {}, warn () {}, error () {}, debug () {} }) }
  })
  return { manager: new WindowManager(), handlers, listeners }
}

describe("dragging a window's only tab", function () {
  it('may leave, but only to join another window', function () {
    expect(tabBar).to.contain('if (this.isOutsideContainer && idsToMove.length === 1 && this.tabs.length === 1) {')
    expect(tabBar).to.contain('if (targetId === null) return this.settleDrag()')
    expect(tabBar).to.contain('this.moveLastTabToWindow(idsToMove[0], targetId, e.screenX, e.screenY)')
  })

  it('closes the window it leaves behind, before the target takes focus', function () {
    const move = tabBar.slice(tabBar.indexOf('moveLastTabToWindow (tabId'), tabBar.indexOf('async windowAt ('))
    expect(move).to.contain('this.detachTab(tabId, { last: true })')
    expect(move).to.contain('closeSource: true')
    const handler = windows.slice(windows.indexOf("'move-tab-to-window'"), windows.indexOf("'new-window-with-split-tabs'"))
    expect(handler).to.contain("source.once('closed', () => { if (!target.window.isDestroyed()) target.window.focus() })")
  })

  it('still refuses the last tab for a plain tear-off', function () {
    expect(tabBar).to.contain('if (!tab || (this.tabs.length === 1 && !last)) return null')
  })
})

// A tab dragged past the window edge vanished, because it was a DOM element.
// A small always-on-top window now stands in for it outside the strip.
describe('the floating tab preview', function () {
  it('escapes the tab title', function () {
    const page = preview.previewPage({ title: '<img src=x onerror=alert(1)>', width: 100, height: 30 })
    expect(page).to.not.contain('<img')
    expect(page).to.contain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('shows favicons from the browser schemes and nothing else', function () {
    expect(preview.previewPage({ favicon: 'peersky://static/assets/favicon.ico', width: 100, height: 30 })).to.contain('url("peersky://static/assets/favicon.ico")')
    expect(preview.previewPage({ favicon: 'javascript:alert(1)', width: 100, height: 30 })).to.contain('background: none')
    expect(preview.previewPage({ favicon: 'https://x.test/a".png', width: 100, height: 30 })).to.contain('url("https://x.test/a%22.png")')
  })

  it('cannot be broken out of by a computed style value', function () {
    const page = preview.previewPage({ background: 'red; } </style><script>1</script>', width: 100, height: 30 })
    expect(page).to.not.contain('<script>')
  })

  it('leaves room for the shadow on every side', function () {
    expect(preview.previewWindowSize({ width: 100.4, height: 30 })).to.deep.equal({ width: 101 + preview.PAD * 2, height: 30 + preview.PAD * 2 })
  })

  it('never takes focus or the pointer, and is torn down at drop', function () {
    expect(previewSource).to.contain('focusable: false')
    expect(previewSource).to.contain('win.setIgnoreMouseEvents(true)')
    expect(previewSource).to.contain("msg?.type === 'end') destroy()")
  })

  it('hides the dragged element only once the preview is on screen', function () {
    const move = tabBar.slice(tabBar.indexOf('moveDragPreview (e) {'), tabBar.indexOf('hideDragPreview () {'))
    expect(move.indexOf('if (!preview?.ready) return')).to.be.below(move.indexOf("visibility = 'hidden'"))
    expect(tabBar).to.contain('this.endDragPreview()')
  })
})

// The tab preview appeared after 0.8s and could sit off the left edge of a
// collapsed vertical strip.
describe('the tab hover card', function () {
  const card = tabBar.slice(tabBar.indexOf('setupTabHoverCard ('), tabBar.indexOf('destroyHoverCard ()'))

  it('waits 3s, and 8s while a vertical strip is still collapsed', function () {
    expect(card).to.contain("this.isVertical && !this.classList.contains('expanded')")
    expect(card).to.contain('collapsedVertical ? 8000 : 3000')
    expect(card).to.not.contain('800)')
  })

  it('sits beside a vertical strip rather than under the tab', function () {
    expect(card).to.contain('vertical ? tabRect.right + 8 : tabRect.left')
    expect(card).to.contain('vertical ? tabRect.top : tabRect.bottom + 8')
  })

  it('is kept inside the window on every side', function () {
    expect(card).to.contain('Math.max(margin, left)')
    expect(card).to.contain('Math.max(margin, top)')
    expect(card).to.contain('window.innerWidth - cardRect.width - margin')
    expect(card).to.contain('window.innerHeight - cardRect.height - margin')
  })
})

// Switching between horizontal and vertical tabs rebuilt the webviews, which
// reloaded every open page.
describe('switching the tab layout', function () {
  const adopt = tabBar.slice(tabBar.indexOf('adoptTabs ('), tabBar.indexOf('// Restore tabs from persisted data'))
  const onSwitch = renderer.slice(renderer.indexOf("'vertical-tabs-changed'"), renderer.indexOf('RE-ATTACH event listeners'))

  it('hands the existing webviews to the new bar instead of destroying them', function () {
    expect(onSwitch).to.contain('webviews: oldBar.webviews')
    expect(onSwitch).to.contain('tabBar.adoptTabs(carried, webviewContainer)')
    expect(onSwitch).to.not.contain('webview.remove()')
    expect(onSwitch).to.not.contain('removeChild(webviewContainer.firstChild)')
  })

  it('rebuilds the strip without creating webviews or replaying history', function () {
    expect(adopt).to.contain('this.webviewContainer = null')
    expect(adopt).to.contain('navigation: webviews.has(tab.id) ? null : tab.navigation')
    expect(adopt).to.contain('this.setupWebviewEvents(webview, tabId)')
  })

  it('keeps the zoom levels and favicons the old strip had', function () {
    expect(adopt).to.contain('this.zoomLevels = zoomLevels')
    expect(onSwitch).to.contain("querySelector('.tab-favicon')?.style.backgroundImage")
  })

  // The old bar's webview listeners keep firing after it is removed.
  it('retires the old bar so it can never persist stale state', function () {
    expect(onSwitch).to.contain('oldBar.retire()')
    expect(tabBar).to.contain('if (this._retired || this._tabsStateTimer) return')
    expect(tabBar).to.match(/writeTabsStateNow \(\) \{\s+if \(this\._retired \|\| this\.isIncognito\) return/)
    const retire = tabBar.slice(tabBar.indexOf('retire ()'), tabBar.indexOf('// Restore tabs from persisted data'))
    expect(retire).to.contain('this.tabs = []')
    expect(retire).to.contain('this.webviews = new Map()')
  })

  it('stops the old bar from driving the address bar', function () {
    expect(onSwitch).to.contain("oldBar.removeEventListener('tab-navigated', handleTabNavigated)")
  })
})

// Restored tabs with media started playing on their own.
describe('media autoplay', function () {
  it('needs the page to have been interacted with first, as browsers do', function () {
    const prefs = tabBar.match(/setAttribute\('webpreferences', '([^']+)'\)/)
    expect(prefs, 'the webview sets its web preferences').to.not.equal(null)
    expect(prefs[1].split(',')).to.include('autoplayPolicy=document-user-activation-required')
  })
})

// The restore handler was a stub, so a restored or moved tab had no history.
// Electron can only restore before a guest's first load, so the guest starts
// on a placeholder src that main blanks as it attaches.
describe('navigation history', function () {
  async function loadModule () {
    const handlers = {}
    const mod = await esmock.strict('../src/navigation-restore.js', {
      electron: { ipcMain: { on: (ch, fn) => { handlers[ch] = fn }, handle: (ch, fn) => { handlers[ch] = fn } } },
      '../src/logger.js': { createLogger: () => ({ warn () {} }) }
    })
    mod.registerNavigationRestore()
    return { mod, handlers }
  }

  function fakeHost () {
    const listeners = {}
    return { on: (ev, fn) => { listeners[ev] = fn }, emit: (ev, ...args) => listeners[ev](...args) }
  }

  it('blanks the placeholder src and restores the queued history as the guest attaches', async function () {
    const { mod, handlers } = await loadModule()
    const host = fakeHost()
    mod.watchHost(host)
    handlers['queue-navigation-restore']({}, { token: 't1', entries: [{ url: 'a' }, { url: 'b', title: 'B' }], index: 1, url: 'b' })
    const params = { src: mod.PLACEHOLDER + 't1' }
    host.emit('will-attach-webview', {}, {}, params)
    expect(params.src).to.equal('')
    let restored
    const guest = { id: 7, isDestroyed: () => false, once () {}, navigationHistory: { restore: async (opts) => { restored = opts } } }
    await host.emit('did-attach-webview', {}, guest)
    expect(restored).to.deep.equal({ entries: [{ url: 'a', title: '' }, { url: 'b', title: 'B' }], index: 1 })
    expect(await handlers['restore-navigation-history']({}, { webContentsId: 7 })).to.deep.equal({ success: true })
  })

  it('forgets a queued restore that nothing ever claims', async function () {
    const preview = await source('../src/navigation-restore.js')
    const queue = preview.slice(preview.indexOf("'queue-navigation-restore'"), preview.indexOf("'restore-navigation-history'"))
    expect(queue).to.contain('setTimeout(() => pending.delete(token), 30000)')
    expect(queue).to.contain('if (expiry.unref) expiry.unref()')
  })

  it('loads the tab url itself when the restore fails, and leaves other guests alone', async function () {
    const { mod, handlers } = await loadModule()
    const host = fakeHost()
    mod.watchHost(host)
    handlers['queue-navigation-restore']({}, { token: 't2', entries: [{ url: 'a' }], index: 0, url: 'a' })
    host.emit('will-attach-webview', {}, {}, { src: mod.PLACEHOLDER + 't2' })
    let loaded
    const guest = { id: 8, isDestroyed: () => false, once () {}, loadURL: async (u) => { loaded = u }, navigationHistory: { restore: async () => { throw new Error('nope') } } }
    await host.emit('did-attach-webview', {}, guest)
    expect(loaded).to.equal('a')
    expect(await handlers['restore-navigation-history']({}, { webContentsId: 8 })).to.deep.equal({ success: false })
    const plain = { src: 'https://example.test' }
    host.emit('will-attach-webview', {}, {}, plain)
    expect(plain.src).to.equal('https://example.test')
  })

  it('waits for an extension to load before opening its page, instead of crashing the start', async function () {
    const { mod, handlers } = await loadModule()
    const host = fakeHost()
    mod.watchHost(host)
    const url = 'chrome-extension://njgdkbplnabflgninlgehplmlcfabmdp/view.html'
    handlers['queue-navigation-restore']({}, { token: 't3', entries: [{ url }], index: 0, url })
    host.emit('will-attach-webview', {}, {}, { src: mod.PLACEHOLDER + 't3' })
    let loaded = false
    const loads = []
    const guest = {
      id: 9,
      isDestroyed: () => false,
      once () {},
      loadURL: async (u) => { loads.push(u) },
      session: { extensions: { getExtension: (id) => loaded && id === 'njgdkbplnabflgninlgehplmlcfabmdp' ? { id } : null } },
      navigationHistory: { restore: async () => { throw new Error("ERR_FAILED (-2) loading '" + url + "'") } }
    }
    await host.emit('did-attach-webview', {}, guest)
    expect(loads).to.deep.equal([])
    loaded = true
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(loads).to.deep.equal([url])
  })

  it('opens Home in place of an extension page whose extension never loads', async function () {
    const restore = await source('../src/navigation-restore.js')
    expect(restore).to.match(/if \(!hasExtension\(guest, extensionId\)\) target = 'peersky:\/\/home'/)
  })

  it('is queued by the tab bar before the placeholder src is set, and travels with a torn-off tab', function () {
    const factory = tabBar.slice(tabBar.indexOf('createWebviewForTab (tabId, url, navigation'), tabBar.indexOf("webview.setAttribute('allowpopups'"))
    expect(factory.indexOf("sendSync('queue-navigation-restore'")).to.be.below(factory.indexOf("webview.setAttribute('src', src)"))
    expect(tabBar).to.contain("send('new-window-with-tab', { url: tab.url, title: tab.title, navigation: tab.navigation, isolate: true })")
    expect(windows).to.contain('singleTabNavigation: JSON.stringify(singleTab.navigation)')
    expect(tabBar).to.contain('if (result?.success && tab) tab.savedNavigation = null')
  })
})

// Figma's sign-in frame changed its own address, and the address bar and the
// saved tabs showed /login_iframe instead of the page the tab was on.
describe('in-page navigation', function () {
  it("ignores frames inside the page, whose address is not the tab's", function () {
    const handler = tabBar.slice(tabBar.indexOf("addEventListener('did-navigate-in-page'"), tabBar.indexOf('// Handle audio state changes'))
    const guard = handler.indexOf('if (!e.isMainFrame) return')
    expect(guard).to.be.above(-1)
    expect(guard).to.be.below(handler.indexOf('savedNavigation.entries.push'))
    expect(guard).to.be.below(handler.indexOf('this.updateTab(tabId, { url: newUrl })'))
  })
})

// The same IPC was handled in main.js and in the window manager, so one send
// opened two windows.
describe('opening a window over IPC', function () {
  it('has exactly one handler', function () {
    const count = (main.match(/ipcMain\.on\('new-window'/g) || []).length + (windows.match(/ipcMain\.on\('new-window'/g) || []).length
    expect(count).to.equal(1)
  })
})

// VerticalTabs.addTabWithId dropped its fourth parameter, so in vertical mode a
// tab lost its history and its suspended state: the bug that made moving a tab
// between windows lose history for anyone not using horizontal tabs.
describe('the vertical tab bar', function () {
  const methods = [...vertical.matchAll(/^ {2}([a-zA-Z_][\w]*) \(([^)]*)\) \{([\s\S]*?)^ {2}\}/gm)]

  it('overrides at least one base method, so this check is live', function () {
    expect(methods.filter(m => m[3].includes(`super.${m[1]}(`)).length).to.be.above(0)
  })

  it('never drops a parameter the base method declares', function () {
    const dropped = []
    for (const [, name, , body] of methods) {
      const call = body.match(new RegExp(`super\\.${name}\\(([^)]*)\\)`))
      const base = tabBar.match(new RegExp(`^ {2}${name} \\(([^)]*)\\)`, 'm'))
      if (!call || !base) continue
      const declared = base[1].trim() ? base[1].split(/,(?![^{]*})/).length : 0
      const forwarded = call[1].trim() ? call[1].split(',').length : 0
      if (forwarded < declared) dropped.push(`${name}: base takes ${declared}, override forwards ${forwarded}`)
    }
    expect(dropped).to.deep.equal([])
  })
})

// The loading spinner was positioned against the tab rather than the favicon,
// so it span in the middle of the tab, over the title.
describe('a loading tab in the vertical strip', function () {
  it('shows no spinner, the same as the horizontal strip', function () {
    expect(verticalCss).to.not.contain('animation: spin')
    expect(verticalCss).to.not.contain('@keyframes spin')
    expect(verticalCss).to.not.match(/\.tab\.loading[^{]*::after/)
  })
})

// A video or sound opened straight has no title of its own, and the tab kept the
// last page's: a hyper:// video opened in a new tab said "Home".
describe('a page with no title of its own', function () {
  const start = tabBar.indexOf('function titleFromAddress (')
  const body = tabBar.slice(start, tabBar.indexOf('\n}\n', start) + 2)
  // eslint-disable-next-line no-new-func
  const titleFromAddress = new Function(`${body}; return titleFromAddress`)()

  it('is named after its file, or its site', function () {
    expect(titleFromAddress('hyper://abc/photos/cat%20one.png')).to.equal('cat one.png')
    expect(titleFromAddress('hyper://blog.example/')).to.equal('blog.example')
    expect(titleFromAddress('hyper://abc/bad%E0%A4%A.png')).to.equal('bad%E0%A4%A.png')
    expect(titleFromAddress('not a url')).to.equal('')
  })

  it('takes that title only when the page gave none since it navigated', function () {
    expect(tabBar).to.contain('if (tab) tab.pageNamedItself = false')
    expect(tabBar).to.contain('if (tab) tab.pageNamedItself = true')
    expect(tabBar).to.match(/loaded\.pageNamedItself === false[\s\S]{0,300}titleFromAddress\(url\)/)
  })
})

// A PDF, or any page without an icon of its own, kept the last page's icon.
describe('a page with no icon of its own', function () {
  const navigated = tabBar.slice(
    tabBar.indexOf("webview.addEventListener('did-navigate', (e) => {"),
    tabBar.indexOf("webview.addEventListener('did-navigate', () => {")
  )
  const stopped = tabBar.slice(
    tabBar.indexOf("webview.addEventListener('did-stop-loading', () => {"),
    tabBar.indexOf("webview.addEventListener('page-title-updated'")
  )

  it('drops the last page\'s icon once the new page is in, unless the tab showed that page before', function () {
    expect(navigated).to.contain("document.getElementById(tabId)?.querySelector('.tab-favicon')")
    expect(navigated).to.contain('const known = this.faviconsByTab.get(tabId)?.get(newUrl)')
    // eslint-disable-next-line no-template-curly-in-string
    expect(navigated).to.contain("faviconElement.style.backgroundImage = known ? `url(${known})` : ''")
  })

  // A page reached with Back or Forward does not send its icon again, so the
  // tab keeps the icons of the pages it showed.
  it('keeps the icon of each page the tab showed, the newest 50', function () {
    expect(tabBar).to.contain('if (faviconUrl) this.rememberFavicon(tabId, webview.getURL(), faviconUrl)')
    const start = tabBar.indexOf('  rememberFavicon (tabId, url, favicon) {')
    const body = tabBar.slice(tabBar.indexOf('{', start) + 1, tabBar.indexOf('\n  }\n', start))
    // eslint-disable-next-line no-new-func
    const remember = new Function('tabId', 'url', 'favicon', body)
    const bar = { faviconsByTab: new Map() }
    for (let i = 0; i < 60; i++) remember.call(bar, 'tab-1', `https://site.example/${i}`, `icon-${i}`)
    remember.call(bar, 'tab-1', 'https://site.example/55', 'icon-55-new')
    remember.call(bar, 'tab-1', '', 'icon-of-nothing')
    const icons = bar.faviconsByTab.get('tab-1')
    expect(icons.size).to.equal(50)
    expect(icons.has('https://site.example/9')).to.equal(false)
    expect(icons.get('https://site.example/10')).to.equal('icon-10')
    expect([...icons].pop()).to.deep.equal(['https://site.example/55', 'icon-55-new'])
  })

  it('forgets a tab\'s icons with the tab, and carries them when the strip changes layout', function () {
    expect(tabBar.match(/this\.zoomLevels\.delete\(tabId\)\n\s*this\.faviconsByTab\.delete\(tabId\)/g)).to.have.length(4)
    expect(tabBar).to.contain('this.faviconsByTab = faviconsByTab || new Map()')
    expect(renderer).to.contain('faviconsByTab: oldBar.faviconsByTab')
  })

  it('shows the default icon when the page gave none by the time it loaded', function () {
    expect(stopped).to.match(/if \(!faviconElement\.style\.backgroundImage \|\| [^)]*\) \{\s*faviconElement\.style\.backgroundImage = this\.iconBeforeNavigation\.get\(webview\) \|\| DEFAULT_TAB_ICON/)
  })

  // The default named icon16.png, which is not in static/assets, so a tab with
  // no icon of its own showed an empty slot.
  it('names only icons that are there', async function () {
    const { existsSync } = await import('fs')
    const named = [...`${tabBar}\n${await source('../src/pages/vertical-tabs.js')}`.matchAll(/peersky:\/\/static\/assets\/([\w.-]+)/g)].map((m) => m[1])
    expect(named).to.include('favicon.ico')
    for (const file of new Set(named)) {
      expect(existsSync(new URL(`../src/pages/static/assets/${file}`, import.meta.url)), file).to.equal(true)
    }
  })

  // Chromium sends no page-favicon-updated when a page's icons are the same as
  // the last page's: every link on Wikipedia, or Home to peersky://version,
  // left the tab with no icon.
  it('keeps the last page\'s icon for a page of the same site that sent none', function () {
    expect(navigated).to.contain("if (before && before !== 'none' && sameSite(this.lastPageUrl.get(webview), newUrl)) this.iconBeforeNavigation.set(webview, before)")
    expect(navigated.indexOf('this.lastPageUrl.set(webview, newUrl)')).to.be.greaterThan(navigated.indexOf('sameSite(this.lastPageUrl.get(webview), newUrl)'))
    expect(tabBar).to.contain("webview.addEventListener('page-favicon-updated', (e) => {\n      this.iconBeforeNavigation.delete(webview)")
    const start = tabBar.indexOf('function sameSite (a, b) {')
    const body = tabBar.slice(tabBar.indexOf('{', start) + 1, tabBar.indexOf('\n}\n', start))
    // eslint-disable-next-line no-new-func
    const sameSite = new Function('a', 'b', body)
    expect(sameSite('https://en.wikipedia.org/wiki/Lake', 'https://en.wikipedia.org/wiki/River')).to.equal(true)
    expect(sameSite('peersky://home/', 'peersky://home/?x=1')).to.equal(true)
    expect(sameSite('peersky://home/', 'peersky://version/')).to.equal(false)
    expect(sameSite('https://example.com/', 'file:///tmp/a.pdf')).to.equal(false)
    expect(sameSite(undefined, 'https://example.com/')).to.equal(false)
  })

  // Chromium compares a page's icons with the last ones it sent, from any
  // site, and a web page always has one to send, its site's /favicon.ico at
  // least. A page on another host sharing the last page's icon showed the
  // default.
  it('gives a web page that sent no icon the one Chromium sent last, from any site', function () {
    const updated = tabBar.slice(
      tabBar.indexOf("webview.addEventListener('page-favicon-updated', (e) => {"),
      tabBar.indexOf("webview.addEventListener('focus'")
    )
    expect(updated.indexOf('this.reportedIcon.set(webview, faviconUrl)'), 'kept even without a tab element').to.be.within(0, updated.indexOf('if (!tabElement) return'))
    // eslint-disable-next-line no-template-curly-in-string
    const carried = 'if (reported && isWebAddress(newUrl)) this.iconBeforeNavigation.set(webview, `url(${reported})`)'
    expect(navigated).to.contain(carried)
    expect(navigated.indexOf(carried), 'ahead of the same-site rule').to.be.below(navigated.indexOf('sameSite(this.lastPageUrl.get(webview), newUrl)'))
    const start = tabBar.indexOf('function isWebAddress (url) {')
    const body = tabBar.slice(tabBar.indexOf('{', start) + 1, tabBar.indexOf('\n}\n', start))
    // eslint-disable-next-line no-new-func
    const isWebAddress = new Function('url', body)
    expect(isWebAddress('https://accounts.example.com/domains/list')).to.equal(true)
    expect(isWebAddress('http://localhost:8080/')).to.equal(true)
    expect(isWebAddress('peersky://version/')).to.equal(false)
    expect(isWebAddress('hyper://abc/')).to.equal(false)
    expect(isWebAddress('about:blank')).to.equal(false)
    expect(isWebAddress(undefined)).to.equal(false)
  })
})

// A link opened in a new tab went to the end of the strip, far from the page
// it came from. Other browsers put it right after that tab.
describe('a link opened in a new tab', function () {
  const start = tabBar.indexOf('  addTabFromLink (url, openerWebContentsId = null) {')
  const end = tabBar.indexOf('\n  findTabByWebContentsId (')
  const body = tabBar.slice(tabBar.indexOf('{', start) + 1, tabBar.lastIndexOf('}', end))
  // eslint-disable-next-line no-new-func
  const addTabFromLink = new Function('url', 'openerWebContentsId', body)

  function strip (ids, { active = ids[0], pinned = [], groups = {} } = {}) {
    let counter = 0
    const bar = {
      tabs: ids.map((id) => ({ id })),
      activeTabId: active,
      pinnedTabs: new Set(pinned),
      tabGroups: new Map(Object.values(groups).map((g) => [g, { id: g }])),
      tabGroupAssignments: new Map(Object.entries(groups)),
      webviews: new Map(),
      addTab () {
        const id = `new-${++counter}`
        this.tabs.push({ id })
        return id
      },
      moveTabToPosition (id, position) {
        const [tab] = this.tabs.splice(this.tabs.findIndex((t) => t.id === id), 1)
        this.tabs.splice(position, 0, tab)
      },
      findTabByWebContentsId: () => null,
      addTabToGroup (id, group) { this.tabGroupAssignments.set(id, group) },
      normalizeGroupLayout () {},
      updateGroupedTabsUI () {},
      saveTabsState () {}
    }
    const open = (url = 'https://example.com/') => addTabFromLink.call(bar, url, null)
    const order = () => bar.tabs.map((t) => t.id)
    return { bar, open, order }
  }

  it('goes right after the tab it came from, and the next one after it', function () {
    const { open, order } = strip(['a', 'b', 'c'], { active: 'a' })
    open()
    expect(order()).to.deep.equal(['a', 'new-1', 'b', 'c'])
    open()
    expect(order()).to.deep.equal(['a', 'new-1', 'new-2', 'b', 'c'])
  })

  it('from a pinned tab, goes after the pinned ones', function () {
    const { open, order } = strip(['p1', 'p2', 'a'], { active: 'p1', pinned: ['p1', 'p2'] })
    open()
    expect(order()).to.deep.equal(['p1', 'p2', 'new-1', 'a'])
  })

  it('joins the group of the tab it came from', function () {
    const { bar, open } = strip(['a', 'b'], { active: 'a', groups: { a: 'trip' } })
    const id = open()
    expect(bar.tabGroupAssignments.get(id)).to.equal('trip')
  })

  it('is what the link menu and a page opening a tab use', function () {
    expect(tabBar).to.contain('this.addTabFromLink(e.url,')
  })
})

describe('the tab and group menus', function () {
  it('says Close other tabs for closing every tab but this one', function () {
    expect(tabBar).to.match(/data-action="close-others">\s*<img[^>]*>\s*Close other tabs\s*</)
    expect(tabBar).to.not.contain('Close all tabs\n')
  })

  it('stay inside the window when opened low or far right in it', function () {
    for (const name of ['showTabContextMenu (event, tabId) {', 'showGroupContextMenu (event, groupId) {']) {
      const start = tabBar.indexOf(name)
      const body = tabBar.slice(start, tabBar.indexOf('\n  }\n', start))
      expect(body, name).to.contain('document.body.appendChild(menu)\n    this.keepInWindow(menu)')
    }
    expect(tabBar).to.contain('menu.style.top = `$' + '{Math.max(0, window.innerHeight - rect.height - 10)}px`')
  })
})
