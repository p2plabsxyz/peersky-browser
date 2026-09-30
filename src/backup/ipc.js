import path from 'path'
import { promises as fs } from 'fs'
import { ipcMain, dialog, app, BrowserWindow } from 'electron'
import { createLogger } from '../logger.js'
import backupManager, { defaultBackupName } from './backup-manager.js'
import { uploadBackup, downloadBackupFromAddress } from './p2p-backup.js'
import { getDeviceKeys, getPublicDeviceInfo } from './device-keys.js'
import { createPairingSession, encodePairingString } from './identity-transfer.js'
import { clearPairedMobile, readPairedMobile } from './mobile-pairing.js'
import { rememberPairingNonce } from './pairing-sessions.js'
import { tabsNotOpen } from './phone-sync.js'
import { listPrivateHyperdrives } from '../protocols/private-hyperdrive-registry.js'

const log = createLogger('backup')

function ownerWindow (event) {
  return BrowserWindow.fromWebContents(event.sender) || null
}

// Tabs from a phone open in the window the Backup & Restore page is in. The
// page is a tab itself, so the window is the one hosting it. A page already
// open in any window is left out. Returns how many tabs were opened.
async function openTabsBeside (event, tabs, getTabs) {
  const host = event.sender.hostWebContents ||
    ownerWindow(event)?.webContents ||
    BrowserWindow.getFocusedWindow()?.webContents ||
    BrowserWindow.getAllWindows()[0]?.webContents
  if (!host || host.isDestroyed()) return 0
  const windows = typeof getTabs === 'function' ? await getTabs().catch(() => null) : null
  const fresh = tabsNotOpen(tabs, windows)
  if (fresh.length > 0) host.send('add-tabs-from-main', { tabs: fresh, group: 'Phone' })
  return fresh.length
}

