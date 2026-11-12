// A site that failed for want of a network stayed on the error page after the
// network came back, and the tab was named for the error (NameNotResolved)
// rather than the site. Runs the error page's script with a stand-in window.

import { expect } from 'chai'
import { readFileSync } from 'fs'
import path from 'path'
import vm from 'vm'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const SOURCE = readFileSync(path.join(ROOT, 'src', 'pages', 'static', 'js', 'error.js'), 'utf8')

function openErrorPage ({ code, url, siteAnswers = () => false }) {
  const timers = []
  const listeners = { window: {}, document: {} }
  const buttons = {}
  const page = {
    replacedWith: null,
    assigned: null,
    reloaded: false,
    fetches: [],
    click (id) { for (const fn of buttons[id]?.click || []) fn() },
    timers,
    fire (target, type) { for (const fn of listeners[target][type] || []) fn() },
    async runNextTimer () {
      const next = timers.shift()
      next.fn()
      await new Promise((resolve) => setImmediate(resolve))
      return next.ms
    }
  }
  const sandbox = {
    URL,
    URLSearchParams,
    AbortSignal,
    navigator: { onLine: true },
    location: {
      search: '?' + new URLSearchParams({ code, name: 'NameNotResolvedErr', msg: 'failed', url }),
      replace (to) { page.replacedWith = to },
      get href () { return page.assigned },
      set href (to) { page.assigned = to },
      reload () { page.reloaded = true }
    },
    document: {
      title: '',
      visibilityState: 'visible',
      getElementById: (id) => id.endsWith('Button')
        ? { addEventListener (type, fn) { ((buttons[id] ||= {})[type] ||= []).push(fn) } }
        : null,
      addEventListener (type, fn) { (listeners.document[type] ||= []).push(fn) }
    },
    addEventListener (type, fn) { (listeners.window[type] ||= []).push(fn) },
    setTimeout (fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer },
    clearTimeout (timer) { const at = timers.indexOf(timer); if (at !== -1) timers.splice(at, 1) },
    fetch (address, options) {
      page.fetches.push({ address, options })
      return siteAnswers() ? Promise.resolve({ type: 'opaque' }) : Promise.reject(new TypeError('Failed to fetch'))
    }
  }
  sandbox.window = sandbox
  vm.runInNewContext(SOURCE, sandbox)
  page.title = () => sandbox.document.title
  return page
}

describe('error page', function () {
  it('names the tab for the site, not the error', function () {
    const page = openErrorPage({ code: '-105', url: 'https://www.youtube.com/watch?v=1' })
    expect(page.title()).to.equal('www.youtube.com')
  })

  it('loads the site by itself once it answers, without adding to the history', async function () {
    let online = false
    const page = openErrorPage({ code: '-105', url: 'https://example.com/a?b=1', siteAnswers: () => online })

    await page.runNextTimer()
    expect(page.fetches[0].address).to.equal('https://example.com/')
    expect(page.fetches[0].options).to.include({ mode: 'no-cors', credentials: 'omit' })
    expect(page.replacedWith).to.equal(null)

    online = true
    page.fire('window', 'online')
    expect(await page.runNextTimer()).to.equal(1000)
    expect(page.replacedWith).to.equal('https://example.com/a?b=1')
  })

  it('tries again when the tab is shown', async function () {
    const page = openErrorPage({ code: '-106', url: 'https://example.com/', siteAnswers: () => true })
    page.fire('document', 'visibilitychange')
    await new Promise((resolve) => setImmediate(resolve))
    expect(page.replacedWith).to.equal('https://example.com/')
  })

  it('waits longer between each try, up to a minute', async function () {
    const page = openErrorPage({ code: '-105', url: 'https://example.com/' })
    const waits = []
    for (let i = 0; i < 7; i++) waits.push(await page.runNextTimer())
    expect(waits).to.deep.equal([2000, 5000, 10000, 30000, 60000, 60000, 60000])
    expect(page.fetches).to.have.length(7)
  })

  it('leaves errors a network does not fix, and other schemes, alone', function () {
    for (const [code, url] of [['-200', 'https://example.com/'], ['-105', 'hyper://example/'], ['-105', 'javascript:alert(1)']]) {
      const page = openErrorPage({ code, url, siteAnswers: () => true })
      page.fire('window', 'online')
      page.fire('document', 'visibilitychange')
      expect(page.timers, `${code} ${url}`).to.have.length(0)
      expect(page.fetches, `${code} ${url}`).to.have.length(0)
    }
  })
})

