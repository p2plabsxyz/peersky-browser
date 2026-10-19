// Zoom was never wired up: nothing in src mentioned it, so the shortcuts did
// nothing at all.

import { expect } from 'chai'
import esmock from 'esmock'
import { EventEmitter } from 'events'
import { attachTrackpadZoom, handlePinchZoom, pinchZoomStep, PINCH_ZOOM_LIMITS, WHEEL_ZOOM_INTERVAL_MS } from '../src/trackpad-zoom.js'

async function loadActions () {
  const executed = []
  const focusedWindow = {
    webContents: {
      executeJavaScript: (script) => { executed.push(script); return Promise.resolve() }
    }
  }
  const module = await esmock.strict('../src/actions.js', {
    electron: {
      app: { name: 'Peersky', getVersion: () => '0.0.0' },
      BrowserWindow: { getFocusedWindow: () => focusedWindow },
      webContents: { fromId: () => null }
    },
    '../src/history-nav.js': { goBackActiveTab () {}, goForwardActiveTab () {} },
    '../src/devtools-dock.js': { toggleDockedDevTools () {} }
  })
  return { actions: module.createActions({ all: [] }), executed }
}

describe('page zoom', function () {
  describe('the shortcuts exist', function () {
    it('binds zoom in, zoom out and actual size', async function () {
      const { actions } = await loadActions()
      expect(actions.ZoomIn.accelerator).to.equal('CommandOrControl+Plus')
      expect(actions.ZoomOut.accelerator).to.equal('CommandOrControl+-')
      expect(actions.ActualSize.accelerator).to.equal('CommandOrControl+0')
    })

    // + sits behind shift on most layouts, so the bare key needs its own entry.
    it('also binds the unshifted key for zoom in', async function () {
      const { actions } = await loadActions()
      expect(actions.ZoomInEquals.accelerator).to.equal('CommandOrControl+=')
      expect(actions.ZoomInEquals.visible).to.equal(false)
    })
  })

  describe('what they do', function () {
    it('steps the active tab up and down', async function () {
      const { actions, executed } = await loadActions()
      actions.ZoomIn.click()
      actions.ZoomOut.click()
      expect(executed[0]).to.contain('zoomActiveTab(0.5)')
      expect(executed[1]).to.contain('zoomActiveTab(-0.5)')
    })

    it('resets rather than stepping for actual size', async function () {
      const { actions, executed } = await loadActions()
      actions.ActualSize.click()
      expect(executed[0]).to.contain('resetActiveTabZoom()')
      expect(executed[0]).to.not.contain('zoomActiveTab(null)')
    })

    // Zooming the shell would scale the tab bar and address bar too.
    it('targets the tab bar, not the window', async function () {
      const { actions, executed } = await loadActions()
      actions.ZoomIn.click()
      expect(executed[0]).to.contain('#tabbar')
      expect(executed[0]).to.contain("typeof tabBar.zoomActiveTab === 'function'")
    })
  })

  describe('the tab bar side', function () {
    let src
    before(async function () {
      const { readFile } = await import('fs/promises')
      src = await readFile(new URL('../src/pages/tab-bar.js', import.meta.url), 'utf8')
    })

    it('exposes the methods the menu calls, with limits', function () {
      expect(src).to.contain('zoomActiveTab (step)')
      expect(src).to.contain('resetActiveTabZoom ()')
      expect(src, 'zoom must be clamped').to.contain('Math.max(-7, Math.min(9,')
    })

    // Chromium scopes zoom per origin, so every peersky://p2p app shared one
    // level until the tab bar kept its own.
    it('keeps a level per tab and reapplies it when the tab is shown', function () {
      expect(src).to.contain('this.zoomLevels = new Map()')
      expect(src).to.contain('applyZoomForTab (tabId)')
      expect(src, 'reapplied on switch').to.contain('this.applyZoomForTab(tabId)')
      expect(src, 'a new webview must not inherit the origin level').to.match(/dom-ready[\s\S]{0,80}applyZoomForTab/)
    })

    it('forgets a tab level once the tab is gone', function () {
      const deletes = src.match(/this\.zoomLevels\.delete\(tabId\)/g) || []
      const webviewDeletes = src.match(/this\.webviews\.delete\(tabId\)/g) || []
      expect(deletes.length, 'one per webview removal').to.equal(webviewDeletes.length)
    })

    // These throw until dom-ready, and selectTab calls them.
    it('survives a webview that is not ready yet', function () {
      const zoom = src.slice(src.indexOf('zoomActiveTab (step)'), src.indexOf('emitZoomChanged ()'))
      expect(zoom).to.contain('try {')
      expect(zoom).to.contain('catch')
    })

    it('reports the new percentage on every change', function () {
      expect(src).to.contain('emitZoomChanged')
      expect(src).to.contain("new CustomEvent('zoom-changed'")
      expect(src, 'percent comes from the zoom factor').to.contain('getZoomFactor() * 100')
    })
  })

  describe('the percentage indicator', function () {
    let nav, renderer
    before(async function () {
      const { readFile } = await import('fs/promises')
      nav = await readFile(new URL('../src/pages/nav-box.js', import.meta.url), 'utf8')
      renderer = await readFile(new URL('../src/renderer.js', import.meta.url), 'utf8')
    })

    it('lives in the address bar', function () {
      expect(nav).to.contain("zoomIndicator.id = 'zoom-indicator'")
      expect(nav).to.contain('urlBarWrapper.appendChild(zoomIndicator)')
    })

    it('hides itself at 100%', function () {
      expect(nav).to.contain('indicator.hidden = percent === 100')
    })

    it('is updated from the tab bar and follows the active tab', function () {
      expect(renderer).to.contain("tabBar.addEventListener('zoom-changed'")
      expect(renderer).to.contain('setZoomIndicator(e.detail.percent)')
      expect(renderer, 'switching tabs refreshes it').to.contain("tab-selected', () => tabBar.emitZoomChanged()")
    })
  })

  describe('the View menu', function () {
    it('lists all four items', async function () {
      const module = await esmock.strict('../src/actions.js', {
        electron: {
          app: { name: 'Peersky', getVersion: () => '0.0.0' },
          BrowserWindow: { getFocusedWindow: () => null },
          webContents: { fromId: () => null }
        },
        '../src/history-nav.js': { goBackActiveTab () {}, goForwardActiveTab () {} },
        '../src/devtools-dock.js': { toggleDockedDevTools () {} }
      })
      const view = module.createMenuTemplate({ all: [] }).find((m) => m.label === 'View')
      const labels = view.submenu.map((i) => i.label).filter(Boolean)
      expect(labels).to.include('Zoom In')
      expect(labels).to.include('Zoom Out')
      expect(labels).to.include('Actual Size')
    })
  })
})

