import path from 'path'
import { promises as fs } from 'fs'
import { ipcMain, dialog, app, BrowserWindow } from 'electron'
import { createLogger } from '../logger.js'
import backupManager, { defaultBackupName } from './backup-manager.js'
import { uploadBackup, downloadBackupFromAddress } from './p2p-backup.js'
import { getDeviceKeys, getPublicDeviceInfo } from './device-keys.js'
import { createPairingSession, encodePairingString } from './identity-transfer.js'

const log = createLogger('backup')

function ownerWindow (event) {
  return BrowserWindow.fromWebContents(event.sender) || null
}

// Register IPC handlers for the backup & restore UI.
export function setupBackupIpc () {
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
      })
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
      return { success: true, device, pairingPayload: encodePairingString(session) }
    } catch (error) {
      log.error(`Backup device info failed: ${error.message}`)
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
        targetPairingPayload
      })
      return { success: true, filePath: result.filePath, bytes: result.bytes, manifest: result.manifest }
    } catch (error) {
      log.error(`Identity transfer create failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('backup-identity-upload-hyper', async (_event, payload = {}) => {
    const outPath = path.join(app.getPath('temp'), `peersky-identity-${Date.now()}.zip`)
    try {
      const { targetPairingPayload } = payload
      const result = await backupManager.createIdentityTransferBackup(outPath, {
        targetPairingPayload
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

  ipcMain.handle('backup-restore-cid', async (event, payload = {}) => {
    let zipPath
    try {
      const address = typeof payload === 'string' ? payload : payload?.address
      zipPath = await downloadBackupFromAddress(address, (status) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('backup-progress', { phase: 'fetch', message: status.message })
        }
      })
      const result = await backupManager.restoreBackup(zipPath, (data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('backup-progress', { phase: 'restore', ...data })
        }
      }, { passphrase: payload?.passphrase })
      return result
    } catch (error) {
      log.error(`Backup CID restore failed: ${error.message}`)
      return { success: false, error: error.message }
    } finally {
      if (zipPath) await fs.rm(zipPath, { force: true }).catch(() => {})
    }
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
