import { ipcMain } from 'electron'
import { isPeerskyAppPage } from '../backup/ipc-caller.js'
import { getDeviceSyncSnapshot, getOwnPrivateFiles } from './hyper-handler.js'

// Only the Hyperdrive app asks. The preload hands the channels to the P2P app
// pages, which share a host, so the folder is checked here as well.
export function setupDeviceSyncIpc () {
  ipcMain.handle('device-sync-list', (event) => {
    if (!isPeerskyAppPage(event?.senderFrame?.url, 'p2p', 'hyperdrive')) throw new Error('Forbidden')
    return getDeviceSyncSnapshot()
  })

  // The private files this desktop shared, which the app lists after a restart.
  ipcMain.handle('private-files-list', async (event) => {
    if (!isPeerskyAppPage(event?.senderFrame?.url, 'p2p', 'hyperdrive')) throw new Error('Forbidden')
    return { files: await getOwnPrivateFiles() }
  })
}
