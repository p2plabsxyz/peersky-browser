import { expect } from 'chai'
import esmock from 'esmock'
import sinon from 'sinon'

const UPDATE_HOST = 'https://update.electronjs.org'

// setupAutoUpdater reads process.platform at call time. Override it per test
// so the suite behaves identically on Linux/Windows/macOS CI runners.
function withPlatform (platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

// process.env.APPIMAGE is the signal electron uses for "running as an AppImage".
// Pass undefined to simulate a deb/rpm/pacman install.
async function withAppImage (value, fn) {
  const original = process.env.APPIMAGE
  if (value === undefined) delete process.env.APPIMAGE
  else process.env.APPIMAGE = value
  try {
    return await fn()
  } finally {
    if (original === undefined) delete process.env.APPIMAGE
    else process.env.APPIMAGE = original
  }
}

function makeNetFetch (response = { ok: false, status: 404 }) {
  return sinon.stub().resolves({
    ok: response.ok ?? false,
    status: response.status ?? 404,
    json: async () => response.body ?? null,
    arrayBuffer: async () => new ArrayBuffer(0),
    body: {
      getReader: () => {
        let done = false
        return {
          read: async () => {
            if (done) return { done: true, value: undefined }
            done = true
            return { done: false, value: new Uint8Array(0) }
          }
        }
      }
    }
  })
}

async function loadAutoUpdater ({ isPackaged = true, version = '1.0.0', autoUpdateEnabled = true, fetchResponse } = {}) {
  // Electron's native autoUpdater (macOS path) with EventEmitter-like support.
  const listeners = {}
  const autoUpdater = {
    setFeedURL: sinon.spy(),
    checkForUpdates: sinon.spy(),
    quitAndInstall: sinon.spy(),
    on: sinon.spy(function (event, handler) {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push({ handler, once: false })
    }),
    once: sinon.spy(function (event, handler) {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push({ handler, once: true })
    }),
    removeListener: sinon.spy(function (event, handler) {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(l => l.handler !== handler)
      }
    }),
    emit: (event, ...args) => {
      if (listeners[event]) {
        const toCall = [...listeners[event]]
        listeners[event] = listeners[event].filter(l => !l.once)
        toCall.forEach(l => l.handler(...args))
      }
    }
  }

  const netFetch = makeNetFetch(fetchResponse)

  const dialog = { showMessageBoxSync: sinon.stub().returns(1) }

  const app = {
    isPackaged,
    getVersion: () => version,
    quit: sinon.spy(),
    relaunch: sinon.spy()
  }

  const log = {
    info: sinon.spy(),
    warn: sinon.spy(),
    error: sinon.spy(),
    transports: { file: {} }
  }

  const module = await esmock.strict('../../src/auto-updater.js', {
    electron: { app, autoUpdater, dialog, net: { fetch: netFetch } },
    'electron-log': { default: log },
    fs: await import('fs'),
    path: await import('path'),
    os: await import('os'),
    '../../src/settings-manager.js': { default: { settings: { autoUpdateEnabled } } }
  })

  return { module, autoUpdater, netFetch, dialog, app, log }
}

