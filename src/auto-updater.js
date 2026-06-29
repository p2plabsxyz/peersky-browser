import { app, autoUpdater as nativeUpdater, dialog, net } from 'electron'
import log from 'electron-log'
import fs from 'fs'
import path from 'path'
import os from 'os'
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

// Windows (NSIS) and Linux: electron-updater uses Node.js HTTP (c-ares DNS)
// which triggers the same native SIGSEGV crash as on macOS. Instead, we use
// Electron's net.fetch() (Chromium networking, no c-ares) to check GitHub
// releases, download the installer, and run it.
function setupNativeNetUpdater (saveSession) {
  const GITHUB_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`
  const UA = `peersky-browser/${app.getVersion()} (${process.platform}: ${process.arch})`

  async function checkAndUpdate () {
    log.info('[auto-updater] checking-for-update')
    try {
      const res = await net.fetch(GITHUB_API, {
        headers: { 'User-Agent': UA, Accept: 'application/vnd.github.v3+json' }
      })
      if (!res.ok) {
        log.warn(`[auto-updater] GitHub API returned ${res.status}`)
        return
      }
      const release = await res.json()
      const latest = release.tag_name?.replace(/^v/, '')
      const current = app.getVersion()
      if (!latest || latest === current) {
        log.info('[auto-updater] update-not-available')
        return
      }
      // Simple semver compare: split on dots and compare numerically
      const isNewer = latest.localeCompare(current, undefined, { numeric: true, sensitivity: 'base' }) > 0
      if (!isNewer) {
        log.info('[auto-updater] update-not-available (latest:', latest, 'current:', current, ')')
        return
      }
      log.info('[auto-updater] update-available:', latest)

      // Find the correct installer asset for this platform
      let asset
      if (process.platform === 'win32') {
        asset = release.assets?.find(a =>
          a.name.endsWith('.exe') && a.name.toLowerCase().includes('setup')
        )
      } else if (process.platform === 'linux') {
        asset = release.assets?.find(a => a.name.endsWith('.AppImage'))
      }

      if (!asset) {
        log.warn('[auto-updater] No matching installer asset found in release')
        return
      }

      log.info('[auto-updater] downloading:', asset.name, `(${(asset.size / 1048576).toFixed(1)} MB)`)

      // Download installer to temp dir using net.fetch (Chromium networking)
      const dlRes = await net.fetch(asset.browser_download_url, {
        headers: { 'User-Agent': UA }
      })
      if (!dlRes.ok) {
        log.error(`[auto-updater] download failed: ${dlRes.status}`)
        return
      }
      const tmpDir = path.join(os.tmpdir(), 'peersky-update')
      fs.mkdirSync(tmpDir, { recursive: true })
      const installerPath = path.join(tmpDir, asset.name)
      const buffer = Buffer.from(await dlRes.arrayBuffer())
      fs.writeFileSync(installerPath, buffer)
      log.info('[auto-updater] update-downloaded:', installerPath)

      // Prompt user
      if (promptRestart(`v${latest}`)) {
        await installUpdateAndQuit(async () => {
          if (process.platform === 'win32') {
            // Launch the NSIS installer silently and quit
            const { exec } = await import('child_process')
            exec(`"${installerPath}" /S`, (err) => {
              if (err) log.error('[auto-updater] installer launch failed:', err.message)
            })
            await new Promise(resolve => setTimeout(resolve, 1000))
          } else if (process.platform === 'linux') {
            // Replace the running AppImage with the downloaded one
            const currentAppImage = process.env.APPIMAGE
            if (currentAppImage) {
              fs.copyFileSync(installerPath, currentAppImage)
              fs.chmodSync(currentAppImage, 0o755)
            }
            app.relaunch()
          }
          app.quit()
        }, saveSession)
      }
    } catch (err) {
      log.error('[auto-updater] checkForUpdates failed:', err?.message || err)
    }
  }

  scheduleChecks(checkAndUpdate)
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
    setupNativeNetUpdater(saveSession)
    return
  }

  if (process.platform === 'linux') {
    // Only the AppImage build can auto-update. The deb/rpm/pacman/apk builds
    // are owned by the system package manager — those users update through
    // their distro. process.env.APPIMAGE is set only when running as an AppImage.
    if (!process.env.APPIMAGE) {
      log.info('[auto-updater] Skipping: Linux non-AppImage build updates via the system package manager')
      return
    }
    setupNativeNetUpdater(saveSession)
    return
  }

  setupMacUpdater(saveSession)
}

export { setupAutoUpdater }
