import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'
import os from 'os'
import path from 'path'
import { readFile, mkdtemp, rm } from 'fs/promises'

// The manager logs heavily on every save; keep the suite output readable.
process.env.PEERSKY_LOGS = process.env.PEERSKY_LOGS || '-window-manager'
// Each esmock load is a fresh module instance registering its own signal
// handlers. Production loads it once, so the accumulation is a test artefact.
process.setMaxListeners(0)

/**
 * Session restore across a browser restart.
 *
 * Drives the real WindowManager save/load code with userData pointed at a temp
 * directory, so lastOpened.json and tabs.json are genuinely written and read
 * back. Only BrowserWindow and the renderer bridge are faked.
 */

const HOME = 'peersky://home'

function makeTabs (urls, { activeIndex = 0, pinnedIndex = -1 } = {}) {
  return {
    tabs: urls.map((url, i) => ({
      id: `tab-${i}`,
      url,
      title: `Tab ${i}`,
      protocol: url.split(':')[0],
      isPinned: i === pinnedIndex,
      groupId: null,
      navigation: { entries: [{ url }], index: 0 },
      isSuspended: false
    })),
    activeTabId: `tab-${activeIndex}`,
    tabCounter: urls.length,
    splitPairs: [],
    tabGroups: []
  }
}

/**
 * A stand-in for PeerskyWindow: only the surface saveWindowStates() and
 * getTabs() actually touch.
 */
function makeWindow ({ windowId, url, position, size, tabs }) {
  return {
    windowId,
    getURL: async () => url,
    window: {
      isDestroyed: () => false,
      getPosition: () => position,
      getSize: () => size,
      webContents: {
        isDestroyed: () => false,
        executeJavaScript: async () => tabs
      }
    }
  }
}

async function loadWindowManager (userDataPath) {
  const electron = {
    app: {
      getPath: () => userDataPath,
      on: () => {},
      whenReady: async () => {},
      quit: () => {}
    },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
    BrowserWindow: Object.assign(function BrowserWindow () {}, {
      getAllWindows: () => [],
      fromWebContents: () => null
    }),
    webContents: { fromId: () => null, getAllWebContents: () => [] },
    session: { fromPartition: () => ({}), defaultSession: {} },
    Menu: { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} },
    shell: { openExternal: async () => {} },
    dialog: {},
    safeStorage: {}
  }

  // All of these are direct imports of window-manager, so they belong in the
  // local map. esmock's global map (third argument) resolves module ids with
  // native separators and misdetects ESM as CJS on Windows.
  const { default: WindowManager } = await esmock.strict('../../src/window-manager.js', {
    electron,
    '../../src/extensions/index.js': { default: { addWindow: () => {}, removeWindow: () => {} } },
    '../../src/context-menu.js': { attachContextMenus: () => {}, setWindowManager: () => {} },
    '../../src/session.js': { getPartition: () => 'persist:peersky', usePersist: () => true }
  })
  return WindowManager
}

