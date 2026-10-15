import { app, ipcMain } from 'electron'
import { isPeerskyAppPage } from '../backup/ipc-caller.js'
import { listHyperdrive } from './hyper-handler.js'
import { hyperFileUrl, readCacheEpoch } from './hyperdrive-views.js'

// Only the Hyperdrive app asks, its Files, Photos and Videos views included.
// The preload hands the channels to the P2P app pages, which share a host, so
// the folder is checked here as well.
function assertHyperdriveApp (event) {
  if (!isPeerskyAppPage(event?.senderFrame?.url, 'p2p', 'hyperdrive')) throw new Error('Forbidden')
}

export function setupHyperdriveViewsIpc () {
  // Every file under a folder, or { code, message } when it cannot be listed.
  ipcMain.handle('hyperdrive-list', (event, url, options) => {
    assertHyperdriveApp(event)
    return listHyperdrive(url, { recursive: options?.recursive !== false })
  })

  // What the views' stored pictures and details have to go with.
  ipcMain.handle('hyperdrive-cache-epoch', (event) => {
    assertHyperdriveApp(event)
    return readCacheEpoch(app.getPath('userData'))
  })

  // <a download> on these pages names a file of another origin, so Chromium
  // opened it in the tab instead. Saved here like any other download.
  ipcMain.handle('hyperdrive-download', (event, url) => {
    assertHyperdriveApp(event)
    const file = hyperFileUrl(url)
    if (!file) throw new Error('Only a file in a hyper:// drive can be downloaded')
    event.sender.downloadURL(file)
    return true
  })
}
