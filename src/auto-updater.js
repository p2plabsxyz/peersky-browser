import { app, autoUpdater as nativeUpdater, dialog, net } from 'electron'
import log from 'electron-log'
import fs from 'fs'
import path from 'path'
import os from 'os'
import settingsManager from './settings-manager.js'

const UPDATE_HOST = 'https://update.electronjs.org'
const UPDATE_REPO = 'p2plabsxyz/peersky-browser'
const STARTUP_DELAY_MS = 10000
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const FORCE_EXIT_TIMEOUT_MS = 3000

// Holds a reference to the check function so it can be triggered manually
// from the Settings UI (via IPC). Set by setupMacUpdater / setupNativeNetUpdater.
let _manualCheck = null

// When an update has been downloaded but the user clicked "Later", we store
// the install callback + release name so the Settings button can re-show
// the restart prompt without re-downloading.
let _pendingUpdate = null

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

// Force-kill if before-quit never fires. On macOS SIGKILL is safe (Squirrel
// handles restart). On Windows/Linux we need app.exit() so app.relaunch() fires.
function forceKill () {
  log.warn('[auto-updater] before-quit did not fire; force-killing')
  if (process.platform === 'darwin') {
    process.kill(process.pid, 'SIGKILL')
  } else {
    app.exit(0)
  }
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
    const label = releaseName || releaseNotes
    if (promptRestart(label)) {
      await installUpdateAndQuit(() => nativeUpdater.quitAndInstall(), saveSession)
    } else {
      _pendingUpdate = {
        label,
        install: () => installUpdateAndQuit(() => nativeUpdater.quitAndInstall(), saveSession)
      }
    }
  })

  nativeUpdater.on('error', (err) => {
    log.error('[auto-updater] error:', err?.message || err)
  })

  _manualCheck = () => {
    try {
      nativeUpdater.checkForUpdates()
    } catch (err) {
      log.error('[auto-updater] checkForUpdates failed:', err?.message || err)
    }
  }
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

      // Stream the download to disk instead of buffering the whole file in memory (installers are 300+ MB).
      const total = asset.size || 0
      let received = 0
      let lastLoggedPct = 0
      const reader = dlRes.body.getReader()
      const fileStream = fs.createWriteStream(installerPath)
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          fileStream.write(Buffer.from(value))
          received += value.length
          if (total) {
            const pct = Math.floor((received / total) * 100)
            if (pct >= lastLoggedPct + 10) {
              lastLoggedPct = pct
              log.info(`[auto-updater] downloading: ${pct}%`)
            }
          }
        }
      } finally {
        fileStream.end()
        await new Promise((resolve, reject) => {
          fileStream.on('finish', resolve)
          fileStream.on('error', reject)
        })
      }
      log.info('[auto-updater] update-downloaded:', installerPath)

      // Prompt user
      const doInstall = async () => {
        await installUpdateAndQuit(async () => {
          if (process.platform === 'win32') {
            // Launch the NSIS installer as a detached process so it survives
            // after the app exits. The installer waits for file locks to
            // release, then replaces the app files.
            const { spawn } = await import('child_process')
            const child = spawn(installerPath, ['/S', '--force-run'], {
              detached: true,
              stdio: 'ignore'
            })
            child.unref()
          } else if (process.platform === 'linux') {
            // Replace the running AppImage with the downloaded one.
            // Linux blocks overwriting a FUSE-mounted file (ETXTBSY),
            // but allows renaming it — the kernel tracks by inode.
            const currentAppImage = process.env.APPIMAGE
            if (currentAppImage) {
              const backupPath = currentAppImage + '.bak'
              try {
                if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath)
              } catch (_) {}
              fs.renameSync(currentAppImage, backupPath)
              fs.copyFileSync(installerPath, currentAppImage)
              fs.chmodSync(currentAppImage, 0o755)
              try {
                fs.unlinkSync(backupPath)
              } catch (_) {}
              // app.relaunch() doesn't work reliably with FUSE-mounted AppImages.
              // Spawn the new AppImage as a detached process instead.
              const { spawn } = await import('child_process')
              spawn(currentAppImage, [], { detached: true, stdio: 'ignore' }).unref()
            }
          }
          app.quit()
        }, saveSession)
      }
      if (promptRestart(`v${latest}`)) {
        await doInstall()
      } else {
        _pendingUpdate = { label: `v${latest}`, install: doInstall }
      }
    } catch (err) {
      log.error('[auto-updater] checkForUpdates failed:', err?.message || err)
    }
  }

  _manualCheck = checkAndUpdate
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
      'builds (24h interval after a 10s delay). Set PEERSKY_TEST_UPDATE=1 to preview the popup.')
    return
  }

  log.transports.file.level = 'info'

  // Always initialize the updater so the manual "Check for Updates" button
  // works regardless of the autoUpdateEnabled setting.
  if (process.platform === 'win32') {
    setupNativeNetUpdater(saveSession)
  } else if (process.platform === 'linux') {
    // Only the AppImage build can auto-update. The deb/rpm/pacman/apk builds
    // are owned by the system package manager — those users update through
    // their distro. process.env.APPIMAGE is set only when running as an AppImage.
    if (!process.env.APPIMAGE) {
      log.info('[auto-updater] Skipping: Linux non-AppImage build updates via the system package manager')
      return
    }
    // Clean up leftover .bak from a previous update that couldn't delete
    // it while the old AppImage was still FUSE-mounted.
    try {
      const bak = process.env.APPIMAGE + '.bak'
      if (fs.existsSync(bak)) {
        fs.unlinkSync(bak)
        log.info('[auto-updater] Cleaned up leftover backup:', bak)
      }
    } catch (_) {}
    setupNativeNetUpdater(saveSession)
  } else {
    setupMacUpdater(saveSession)
  }

  // Only schedule periodic checks if auto-updates are enabled.
  // The manual button (checkForUpdatesNow) still works either way.
  if (settingsManager.settings.autoUpdateEnabled === false) {
    log.info('[auto-updater] Periodic checks disabled in user settings (manual check still available)')
    return
  }

  if (_manualCheck) {
    scheduleChecks(_manualCheck)
  }
}

async function checkForUpdatesNow () {
  if (_pendingUpdate) {
    log.info('[auto-updater] Manual check: update already downloaded, re-showing prompt')
    if (promptRestart(_pendingUpdate.label)) {
      await _pendingUpdate.install()
    }
    return 'update-available'
  }
  if (!_manualCheck) {
    log.warn('[auto-updater] Manual check: updater not initialized')
    return 'not-initialized'
  }
  log.info('[auto-updater] Manual check triggered from Settings')

  // On macOS the native updater is event-based; wait for the outcome.
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve('timeout'), 30000)
      const cleanup = (result) => {
        clearTimeout(timeout)
        nativeUpdater.removeListener('update-not-available', onNotAvail)
        nativeUpdater.removeListener('update-downloaded', onDownloaded)
        nativeUpdater.removeListener('error', onError)
        resolve(result)
      }
      const onNotAvail = () => cleanup('up-to-date')
      const onDownloaded = () => cleanup('update-available')
      const onError = () => cleanup('error')
      nativeUpdater.once('update-not-available', onNotAvail)
      nativeUpdater.once('update-downloaded', onDownloaded)
      nativeUpdater.once('error', onError)
      _manualCheck()
    })
  }

  // Windows/Linux: checkAndUpdate is async and shows the prompt itself.
  // We can detect the outcome by checking _pendingUpdate after it runs.
  await _manualCheck()
  return _pendingUpdate ? 'update-available' : 'up-to-date'
}

export { setupAutoUpdater, checkForUpdatesNow }
