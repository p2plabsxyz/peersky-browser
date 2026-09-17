// Tab bar behaviour: dragging between windows, the floating drag preview, the
// hover card, switching layouts, and media autoplay.

import { expect } from 'chai'
import { readFile } from 'fs/promises'
import esmock from 'esmock'

const tabBar = await readFile(new URL('../src/pages/tab-bar.js', import.meta.url), 'utf8')
const windows = await readFile(new URL('../src/window-manager.js', import.meta.url), 'utf8')
const renderer = await readFile(new URL('../src/renderer.js', import.meta.url), 'utf8')

// The preview module creates windows, so electron is stubbed out.
const preview = await esmock.strict('../src/tab-drag-preview.js', {
  electron: { BrowserWindow: class {}, ipcMain: { handle () {}, on () {} } },
  '../src/session.js': { getPartition: () => 'persist:test' }
})
const previewSource = await readFile(new URL('../src/tab-drag-preview.js', import.meta.url), 'utf8')

// A tab dragged onto another window opened a new window instead of joining it.
describe('dragging a tab onto another window', function () {
  it('asks which window is under the drop point before tearing off', function () {
    expect(tabBar).to.contain('this.moveTabOut(idsToMove[0], e.screenX, e.screenY)')
    expect(tabBar).to.contain("ipcRenderer.invoke('window-at-point'")
    expect(tabBar).to.contain('if (targetId === null) return this.moveTabToNewWindow(tabId)')
  })

  it('resolves the point against every other window, never the source', function () {
    const handler = windows.slice(windows.indexOf("'window-at-point'"), windows.indexOf("'move-tab-to-window'"))
    expect(handler).to.contain('win.webContents.id === event.sender.id) continue')
    expect(handler).to.contain('win.getBounds()')
  })

  it('hands the tab to the target and focuses it', function () {
    const handler = windows.slice(windows.indexOf("'move-tab-to-window'"), windows.indexOf("'new-window-with-split-tabs'"))
    expect(handler).to.contain("send('add-tab-at-point', tab)")
    expect(handler).to.contain('target.window.focus()')
    expect(renderer).to.contain("ipcRenderer.on('add-tab-at-point'")
  })

  it('inserts at the drop position, not at the end', function () {
    const start = tabBar.indexOf('insertTabAtPoint (')
    const insert = tabBar.slice(start, start + 1500)
    expect(insert).to.contain('cx < r.left + r.width / 2')
    expect(insert).to.contain('cy < r.top + r.height / 2')
    expect(insert).to.contain('this.moveTabToPosition(tabId, index)')
  })
})

describe("dragging a window's only tab", function () {
  it('may leave, but only to join another window', function () {
    expect(tabBar).to.contain('if (this.isOutsideContainer && idsToMove.length === 1 && this.tabs.length === 1) {')
    expect(tabBar).to.contain('if (targetId === null) return this.settleDrag()')
    expect(tabBar).to.contain('this.moveLastTabToWindow(idsToMove[0], targetId, e.screenX, e.screenY)')
  })

  it('closes the window it leaves behind, before the target takes focus', function () {
    const move = tabBar.slice(tabBar.indexOf('moveLastTabToWindow (tabId'), tabBar.indexOf('async windowAt ('))
    expect(move).to.contain('this.detachTab(tabId, { last: true })')
    expect(move).to.contain('closeSource: true')
    const handler = windows.slice(windows.indexOf("'move-tab-to-window'"), windows.indexOf("'new-window-with-split-tabs'"))
    expect(handler).to.contain("source.once('closed', () => { if (!target.window.isDestroyed()) target.window.focus() })")
  })

  it('still refuses the last tab for a plain tear-off', function () {
    expect(tabBar).to.contain('if (!tab || (this.tabs.length === 1 && !last)) return null')
  })
})