// Register IPC handlers for the backup & restore UI. getTabs reads every
// window's tabs, so a phone's tab already open here is not opened again.
export function setupBackupIpc ({ getTabs } = {}) {
  backupManager.clearLeftoverStaging().catch((error) => {
    log.error(`Could not clear leftover restore staging: ${error.message}`)
  })

  ipcMain.handle('backup-create', async (event, payload = {}) => {
    try {
      const win = ownerWindow(event)
      const saveOptions = {
        title: 'Save Peersky Backup',
        defaultPath: path.join(app.getPath('downloads'), defaultBackupName()),
        filters: [{ name: 'Zip Archives', extensions: ['zip'] }]
      }
      const { canceled, filePath } = win
        ? await dialog.showSaveDialog(win, saveOptions)
        : await dialog.showSaveDialog(saveOptions)

      if (canceled || !filePath) return { canceled: true }

      const result = await backupManager.createBackup(filePath, payload.passphrase, (data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('backup-progress', { phase: 'create', ...data })
        }
      }, { includePrivate: payload.includePrivate === true })
      return { success: true, filePath: result.filePath, bytes: result.bytes }
    } catch (error) {
      log.error(`Backup create failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('backup-validate', async (event) => {
    try {
      const win = ownerWindow(event)
      const openOptions = {
        title: 'Select Peersky Backup',
        properties: ['openFile'],
        filters: [{ name: 'Zip Archives', extensions: ['zip'] }]
      }
      const result = win
        ? await dialog.showOpenDialog(win, openOptions)
        : await dialog.showOpenDialog(openOptions)

      if (result.canceled || !result.filePaths?.length) return { canceled: true }

      const zipPath = result.filePaths[0]
      const manifest = await backupManager.inspectBackup(zipPath)
      return { success: true, zipPath, manifest }
    } catch (error) {
      log.error(`Backup validate failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('backup-restore', async (event, payload = {}) => {
    try {
      const zipPath = typeof payload === 'string' ? payload : payload?.zipPath
      if (!zipPath || typeof zipPath !== 'string') {
        throw new Error('A backup file path is required')
      }
      const result = await backupManager.restoreBackup(zipPath, (data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('backup-progress', { phase: 'restore', ...data })
        }
      }, { passphrase: payload?.passphrase })
      return result
    } catch (error) {
      log.error(`Backup restore failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('backup-device-info', async () => {
    try {
      const keys = await getDeviceKeys(app.getPath('userData'))
      const device = getPublicDeviceInfo(keys)
      const session = await createPairingSession(app.getPath('userData'), 'desktop')
      rememberPairingNonce(session.nonce)
      return { success: true, device, pairingPayload: encodePairingString(session) }
    } catch (error) {
      log.error(`Backup device info failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('backup-private-hyperdrives', async () => {
    try {
      const items = await listPrivateHyperdrives(app.getPath('userData'))
      return { success: true, items }
    } catch (error) {
      log.error(`Private Hyperdrive listing failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('backup-identity-create', async (event, payload = {}) => {
    try {
      const { targetPairingPayload } = payload
      const win = ownerWindow(event)
      const saveOptions = {
        title: 'Save Peersky Identity Transfer',
        defaultPath: path.join(app.getPath('downloads'), `peersky-identity-${Date.now()}.zip`),
        filters: [{ name: 'Zip Archives', extensions: ['zip'] }]
      }
      const { canceled, filePath } = win
        ? await dialog.showSaveDialog(win, saveOptions)
        : await dialog.showSaveDialog(saveOptions)

      if (canceled || !filePath) return { canceled: true }

      const result = await backupManager.createIdentityTransferBackup(filePath, {
        targetPairingPayload,
        includePrivate: payload.includePrivate !== false
      })
      return { success: true, filePath: result.filePath, bytes: result.bytes, manifest: result.manifest }
    } catch (error) {
      log.error(`Identity transfer create failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('backup-paired-mobile', async () => {
    try {
      return { success: true, paired: await readPairedMobile(app.getPath('userData')) }
    } catch (error) {
      log.error(`Reading paired mobile failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  })

  // Releases the phone slot so another can be paired. Deliberately does not
  // wait to hear from the old phone: the usual reason to move is that it is
  // broken, sold or already wiped, and blocking on it would fail exactly when
  // this is needed. The caller warns the user to wipe the old phone first.
  ipcMain.handle('backup-forget-mobile', async () => {
    try {
      await clearPairedMobile(app.getPath('userData'))
      log.info('Paired mobile cleared; a new phone can be paired')
      return { success: true }
    } catch (error) {
      log.error(`Clearing paired mobile failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('backup-identity-upload-hyper', async (_event, payload = {}) => {
    const outPath = path.join(app.getPath('temp'), `peersky-identity-${Date.now()}.zip`)
    try {
      const { targetPairingPayload } = payload
      const result = await backupManager.createIdentityTransferBackup(outPath, {
        targetPairingPayload,
        includePrivate: payload.includePrivate !== false
      })
      const ttlMs = result.manifest.identityTransfer.expiresAt - Date.now()
      const upload = await uploadBackup(result.filePath, 'hyper', { ephemeral: true, ttlMs })
      return { success: true, bytes: result.bytes, manifest: result.manifest, verificationCode: result.verificationCode, ...upload }
    } catch (error) {
      log.error(`Identity transfer Hyper upload failed: ${error.message}`)
      return { success: false, error: error.message }
    } finally {
      await fs.rm(outPath, { force: true }).catch(() => {})
    }
  })

  // Restoring from the network is two steps. The download is checked first,
  // and a transfer shows its code, so the person compares the two screens
  // before anything here changes.
  ipcMain.handle('backup-fetch-restore', async (event, payload = {}) => {
    try {
      const address = typeof payload === 'string' ? payload : payload?.address
      const zipPath = await downloadBackupFromAddress(address, (status) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('backup-progress', { phase: 'fetch', message: status.message })
        }
      })
      const staged = await backupManager.stageRestore(zipPath, (data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('backup-progress', { phase: 'restore', ...data })
        }
      })
      return { success: true, ...staged }
    } catch (error) {
      log.error(`Fetching a restore failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('backup-apply-restore', async (event, payload = {}) => {
    try {
      return await backupManager.applyStaged(payload?.stageId, {
        passphrase: payload?.passphrase,
        onProgress: (data) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('backup-progress', { phase: 'restore', ...data })
          }
        },
        openTabs: (tabs) => openTabsBeside(event, tabs, getTabs)
      })
    } catch (error) {
      log.error(`Applying a restore failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('backup-discard-restore', async (_event, payload = {}) => {
    backupManager.discardStaged(payload?.stageId)
    return { success: true }
  })

  ipcMain.handle('backup-relaunch', async () => {
    const { windowManager } = await import('../main.js')
    if (windowManager) {
      windowManager.setSkipSaveOnQuit(true)
    }
    backupManager.relaunch()
    return { success: true }
  })

  log.info('Backup IPC handlers registered')
}
