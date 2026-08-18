import { expect } from 'chai'
import esmock from 'esmock'
import sinon from 'sinon'

function makeWindow (id = 1) {
  return {
    id,
    isDestroyed: () => false,
    webContents: {
      send: sinon.spy()
    }
  }
}

function makeManager (overrides = {}) {
  return {
    activeSidePanels: new Map(),
    sidePanelOpenByTab: new Map(),
    sidePanelOpenGlobal: new Map(),
    sidePanelGuestIds: new Set(),
    _registeredTabs: new Set(),
    loadedExtensions: new Map([
      ['ext-1', {
        id: 'ext-1',
        electronId: 'ext-1',
        displayName: 'Side Panel Fixture',
        name: 'Side Panel Fixture',
        manifest: {
          side_panel: { default_path: 'sidepanel.html' }
        }
      }]
    ]),
    session: {
      extensions: {
        getExtension: () => ({ id: 'ext-1', name: 'Side Panel Fixture' })
      }
    },
    electronChromeExtensions: {
      api: {
        sidePanel: {
          getResolvedOptions: sinon.stub().returns({ enabled: true, path: 'sidepanel.html' }),
          getResolvedPanelBehavior: sinon.stub().returns({ openPanelOnActionClick: false })
        }
      },
      ctx: {
        store: {
          tabs: new Set(),
          windowToActiveTab: new Map(),
          lastFocusedWindowId: null
        }
      },
      addTab: sinon.spy(),
      removeTab: sinon.spy(),
      selectTab: sinon.spy()
    },
    ...overrides
  }
}

