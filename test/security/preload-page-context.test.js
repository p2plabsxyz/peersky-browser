// The preload used to match substrings of the href, so ?x=peersky://tabs was
// handed getTabs(). A sandboxed preload cannot require a local module, so this
// evaluates the shipped rules in place rather than restating them.

import { expect } from 'chai'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const PRELOAD = path.join(ROOT, 'src', 'pages', 'unified-preload.js')

const RULES_START = 'function parseLocation'
const RULES_END = 'const isBitTorrent'

const FLAGS = [
  'isSettings', 'isExtensions', 'isHome', 'isOnboarding', 'isBookmarks',
  'isDownloads', 'isBackup', 'isTabsPage', 'isP2PPage', 'isUserP2PApp',
  'isInternal', 'isExternal', 'isP2P', 'isBitTorrent'
]

function classify (href) {
  const source = readFileSync(PRELOAD, 'utf8')
  const start = source.indexOf(RULES_START)
  const end = source.indexOf(RULES_END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Could not locate the page context rules in unified-preload.js')
  }
  const rules = source.slice(start, source.indexOf('\n', end) + 1)
  const body = `const url = href;\n${rules}\nreturn { ${FLAGS.join(', ')} }`
  return new Function('href', body)(href) // eslint-disable-line no-new-func
}

describe('preload page context', function () {
  describe('a page cannot claim a context by naming it in its own URL', function () {
    const markers = [
      'peersky://tabs',
      'peersky://downloads',
      'peersky://bookmarks',
      'peersky://settings',
      'peersky://home',
      'agregore.mauve.moe'
    ]

    for (const marker of markers) {
      it(`treats https://evil.example/?x=${marker} as external`, function () {
        const context = classify(`https://evil.example/?x=${encodeURIComponent(marker)}`)
        expect(context.isExternal, `${marker} in a query string was treated as internal`).to.equal(true)
        expect(context.isInternal).to.equal(false)
      })

      it(`treats https://evil.example/#${marker} as external`, function () {
        const context = classify(`https://evil.example/#${marker}`)
        expect(context.isExternal, `${marker} in a fragment was treated as internal`).to.equal(true)
      })
    }

    it('is not fooled by a lookalike host', function () {
      const context = classify('https://agregore.mauve.moe.evil.example/')
      expect(context.isInternal, 'a suffixed hostname was trusted').to.equal(false)
    })

    it('grants no page-specific API to an external page', function () {
      const context = classify('https://evil.example/?x=peersky://tabs&y=peersky://downloads')
      for (const flag of ['isTabsPage', 'isDownloads', 'isBookmarks', 'isSettings', 'isHome']) {
        expect(context[flag], `${flag} was granted to an external page`).to.equal(false)
      }
    })
  })

  describe('real internal pages keep their context', function () {
    const cases = [
      ['peersky://settings', 'isSettings'],
      ['peersky://extensions', 'isExtensions'],
      ['peersky://home', 'isHome'],
      ['peersky://onboarding', 'isOnboarding'],
      ['peersky://bookmarks', 'isBookmarks'],
      ['peersky://downloads', 'isDownloads'],
      ['peersky://backup', 'isBackup'],
      ['peersky://tabs', 'isTabsPage'],
      ['peersky://p2p/p2pmd/?protocol=hyper', 'isP2PPage']
    ]

    for (const [href, flag] of cases) {
      it(`${href} is ${flag}`, function () {
        const context = classify(href)
        expect(context[flag], `${href} lost its context`).to.equal(true)
        expect(context.isInternal).to.equal(true)
      })
    }

    it('trusts the agregore host itself', function () {
      expect(classify('https://agregore.mauve.moe/some/page').isInternal).to.equal(true)
    })

    it('keeps a user p2p app out of internal treatment', function () {
      const context = classify('peersky://myapps/my-site/index.html')
      expect(context.isUserP2PApp).to.equal(true)
      expect(context.isInternal, 'a user app was given internal privileges').to.equal(false)
    })

    it('classifies p2p and bittorrent schemes', function () {
      expect(classify('hyper://abc/').isP2P).to.equal(true)
      expect(classify('ipns://abc/').isP2P).to.equal(true)
      expect(classify('magnet:?xt=urn:btih:abc').isBitTorrent).to.equal(true)
      expect(classify('https://evil.example/?x=hyper://abc').isP2P).to.equal(false)
    })
  })

  it('treats an unparseable URL as external', function () {
    const context = classify('not a url at all')
    expect(context.isExternal).to.equal(true)
    expect(context.isInternal).to.equal(false)
  })
})