describe('auto-updater', function () {
  let clock

  afterEach(function () {
    if (clock) {
      clock.restore()
      clock = null
    }
    sinon.restore()
  })

  it('skips entirely in dev mode (not packaged)', async function () {
    const { module, autoUpdater, log } = await loadAutoUpdater({ isPackaged: false })

    withPlatform('darwin', () => module.setupAutoUpdater())

    expect(autoUpdater.setFeedURL.called).to.equal(false)
    expect(autoUpdater.on.called).to.equal(false)
    expect(log.info.calledWithMatch(/Dev mode/)).to.equal(true)
  })

  it('uses net.fetch updater on Linux when running as an AppImage', async function () {
    clock = sinon.useFakeTimers()
    const { module, autoUpdater, netFetch } = await loadAutoUpdater()

    await withAppImage('/tmp/Peersky.AppImage', async () =>
      withPlatform('linux', () => module.setupAutoUpdater())
    )

    expect(autoUpdater.setFeedURL.called).to.equal(false)
    await clock.tickAsync(10000)
    expect(netFetch.called).to.equal(true)
  })

  it('skips non-AppImage Linux builds (handled by the distro package manager)', async function () {
    const { module, netFetch, log } = await loadAutoUpdater()

    await withAppImage(undefined, () =>
      withPlatform('linux', () => module.setupAutoUpdater())
    )

    expect(netFetch.called).to.equal(false)
    expect(log.info.calledWithMatch(/package manager/)).to.equal(true)
  })

  it('skips periodic checks when disabled in user settings but initializes updater', async function () {
    clock = sinon.useFakeTimers()
    const { module, autoUpdater, log } = await loadAutoUpdater({ autoUpdateEnabled: false })

    withPlatform('darwin', () => module.setupAutoUpdater())

    // Updater is initialized (manual button works)
    expect(autoUpdater.setFeedURL.called).to.equal(true)
    expect(log.info.calledWithMatch(/manual check still available/)).to.equal(true)

    // But no periodic checks are scheduled
    clock.tick(10000)
    expect(autoUpdater.checkForUpdates.called).to.equal(false)
  })

  it('configures a JSON feed URL pointing at the configured repo and version', async function () {
    const { module, autoUpdater } = await loadAutoUpdater({ version: '1.2.3' })

    withPlatform('darwin', () => module.setupAutoUpdater())

    expect(autoUpdater.setFeedURL.calledOnce).to.equal(true)
    const arg = autoUpdater.setFeedURL.firstCall.args[0]
    expect(arg.serverType).to.equal('json')
    expect(arg.url).to.match(new RegExp(`^${UPDATE_HOST}/[\\w-]+/[\\w-]+/`))
    expect(arg.url).to.contain('darwin-')
    expect(arg.url.endsWith('/1.2.3')).to.equal(true)
    expect(arg.headers['User-Agent']).to.contain('1.2.3')
  })

  it('registers the expected autoUpdater event handlers', async function () {
    const { module, autoUpdater } = await loadAutoUpdater()

    withPlatform('darwin', () => module.setupAutoUpdater())

    const events = autoUpdater.on.getCalls().map((c) => c.args[0])
    expect(events).to.include.members([
      'checking-for-update',
      'update-available',
      'update-not-available',
      'download-progress',
      'update-downloaded',
      'error'
    ])
  })

  it('checks after a 10s startup delay, then on a 24h interval', async function () {
    clock = sinon.useFakeTimers()
    const { module, autoUpdater } = await loadAutoUpdater()

    withPlatform('darwin', () => module.setupAutoUpdater())

    // Nothing should fire before the startup delay elapses.
    expect(autoUpdater.checkForUpdates.called).to.equal(false)

    clock.tick(10000)
    expect(autoUpdater.checkForUpdates.callCount).to.equal(1)

    clock.tick(24 * 60 * 60 * 1000)
    expect(autoUpdater.checkForUpdates.callCount).to.equal(2)

    clock.tick(24 * 60 * 60 * 1000)
    expect(autoUpdater.checkForUpdates.callCount).to.equal(3)
  })

  it('does not throw when checkForUpdates returns void (native autoUpdater)', async function () {
    clock = sinon.useFakeTimers()
    const { module, autoUpdater, log } = await loadAutoUpdater()
    // Native autoUpdater.checkForUpdates() returns undefined; the spy already does.

    withPlatform('darwin', () => module.setupAutoUpdater())

    expect(() => clock.tick(10000)).to.not.throw()
    expect(autoUpdater.checkForUpdates.calledOnce).to.equal(true)
    expect(log.error.called).to.equal(false)
  })

  it('logs and recovers if checkForUpdates throws', async function () {
    clock = sinon.useFakeTimers()
    const { module, autoUpdater, log } = await loadAutoUpdater()
    autoUpdater.checkForUpdates = sinon.stub().throws(new Error('boom'))

    withPlatform('darwin', () => module.setupAutoUpdater())

    expect(() => clock.tick(10000)).to.not.throw()
    expect(log.error.calledWithMatch(/checkForUpdates failed/)).to.equal(true)
  })

  it('prompts to restart and installs when the user accepts', async function () {
    const { module, autoUpdater, dialog } = await loadAutoUpdater()
    dialog.showMessageBoxSync.returns(0) // user clicks "Restart Now"

    withPlatform('darwin', () => module.setupAutoUpdater())

    const downloadedHandler = autoUpdater.on
      .getCalls()
      .find((c) => c.args[0] === 'update-downloaded').args[1]

    await downloadedHandler({}, 'release notes', '2.0.0')

    expect(dialog.showMessageBoxSync.calledOnce).to.equal(true)
    expect(autoUpdater.quitAndInstall.calledOnce).to.equal(true)
  })

  it('does not install when the user postpones', async function () {
    const { module, autoUpdater, dialog } = await loadAutoUpdater()
    dialog.showMessageBoxSync.returns(1) // user clicks "Later"

    withPlatform('darwin', () => module.setupAutoUpdater())

    const downloadedHandler = autoUpdater.on
      .getCalls()
      .find((c) => c.args[0] === 'update-downloaded').args[1]

    await downloadedHandler({}, 'release notes', '2.0.0')

    expect(dialog.showMessageBoxSync.calledOnce).to.equal(true)
    expect(autoUpdater.quitAndInstall.called).to.equal(false)
  })

  describe('checkForUpdatesNow (manual check from Settings)', function () {
    it('returns not-initialized when updater is not set up', async function () {
      const { module } = await loadAutoUpdater({ isPackaged: false })

      withPlatform('darwin', () => module.setupAutoUpdater())

      const result = await module.checkForUpdatesNow()
      expect(result).to.equal('not-initialized')
    })

    it('returns up-to-date on macOS when update-not-available fires', async function () {
      const { module, autoUpdater } = await loadAutoUpdater()

      withPlatform('darwin', () => module.setupAutoUpdater())

      // Simulate Squirrel responding with no update
      autoUpdater.checkForUpdates = sinon.spy(() => {
        autoUpdater.emit('update-not-available')
      })

      const result = await withPlatform('darwin', () => module.checkForUpdatesNow())
      expect(result).to.equal('up-to-date')
    })

    it('returns up-to-date on macOS when Squirrel fires invalid response error', async function () {
      const { module, autoUpdater } = await loadAutoUpdater()

      withPlatform('darwin', () => module.setupAutoUpdater())

      // Simulate Squirrel error when already on latest (204 from update server)
      autoUpdater.checkForUpdates = sinon.spy(() => {
        autoUpdater.emit('error', new Error('Update check failed. The server sent an invalid response. Try again later.'))
      })

      const result = await withPlatform('darwin', () => module.checkForUpdatesNow())
      expect(result).to.equal('up-to-date')
    })

    it('returns error on macOS for genuine errors', async function () {
      const { module, autoUpdater } = await loadAutoUpdater()

      withPlatform('darwin', () => module.setupAutoUpdater())

      autoUpdater.checkForUpdates = sinon.spy(() => {
        autoUpdater.emit('error', new Error('Network connection lost'))
      })

      const result = await withPlatform('darwin', () => module.checkForUpdatesNow())
      expect(result).to.equal('error')
    })

    it('re-shows prompt from pending update when user previously clicked Later', async function () {
      const { module, autoUpdater, dialog } = await loadAutoUpdater()
      dialog.showMessageBoxSync.returns(1) // user clicks "Later"

      withPlatform('darwin', () => module.setupAutoUpdater())

      // Trigger update-downloaded so _pendingUpdate is stored
      const downloadedHandler = autoUpdater.on
        .getCalls()
        .find((c) => c.args[0] === 'update-downloaded').args[1]
      await downloadedHandler({}, 'notes', '2.0.0')

      expect(dialog.showMessageBoxSync.callCount).to.equal(1)

      // Now call checkForUpdatesNow - should re-show prompt without re-checking
      dialog.showMessageBoxSync.returns(1) // still clicks Later
      const result = await module.checkForUpdatesNow()

      expect(result).to.equal('update-available')
      expect(dialog.showMessageBoxSync.callCount).to.equal(2)
      // Should NOT have called checkForUpdates again
      expect(autoUpdater.checkForUpdates.called).to.equal(false)
    })

    it('returns up-to-date on Windows/Linux when already on latest', async function () {
      clock = sinon.useFakeTimers()
      const { module } = await loadAutoUpdater({
        version: '1.0.0',
        fetchResponse: { ok: true, status: 200, body: { tag_name: 'v1.0.0', assets: [] } }
      })

      withPlatform('win32', () => module.setupAutoUpdater())

      // Wait for initial scheduled check to complete
      await clock.tickAsync(10000)

      // Manual check should return up-to-date
      const result = await withPlatform('win32', () => module.checkForUpdatesNow())
      expect(result).to.equal('up-to-date')
    })
  })

  describe('Windows (net.fetch updater)', function () {
    it('uses net.fetch, not the native autoUpdater', async function () {
      clock = sinon.useFakeTimers()
      const { module, autoUpdater, netFetch } = await loadAutoUpdater()

      withPlatform('win32', () => module.setupAutoUpdater())

      expect(autoUpdater.setFeedURL.called).to.equal(false)
      expect(autoUpdater.on.called).to.equal(false)

      await clock.tickAsync(10000)
      expect(netFetch.called).to.equal(true)
    })

    it('checks after a 10s startup delay, then on a 24h interval', async function () {
      clock = sinon.useFakeTimers()
      const { module, netFetch } = await loadAutoUpdater()

      withPlatform('win32', () => module.setupAutoUpdater())

      expect(netFetch.called).to.equal(false)

      await clock.tickAsync(10000)
      expect(netFetch.callCount).to.equal(1)

      await clock.tickAsync(24 * 60 * 60 * 1000)
      expect(netFetch.callCount).to.equal(2)
    })

    it('logs update-not-available when already on latest', async function () {
      clock = sinon.useFakeTimers()
      const { module, log } = await loadAutoUpdater({
        version: '1.0.0',
        fetchResponse: { ok: true, status: 200, body: { tag_name: 'v1.0.0', assets: [] } }
      })

      withPlatform('win32', () => module.setupAutoUpdater())
      await clock.tickAsync(10000)

      expect(log.info.calledWithMatch(/update-not-available/)).to.equal(true)
    })

    it('logs and recovers if net.fetch rejects', async function () {
      clock = sinon.useFakeTimers()
      const { module, netFetch, log } = await loadAutoUpdater()
      netFetch.rejects(new Error('network error'))

      withPlatform('win32', () => module.setupAutoUpdater())
      await clock.tickAsync(10000)

      expect(log.error.calledWithMatch(/checkForUpdates failed/)).to.equal(true)
    })

    it('logs warning when GitHub API returns non-200', async function () {
      clock = sinon.useFakeTimers()
      const { module, log } = await loadAutoUpdater({
        fetchResponse: { ok: false, status: 403 }
      })

      withPlatform('win32', () => module.setupAutoUpdater())
      await clock.tickAsync(10000)

      expect(log.warn.calledWithMatch(/GitHub API returned 403/)).to.equal(true)
    })
  })
})
