import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'

// The home page's clock, wallpaper and pinned apps live in a tab, which is a
// page of its own, not the window. A change sent only to windows reached an
// open home tab only after it was reloaded: unpinning an app on the P2P apps
// page left it on the home page's bar.
describe('settings that the home page shows', function () {
  async function loadManager () {
    const windowPage = { isDestroyed: () => false, send: sinon.spy() }
    const homeTab = { isDestroyed: () => false, send: sinon.spy() }
    const closedTab = { isDestroyed: () => true, send: sinon.spy() }
    const electron = {
      app: { getPath: () => '/tmp/peersky-settings-broadcast-test', on () {}, whenReady: () => new Promise(() => {}) },
      ipcMain: { handle () {}, on () {}, removeHandler () {} },
      BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: windowPage }] },
      session: { defaultSession: {} },
      safeStorage: { isEncryptionAvailable: () => false },
      dialog: {},
      webContents: { getAllWebContents: () => [windowPage, homeTab, closedTab] },
      nativeTheme: { themeSource: 'system' }
    }
    const { default: manager } = await esmock.strict('../src/settings-manager.js', {
      '../src/protocols/config.js': { ensCache: new Map(), ipfsCache: new Map(), hyperCache: new Map(), saveEnsCache () {}, saveIpfsCache () {}, saveHyperCache () {} },
      '../src/ens-utils.js': { normalizeEnsHash: (v) => v },
      '../src/permissions.js': { clearPersistedPermissions () {} },
      '../src/p2p-app-registry.js': { default: {} }
    }, { electron, fs: { promises: { readFile: async () => '{}', writeFile: async () => {}, mkdir: async () => {}, access: async () => {}, appendFile: async () => {} } } })
    return { manager, windowPage, homeTab, closedTab }
  }

  for (const [key, channel, value] of [
    ['pinnedP2PApps', 'pinned-apps-changed', ['chat', 'p2pmd']],
    ['showClock', 'show-clock-changed', false],
    ['clockFormat', 'clock-format-changed', '24h'],
    ['wallpaper', 'wallpaper-changed', 'builtin']
  ]) {
    it(`reaches an open home tab when ${key} changes`, async function () {
      const { manager, windowPage, homeTab, closedTab } = await loadManager()
      manager.applySettingChange(key, value)
      expect(homeTab.send.calledWith(channel, value)).to.equal(true)
      expect(windowPage.send.calledWith(channel, value)).to.equal(true)
      expect(closedTab.send.called).to.equal(false)
    })
  }
})

// With the Light theme on a Mac in dark mode, websites still matched
// prefers-color-scheme: dark, since Electron followed the system whatever
// PeerSky's theme was.
describe('the light or dark websites see', function () {
  async function loadManager (saved = {}) {
    const nativeTheme = { themeSource: 'system' }
    const electron = {
      app: { getPath: () => '/tmp/peersky-color-scheme-test', on () {}, whenReady: () => Promise.resolve() },
      ipcMain: { handle () {}, on () {}, removeHandler () {} },
      BrowserWindow: { getAllWindows: () => [] },
      session: { defaultSession: {} },
      safeStorage: { isEncryptionAvailable: () => false },
      dialog: {},
      webContents: { getAllWebContents: () => [] },
      nativeTheme
    }
    const module = await esmock.strict('../src/settings-manager.js', {
      '../src/protocols/config.js': { ensCache: new Map(), ipfsCache: new Map(), hyperCache: new Map(), saveEnsCache () {}, saveIpfsCache () {}, saveHyperCache () {} },
      '../src/ens-utils.js': { normalizeEnsHash: (v) => v },
      '../src/permissions.js': { clearPersistedPermissions () {} },
      '../src/p2p-app-registry.js': { default: {} }
    }, { electron, fs: { promises: { readFile: async () => JSON.stringify({ tabLayoutV1: true, ...saved }), writeFile: async () => {}, rename: async () => {}, mkdir: async () => {}, access: async () => {}, appendFile: async () => {} } } })
    // Let the saved settings load.
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { manager: module.default, colorSchemeForTheme: module.colorSchemeForTheme, nativeTheme }
  }

  it('follows the theme picked, as Chrome follows its own light or dark mode', async function () {
    const { manager, nativeTheme } = await loadManager()
    manager.applySettingChange('theme', 'light')
    expect(nativeTheme.themeSource).to.equal('light')
    manager.applySettingChange('theme', 'dark')
    expect(nativeTheme.themeSource).to.equal('dark')
  })

  it('is light for each light theme and dark for each dark one', async function () {
    const { colorSchemeForTheme } = await loadManager()
    for (const theme of ['light', 'cyan', 'green', 'yellow', 'violet']) expect(colorSchemeForTheme(theme), theme).to.equal('light')
    for (const theme of ['dark', 'transparent']) expect(colorSchemeForTheme(theme), theme).to.equal('dark')
    expect(colorSchemeForTheme('something-new')).to.equal('system')
  })

  it('is set from the saved theme at start', async function () {
    const { nativeTheme } = await loadManager({ theme: 'violet' })
    expect(nativeTheme.themeSource).to.equal('light')
  })
})