// Back from an error page tried the failed address again, which failed again
// and added another error page, so the tab never got back to the page before.
// The error page now takes the failed load's own history entry.
describe('a failed load in the history', function () {
  const renderer = readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n')
  const tabBar = readFileSync(path.join(ROOT, 'src', 'pages', 'tab-bar.js'), 'utf8').replace(/\r\n/g, '\n')

  async function runInTab (href, target) {
    const { replaceErrorDocumentScript, ERROR_DOCUMENT_URL } = await import('../src/utils.js')
    const replaced = []
    const result = vm.runInNewContext(replaceErrorDocumentScript(target), {
      location: { href: href === 'error' ? ERROR_DOCUMENT_URL : href, replace: (to) => replaced.push(to) }
    })
    return { result, replaced }
  }

  it("shows the error page in the failed entry, from Chromium's own error document", async function () {
    const target = 'peersky://error.html?code=-105&url=https%3A%2F%2Fnope.invalid%2F'
    const { result, replaced } = await runInTab('error', target)
    expect(result).to.equal(true)
    expect(replaced).to.deep.equal([target])
  })

  it('leaves a page alone once the tab has moved on to it', async function () {
    const { result, replaced } = await runInTab('https://example.com/', 'peersky://error.html?code=-105')
    expect(result).to.equal(false)
    expect(replaced).to.deep.equal([])
  })

  it('carries any address through as it is', async function () {
    const target = 'peersky://error.html?url=x\'"</script>`$' + '{1}`\\u2028'
    const { replaced } = await runInTab('error', target)
    expect(replaced).to.deep.equal([target])
  })

  it('is how the window shows every error page and retries a local one', function () {
    const handler = renderer.slice(renderer.indexOf('function setupWebviewErrorHandling'), renderer.indexOf("document.addEventListener('DOMContentLoaded'"))
    expect(handler).to.contain('showInPlaceOfFailure(`peersky://error.html?$' + '{params}`)')
    expect(handler).to.contain('webview.executeJavaScript(replaceErrorDocumentScript(target))')
    expect(handler).to.match(/if \(webview\.getURL\(\) === validatedURL\) \{\s+showInPlaceOfFailure\(validatedURL\)/)
    expect(handler).to.not.contain('webview.src = errorURL')
    expect(handler).to.not.contain('t: Date.now()')
  })

  it('takes the error page out of the history when Retry is pressed', function () {
    const page = openErrorPage({ code: '-200', url: 'https://example.com/a' })
    page.click('retryButton')
    expect(page.replacedWith).to.equal('https://example.com/a')
    expect(page.assigned).to.equal(null)
  })

  it('does the same for Reload, and for the failed address entered again', function () {
    const reload = tabBar.slice(tabBar.indexOf('  reloadActiveTab () {'), tabBar.indexOf('  // Zoom the page'))
    expect(reload).to.contain('if (failed) this.retryFailedLoad(webview, failed)')
    const navigate = tabBar.slice(tabBar.indexOf('  navigateActiveTab (url) {'), tabBar.indexOf('  goBackActiveTab () {'))
    expect(navigate).to.contain('if (failed && sameAddress(failed, url)) this.retryFailedLoad(webview, failed)')
    expect(navigate).to.match(/location\.protocol === 'peersky:' && location\.hostname === 'error\.html' && location\.replace\(\$\{JSON\.stringify\(failed\)\}\)/)
  })
})
