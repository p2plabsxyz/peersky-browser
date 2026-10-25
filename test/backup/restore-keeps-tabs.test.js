import { describe, it } from 'mocha'
import { expect } from 'chai'
import { readFile } from 'fs/promises'

// A transfer or a backup writes tabs.json and lastOpened.json and then waits
// for Restart now. The window's 30 s saver went on writing this computer's
// tabs over them, so the person came back to their old tabs.
describe('applying a transfer or a backup', function () {
  it("stops saving this window's tabs first, and saves again if it fails", async function () {
    const ipc = (await readFile(new URL('../../src/backup/ipc.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
    const start = ipc.indexOf("handle('backup-apply-restore'")
    const handler = ipc.slice(start, ipc.indexOf("handle('backup-discard-restore'", start))
    // A phone's send adds tabs in place and restarts nothing, so it keeps saving.
    expect(handler).to.contain("backupManager.staged?.kind !== 'phone'")
    const stop = handler.indexOf('windowManager.stopSaver()')
    expect(stop).to.be.greaterThan(-1)
    expect(handler.indexOf('windowManager.setSkipSaveOnQuit(true)')).to.be.greaterThan(stop)
    expect(handler.indexOf('backupManager.applyStaged(')).to.be.greaterThan(stop)
    expect(handler.match(/windowManager\.startSaver\(\)/g)).to.have.length(2)
  })
})
