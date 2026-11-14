import { expect } from 'chai'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// A tab's page reads its window's visibility, "visible" behind another tab
// too. The tab bar tells each page when its tab goes behind another one and
// comes back, and the preload marks PeerSky's own P2P pages, which PeerChat
// reads as a chat not on screen.
const source = (path) => readFile(new URL(path, import.meta.url), 'utf8')

function methodsOf (code) {
  const start = code.indexOf('  watchTabShown (webview) {')
  const end = code.indexOf('  // Set up all event handlers for a webview')
  expect(start, 'watchTabShown').to.be.above(-1)
  return `class Bar {\n${code.slice(start, end)}\n}; this.Bar = Bar`
}

describe('tabs behind another one', function () {
  it('tells a page each time its tab goes behind another one or comes back, and again when it loads', async function () {
    const tabBar = await source('../src/pages/tab-bar.js')
    const observers = []
    class IntersectionObserver {
      constructor (callback) {
        this.callback = callback
        this.watched = new Set()
        observers.push(this)
      }

      observe (target) { this.watched.add(target) }
      unobserve (target) { this.watched.delete(target) }
      fire (targets) { this.callback(targets.map((target) => ({ target }))) }
    }
    const context = { IntersectionObserver }
    vm.runInNewContext(methodsOf(tabBar), context)
    const bar = new context.Bar()

    const webview = (laidOut, { attached = true } = {}) => ({
      laidOut,
      attached,
      isConnected: true,
      sent: [],
      getClientRects () { return { length: this.laidOut ? 1 : 0 } },
      send (channel, value) {
        if (!this.attached) throw new Error('The WebView must be attached to the DOM')
        this.sent.push([channel, value])
      }
    })
    const front = webview(true)
    const behind = webview(false)
    bar.watchTabShown(front)
    bar.watchTabShown(behind)
    expect(observers).to.have.length(1)
    const [observer] = observers
    observer.fire([front, behind])
    expect(front.sent).to.deep.equal([['peersky-tab-shown', true]])
    expect(behind.sent).to.deep.equal([['peersky-tab-shown', false]])

    // A switch: once each, nothing for what did not change.
    front.laidOut = false
    behind.laidOut = true
    observer.fire([front, behind])
    observer.fire([front, behind])
    expect(front.sent.map(([, shown]) => shown)).to.deep.equal([true, false])
    expect(behind.sent.map(([, shown]) => shown)).to.deep.equal([false, true])

    // A page that loads hears it again, the one it replaced having heard it.
    bar.tellTabShown(behind, { again: true })
    expect(behind.sent.map(([, shown]) => shown)).to.deep.equal([false, true, true])

    // Not attached yet: told at dom-ready instead, with nothing lost.
    const fresh = webview(false, { attached: false })
    bar.watchTabShown(fresh)
    observer.fire([fresh])
    expect(fresh.sent).to.deep.equal([])
    fresh.attached = true
    bar.tellTabShown(fresh, { again: true })
    expect(fresh.sent).to.deep.equal([['peersky-tab-shown', false]])

    // A closed tab is let go.
    front.isConnected = false
    observer.fire([front])
    expect(observer.watched.has(front)).to.equal(false)
    expect(tabBar).to.match(/this\.webviewContainer\.appendChild\(webview\)\n\s+this\.watchTabShown\(webview\)/)
    expect(tabBar).to.match(/webview\.addEventListener\('dom-ready', \(\) => \{\n\s+this\.applyZoomForTab\(tabId\)\n\s+\/\/ Each page that loads hears whether its tab is in front\.\n\s+this\.tellTabShown\(webview, \{ again: true \}\)/)
  })

  it('marks PeerSky\'s own P2P pages, and only on a change', async function () {
    const preload = await source('../src/pages/unified-preload.js')
    const start = preload.indexOf('if (isP2PPage) {\n  ipcRenderer.on(\'peersky-tab-shown\'')
    const end = preload.indexOf('// AI Chat taken up again')
    expect(start).to.be.above(-1)
    const block = preload.slice(start, end)

    const run = ({ isP2PPage, root = { dataset: {} } }) => {
      const listeners = new Map()
      const events = []
      const document = {
        documentElement: root,
        dispatchEvent: (event) => events.push(event.type)
      }
      const window = { addEventListener: (type, listener) => listeners.set(type, listener) }
      const ipcRenderer = { on: (channel, listener) => listeners.set(channel, listener) }
      vm.runInNewContext(block, { isP2PPage, ipcRenderer, document, window, Event: class { constructor (type) { this.type = type } } })
      return { listeners, events, document }
    }

    const page = run({ isP2PPage: true })
    const tell = page.listeners.get('peersky-tab-shown')
    tell({}, true)
    tell({}, true)
    expect(page.document.documentElement.dataset.peerskyTab).to.equal('shown')
    tell({}, false)
    expect(page.document.documentElement.dataset.peerskyTab).to.equal('hidden')
    expect(page.events).to.deep.equal(['peersky-tab-visibility', 'peersky-tab-visibility'])

    // Told before the page has an element to mark: marked once it does.
    const early = run({ isP2PPage: true, root: null })
    early.listeners.get('peersky-tab-shown')({}, false)
    expect(early.events).to.deep.equal([])
    early.document.documentElement = { dataset: {} }
    early.listeners.get('DOMContentLoaded')()
    expect(early.document.documentElement.dataset.peerskyTab).to.equal('hidden')

    // A site, or an app added under peersky://myapps, hears nothing.
    expect(run({ isP2PPage: false }).listeners.size).to.equal(0)
    expect(preload).to.match(/const isP2PPage = isPeerskyPage\('p2p'\)/)
  })
})
