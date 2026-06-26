import { app, autoUpdater as nativeUpdater, dialog } from 'electron'
import log from 'electron-log'
import electronUpdater from 'electron-updater'
import settingsManager from './settings-manager.js'

const UPDATE_HOST = 'https://update.electronjs.org'
const UPDATE_REPO = 'p2plabsxyz/peersky-browser'
const STARTUP_DELAY_MS = 10000
const CHECK_INTERVAL_MS = 60 * 60 * 1000
const FORCE_EXIT_TIMEOUT_MS = 3000

function getFeedUrl () {
  const formatSegment = process.windowsStore ? '/msix' : ''
  return `${UPDATE_HOST}/${UPDATE_REPO}/${process.platform}-${process.arch}${formatSegment}/${app.getVersion()}`
}

// Returns true if the user chose to restart now.
function promptRestart (releaseName) {
  const response = dialog.showMessageBoxSync({
    type: 'info',
    buttons: ['Restart Now', 'Later'],
    title: 'Update Ready',
    message: releaseName || 'A new version is ready',
    detail: 'Restart now to install the latest update, or choose Later to postpone. Restart may take a few minutes depending on download size. Do not close the browser — it will restart on its own.'
  })
  return response === 0
}

// SIGKILL can't be blocked, so the process dies even when p2p native modules
// hang process.exit (which used to leave the app stuck in the dock on macOS).
function forceKill () {
  log.warn('[auto-updater] before-quit did not fire; force-killing')
  process.kill(process.pid, 'SIGKILL')
}

// Save the session before quitting: quitAndInstall destroys windows, and a save
// that races it can wipe the restore file, so we persist while windows are alive.
async function installUpdateAndQuit (quitFn, saveSession) {
  app.isQuittingForUpdate = true
  try {
    await saveSession?.()
  } catch (err) {
    log.error('[auto-updater] session save failed:', err?.message || err)
  }
  // Backup if before-quit never fires; unref'd so it can't keep the app alive.
  setTimeout(forceKill, FORCE_EXIT_TIMEOUT_MS).unref?.()
  quitFn()
}

// First check after a short startup delay, then on a fixed interval.
function scheduleChecks (check) {
  setTimeout(() => {
    log.info('[auto-updater] Initialized')
    check()
    setInterval(check, CHECK_INTERVAL_MS)
  }, STARTUP_DELAY_MS)
}

// macOS uses the native autoUpdater (Squirrel.Mac). It relies on native OS
// networking, which avoids the c-ares DNS crash electron-updater hits on macOS.
function setupMacUpdater (saveSession) {
  const feedURL = getFeedUrl()
  log.info('[auto-updater] feedURL', feedURL)

  // update.electronjs.org returns JSON (204 when up to date); Squirrel needs
  // serverType: 'json' to parse it.
  nativeUpdater.setFeedURL({
    url: feedURL,
    serverType: 'json',
    headers: {
      'User-Agent': `peersky-browser/${app.getVersion()} (${process.platform}: ${process.arch})`
    }
  })

  nativeUpdater.on('checking-for-update', () => {
    log.info('[auto-updater] checking-for-update')
  })

  nativeUpdater.on('update-available', () => {
    log.info('[auto-updater] update-available; downloading...')
  })

  nativeUpdater.on('update-not-available', () => {
    log.info('[auto-updater] update-not-available')
  })

  nativeUpdater.on('download-progress', (progress) => {
    log.info(`[auto-updater] download ${progress.percent?.toFixed(1) ?? 0}%`)
  })

  nativeUpdater.on('update-downloaded', async (_event, releaseNotes, releaseName) => {
    log.info('[auto-updater] update-downloaded:', releaseName || releaseNotes)
    if (promptRestart(releaseName || releaseNotes)) {
      await installUpdateAndQuit(() => nativeUpdater.quitAndInstall(), saveSession)
    }
  })

  nativeUpdater.on('error', (err) => {
    log.error('[auto-updater] error:', err?.message || err)
  })

  scheduleChecks(() => {
    // Native checkForUpdates() returns void, so guard with try/catch.
    try {
      nativeUpdater.checkForUpdates()
    } catch (err) {
      log.error('[auto-updater] checkForUpdates failed:', err?.message || err)
    }
  })
}

