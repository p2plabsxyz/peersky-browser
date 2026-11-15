// A page with no scripts of its own, like a raw code or text file, can be
// parsed before the preload runs. The page styling waited for DOMContentLoaded,
// which had gone by then, so raw code sat on a white page in the dark theme.

import { expect } from 'chai'
import { EventEmitter } from 'events'
import { readFileSync } from 'fs'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'
import { RAW_TEXT_CSS, darkenRawTextPages } from '../src/raw-text-pages.js'

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const PRELOAD = path.join(ROOT, 'src', 'pages', 'unified-preload.js')
const MAIN = path.join(ROOT, 'src', 'main.js')

describe('raw text pages', function () {
  const source = readFileSync(PRELOAD, 'utf8')

  it('are styled even when they finished loading before the preload ran', function () {
    expect(source).to.match(/if \(document\.readyState === 'loading'\) \{\s+window\.addEventListener\('DOMContentLoaded', injectPageStyles\)\s+\} else \{\s+injectPageStyles\(\)\s+\}/)
    expect(source).not.to.match(/window\.addEventListener\('DOMContentLoaded', async \(\) =>/)
  })

  it('get the dark page', function () {
    expect(source).to.include("document.querySelector('rss, feed, body > pre') !== null")
    expect(source).to.include("sheet.insertRule('body { background: #000; color: #fff }'")
  })

  // The preload's styles came seconds after the page, or never while a big
  // file was still loading, and the text sat white on white till then, as on
  // raw.githubusercontent.com.
  it('are white on black from the moment each page in a tab commits', async function () {
    const wc = new EventEmitter()
    const inserted = []
    wc.insertCSS = (css) => {
      inserted.push(css)
      return Promise.resolve('key')
    }
    darkenRawTextPages(wc)
    wc.emit('did-navigate', {}, 'https://raw.githubusercontent.com/a/b/README.md')
    wc.emit('did-navigate', {}, 'https://example.com/notes.txt')
    expect(inserted).to.deep.equal([RAW_TEXT_CSS, RAW_TEXT_CSS])
    expect(RAW_TEXT_CSS).to.match(/^html:has\(> body > pre:first-child\[style\*="pre-wrap"\]\) \{ background: #000; color: #fff; \}$/)
    expect(readFileSync(MAIN, 'utf8')).to.match(/if \(wc\.getType\(\) === 'webview'\) \{\s+followHistoryRedirect\(wc\)\s+darkenRawTextPages\(wc\)/)
  })

  it('never let a page that went away take the browser down', async function () {
    const wc = new EventEmitter()
    wc.insertCSS = () => Promise.reject(new Error('Render frame was disposed'))
    darkenRawTextPages(wc)
    wc.emit('did-navigate', {}, 'https://example.com/gone.txt')
    await new Promise((resolve) => setImmediate(resolve))
  })
})

// An RFC served as HTML, with no stylesheet and its text in a <pre>, turned
// white on black in a coloured code font: the styling for raw text reached any
// page that looked like it. It goes by the document's type now.
describe('a page made in HTML', function () {
  const source = readFileSync(PRELOAD, 'utf8').replace(/\r\n/g, '\n')
  const start = source.indexOf('async function injectPageStyles () {')
  const injectSource = source.slice(start, source.indexOf('\n}\n', start) + 2)

  async function load (contentType, { pathname = '/rfc2616.html', hasPre = true } = {}) {
    const appended = []
    const rules = []
    const sheets = []
    const document = {
      contentType,
      get styleSheets () { return sheets },
      head: { appendChild: (el) => { appended.push(el); sheets.push({ cssRules: [], insertRule: (rule) => rules.push(rule) }) } },
      body: { classList: { add () {}, remove () {} } },
      documentElement: { setAttribute () {} },
      createElement: () => ({}),
      querySelector: (selector) => selector === 'rss, feed, body > pre' && hasPre ? {} : null
    }
    const sandbox = {
      document,
      window: { location: { protocol: 'https:', pathname } },
      ipcRenderer: { invoke: async (channel, name) => `/* ${name} */`, on () {} },
      isInternal: false,
      isSettings: false,
      console: { log () {}, error () {}, warn () {} },
      setTimeout
    }
    await vm.runInNewContext(`${injectSource}; injectPageStyles()`, sandbox)
    return { appended, rules }
  }

  it('is left as its author styled it, as in Chrome', async function () {
    for (const type of ['text/html', 'application/xhtml+xml']) {
      const { appended, rules } = await load(type)
      expect(appended, type).to.deep.equal([])
      expect(rules, type).to.deep.equal([])
    }
  })

  it('even when its address ends in .xml', async function () {
    const { rules } = await load('text/html', { pathname: '/feed.xml', hasPre: false })
    expect(rules).to.deep.equal([])
  })

  it('while a text file, raw code or a feed still gets the dark page', async function () {
    for (const type of ['text/plain', 'application/json', 'text/xml']) {
      const { appended, rules } = await load(type)
      expect(appended, type).to.have.length(1)
      expect(appended[0].textContent, type).to.equal('/* vars */\n/* base */')
      expect(rules, type).to.deep.equal(['body { background: #000; color: #fff }'])
    }
  })
})
