import { expect } from 'chai'
import esmock from 'esmock'

// Tabs down the side, kept open, became the default in v1. A profile from
// before has horizontal tabs written down whether or not anyone chose them,
// since the whole settings object is saved, so each moves once.
describe('the v1 tab layout', function () {
  async function loadManager (saved) {
    const written = []
    const electron = {
      app: { getPath: () => '/tmp/peersky-tab-layout-test', on () {}, whenReady: () => new Promise(() => {}) },
      ipcMain: { handle () {}, on () {}, removeHandler () {} },
      BrowserWindow: { getAllWindows: () => [] },
      session: { defaultSession: {} },
      safeStorage: { isEncryptionAvailable: () => false },
      dialog: {},
      webContents: { getAllWebContents: () => [] }
    }
    const readFile = async () => {
      if (saved === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return JSON.stringify(saved)
    }
    const { default: manager } = await esmock.strict('../src/settings-manager.js', {
      '../src/protocols/config.js': { ensCache: new Map(), ipfsCache: new Map(), hyperCache: new Map(), saveEnsCache () {}, saveIpfsCache () {}, saveHyperCache () {} },
      '../src/ens-utils.js': { normalizeEnsHash: (v) => v },
      '../src/permissions.js': { clearPersistedPermissions () {} },
      '../src/p2p-app-registry.js': { default: {} }
    }, {
      electron,
      fs: {
        promises: {
          readFile,
          writeFile: async (file, text) => { written.push(JSON.parse(text)) },
          rename: async () => {},
          mkdir: async () => {},
          access: async () => {},
          appendFile: async () => {}
        }
      }
    })
    return { manager, written }
  }

  it('a new profile starts with vertical tabs kept expanded', async function () {
    const { manager } = await loadManager(undefined)
    const settings = await manager.loadSettings()
    expect(settings.verticalTabs).to.equal(true)
    expect(settings.keepTabsExpanded).to.equal(true)
  })

  it('a profile from beta 30 with horizontal tabs moves to vertical once, and the move is saved', async function () {
    const { manager, written } = await loadManager({ theme: 'dark', verticalTabs: false, keepTabsExpanded: false, onboardingCompleted: true })
    const settings = await manager.loadSettings()
    expect(settings.verticalTabs).to.equal(true)
    expect(settings.keepTabsExpanded).to.equal(true)
    expect(settings.theme).to.equal('dark')
    expect(written.at(-1)).to.include({ verticalTabs: true, keepTabsExpanded: true, tabLayoutV1: true })
  })

  it('after the move, horizontal tabs picked again are kept', async function () {
    const { manager, written } = await loadManager({ verticalTabs: false, keepTabsExpanded: false, tabLayoutV1: true, onboardingCompleted: true })
    const settings = await manager.loadSettings()
    expect(settings.verticalTabs).to.equal(false)
    expect(settings.keepTabsExpanded).to.equal(false)
    expect(written).to.deep.equal([])
  })
})