describe('Session restore across restart', function () {
  this.timeout(20000)

  let userData
  let WindowManager

  beforeEach(async function () {
    userData = await mkdtemp(path.join(os.tmpdir(), 'peersky-session-'))
    WindowManager = await loadWindowManager(userData)
  })

  afterEach(async function () {
    sinon.restore()
    await rm(userData, { recursive: true, force: true })
  })

  const readJson = async (name) => JSON.parse(await readFile(path.join(userData, name), 'utf8'))

  /** Four windows at distinct positions, each with its own set of tabs. */
  function fourWindows () {
    return [
      makeWindow({
        windowId: 'win-a',
        url: HOME,
        position: [0, 0],
        size: [1200, 800],
        tabs: makeTabs([HOME, 'ipfs://bafyone/', 'https://example.com/'], { activeIndex: 1 })
      }),
      makeWindow({
        windowId: 'win-b',
        url: 'hyper://chat/',
        position: [340, 120],
        size: [1000, 700],
        tabs: makeTabs(['hyper://chat/', 'peersky://settings'], { pinnedIndex: 0 })
      }),
      makeWindow({
        windowId: 'win-c',
        url: 'peersky://backup',
        position: [700, 260],
        size: [900, 640],
        tabs: makeTabs(['peersky://backup'])
      }),
      makeWindow({
        windowId: 'win-d',
        url: 'ipns://peersky.p2plabs.xyz/',
        position: [1080, 400],
        size: [1400, 900],
        tabs: makeTabs(['ipns://peersky.p2plabs.xyz/', 'bt://somehash/', HOME], { activeIndex: 2 })
      })
    ]
  }

  async function saveSession (manager, windows) {
    manager.windows = new Set(windows)
    await manager.saveCompleteState()
  }

  it('restores every window with its position, size and tabs', async function () {
    const manager = new WindowManager()
    const windows = fourWindows()
    await saveSession(manager, windows)

    const states = await readJson('lastOpened.json')
    const tabs = await readJson('tabs.json')
    expect(states).to.have.lengthOf(4)
    expect(Object.keys(tabs)).to.have.members(['win-a', 'win-b', 'win-c', 'win-d'])

    // Restart: a fresh manager reads what the previous run wrote.
    const restarted = new WindowManager()
    const open = sinon.stub(restarted, 'open')
    await restarted.openSavedWindows()

    expect(open.callCount).to.equal(4)

    for (const original of windows) {
      const call = open.getCalls().find((c) => c.args[0].windowId === original.windowId)
      expect(call, `window ${original.windowId} was not restored`).to.not.equal(undefined)

      const options = call.args[0]
      const [x, y] = original.window.getPosition()
      const [width, height] = original.window.getSize()
      expect(options.x).to.equal(x)
      expect(options.y).to.equal(y)
      expect(options.width).to.equal(width)
      expect(options.height).to.equal(height)
      expect(options.url).to.equal(await original.getURL())
    }
  })

  it('gives each window back its own tabs, not those of another window', async function () {
    const manager = new WindowManager()
    await saveSession(manager, fourWindows())

    const restarted = new WindowManager()
    const open = sinon.stub(restarted, 'open')
    await restarted.openSavedWindows()

    const optionsFor = (id) => open.getCalls().find((c) => c.args[0].windowId === id).args[0]

    expect(optionsFor('win-a').savedTabs.tabs.map((t) => t.url)).to.deep.equal([
      HOME, 'ipfs://bafyone/', 'https://example.com/'
    ])
    expect(optionsFor('win-b').savedTabs.tabs.map((t) => t.url)).to.deep.equal([
      'hyper://chat/', 'peersky://settings'
    ])
    expect(optionsFor('win-d').savedTabs.tabs).to.have.lengthOf(3)

    // Per-window UI state survives too.
    expect(optionsFor('win-a').savedTabs.activeTabId).to.equal('tab-1')
    expect(optionsFor('win-d').savedTabs.activeTabId).to.equal('tab-2')
    expect(optionsFor('win-b').savedTabs.tabs[0].isPinned).to.equal(true)
  })

  it('does not restore a window that was closed before quitting', async function () {
    const manager = new WindowManager()
    const windows = fourWindows()
    await saveSession(manager, windows)

    // Close one window, then save again as the app would on the next tick.
    const closed = windows[2]
    await saveSession(manager, windows.filter((w) => w !== closed))

    const states = await readJson('lastOpened.json')
    expect(states.map((s) => s.windowId)).to.not.include(closed.windowId)

    const restarted = new WindowManager()
    const open = sinon.stub(restarted, 'open')
    await restarted.openSavedWindows()

    expect(open.callCount).to.equal(3)
    const restored = open.getCalls().map((c) => c.args[0].windowId)
    expect(restored).to.have.members(['win-a', 'win-b', 'win-d'])
    expect(restored).to.not.include('win-c')
  })

  it('keeps the remaining windows at their own positions after one closes', async function () {
    const manager = new WindowManager()
    const windows = fourWindows()
    await saveSession(manager, windows.filter((w) => w.windowId !== 'win-b'))

    const restarted = new WindowManager()
    const open = sinon.stub(restarted, 'open')
    await restarted.openSavedWindows()

    const byId = Object.fromEntries(open.getCalls().map((c) => [c.args[0].windowId, c.args[0]]))
    expect(byId['win-a'].x).to.equal(0)
    expect(byId['win-a'].y).to.equal(0)
    expect(byId['win-c'].x).to.equal(700)
    expect(byId['win-c'].y).to.equal(260)
    expect(byId['win-d'].width).to.equal(1400)
    expect(byId['win-d'].height).to.equal(900)
  })

  // Both tab modes must persist the same way, or one of them silently loses its
  // session. VerticalTabs extends BaseTabBar rather than reimplementing the
  // serializer, and getTabs() queries for both custom elements.
  describe('horizontal and vertical tab modes', function () {
    const read = async (file) => readFile(new URL(`../../src/${file}`, import.meta.url), 'utf8')

    it('collects tabs from either tab bar element', async function () {
      const source = await read('window-manager.js')
      const selector = source.match(/querySelector\('([^']*tab-bar[^']*)'\)/)

      expect(selector, 'tab bar lookup not found in getTabs()').to.not.equal(null)
      expect(selector[1]).to.contain('tab-bar')
      expect(selector[1]).to.contain('vertical-tabs')
    })

    it('serializes vertical tabs with the shared implementation', async function () {
      const vertical = await read('pages/vertical-tabs.js')
      const horizontal = await read('pages/tab-bar.js')

      expect(vertical).to.match(/class VerticalTabs extends BaseTabBar/)
      // An override here would let the two modes drift apart.
      expect(vertical).to.not.contain('getTabsStateForSaving (')
      expect(horizontal).to.contain('getTabsStateForSaving (')
    })

    it('restores a window saved in either mode identically', async function () {
      const manager = new WindowManager()
      const urls = [HOME, 'ipfs://bafyone/']

      // Same payload either way, since the serializer is shared.
      await saveSession(manager, [
        makeWindow({
          windowId: 'win-horizontal',
          url: HOME,
          position: [0, 0],
          size: [1200, 800],
          tabs: makeTabs(urls, { activeIndex: 1 })
        }),
        makeWindow({
          windowId: 'win-vertical',
          url: HOME,
          position: [500, 300],
          size: [1000, 700],
          tabs: makeTabs(urls, { activeIndex: 1 })
        })
      ])

      const restarted = new WindowManager()
      const open = sinon.stub(restarted, 'open')
      await restarted.openSavedWindows()

      const byId = Object.fromEntries(open.getCalls().map((c) => [c.args[0].windowId, c.args[0]]))
      expect(byId['win-horizontal'].savedTabs).to.deep.equal(byId['win-vertical'].savedTabs)
      expect(byId['win-vertical'].savedTabs.tabs.map((t) => t.url)).to.deep.equal(urls)
      expect(byId['win-vertical'].x).to.equal(500)
    })
  })

  it('opens a single default window when nothing was saved', async function () {
    const restarted = new WindowManager()
    const open = sinon.stub(restarted, 'open')
    await restarted.openSavedWindows()

    expect(open.calledOnce).to.equal(true)
    expect(open.firstCall.args[0]).to.equal(undefined)
  })

  it('falls back to the home page for a window with no saved tabs', async function () {
    const manager = new WindowManager()
    const windows = [
      makeWindow({
        windowId: 'win-empty',
        url: HOME,
        position: [10, 20],
        size: [800, 600],
        tabs: null
      })
    ]
    await saveSession(manager, windows)

    const restarted = new WindowManager()
    const open = sinon.stub(restarted, 'open')
    await restarted.openSavedWindows()

    const options = open.firstCall.args[0]
    expect(options.savedTabs).to.equal(null)
    expect(options.url).to.equal(HOME)
  })
})
