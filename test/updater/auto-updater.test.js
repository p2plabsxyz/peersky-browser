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

async function loadAutoUpdater ({ isPackaged = true, version = '1.0.0', autoUpdateEnabled = true } = {}) {
  // Electron's native autoUpdater (macOS path).
  const autoUpdater = {
    setFeedURL: sinon.spy(),
    checkForUpdates: sinon.spy(),
    quitAndInstall: sinon.spy(),
    on: sinon.spy()
  }

  // electron-updater (Windows path). checkForUpdates() returns a Promise.
  const winUpdater = {
    on: sinon.spy(),
    checkForUpdates: sinon.stub().resolves(),
    quitAndInstall: sinon.spy(),
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: false
  }

  const dialog = { showMessageBoxSync: sinon.stub().returns(1) }

  const app = {
    isPackaged,
    getVersion: () => version
  }

  const log = {
    info: sinon.spy(),
    error: sinon.spy(),
    transports: { file: {} }
  }

  const module = await esmock.strict('../../src/auto-updater.js', {
    electron: { app, autoUpdater, dialog },
    'electron-updater': { default: { autoUpdater: winUpdater } },
    'electron-log': { default: log },
    '../../src/settings-manager.js': { default: { settings: { autoUpdateEnabled } } }
  })

  return { module, autoUpdater, winUpdater, dialog, app, log }
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

  it('uses electron-updater on Linux when running as an AppImage', async function () {
    const { module, autoUpdater, winUpdater } = await loadAutoUpdater()

    await withAppImage('/tmp/Peersky.AppImage', () =>
      withPlatform('linux', () => module.setupAutoUpdater())
    )

    expect(autoUpdater.setFeedURL.called).to.equal(false)
    expect(winUpdater.on.called).to.equal(true)
  })

  it('skips non-AppImage Linux builds (handled by the distro package manager)', async function () {
    const { module, winUpdater, log } = await loadAutoUpdater()

    await withAppImage(undefined, () =>
      withPlatform('linux', () => module.setupAutoUpdater())
    )

    expect(winUpdater.on.called).to.equal(false)
    expect(log.info.calledWithMatch(/package manager/)).to.equal(true)
  })

  it('skips when disabled in user settings', async function () {
    const { module, autoUpdater, log } = await loadAutoUpdater({ autoUpdateEnabled: false })

    withPlatform('darwin', () => module.setupAutoUpdater())

    expect(autoUpdater.setFeedURL.called).to.equal(false)
    expect(log.info.calledWithMatch(/disabled in user settings/)).to.equal(true)
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

  it('checks after a 10s startup delay, then on a 1h interval', async function () {
    clock = sinon.useFakeTimers()
    const { module, autoUpdater } = await loadAutoUpdater()

    withPlatform('darwin', () => module.setupAutoUpdater())

    // Nothing should fire before the startup delay elapses.
    expect(autoUpdater.checkForUpdates.called).to.equal(false)

    clock.tick(10000)
    expect(autoUpdater.checkForUpdates.callCount).to.equal(1)

    clock.tick(60 * 60 * 1000)
    expect(autoUpdater.checkForUpdates.callCount).to.equal(2)

    clock.tick(60 * 60 * 1000)
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

  describe('Windows (electron-updater)', function () {
    it('uses electron-updater, not the native autoUpdater', async function () {
      const { module, autoUpdater, winUpdater } = await loadAutoUpdater()

      await withPlatform('win32', () => module.setupAutoUpdater())

      expect(autoUpdater.setFeedURL.called).to.equal(false)
      expect(autoUpdater.on.called).to.equal(false)
      expect(winUpdater.on.called).to.equal(true)
      expect(winUpdater.logger).to.not.equal(null)
      expect(winUpdater.autoDownload).to.equal(true)
    })

    it('registers the expected electron-updater event handlers', async function () {
      const { module, winUpdater } = await loadAutoUpdater()

      await withPlatform('win32', () => module.setupAutoUpdater())

      const events = winUpdater.on.getCalls().map((c) => c.args[0])
      expect(events).to.include.members([
        'checking-for-update',
        'update-available',
        'update-not-available',
        'download-progress',
        'update-downloaded',
        'error'
      ])
    })

    it('checks after a 10s startup delay, then on a 1h interval', async function () {
      clock = sinon.useFakeTimers()
      const { module, winUpdater } = await loadAutoUpdater()

      await withPlatform('win32', () => module.setupAutoUpdater())

      expect(winUpdater.checkForUpdates.called).to.equal(false)

      await clock.tickAsync(10000)
      expect(winUpdater.checkForUpdates.callCount).to.equal(1)

      await clock.tickAsync(60 * 60 * 1000)
      expect(winUpdater.checkForUpdates.callCount).to.equal(2)
    })

    it('logs and recovers if checkForUpdates rejects', async function () {
      clock = sinon.useFakeTimers()
      const { module, winUpdater, log } = await loadAutoUpdater()
      winUpdater.checkForUpdates = sinon.stub().rejects(new Error('boom'))

      await withPlatform('win32', () => module.setupAutoUpdater())

      await clock.tickAsync(10000)
      expect(log.error.calledWithMatch(/checkForUpdates failed/)).to.equal(true)
    })

    it('prompts to restart and installs when the user accepts', async function () {
      const { module, winUpdater, dialog } = await loadAutoUpdater()
      dialog.showMessageBoxSync.returns(0) // user clicks "Restart Now"

      await withPlatform('win32', () => module.setupAutoUpdater())

      const downloadedHandler = winUpdater.on
        .getCalls()
        .find((c) => c.args[0] === 'update-downloaded').args[1]

      await downloadedHandler({ version: '2.0.0', releaseName: '2.0.0' })

      expect(dialog.showMessageBoxSync.calledOnce).to.equal(true)
      expect(winUpdater.quitAndInstall.calledOnce).to.equal(true)
    })

    it('does not install when the user postpones', async function () {
      const { module, winUpdater, dialog } = await loadAutoUpdater()
      dialog.showMessageBoxSync.returns(1) // user clicks "Later"

      await withPlatform('win32', () => module.setupAutoUpdater())

      const downloadedHandler = winUpdater.on
        .getCalls()
        .find((c) => c.args[0] === 'update-downloaded').args[1]

      await downloadedHandler({ version: '2.0.0', releaseName: '2.0.0' })

      expect(dialog.showMessageBoxSync.calledOnce).to.equal(true)
      expect(winUpdater.quitAndInstall.called).to.equal(false)
    })
  })
})