describe('side panel host service', function () {
  let SidePanel
  let BrowserWindow
  let win
  let pageTab
  let webContentsApi

  beforeEach(async function () {
    win = makeWindow(7)
    pageTab = {
      id: 42,
      isDestroyed: () => false,
      getURL: () => 'https://example.com/'
    }
    webContentsApi = {
      fromId: sinon.stub().callsFake((id) => (id === pageTab.id ? pageTab : null))
    }
    BrowserWindow = {
      fromId: sinon.stub().callsFake((id) => (id === win.id ? win : null)),
      getFocusedWindow: sinon.stub().returns(win),
      getAllWindows: sinon.stub().returns([win])
    }

    SidePanel = await esmock('../../src/extensions/services/side-panel.js', {
      electron: { BrowserWindow, webContents: webContentsApi }
    })
  })

  afterEach(function () {
    sinon.restore()
  })

  it('openSidePanel records tab-scoped intent and notifies the shell', async function () {
    const manager = makeManager()
    await SidePanel.openSidePanel(manager, {
      extension: { id: 'ext-1', name: 'Side Panel Fixture' },
      path: 'sidepanel.html',
      tabId: 42,
      windowId: win.id
    })

    expect(manager.sidePanelOpenByTab.get('7:42')).to.include({
      extensionId: 'ext-1',
      path: 'sidepanel.html',
      tabId: 42
    })
    expect(manager.activeSidePanels.get(7).tabId).to.equal(42)
    expect(win.webContents.send.calledWith('extensions-side-panel-open')).to.equal(true)
    const payload = win.webContents.send.firstCall.args[1]
    expect(payload.url).to.equal('chrome-extension://ext-1/sidepanel.html')
  })

  it('openSidePanel pins the page tab as the active ECE tab', async function () {
    const manager = makeManager()
    await SidePanel.openSidePanel(manager, {
      extension: { id: 'ext-1', name: 'Side Panel Fixture' },
      path: 'sidepanel.html',
      tabId: 42,
      windowId: win.id
    })

    const store = manager.electronChromeExtensions.ctx.store
    expect(store.lastFocusedWindowId).to.equal(7)
    expect(store.windowToActiveTab.get(win)).to.equal(pageTab)
    expect(manager.electronChromeExtensions.selectTab.calledWith(pageTab, win)).to.equal(true)
  })

  it('openSidePanel without tabId records global intent', async function () {
    const manager = makeManager()
    await SidePanel.openSidePanel(manager, {
      extension: { id: 'ext-1', name: 'Side Panel Fixture' },
      path: 'sidepanel.html',
      windowId: win.id
    })

    expect(manager.sidePanelOpenGlobal.get(7)).to.include({
      extensionId: 'ext-1',
      path: 'sidepanel.html'
    })
    expect(manager.sidePanelOpenByTab.size).to.equal(0)
  })

  it('syncSidePanelForActiveTab hides a tab-scoped panel on other tabs', async function () {
    const manager = makeManager()
    await SidePanel.openSidePanel(manager, {
      extension: { id: 'ext-1', name: 'Side Panel Fixture' },
      path: 'sidepanel.html',
      tabId: 42,
      windowId: win.id
    })
    win.webContents.send.resetHistory()

    SidePanel.syncSidePanelForActiveTab(manager, win, 99)

    expect(manager.activeSidePanels.has(7)).to.equal(false)
    expect(manager.sidePanelOpenByTab.has('7:42')).to.equal(true)
    expect(win.webContents.send.calledWith('extensions-side-panel-close')).to.equal(true)
  })

  it('syncSidePanelForActiveTab restores a previously opened tab panel without clearing intent', async function () {
    const manager = makeManager()
    await SidePanel.openSidePanel(manager, {
      extension: { id: 'ext-1', name: 'Side Panel Fixture' },
      path: 'sidepanel.html',
      tabId: 42,
      windowId: win.id
    })
    SidePanel.syncSidePanelForActiveTab(manager, win, 99)
    win.webContents.send.resetHistory()

    SidePanel.syncSidePanelForActiveTab(manager, win, 42)

    expect(manager.activeSidePanels.get(7).tabId).to.equal(42)
    expect(manager.sidePanelOpenByTab.has('7:42')).to.equal(true)
    expect(win.webContents.send.calledWith('extensions-side-panel-open')).to.equal(true)
  })

  it('syncSidePanelForActiveTab keeps a global panel visible across tabs', async function () {
    const manager = makeManager()
    await SidePanel.openSidePanel(manager, {
      extension: { id: 'ext-1', name: 'Side Panel Fixture' },
      path: 'sidepanel.html',
      windowId: win.id
    })
    win.webContents.send.resetHistory()

    SidePanel.syncSidePanelForActiveTab(manager, win, 55)

    expect(manager.activeSidePanels.get(7).extensionId).to.equal('ext-1')
    expect(win.webContents.send.calledWith('extensions-side-panel-open')).to.equal(true)
  })

  it('syncSidePanelForActiveTab hides when options disable the panel for that tab', async function () {
    const manager = makeManager()
    manager.electronChromeExtensions.api.sidePanel.getResolvedOptions
      .withArgs('ext-1', 55)
      .returns({ enabled: false, path: 'sidepanel.html' })

    await SidePanel.openSidePanel(manager, {
      extension: { id: 'ext-1', name: 'Side Panel Fixture' },
      path: 'sidepanel.html',
      windowId: win.id
    })
    win.webContents.send.resetHistory()

    SidePanel.syncSidePanelForActiveTab(manager, win, 55)

    expect(manager.activeSidePanels.has(7)).to.equal(false)
    expect(win.webContents.send.calledWith('extensions-side-panel-close')).to.equal(true)
  })

  it('tryOpenSidePanelOnActionClick opens when behavior is enabled', async function () {
    const manager = makeManager()
    manager.electronChromeExtensions.api.sidePanel.getResolvedPanelBehavior
      .returns({ openPanelOnActionClick: true })

    const handled = await SidePanel.tryOpenSidePanelOnActionClick(
      manager,
      manager.loadedExtensions.get('ext-1'),
      win,
      { id: 12 }
    )

    expect(handled).to.equal(true)
    expect(manager.activeSidePanels.get(7).tabId).to.equal(12)
  })

  it('tryOpenSidePanelOnActionClick leaves WebBrain-style clicks alone', async function () {
    const manager = makeManager()
    manager.electronChromeExtensions.api.sidePanel.getResolvedPanelBehavior
      .returns({ openPanelOnActionClick: false })

    const handled = await SidePanel.tryOpenSidePanelOnActionClick(
      manager,
      manager.loadedExtensions.get('ext-1'),
      win,
      { id: 12 }
    )

    expect(handled).to.equal(false)
    expect(manager.activeSidePanels.size).to.equal(0)
  })

  it('clearSidePanelState removes visible tab intent on user close', async function () {
    const manager = makeManager()
    await SidePanel.openSidePanel(manager, {
      extension: { id: 'ext-1', name: 'Side Panel Fixture' },
      path: 'sidepanel.html',
      tabId: 42,
      windowId: win.id
    })

    SidePanel.clearSidePanelState(manager, win.id)

    expect(manager.activeSidePanels.has(7)).to.equal(false)
    expect(manager.sidePanelOpenByTab.has('7:42')).to.equal(false)
  })

  it('isSidePanelGuest matches tracked guest ids and panel urls', async function () {
    const manager = makeManager()
    await SidePanel.openSidePanel(manager, {
      extension: { id: 'ext-1', name: 'Side Panel Fixture' },
      path: 'sidepanel.html',
      tabId: 42,
      windowId: win.id
    })

    const guest = {
      id: 900,
      isDestroyed: () => false,
      getURL: () => 'chrome-extension://ext-1/sidepanel.html'
    }
    expect(SidePanel.isSidePanelGuest(manager, win, guest)).to.equal(true)

    manager.sidePanelGuestIds.add(901)
    const tracked = {
      id: 901,
      isDestroyed: () => false,
      getURL: () => 'about:blank'
    }
    expect(SidePanel.isSidePanelGuest(manager, win, tracked)).to.equal(true)

    const page = {
      id: 42,
      isDestroyed: () => false,
      getURL: () => 'https://example.com/'
    }
    expect(SidePanel.isSidePanelGuest(manager, win, page)).to.equal(false)
  })

  it('isSidePanelGuest ignores panel urls from another window', function () {
    const manager = makeManager()
    manager.sidePanelOpenByTab.set('8:99', {
      extensionId: 'ext-1',
      path: 'sidepanel.html',
      url: 'chrome-extension://ext-1/sidepanel.html',
      tabId: 99
    })

    const guest = {
      id: 500,
      isDestroyed: () => false,
      getURL: () => 'chrome-extension://ext-1/sidepanel.html'
    }
    expect(SidePanel.isSidePanelGuest(manager, win, guest)).to.equal(false)
    expect(SidePanel.isSidePanelGuest(manager, makeWindow(8), guest)).to.equal(true)
  })

  it('registerSidePanelGuest excludes the guest from ECE tabs', function () {
    const manager = makeManager()
    const guest = {
      id: 900,
      isDestroyed: () => false,
      once: sinon.spy()
    }
    webContentsApi.fromId.callsFake((id) => (id === 900 ? guest : id === 42 ? pageTab : null))
    manager._registeredTabs.add(900)

    SidePanel.registerSidePanelGuest(manager, 900)

    expect(manager.sidePanelGuestIds.has(900)).to.equal(true)
    expect(manager._registeredTabs.has(900)).to.equal(false)
    expect(manager.electronChromeExtensions.removeTab.calledWith(guest)).to.equal(true)
  })
})
