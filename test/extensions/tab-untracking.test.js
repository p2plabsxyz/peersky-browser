/**
 * Untracking a closing tab must not ask the UI to close it again.
 *
 * ExtensionStore.removeTab() calls the host's removeTab impl on its way out, so
 * the call we make to stop tracking a tab that the renderer has already closed
 * came back as a second close. That second close ran executeJavaScript against
 * a webContents being torn down and killed the main process with SIGTRAP on an
 * ordinary tab close.
 *
 * chrome.tabs.remove() arrives through the same impl without the untracking
 * flag set, and must still close the tab.
 */

import { expect } from 'chai'
import { readFile } from 'fs/promises'
import { refuseTabClose } from '../../src/extensions/tab-untracking.js'

const store = await readFile(
  new URL('../../node_modules/@p2plabs/peersky-chrome-extensions/dist/cjs/index.js', import.meta.url),
  'utf8'
)
const manager = await readFile(new URL('../../src/extensions/index.js', import.meta.url), 'utf8')

const live = { id: 26, isDestroyed: () => false }

describe('extension tab untracking', () => {
  it('closes the tab when an extension asks', () => {
    expect(refuseTabClose({ untracking: new Set(), tab: live })).to.equal(null)
  })

  it('only untracks a tab that is already closing', () => {
    expect(refuseTabClose({ untracking: new Set([26]), tab: live })).to.equal(
      'tab is already closing, only untracking'
    )
  })

  it('still closes a different tab while one is untracking', () => {
    const other = { id: 27, isDestroyed: () => false }
    expect(refuseTabClose({ untracking: new Set([26]), tab: other })).to.equal(null)
  })

  it('refuses a destroyed tab', () => {
    const gone = { id: 26, isDestroyed: () => true }
    expect(refuseTabClose({ untracking: new Set(), tab: gone })).to.equal('tab already destroyed')
  })

  it('refuses a tab with no webContents id', () => {
    expect(refuseTabClose({ untracking: new Set(), tab: { isDestroyed: () => false } })).to.equal(
      'no valid webContents ID'
    )
  })

  it('refuses when no tab is given', () => {
    expect(refuseTabClose({ untracking: new Set(), tab: null })).to.equal('no tab given')
  })

  it('does not close the tab a plain close is untracking', () => {
    // extensions-unregister-webview -> removeWindow -> ece.removeTab -> impl
    const untracking = new Set()
    let uiCloses = 0

    untracking.add(live.id)
    try {
      if (!refuseTabClose({ untracking, tab: live })) uiCloses++
    } finally {
      untracking.delete(live.id)
    }

    expect(uiCloses).to.equal(0)
  })
})

/**
 * The guard is a flag held only for the duration of one call, so it works only
 * because the store invokes the host hook synchronously from inside its own
 * removeTab. If a dependency bump makes that call async the flag would already
 * be cleared by the time the hook reads it, and the crash would come back
 * silently. Pin both halves of that contract.
 */
describe('untracking guard fits the extensions store', function () {
  it('store.removeTab calls the host hook without awaiting it', function () {
    expect(store).to.contain('if (typeof this.impl.removeTab === "function") {\n      this.impl.removeTab(tab, win);')
  })

  it('removeWindow holds the flag across the untrack call and clears it after', function () {
    expect(manager).to.contain('this._untrackingTabs.add(webContents.id)')
    expect(manager).to.contain('this.electronChromeExtensions.removeTab(webContents)')
    expect(manager).to.contain('this._untrackingTabs.delete(webContents.id)')
  })

  it('the hook consults the guard before it can await anything', function () {
    const hook = manager.slice(manager.indexOf('removeTab: async (tab, win) =>'))
    const guard = hook.indexOf('refuseTabClose({ untracking: this._untrackingTabs, tab })')
    const firstAwait = hook.indexOf('await ')
    expect(guard).to.be.greaterThan(-1)
    expect(firstAwait).to.be.greaterThan(-1)
    expect(guard).to.be.lessThan(firstAwait)
  })
})