// A tab dragged past the window edge vanished, because it was a DOM element.
// A small always-on-top window now stands in for it outside the strip.
describe('the floating tab preview', function () {
  it('escapes the tab title', function () {
    const page = preview.previewPage({ title: '<img src=x onerror=alert(1)>', width: 100, height: 30 })
    expect(page).to.not.contain('<img')
    expect(page).to.contain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('shows favicons from the browser schemes and nothing else', function () {
    expect(preview.previewPage({ favicon: 'peersky://static/assets/icon16.png', width: 100, height: 30 })).to.contain('url("peersky://static/assets/icon16.png")')
    expect(preview.previewPage({ favicon: 'javascript:alert(1)', width: 100, height: 30 })).to.contain('background: none')
    expect(preview.previewPage({ favicon: 'https://x.test/a".png', width: 100, height: 30 })).to.contain('url("https://x.test/a%22.png")')
  })

  it('cannot be broken out of by a computed style value', function () {
    const page = preview.previewPage({ background: 'red; } </style><script>1</script>', width: 100, height: 30 })
    expect(page).to.not.contain('<script>')
  })

  it('leaves room for the shadow on every side', function () {
    expect(preview.previewWindowSize({ width: 100.4, height: 30 })).to.deep.equal({ width: 101 + preview.PAD * 2, height: 30 + preview.PAD * 2 })
  })

  it('never takes focus or the pointer, and is torn down at drop', function () {
    expect(previewSource).to.contain('focusable: false')
    expect(previewSource).to.contain('win.setIgnoreMouseEvents(true)')
    expect(previewSource).to.contain("msg?.type === 'end') destroy()")
  })

  it('hides the dragged element only once the preview is on screen', function () {
    const move = tabBar.slice(tabBar.indexOf('moveDragPreview (e) {'), tabBar.indexOf('hideDragPreview () {'))
    expect(move.indexOf('if (!preview?.ready) return')).to.be.below(move.indexOf("visibility = 'hidden'"))
    expect(tabBar).to.contain('this.endDragPreview()')
  })
})

// The tab preview appeared after 0.8s and could sit off the left edge of a
// collapsed vertical strip.
describe('the tab hover card', function () {
  const card = tabBar.slice(tabBar.indexOf('setupTabHoverCard ('), tabBar.indexOf('destroyHoverCard ()'))

  it('waits 3s, and 8s while a vertical strip is still collapsed', function () {
    expect(card).to.contain("this.isVertical && !this.classList.contains('expanded')")
    expect(card).to.contain('collapsedVertical ? 8000 : 3000')
    expect(card).to.not.contain('800)')
  })

  it('sits beside a vertical strip rather than under the tab', function () {
    expect(card).to.contain('vertical ? tabRect.right + 8 : tabRect.left')
    expect(card).to.contain('vertical ? tabRect.top : tabRect.bottom + 8')
  })

  it('is kept inside the window on every side', function () {
    expect(card).to.contain('Math.max(margin, left)')
    expect(card).to.contain('Math.max(margin, top)')
    expect(card).to.contain('window.innerWidth - cardRect.width - margin')
    expect(card).to.contain('window.innerHeight - cardRect.height - margin')
  })
})

// Switching between horizontal and vertical tabs rebuilt the webviews, which
// reloaded every open page.
describe('switching the tab layout', function () {
  const adopt = tabBar.slice(tabBar.indexOf('adoptTabs ('), tabBar.indexOf('// Restore tabs from persisted data'))
  const onSwitch = renderer.slice(renderer.indexOf("'vertical-tabs-changed'"), renderer.indexOf('RE-ATTACH event listeners'))

  it('hands the existing webviews to the new bar instead of destroying them', function () {
    expect(onSwitch).to.contain('webviews: oldBar.webviews')
    expect(onSwitch).to.contain('tabBar.adoptTabs(carried, webviewContainer)')
    expect(onSwitch).to.not.contain('webview.remove()')
    expect(onSwitch).to.not.contain('removeChild(webviewContainer.firstChild)')
  })

  it('rebuilds the strip without creating webviews or replaying history', function () {
    expect(adopt).to.contain('this.webviewContainer = null')
    expect(adopt).to.contain('navigation: webviews.has(tab.id) ? null : tab.navigation')
    expect(adopt).to.contain('this.setupWebviewEvents(webview, tabId)')
  })

  it('keeps the zoom levels and favicons the old strip had', function () {
    expect(adopt).to.contain('this.zoomLevels = zoomLevels')
    expect(onSwitch).to.contain("querySelector('.tab-favicon')?.style.backgroundImage")
  })

  // The old bar's webview listeners keep firing after it is removed.
  it('retires the old bar so it can never persist stale state', function () {
    expect(onSwitch).to.contain('oldBar.retire()')
    expect(tabBar).to.contain('if (this._retired || this._tabsStateTimer) return')
    expect(tabBar).to.match(/writeTabsStateNow \(\) \{\n\s+if \(this\._retired\) return/)
    const retire = tabBar.slice(tabBar.indexOf('retire ()'), tabBar.indexOf('// Restore tabs from persisted data'))
    expect(retire).to.contain('this.tabs = []')
    expect(retire).to.contain('this.webviews = new Map()')
  })

  it('stops the old bar from driving the address bar', function () {
    expect(onSwitch).to.contain("oldBar.removeEventListener('tab-navigated', handleTabNavigated)")
  })
})

// Restored tabs with media started playing on their own.
describe('media autoplay', function () {
  it('needs the page to have been interacted with first, as browsers do', function () {
    const prefs = tabBar.match(/setAttribute\('webpreferences', '([^']+)'\)/)
    expect(prefs, 'the webview sets its web preferences').to.not.equal(null)
    expect(prefs[1].split(',')).to.include('autoplayPolicy=document-user-activation-required')
  })
})
