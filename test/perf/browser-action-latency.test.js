/**
 * Cost of one click on an extension's toolbar icon.
 *
 * Opening a popup used to resolve the active tab twice — each resolution being
 * an executeJavaScript round-trip into the shell renderer — and probe the
 * extension directory on disk before the popup was even asked for, walking two
 * levels deep when a manifest's popup path did not match. On a busy renderer
 * that latency is what made a click look like it did nothing, so the user
 * clicked again.
 *
 * The renderer now names the active tab in the IPC payload, the resolution
 * happens once, and the directory probe only runs in the fallback path that
 * actually needs it.
 */

import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'

const ACTION_ID = 'ext-perf'
const ELECTRON_ID = 'aaaabbbbccccddddeeeeffffgggghhhh'

function makeWindow (id = 7, shellWebContents) {
  return {
    id,
    isDestroyed: () => false,
    webContents: shellWebContents,
    getBounds: () => ({ x: 0, y: 0, width: 1280, height: 800 })
  }
}

function makeManager ({ openPopup, addWindow } = {}) {
  return {
    loadedExtensions: new Map([[ACTION_ID, {
      id: ACTION_ID,
      electronId: ELECTRON_ID,
      enabled: true,
      installedPath: '/nonexistent/extension/path',
      displayName: 'Perf Fixture',
      name: 'Perf Fixture',
      manifest: { action: { default_popup: 'popup.html' } }
    }]]),
    activePopups: new Set(),
    popupToOpener: new Map(),
    popupToExtensionId: new Map(),
    addWindow: addWindow || sinon.stub(),
    electronChromeExtensions: {
      api: { browserAction: { openPopup: openPopup || sinon.stub().resolves() } },
      ctx: {
        store: {
          tabs: new Set(),
          windowToActiveTab: new Map(),
          tabDetailsCache: new Map(),
          lastFocusedWindowId: null
        },
        router: { broadcastEvent: sinon.stub() }
      },
      addTab: sinon.stub(),
      selectTab: sinon.stub()
    }
  }
}

/**
 * Load browser-actions with a stubbed Electron so webContents.fromId and the
 * ownership check are under the test's control.
 */
async function loadBrowserActions ({ tabWebContents, shellWebContents, ownerWindow }) {
  const access = sinon.stub().resolves()
  const readdir = sinon.stub().resolves([])

  const module = await esmock.strict('../../src/extensions/services/browser-actions.js', {
    electron: {
      app: { once: sinon.stub() },
      BrowserWindow: { fromWebContents: (wc) => (wc === tabWebContents ? ownerWindow : null) },
      Menu: { buildFromTemplate: sinon.stub().returns({ popup: sinon.stub() }) },
      webContents: { fromId: (id) => (tabWebContents && id === tabWebContents.id ? tabWebContents : null) }
    },
    fs: { promises: { access, readdir } },
    '../../src/extensions/services/popup-guards.js': {
      registerPopupForStabilization: sinon.stub(),
      consumeRecentFocusClose: sinon.stub().returns(false)
    },
    '../../src/extensions/services/side-panel.js': {
      tryOpenSidePanelOnActionClick: sinon.stub().resolves(false),
      isSidePanelGuest: sinon.stub().returns(false),
      registerSidePanelGuest: sinon.stub()
    },
    '../../src/logger.js': {
      createLogger: () => ({ info () {}, warn () {}, error () {}, debug () {} })
    }
  })

  return { module, access, readdir, shellWebContents }
}