// Shared electron-updater path for Windows (NSIS) and Linux (AppImage); the
// native autoUpdater can't consume either. electron-updater reads app-update.yml
// plus the platform's latest-*.yml and handles the download + install.
function setupElectronUpdater (saveSession) {
  const { autoUpdater } = electronUpdater
  autoUpdater.logger = log
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    log.info('[auto-updater] checking-for-update')
  })

  autoUpdater.on('update-available', (info) => {
    log.info('[auto-updater] update-available; downloading...', info?.version)
  })

  autoUpdater.on('update-not-available', () => {
    log.info('[auto-updater] update-not-available')
  })

  autoUpdater.on('download-progress', (progress) => {
    log.info(`[auto-updater] download ${progress?.percent?.toFixed(1) ?? 0}%`)
  })

  autoUpdater.on('update-downloaded', async (info) => {
    log.info('[auto-updater] update-downloaded:', info?.version)
    if (promptRestart(info?.releaseName || info?.version)) {
      await installUpdateAndQuit(() => autoUpdater.quitAndInstall(), saveSession)
    }
  })

  autoUpdater.on('error', (err) => {
    log.error('[auto-updater] error:', err?.message || err)
  })

  scheduleChecks(() => {
    // electron-updater.checkForUpdates() returns a Promise, so guard with .catch().
    autoUpdater.checkForUpdates().catch((err) => {
      log.error('[auto-updater] checkForUpdates failed:', err?.message || err)
    })
  })
}

// Dev-only: run the popup -> quit -> relaunch path without a build or real
// update, via `PEERSKY_TEST_UPDATE=1 npm start`. app.relaunch() starts a fresh
// instance once this one exits.
function simulateUpdatePopupForDev (saveSession) {
  setTimeout(async () => {
    log.info('[auto-updater] (dev) Simulating update-downloaded popup')
    if (promptRestart(`Dev Update Simulation (v${app.getVersion()})`)) {
      log.info('[auto-updater] (dev) Restart chosen — relaunching to verify quit path')
      app.relaunch()
      await installUpdateAndQuit(() => app.quit(), saveSession)
    } else {
      log.info('[auto-updater] (dev) Restart postponed')
    }
  }, 3000)
}

function setupAutoUpdater (saveSession) {
  if (!app.isPackaged) {
    if (process.env.PEERSKY_TEST_UPDATE) {
      log.info('[auto-updater] Dev mode: PEERSKY_TEST_UPDATE set — simulating the update popup.')
      simulateUpdatePopupForDev(saveSession)
      return
    }
    log.info('[auto-updater] Dev mode: auto-update checks run only in packaged ' +
      'builds (1h interval after a 10s delay). Set PEERSKY_TEST_UPDATE=1 to preview the popup.')
    return
  }

  if (settingsManager.settings.autoUpdateEnabled === false) {
    log.info('[auto-updater] Skipping: disabled in user settings')
    return
  }

  log.transports.file.level = 'info'

  if (process.platform === 'win32') {
    try {
      setupElectronUpdater(saveSession)
    } catch (err) {
      log.error('[auto-updater] Windows updater init failed:', err?.message || err)
    }
    return
  }

  if (process.platform === 'linux') {
    // Only the AppImage build can auto-update: electron-updater swaps the running
    // .AppImage in place. The deb/rpm/pacman/apk builds are owned by the system
    // package manager, so they have no in-app update path — those users update
    // through their distro. process.env.APPIMAGE is set only when running as an
    // AppImage, which is how we tell the builds apart.
    if (!process.env.APPIMAGE) {
      log.info('[auto-updater] Skipping: Linux non-AppImage build updates via the system package manager')
      return
    }
    try {
      setupElectronUpdater(saveSession)
    } catch (err) {
      log.error('[auto-updater] Linux (AppImage) updater init failed:', err?.message || err)
    }
    return
  }

  setupMacUpdater(saveSession)
}

export { setupAutoUpdater }
