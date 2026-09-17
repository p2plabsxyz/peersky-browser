// "abcd: asd" parsed as the scheme "abcd", so it navigated nowhere instead of
// searching.

import { expect } from 'chai'
import { isURL, looksLikeDomain, isLoopbackAddress, NAVIGABLE_SCHEMES } from '../src/utils.js'
import { readFile } from 'fs/promises'

const navBox = await readFile(new URL('../src/pages/nav-box.js', import.meta.url), 'utf8')

describe('telling a typed URL from a search', function () {
  describe('text that merely contains a colon', function () {
    it('is a search, not a scheme', function () {
      expect(isURL('abcd: asd')).to.equal(false)
      expect(isURL('note: buy milk')).to.equal(false)
      expect(isURL('what is foo: bar')).to.equal(false)
    })

    it('still is when the colon is spaced out, as it always was', function () {
      expect(isURL('abcd : asd')).to.equal(false)
    })

    it('is a search however many colons it has', function () {
      expect(isURL('a: b: c')).to.equal(false)
    })
  })

  describe('real addresses keep working', function () {
    it('accepts the web schemes', function () {
      expect(isURL('https://example.com')).to.equal(true)
      expect(isURL('http://example.com/a?b=1#c')).to.equal(true)
    })

    it('accepts every scheme the browser serves', function () {
      for (const scheme of NAVIGABLE_SCHEMES) {
        expect(isURL(`${scheme}//host/path`), scheme).to.equal(true)
      }
    })

    // A space in a known scheme is encoded, so it is a typo not a phrase.
    it('keeps a known scheme navigable even with a space in the path', function () {
      expect(isURL('https://example.com/a b')).to.equal(true)
    })

    // The OS handles these, so they must not become searches.
    it('leaves app schemes alone so the OS still gets them', function () {
      expect(isURL('mailto:someone@example.com')).to.equal(true)
      expect(isURL('itms-apps://itunes.apple.com/app/id1')).to.equal(true)
      expect(isURL('abcd:asd')).to.equal(true)
    })
  })

  describe('the rest of the address bar is unchanged', function () {
    it('treats a bare domain as a domain', function () {
      expect(looksLikeDomain('example.com')).to.equal(true)
      expect(isURL('example.com')).to.equal(false)
    })

    it('treats a phrase as a search', function () {
      expect(isURL('hello world')).to.equal(false)
      expect(looksLikeDomain('hello world')).to.equal(false)
    })

    // localhost:3000 also parses as a scheme, so it is matched before isURL.
    it('still recognises loopback authorities', function () {
      expect(isLoopbackAddress('localhost:3000')).to.equal(true)
      expect(isLoopbackAddress('127.0.0.1:8080')).to.equal(true)
      expect(isLoopbackAddress('[::1]:9229')).to.equal(true)
    })
  })

  // The set must cover everything main.js registers.
  describe('the navigable scheme set', function () {
    it('covers every scheme registered as privileged', async function () {
      const { readFile } = await import('fs/promises')
      const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8')
      const block = main.slice(main.indexOf('registerSchemesAsPrivileged'))
      const registered = [...block.slice(0, block.indexOf('])')).matchAll(/scheme:\s*'([^']+)'/g)].map((m) => m[1])
      expect(registered.length, 'found the privileged scheme list').to.be.greaterThan(5)
      for (const scheme of registered) {
        expect(NAVIGABLE_SCHEMES.has(`${scheme}:`), `${scheme}: is registered but not navigable`).to.equal(true)
      }
    })

    it('includes the web schemes Chromium serves', function () {
      for (const scheme of ['http:', 'https:', 'about:']) {
        expect(NAVIGABLE_SCHEMES.has(scheme), scheme).to.equal(true)
      }
    })
  })
})

// Pressing Enter closed the suggestions, then the history search that was still
// in flight came back and reopened them over the page that had just loaded.
describe('the address bar suggestions', function () {
  const search = navBox.slice(navBox.indexOf('_handleAutocompleteInput (value)'), navBox.indexOf('_handleAutocompleteKeydown (e)'))
  const dismiss = navBox.slice(navBox.indexOf('_dismissAutocomplete () {'))

  it('ignores a search that lands after the query moved on', function () {
    expect(search).to.contain('const epoch = this._autocompleteEpoch')
    expect(search).to.contain('if (epoch !== this._autocompleteEpoch) return')
  })

  it('checks that before it stores or shows anything', function () {
    expect(search.indexOf('if (epoch !== this._autocompleteEpoch) return')).to.be.below(search.indexOf('this._autocompleteResults = filteredResults'))
    expect(search.indexOf('if (epoch !== this._autocompleteEpoch) return')).to.be.below(search.indexOf('this._showAutocomplete()'))
  })

  it('moves the epoch on for new input and when navigating away', function () {
    expect(search).to.contain('this._autocompleteEpoch++')
    expect(dismiss).to.contain('this._autocompleteEpoch++')
  })
})
