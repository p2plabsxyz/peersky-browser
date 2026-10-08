// Cmd-click (Ctrl-click off macOS) picked one tab, so dragging tabs into a
// new window only ever took one. Tabs can be picked together now, and travel
// together: within the strip, into a window of their own, or onto another.
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { readFile } from 'fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const tabBar = await read('src/pages/tab-bar.js')
const windows = await read('src/window-manager.js')
const renderer = await read('src/renderer.js')
const between = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)))

describe('picking several tabs', function () {
  const click = between(tabBar, '  handleTabClick (tabId, e) {', '  toggleTabSelection (tabId) {')

  it('adds with Cmd on macOS and Ctrl elsewhere, ranges with Shift, and starts over on a plain click', function () {
    expect(tabBar).to.contain("tab.addEventListener('click', (e) => this.handleTabClick(tabId, e))")
    expect(click).to.contain("const adds = process.platform === 'darwin' ? e.metaKey : e.ctrlKey")
    expect(click).to.contain('if (adds) return this.toggleTabSelection(tabId)')
    expect(click).to.contain('if (e.shiftKey) return this.selectTabRange(tabId)')
    // Not straight after a drag, whose closing click would drop the picks.
    expect(click).to.contain('if (Date.now() - (this.dragEndedAt || 0) > 300) this.clearTabSelection()')
  })

  it('always includes the tab on screen, and lets go of closed or moved tabs', function () {
    expect(between(tabBar, '  toggleTabSelection (tabId) {', '  selectTabRange (tabId) {')).to.contain('else if (tabId !== this.activeTabId) this.selectedTabIds.delete(tabId)')
    expect(between(tabBar, '  selectTab (tabId, isNewTab = false) {', 'const currentActive')).to.contain('if (this.selectedTabIds?.size && !this.selectedTabIds.has(tabId)) this.clearTabSelection()')
    expect(between(tabBar, '  detachTab (tabId', '  moveTabToNewWindow (tabId) {')).to.contain('this.selectedTabIds.delete(tabId)')
    expect(between(tabBar, '  closeTab (tabId) {', '    // If we closed the active tab')).to.contain('this.selectedTabIds.delete(tabId)')
  })
})

describe('dragging picked tabs', function () {
  const down = between(tabBar, '  handlePointerDown (e) {', '  handlePointerMove (e) {')
  const move = between(tabBar, '  handlePointerMove (e) {', '  handlePointerUp (e) {')
  const up = between(tabBar, '  handlePointerUp (e) {', '  discardDraggedElements () {')

  it('takes all of them, in strip order, when one of them is in the hand', function () {
    expect(down).to.contain('const picked = this.selectionToDrag(tab)')
    expect(down).to.match(/if \(picked\) \{\s+this\.draggedElements = picked\s+this\.dragSelection = true/)
  })

  it('carries them as one block, with the tab in the hand under the pointer', function () {
    expect(move).to.contain('if (this.dragSelection) {')
    expect(move).to.contain('lead = Math.max(0, this.draggedElements.indexOf(this.primaryDragTarget))')
    expect(move).to.contain('el.dataset.dragOffsetX = isVert ? 0 : stacked[index]')
    expect(move).to.contain('this.startDragPreview(rects[lead])')
  })

  it('moves them out together when dropped outside the strip', function () {
    expect(up).to.match(/if \(selection\) \{\s+this\.moveTabsOut\(idsToMove, e\.screenX, e\.screenY\)/)
    const out = between(tabBar, '  async moveTabsOut (tabIds, screenX, screenY) {', '  // Takes a tab out of this window')
    expect(out).to.contain('if (this.getSplitForTab(id)) this.breakSplitView(id)')
    expect(out).to.contain("ipcRenderer.send('new-window-with-tabs', { tabs: moved })")
    expect(out).to.contain("ipcRenderer.send('move-tabs-to-window', { targetId, tabs: moved, x: screenX, y: screenY })")
  })
})

describe('a window taking several tabs', function () {
  it('opens a new one with all of them, in their order', function () {
    expect(windows).to.contain("ipcMain.on('new-window-with-tabs', (event, data) => {")
    expect(windows).to.contain('...(tabs.length === 1 ? { singleTab: tabs[0] } : { movedTabs: tabs })')
    expect(windows).to.match(/const \{ url, isMainWindow = false, newWindow = false, windowId, savedTabs, isolate, singleTab, movedTabs, incognito, \.\.\.windowOptions \} = options/)
    expect(windows).to.contain('...(movedTabs?.length && { movedTabs: JSON.stringify(movedTabs) }),')
    expect(between(tabBar, '  restoreOrCreateInitialTabs () {', '  loadPersistedTabs () {')).to.contain("JSON.parse(searchParams.get('movedTabs') || '[]')")
  })

  it('or puts them where they were dropped in another, side by side', function () {
    expect(windows).to.contain("target.window.webContents.send('add-tabs-at-point', { tabs: list, x, y })")
    expect(renderer).to.contain('tabBar?.insertTabsAtPoint?.(batch)')
    expect(tabBar).to.contain('  insertTabsAtPoint ({ tabs, x, y }) {')
  })

  it('shows which tabs are picked, in both tab layouts', async function () {
    expect(await read('src/pages/theme/index.css')).to.contain('.tab.multi-selected:not(.active) {')
    expect(await read('src/pages/theme/vertical-tabs.css')).to.contain('.tabbar.vertical-tabs .tab.multi-selected:not(.active) {')
  })
})
