import path from 'path'
import { ipcMain, dialog, app, BrowserWindow } from 'electron'
import { createLogger } from '../logger.js'
import backupManager, { defaultBackupName } from './backup-manager.js'
import { uploadBackup, downloadBackupFromAddress } from './p2p-backup.js'

const log = createLogger('backup')

function ownerWindow (event) {
  return BrowserWindow.fromWebContents(event.sender) || null
}

// Register IPC handlers for the backup & restore UI.
export function setupBackupIpc () {
  ipcMain.handle('backup-create', async (event) => {
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

      const result = await backupManager.createBackup(filePath, (data) => {
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

  ipcMain.handle('backup-restore', async (event, zipPath) => {
    try {
      if (!zipPath || typeof zipPath !== 'string') {
        throw new Error('A backup file path is required')
      }
      const result = await backupManager.restoreBackup(zipPath, (data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('backup-progress', { phase: 'restore', ...data })
        }
      })
      return result
    } catch (error) {
      log.error(`Backup restore failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('backup-upload', async (event, payload = {}) => {
    try {
      const { zipPath, protocol = 'ipfs' } = payload
      let target = zipPath
      if (!target) {
        const win = ownerWindow(event)
        const openOptions = {
          title: 'Select Backup to Share',
          properties: ['openFile'],
          filters: [{ name: 'Zip Archives', extensions: ['zip'] }]
        }
        const result = win
          ? await dialog.showOpenDialog(win, openOptions)
          : await dialog.showOpenDialog(openOptions)
        if (result.canceled || !result.filePaths?.length) return { canceled: true }
        target = result.filePaths[0]
      }
      const res = await uploadBackup(target, protocol)
      return { success: true, ...res }
    } catch (error) {
      log.error(`Backup upload failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('backup-restore-cid', async (event, address) => {
    try {
      const zipPath = await downloadBackupFromAddress(address, (status) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('backup-progress', { phase: 'fetch', message: status.message })
        }
      })
      const result = await backupManager.restoreBackup(zipPath, (data) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('backup-progress', { phase: 'restore', ...data })
        }
      })
      return result
    } catch (error) {
      log.error(`Backup CID restore failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('backup-relaunch', async () => {
    const { windowManager } = await import('../main.js')
    windowManager.setSkipSaveOnQuit(true)
    backupManager.relaunch()
    return { success: true }
  })

  log.info('Backup IPC handlers registered')
}
