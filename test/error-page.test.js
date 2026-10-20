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
  const page = {
    replacedWith: null,
    fetches: [],
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
      replace (to) { page.replacedWith = to }
    },
    document: {
      title: '',
      visibilityState: 'visible',
      getElementById: () => null,
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
