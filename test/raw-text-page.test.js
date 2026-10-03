// A page with no scripts of its own, like a raw code or text file, can be
// parsed before the preload runs. The page styling waited for DOMContentLoaded,
// which had gone by then, so raw code sat on a white page in the dark theme.

import { expect } from 'chai'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const PRELOAD = path.join(ROOT, 'src', 'pages', 'unified-preload.js')

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
})
