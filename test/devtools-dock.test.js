import { expect } from 'chai'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import esmock from 'esmock'

// Issue 22: a page's DevTools opened in a window of their own. They are now
// drawn in a view over a dock the window page keeps free on the right.
describe('Docked DevTools', function () {
  function fakeContents (id, type = 'webview') {
    const wc = new EventEmitter()
    Object.assign(wc, {
      id,
      calls: [],
      sent: [],
      destroyed: false,
      zoom: 1,
      isDestroyed () { return this.destroyed },
      getType () { return type },
      getZoomFactor () { return this.zoom },
      send (channel, ...args) { this.sent.push([channel, ...args]) },
      setDevToolsWebContents (devtools) { this.calls.push(['setDevToolsWebContents', devtools.id]) },
      openDevTools (options) { this.calls.push(['openDevTools', options]) },
      inspectElement (x, y) { this.calls.push(['inspectElement', x, y]) },
      closeDevTools () { this.calls.push(['closeDevTools']) },
      focus () { this.calls.push(['focus']) },
      close () {
        this.calls.push(['close'])
        this.destroyed = true
        this.emit('destroyed')
      }
    })
    return wc
  }

  async function load () {
    let nextViewId = 100
    const views = []
    class WebContentsView {
      constructor () {
        this.webContents = fakeContents(nextViewId++, 'browserView')
        this.visible = true
        this.bounds = null
        views.push(this)
      }

      setVisible (visible) { this.visible = visible }
      setBounds (bounds) { this.bounds = bounds }
    }
    const windows = new Map()
    const ipcHandlers = new Map()
    const electron = {
      WebContentsView,
      BrowserWindow: { fromWebContents: (wc) => windows.get(wc) || null },
      ipcMain: { on: (channel, handler) => ipcHandlers.set(channel, handler) }
    }
    const dock = await esmock.strict('../src/devtools-dock.js', {}, { electron })

    function makeWindow () {
      const shell = fakeContents(1, 'window')
      const children = []
      const win = {
        destroyed: false,
        isDestroyed () { return this.destroyed },
        contentView: {
          children,
          addChildView: (view) => children.push(view),
          removeChildView: (view) => children.splice(children.indexOf(view), 1)
        }
      }
      windows.set(shell, win)
      return { shell, win }
    }

    function makeGuest (shell, id = 7) {
      const guest = fakeContents(id)
      guest.hostWebContents = shell
      return guest
    }

    return { dock, views, ipcHandlers, makeWindow, makeGuest }
  }

  it('opens a tab\'s DevTools in a hidden view in its window, and inspects the element', async function () {
    const { dock, views, makeWindow, makeGuest } = await load()
    const { shell, win } = makeWindow()
    const guest = makeGuest(shell)

    await dock.openDockedDevTools(guest, { inspect: { x: 10, y: 20 } })

    expect(views).to.have.length(1)
    expect(win.contentView.children).to.deep.equal(views)
    expect(views[0].visible).to.equal(false)
    expect(guest.calls).to.deep.equal([
      ['setDevToolsWebContents', views[0].webContents.id],
      ['openDevTools', undefined],
      ['inspectElement', 10, 20]
    ])
    expect(shell.sent).to.deep.equal([['devtools-dock-opened', 7]])
    expect(dock.isDevToolsDocked(guest)).to.equal(true)

    // Inspect again while open: same view, the element is selected.
    await dock.openDockedDevTools(guest, { inspect: { x: 1, y: 2 } })
    expect(views).to.have.length(1)
    expect(guest.calls.at(-1)).to.deep.equal(['inspectElement', 1, 2])
  })

  it('closes by destroying the view, and opens again only once the old one is gone', async function () {
    const { dock, views, makeWindow, makeGuest } = await load()
    const { shell, win } = makeWindow()
    const guest = makeGuest(shell)
    await dock.openDockedDevTools(guest)

    const closing = dock.closeDockedDevTools(guest.id)
    expect(dock.isDevToolsDocked(guest)).to.equal(false)
    expect(win.contentView.children).to.deep.equal([])
    expect(views[0].webContents.isDestroyed()).to.equal(true)
    expect(shell.sent.at(-1)).to.deep.equal(['devtools-dock-closed', 7])

    // A reopen asked for now waits for the close to finish.
    const reopening = dock.openDockedDevTools(guest)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(views).to.have.length(1)
    guest.emit('devtools-closed')
    await closing
    await reopening
    expect(views).to.have.length(2)
    expect(guest.calls.filter(([name]) => name === 'setDevToolsWebContents').map(([, id]) => id))
      .to.deep.equal([views[0].webContents.id, views[1].webContents.id])
  })

  it('toggles, and closes when the page goes away', async function () {
    const { dock, views, makeWindow, makeGuest } = await load()
    const { shell } = makeWindow()
    const guest = makeGuest(shell)

    await dock.toggleDockedDevTools(guest)
    expect(dock.isDevToolsDocked(guest)).to.equal(true)
    guest.destroyed = true
    guest.emit('destroyed')
    expect(dock.isDevToolsDocked(guest)).to.equal(false)
    expect(views[0].webContents.isDestroyed()).to.equal(true)
  })

  it('shows only the page on screen, where the window page says, at its zoom', async function () {
    const { dock, views, makeWindow, makeGuest } = await load()
    const { shell } = makeWindow()
    const first = makeGuest(shell, 7)
    const second = makeGuest(shell, 8)
    await dock.openDockedDevTools(first)
    await dock.openDockedDevTools(second)
    shell.zoom = 1.5

    dock.layoutDockedDevTools(shell, { visibleGuestId: 8, bounds: { x: 10.2, y: 88, width: 400, height: 600 } })
    expect(views.map((view) => view.visible)).to.deep.equal([false, true])
    expect(views[1].bounds).to.deep.equal({ x: 15, y: 132, width: 600, height: 900 })

    // Covered, or no tab with DevTools on screen: none shows.
    dock.layoutDockedDevTools(shell, { visibleGuestId: null, bounds: null })
    expect(views.map((view) => view.visible)).to.deep.equal([false, false])
    dock.layoutDockedDevTools(shell, { visibleGuestId: 8, bounds: { x: 0, y: 0, width: 0, height: 10 } })
    expect(views[1].visible).to.equal(false)

    // Another window's page says nothing about these.
    const other = makeWindow().shell
    dock.layoutDockedDevTools(other, { visibleGuestId: 7, bounds: { x: 0, y: 0, width: 100, height: 100 } })
    expect(views.map((view) => view.visible)).to.deep.equal([false, false])
  })

  it('takes a close only from the window the DevTools are in', async function () {
    const { dock, ipcHandlers, makeWindow, makeGuest } = await load()
    const { shell } = makeWindow()
    const guest = makeGuest(shell)
    dock.setupDevToolsDock()
    await dock.openDockedDevTools(guest)

    ipcHandlers.get('devtools-dock-close')({ sender: makeWindow().shell }, guest.id)
    expect(dock.isDevToolsDocked(guest)).to.equal(true)
    ipcHandlers.get('devtools-dock-close')({ sender: shell }, guest.id)
    expect(dock.isDevToolsDocked(guest)).to.equal(false)
  })

  it('keeps the old window for something that is not a tab in a browser window', async function () {
    const { dock, views } = await load()
    const lonely = fakeContents(9)
    lonely.hostWebContents = null
    await dock.openDockedDevTools(lonely, { inspect: { x: 3, y: 4 } })
    expect(views).to.have.length(0)
    expect(lonely.calls).to.deep.equal([['openDevTools', { mode: 'detach' }], ['inspectElement', 3, 4]])
  })

  it('is what Inspect and the DevTools shortcut use for a page', async function () {
    const menu = await readFile(new URL('../src/context-menu.js', import.meta.url), 'utf8')
    const actions = await readFile(new URL('../src/actions.js', import.meta.url), 'utf8')
    const page = await readFile(new URL('../src/pages/index.html', import.meta.url), 'utf8')
    const css = await readFile(new URL('../src/pages/theme/index.css', import.meta.url), 'utf8')
    expect(menu).to.match(/if \(webContents\.getType\(\) === 'webview'\) \{\s+openDockedDevTools\(webContents, \{ inspect: \{ x: params\.x, y: params\.y \} \}\)/)
    expect(actions).to.match(/toggleDockedDevTools\(guest\)/)
    expect(page).to.match(/<script src="\.\/tab-bar\.js"><\/script>\s+<script src="\.\/devtools-dock\.js"><\/script>/)
    expect(css).to.match(/body\.devtools-dock-open \.webview-container,[\s\S]*?right: var\(--devtools-dock-width, 480px\);/)
    expect(css).to.match(/body\.devtools-dock-resizing webview \{\s+pointer-events: none;/)
  })
})
