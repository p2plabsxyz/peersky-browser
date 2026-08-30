/**
 * Registering a tab with the extension system must not move the user's tab.
 *
 * ECE marks every tab active as it is added to its store and calls the host
 * back to select it. On a session restore each tab registers in turn, so those
 * callbacks walked the selection from the first restored tab to the last and
 * lost the tab the user left active. Traced on a four-tab window: restoreTabs
 * correctly selected the saved tab, then
 * addWindow -> ece.addTab -> ExtensionStore.setActiveTab -> the host selectTab
 * impl fired once per registered tab, in registration order, each one running
 * tabBar.selectTab in the renderer.
 *
 * Activation that does not come from registration, which is how
 * chrome.tabs.update({ active: true }) arrives, must still be honoured.
 */

import { expect } from 'chai'
import { shouldHonourTabActivation } from '../../src/extensions/tab-activation.js'

const live = { id: 1, isDestroyed: () => false }

describe('extension tab activation', () => {
  it('is refused while a tab is registering', () => {
    expect(shouldHonourTabActivation({ registering: true, window: live })).to.equal(false)
  })

  it('is honoured when it does not come from registration', () => {
    expect(shouldHonourTabActivation({ registering: false, window: live })).to.equal(true)
  })

  it('leaves the restored tab active while every tab registers', () => {
    const restored = ['tab-0', 'tab-1', 'tab-2', 'tab-3']
    const saved = 'tab-1'
    let active = saved

    // ECE activates each tab as it is added; the host is called back for each.
    for (const tabId of restored) {
      if (shouldHonourTabActivation({ registering: true, window: live })) active = tabId
    }

    expect(active).to.equal(saved)
  })

  it('is refused for a window that is gone', () => {
    expect(shouldHonourTabActivation({ registering: false, window: { isDestroyed: () => true } })).to.equal(false)
  })

  it('is refused when no window is given', () => {
    expect(shouldHonourTabActivation({ registering: false, window: null })).to.equal(false)
  })
})
