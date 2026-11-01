// A page with no scripts of its own, like a raw code or text file, can be
// parsed before the preload runs. The page styling waited for DOMContentLoaded,
// which had gone by then, so raw code sat on a white page in the dark theme.

import { expect } from 'chai'
import { EventEmitter } from 'events'
import { readFileSync } from 'fs'
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
