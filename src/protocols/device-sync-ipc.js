import { ipcMain } from 'electron'
import { isPeerskyAppPage } from '../backup/ipc-caller.js'
import { getDeviceSyncSnapshot } from './hyper-handler.js'

// Only the Hyperdrive app asks. The preload hands the channel to the P2P app
// pages, which share a host, so the folder is checked here as well.
export function setupDeviceSyncIpc () {
  ipcMain.handle('device-sync-list', (event) => {
    if (!isPeerskyAppPage(event?.senderFrame?.url, 'p2p', 'hyperdrive')) throw new Error('Forbidden')
    return getDeviceSyncSnapshot()
  })
}
