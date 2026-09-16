// Zoom was never wired up: nothing in src mentioned it, so the shortcuts did
// nothing at all.

import { expect } from 'chai'
import esmock from 'esmock'

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
      BrowserWindow: { getFocusedWindow: () => focusedWindow }
    },
    '../src/history-nav.js': { goBackActiveTab () {}, goForwardActiveTab () {} }
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
          BrowserWindow: { getFocusedWindow: () => null }
        },
        '../src/history-nav.js': { goBackActiveTab () {}, goForwardActiveTab () {} }
      })
      const view = module.createMenuTemplate({ all: [] }).find((m) => m.label === 'View')
      const labels = view.submenu.map((i) => i.label).filter(Boolean)
      expect(labels).to.include('Zoom In')
      expect(labels).to.include('Zoom Out')
      expect(labels).to.include('Actual Size')
    })
  })
})
