// The back and forward buttons on a mouse did nothing on a Mac: Electron gives
// them to the window as app commands only on Windows and Linux.

import { expect } from 'chai'
import { readFile } from 'fs/promises'
import vm from 'vm'
import { stepTabHistory } from '../src/history-nav.js'

const read = async (file) => (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
const preload = await read('../src/pages/unified-preload.js')
const main = await read('../src/main.js')
const windows = await read('../src/window-manager.js')

function fakeTab ({ id = 9, destroyed = false } = {}) {
  const scripts = []
  const host = { isDestroyed: () => destroyed, executeJavaScript: async (script) => { scripts.push(script) } }
  return { tab: { id, hostWebContents: host }, scripts }
}

// Runs what main sent the window, over a tab strip whose active tab is tab-1.
function runInWindow (script) {
  const calls = []
  const tabBar = {
    activeTabId: 'tab-1',
    findTabByWebContentsId: (id) => (id === 9 ? { id: 'tab-2' } : null),
    selectTab (id) { calls.push(['selectTab', id]); this.activeTabId = id },
    goBackActiveTab () { calls.push(['back', this.activeTabId]) },
    goForwardActiveTab () { calls.push(['forward', this.activeTabId]) }
  }
  vm.runInNewContext(script, { document: { querySelector: (selector) => (selector === '#tabbar' ? tabBar : null) } })
  return calls
}

describe('the back and forward buttons on a mouse', function () {
  it('step back in the tab the page is in, bringing it to the front', function () {
    const { tab, scripts } = fakeTab()
    stepTabHistory(tab, 'back')
    expect(runInWindow(scripts[0])).to.deep.equal([['selectTab', 'tab-2'], ['back', 'tab-2']])
  })

  it('step forward', function () {
    const { tab, scripts } = fakeTab()
    stepTabHistory(tab, 'forward')
    expect(runInWindow(scripts[0])).to.deep.equal([['selectTab', 'tab-2'], ['forward', 'tab-2']])
  })

  it('do nothing for a tab that is gone, or anything but back and forward', function () {
    const gone = fakeTab({ id: 4 })
    stepTabHistory(gone.tab, 'back')
    expect(runInWindow(gone.scripts[0])).to.deep.equal([])
    const closed = fakeTab({ destroyed: true })
    stepTabHistory(closed.tab, 'back')
    const odd = fakeTab()
    stepTabHistory(odd.tab, 'reload')
    stepTabHistory(odd.tab, 'goBackActiveTab(); alert(1)')
    expect(closed.scripts.concat(odd.scripts)).to.deep.equal([])
  })

  it('are heard by the page on a Mac, unless it used them itself', function () {
    const start = preload.indexOf("if (process.platform === 'darwin') {\n  window.addEventListener('mouseup'")
    expect(start).to.be.above(-1)
    const listener = preload.slice(start, preload.indexOf('\n}\n', start))
    expect(listener).to.contain('if (!event.isTrusted || (event.button !== 3 && event.button !== 4)) return')
    expect(listener).to.match(/setTimeout\(\(\) => \{\s+if \(event\.defaultPrevented\) return\s+ipcRenderer\.send\('peersky-mouse-history', event\.button === 3 \? 'back' : 'forward'\)/)
  })

  it('come only from a page in a tab, and stay app commands on Windows and Linux', function () {
    const handler = main.slice(main.indexOf("ipcMain.on('peersky-mouse-history'"))
    expect(handler).to.contain("if (!tab || tab.isDestroyed() || tab.getType() !== 'webview') return")
    expect(handler).to.contain('if (event.senderFrame?.parent) return')
    expect(handler).to.contain('stepTabHistory(tab, step)')
    expect(windows).to.contain("if (command === 'browser-backward') goBackActiveTab(window.window)")
  })
})