// A trackpad did nothing: Electron turns pinching and Ctrl with the wheel off
// in a page.
describe('trackpad and wheel zoom', function () {
  function page (type = 'webview') {
    const wc = new EventEmitter()
    wc.limits = []
    wc.scripts = []
    wc.getType = () => type
    wc.isDestroyed = () => false
    wc.setVisualZoomLevelLimits = (...limits) => wc.limits.push(limits)
    wc.hostWebContents = {
      isDestroyed: () => false,
      executeJavaScript: (script) => { wc.scripts.push(script); return Promise.resolve() }
    }
    return wc
  }

  it('lets a pinch magnify every page a tab loads', function () {
    const wc = page()
    attachTrackpadZoom(wc)
    wc.emit('dom-ready')
    wc.emit('did-navigate')
    expect(wc.limits).to.deep.equal([PINCH_ZOOM_LIMITS, PINCH_ZOOM_LIMITS])
  })

  it('zooms the tab with Ctrl and the wheel, one step per gesture burst', function () {
    let clock = 1000
    const wc = page()
    attachTrackpadZoom(wc, { now: () => clock })
    wc.emit('zoom-changed', {}, 'in')
    wc.emit('zoom-changed', {}, 'in')
    clock += WHEEL_ZOOM_INTERVAL_MS
    wc.emit('zoom-changed', {}, 'out')
    expect(wc.scripts).to.have.lengthOf(2)
    expect(wc.scripts[0]).to.contain('tabBar.zoomActiveTab(0.5)')
    expect(wc.scripts[1]).to.contain('tabBar.zoomActiveTab(-0.5)')
  })

  it('leaves the browser window itself alone', function () {
    const wc = page('window')
    attachTrackpadZoom(wc)
    wc.emit('dom-ready')
    wc.emit('zoom-changed', {}, 'in')
    expect(wc.limits).to.deep.equal([])
    expect(wc.scripts).to.deep.equal([])
  })
})

