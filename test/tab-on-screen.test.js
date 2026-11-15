import { expect } from 'chai'
import vm from 'node:vm'
import esmock from 'esmock'

// A tab's page reads "visible" whenever its window is, even behind another
// tab, so PeerSky asks the window which tabs it shows.
describe('whether a tab is in front', function () {
  async function load () {
    return esmock('../src/tab-on-screen.js', {}, { electron: { BrowserWindow: { fromWebContents: () => null } } })
  }

  // A window's webviews, as the shell has them: laid out or display: none.
  function shell (views) {
    return {
      document: {
        querySelectorAll: () => views.map(({ id, shown, throws }) => ({
          getWebContentsId () {
            if (throws) throw new Error('not attached yet')
            return id
          },
          getClientRects: () => ({ length: shown ? 1 : 0 })
        }))
      }
    }
  }

  function setup ({ views = [], window = {}, type = 'webview', id = 7, destroyed = false } = {}) {
    const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, ...window }
    const host = {
      isDestroyed: () => false,
      ran: [],
      executeJavaScript (script) {
        this.ran.push(script)
        return Promise.resolve(vm.runInNewContext(script, shell(views)))
      }
    }
    const contents = { id, isDestroyed: () => destroyed, getType: () => type, hostWebContents: host }
    return { contents, host, windowOf: () => win }
  }

  it('is the tab its window lays out, side by side ones too', async function () {
    const { isTabOnScreen } = await load()
    let s = setup({ views: [{ id: 3, shown: true }, { id: 7, shown: true }] })
    expect(await isTabOnScreen(s.contents, s)).to.equal(true)
    s = setup({ views: [{ id: 3, shown: true }, { id: 7, shown: false }] })
    expect(await isTabOnScreen(s.contents, s)).to.equal(false)
    s = setup({ views: [{ id: 2, throws: true }, { id: 7, shown: true }] })
    expect(await isTabOnScreen(s.contents, s)).to.equal(true)
    s = setup({ views: [{ id: 3, shown: true }] })
    expect(await isTabOnScreen(s.contents, s)).to.equal(false)
  })

  it('is not in front in a minimized or hidden window, or once gone', async function () {
    const { isTabOnScreen } = await load()
    const views = [{ id: 7, shown: true }]
    for (const window of [{ isMinimized: () => true }, { isVisible: () => false }, { isDestroyed: () => true }]) {
      const s = setup({ views, window })
      expect(await isTabOnScreen(s.contents, s)).to.equal(false)
    }
    let s = setup({ views, destroyed: true })
    expect(await isTabOnScreen(s.contents, s)).to.equal(false)
    // A page not in a tab, such as a browser window's own page.
    s = setup({ views, type: 'window' })
    expect(await isTabOnScreen(s.contents, s)).to.equal(false)
    expect(s.host.ran).to.have.length(0)
    s = setup({ views })
    expect(await isTabOnScreen(s.contents, { windowOf: () => null })).to.equal(false)
    expect(await isTabOnScreen(null, s)).to.equal(false)
  })

  it('never fails, and puts only a number in the script it runs', async function () {
    const { isTabOnScreen, laidOutScript } = await load()
    const s = setup({ views: [{ id: 7, shown: true }] })
    s.host.executeJavaScript = () => Promise.reject(new Error('window closing'))
    expect(await isTabOnScreen(s.contents, s)).to.equal(false)
    expect(laidOutScript('7); alert(1')).to.equal(null)
    expect(laidOutScript(-1)).to.equal(null)
    expect(laidOutScript(1.5)).to.equal(null)
    expect(laidOutScript(12)).to.include('if (id === 12) return')
  })
})