describe('Opening an extension popup', function () {
  let tabWebContents
  let shellWebContents
  let ownerWindow

  beforeEach(function () {
    shellWebContents = {
      id: 100,
      isDestroyed: () => false,
      send: sinon.stub(),
      executeJavaScript: sinon.stub().resolves(null)
    }
    ownerWindow = makeWindow(7, shellWebContents)
    tabWebContents = {
      id: 101,
      isDestroyed: () => false,
      hostWebContents: shellWebContents,
      getURL: () => 'peersky://home'
    }
  })

  afterEach(function () {
    sinon.restore()
  })

  it('makes no renderer round-trip when the renderer named the active tab', async function () {
    const openPopup = sinon.stub().resolves()
    const { module } = await loadBrowserActions({ tabWebContents, shellWebContents, ownerWindow })
    const manager = makeManager({ openPopup })

    const result = await module.openBrowserAction(manager, ACTION_ID, ownerWindow, {}, {
      activeWebContentsId: tabWebContents.id
    })

    expect(result.success).to.equal(true)
    expect(
      shellWebContents.executeJavaScript.callCount,
      'the click still asked the renderer which tab is active'
    ).to.equal(0)
    expect(openPopup.calledOnce).to.equal(true)
  })

  it('resolves the active tab exactly once when no hint is given', async function () {
    shellWebContents.executeJavaScript.resolves({
      tabId: 'tab-0',
      url: 'peersky://home',
      title: 'Home',
      webContentsId: tabWebContents.id
    })
    const { module } = await loadBrowserActions({ tabWebContents, shellWebContents, ownerWindow })
    const manager = makeManager()

    await module.openBrowserAction(manager, ACTION_ID, ownerWindow, {})

    expect(
      shellWebContents.executeJavaScript.callCount,
      'the active tab was resolved more than once per click'
    ).to.equal(1)
  })

  it('does not touch the extension directory on the happy path', async function () {
    const { module, access, readdir } = await loadBrowserActions({
      tabWebContents, shellWebContents, ownerWindow
    })
    const manager = makeManager()

    await module.openBrowserAction(manager, ACTION_ID, ownerWindow, {}, {
      activeWebContentsId: tabWebContents.id
    })

    expect(access.called, 'the popup file was probed before it was needed').to.equal(false)
    expect(readdir.called, 'the extension directory was walked on a plain click').to.equal(false)
  })

  it('registers the hinted tab with the extension host before opening', async function () {
    const addWindow = sinon.stub()
    const { module } = await loadBrowserActions({ tabWebContents, shellWebContents, ownerWindow })
    const manager = makeManager({ addWindow })

    await module.openBrowserAction(manager, ACTION_ID, ownerWindow, {}, {
      activeWebContentsId: tabWebContents.id
    })

    expect(addWindow.calledWith(ownerWindow, tabWebContents)).to.equal(true)
  })

  it('ignores a webContents id that does not belong to the sending window', async function () {
    const foreignTab = { id: 999, isDestroyed: () => false, hostWebContents: { id: 555 } }
    shellWebContents.executeJavaScript.resolves(null)
    const module = await esmock.strict('../../src/extensions/services/browser-actions.js', {
      electron: {
        app: { once: sinon.stub() },
        BrowserWindow: { fromWebContents: () => null },
        Menu: { buildFromTemplate: sinon.stub().returns({ popup: sinon.stub() }) },
        webContents: { fromId: (id) => (id === foreignTab.id ? foreignTab : null) }
      },
      fs: { promises: { access: sinon.stub().resolves(), readdir: sinon.stub().resolves([]) } },
      '../../src/extensions/services/popup-guards.js': {
        registerPopupForStabilization: sinon.stub(),
        consumeRecentFocusClose: sinon.stub().returns(false)
      },
      '../../src/extensions/services/side-panel.js': {
        tryOpenSidePanelOnActionClick: sinon.stub().resolves(false),
        isSidePanelGuest: sinon.stub().returns(false),
        registerSidePanelGuest: sinon.stub()
      },
      '../../src/logger.js': {
        createLogger: () => ({ info () {}, warn () {}, error () {}, debug () {} })
      }
    })
    const addWindow = sinon.stub()
    const manager = makeManager({ addWindow })

    await module.openBrowserAction(manager, ACTION_ID, ownerWindow, {}, {
      activeWebContentsId: foreignTab.id
    })

    expect(addWindow.calledWith(ownerWindow, foreignTab), 'a foreign tab was registered').to.equal(false)
    expect(
      shellWebContents.executeJavaScript.callCount,
      'a rejected hint must fall back to asking the renderer'
    ).to.equal(1)
  })

  it('still toggles off without doing any work when the click closed the popup', async function () {
    const openPopup = sinon.stub().resolves()
    const module = await esmock.strict('../../src/extensions/services/browser-actions.js', {
      electron: {
        app: { once: sinon.stub() },
        BrowserWindow: { fromWebContents: () => null },
        Menu: { buildFromTemplate: sinon.stub().returns({ popup: sinon.stub() }) },
        webContents: { fromId: () => null }
      },
      fs: { promises: { access: sinon.stub().resolves(), readdir: sinon.stub().resolves([]) } },
      '../../src/extensions/services/popup-guards.js': {
        registerPopupForStabilization: sinon.stub(),
        consumeRecentFocusClose: sinon.stub().returns(true)
      },
      '../../src/extensions/services/side-panel.js': {
        tryOpenSidePanelOnActionClick: sinon.stub().resolves(false),
        isSidePanelGuest: sinon.stub().returns(false),
        registerSidePanelGuest: sinon.stub()
      },
      '../../src/logger.js': {
        createLogger: () => ({ info () {}, warn () {}, error () {}, debug () {} })
      }
    })

    const result = await module.openBrowserAction(makeManager({ openPopup }), ACTION_ID, ownerWindow, {})

    expect(result).to.deep.equal({ success: true, toggled: true })
    expect(openPopup.called).to.equal(false)
    expect(shellWebContents.executeJavaScript.called).to.equal(false)
  })
})
