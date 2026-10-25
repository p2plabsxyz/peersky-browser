import { expect } from 'chai'
import esmock from 'esmock'

// Clear Cache cleared every origin in the session, so it took the window's
// tabs, P2PMD's notes with their keys, PeerChat's page and the History
// extension's records along with the websites. It now leaves PeerSky's own
// origins out.
describe('Clear Cache', function () {
  async function loadManager () {
    const electron = {
      app: { getPath: () => '/tmp/peersky-clear-cache-test', on () {}, whenReady: () => new Promise(() => {}) },
      ipcMain: { handle () {}, on () {}, removeHandler () {} },
      BrowserWindow: { getAllWindows: () => [] },
      session: { defaultSession: {} },
      safeStorage: { isEncryptionAvailable: () => false },
      dialog: {},
      webContents: { getAllWebContents: () => [] }
    }
    return esmock.strict('../../src/settings-manager.js', {
      '../../src/protocols/config.js': { ensCache: new Map(), ipfsCache: new Map(), hyperCache: new Map(), saveEnsCache () {}, saveIpfsCache () {}, saveHyperCache () {} },
      '../../src/ens-utils.js': { normalizeEnsHash: (v) => v },
      '../../src/permissions.js': { clearPersistedPermissions () {} },
      '../../src/p2p-app-registry.js': { default: {} }
    }, { electron })
  }

  it("leaves PeerSky's own pages, the window and extensions out", async function () {
    const { ownStorageOrigins } = await loadManager()
    const ses = { extensions: { getAllExtensions: () => [{ id: 'abcdefghijklmnopabcdefghijklmnop' }] } }
    const origins = await ownStorageOrigins(ses)
    expect(origins).to.include.members([
      'file://',
      'peersky://p2p',
      'peersky://home',
      'peersky://settings',
      'peersky://backup',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
    ])
    for (const origin of origins) {
      expect(origin).to.match(/^(file:\/\/|peersky:\/\/[a-z0-9-]+|chrome-extension:\/\/[a-p]{32})$/)
    }
  })

  it('still clears websites', async function () {
    const { ownStorageOrigins } = await loadManager()
    const origins = await ownStorageOrigins({ getAllExtensions: () => [] })
    for (const site of ['https://example.com', 'http://127.0.0.1:8080', 'hyper://example', 'ipfs://example']) {
      expect(origins).to.not.include(site)
    }
  })
})
