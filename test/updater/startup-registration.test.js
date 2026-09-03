/**
 * The update handler must be reachable from the moment the app is ready.
 *
 * In beta.27 `ipcMain.handle('check-for-updates')` sat after
 * `await extensionManager.initialize(...)`, which measured 5177ms on a real
 * profile. Clicking "Check for Updates" inside that window failed with "No
 * handler registered for 'check-for-updates'". Both the handler and
 * setupAutoUpdater also ran at the very end of an unguarded async block, so a
 * rejection earlier in boot left the build unable to update itself out of it.
 *
 * Nothing in the suite boots the app, so this reads the ordering out of the
 * source instead.
 */

import { expect } from 'chai'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const mainPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'main.js')
const source = readFileSync(mainPath, 'utf8')

const READY = 'app.whenReady().then(async () => {'
const readyAt = source.indexOf(READY)
const closeAt = source.indexOf('\n}).catch(', readyAt)
const block = source.slice(readyAt, closeAt === -1 ? undefined : closeAt)

const firstAwaitAt = block.search(/\bawait\b/)
const handlerAt = block.indexOf("ipcMain.handle('check-for-updates'")
const updaterAt = block.indexOf('setupAutoUpdater(')
const restoreAt = block.indexOf('await windowManager.openSavedWindows()')

describe('startup registration order', () => {
  it('reads a whenReady block that awaits something', () => {
    expect(readyAt, READY).to.be.greaterThan(-1)
    expect(closeAt, 'the block is closed by a .catch').to.be.greaterThan(readyAt)
    expect(firstAwaitAt, 'an await inside the block').to.be.greaterThan(-1)
  })

  it('registers check-for-updates before the first await', () => {
    expect(handlerAt, "ipcMain.handle('check-for-updates')").to.be.greaterThan(-1)
    expect(handlerAt, 'the handler must not sit behind a startup await').to.be.lessThan(firstAwaitAt)
  })

  it('starts the updater before the work that can fail', () => {
    expect(updaterAt, 'setupAutoUpdater').to.be.greaterThan(-1)
    expect(restoreAt, 'window restore').to.be.greaterThan(-1)
    expect(updaterAt, 'the updater must be up before window restore can throw').to.be.lessThan(restoreAt)
  })

  it('settles the startup tasks rather than racing them', () => {
    // Promise.all abandons the rest of boot on the first rejection, including
    // the updater that would ship the fix for whatever rejected.
    expect(block.slice(0, updaterAt)).to.include('Promise.allSettled')
    expect(block).to.not.match(/await Promise\.all\(/)
  })

  it('does not let a startup rejection vanish', () => {
    expect(closeAt, 'a .catch on the whenReady chain').to.be.greaterThan(-1)
  })
})
