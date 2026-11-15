import { app, ipcMain } from 'electron'
import { isPeerskyAppPage } from '../backup/ipc-caller.js'
import { getDeviceSyncSnapshot, getOwnPrivateFiles } from './hyper-handler.js'
import { markDeviceFilesSeen } from './device-sync-state.js'
import { isTabOnScreen } from '../tab-on-screen.js'

// Only the Hyperdrive app asks. The preload hands the channels to the P2P app
// pages, which share a host, so the folder is checked here as well.
export function setupDeviceSyncIpc () {
  ipcMain.handle('device-sync-list', (event) => {
    if (!isPeerskyAppPage(event?.senderFrame?.url, 'p2p', 'hyperdrive')) throw new Error('Forbidden')
    return getDeviceSyncSnapshot()
  })

  // The app showed the files from the other devices, so the home page stops
  // counting them as new. Only from a tab in front: a page left behind
  // another tab says it is visible all the same (tab-on-screen.js).
  ipcMain.handle('device-sync-seen', async (event) => {
    if (!isPeerskyAppPage(event?.senderFrame?.url, 'p2p', 'hyperdrive')) throw new Error('Forbidden')
    if (!await isTabOnScreen(event.sender)) return false
    return markDeviceFilesSeen(app.getPath('userData'))
  })

  // The private files this desktop shared, which the app lists after a restart.
  ipcMain.handle('private-files-list', async (event) => {
    if (!isPeerskyAppPage(event?.senderFrame?.url, 'p2p', 'hyperdrive')) throw new Error('Forbidden')
    return { files: await getOwnPrivateFiles() }
  })
}