// On a Mac, Chromium leaves Ctrl with the wheel to the page and Electron keeps
// the pinch off for a page in a tab, so a two finger pinch did nothing. The
// pinch comes to the page as Ctrl with the wheel: the page's preload hands it
// on, or the window picks it up when it lands there.
describe('a trackpad pinch on a Mac', function () {
  function fakeIpcMain () {
    const handlers = {}
    return { on: (channel, handler) => { handlers[channel] = handler }, handlers }
  }

  function sender (type = 'webview', id = 7) {
    const scripts = []
    return {
      id,
      scripts,
      isDestroyed: () => false,
      getType: () => type,
      hostWebContents: { isDestroyed: () => false, executeJavaScript: (script) => { scripts.push(script); return Promise.resolve() } }
    }
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  it('zooms as much as the fingers spread: 1.6 times is 1.6 times', function () {
    // Chromium sends -100 ln(scale) in all, and a zoom level is a power of 1.2.
    const level = pinchZoomStep(-100 * Math.log(1.6))
    expect(Math.pow(1.2, level)).to.be.closeTo(1.6, 1e-9)
    expect(pinchZoomStep(0)).to.equal(-0)
    expect(pinchZoomStep(10)).to.be.below(0)
  })

  it('adds up a burst of events and zooms the tab the page is in, not the active one', async function () {
    const ipc = fakeIpcMain()
    handlePinchZoom(ipc, { delay: 5 })
    const page = sender('webview', 42)
    for (let i = 0; i < 10; i++) ipc.handlers['peersky-pinch-zoom']({ sender: page }, -4.7)
    await wait(20)
    expect(page.scripts).to.have.length(1)
    expect(page.scripts[0]).to.contain('zoomTabForWebContents(42, ')
    const step = Number(page.scripts[0].match(/zoomTabForWebContents\(42, ([-\d.e]+)\)/)[1])
    expect(step).to.be.closeTo(pinchZoomStep(-47), 1e-9)
  })

  it('takes it only from a page in a tab, and only a sane number', async function () {
    const ipc = fakeIpcMain()
    handlePinchZoom(ipc, { delay: 5 })
    const shell = sender('window')
    const page = sender('webview')
    ipc.handlers['peersky-pinch-zoom']({ sender: shell }, -10)
    for (const value of ['-10', NaN, Infinity, 5000, null]) ipc.handlers['peersky-pinch-zoom']({ sender: page }, value)
    await wait(20)
    expect(shell.scripts).to.deep.equal([])
    expect(page.scripts).to.deep.equal([])
  })

  describe('where it is picked up', function () {
    let preload
    let tabBar
    before(async function () {
      const { readFile } = await import('fs/promises')
      preload = await readFile(new URL('../src/pages/unified-preload.js', import.meta.url), 'utf8')
      tabBar = await readFile(new URL('../src/pages/tab-bar.js', import.meta.url), 'utf8')
    })

    it('the page hands on a real Ctrl wheel it did not use, on a Mac only', function () {
      const start = preload.indexOf('// A trackpad pinch on a Mac comes to the page')
      const part = preload.slice(start, preload.indexOf("ipcRenderer.send('peersky-pinch-zoom'", start) + 200)
      expect(part).to.contain("process.platform === 'darwin'")
      expect(part).to.contain('event.isTrusted')
      expect(part).to.contain('event.ctrlKey')
      expect(part, 'a map that uses the pinch keeps it').to.contain('event.defaultPrevented')
      expect(part, 'looked at after every listener').to.contain('setTimeout(')
      expect(part, 'scrolling must not wait on it').to.contain('passive: true')
      expect(part, 'CSS pixels back to the fingers').to.contain('webFrame.getZoomFactor()')
    })

    it('the window zooms the tab under the fingers when the pinch lands there', function () {
      const part = tabBar.slice(tabBar.indexOf('listenForPinchZoom () {'), tabBar.indexOf('listenForPinchZoom () {') + 900)
      expect(part).to.contain("process.platform !== 'darwin'")
      expect(part).to.contain("target.tagName !== 'WEBVIEW'")
      expect(part).to.contain('this.zoomTab(tabId,')
      expect(tabBar).to.contain('this.listenForPinchZoom()')
    })
  })
})
