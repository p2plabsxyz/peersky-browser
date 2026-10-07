import { expect } from 'chai'
import vm from 'node:vm'
import {
  historyLookupScript,
  historySitePrefix,
  lookupHistory,
  rankHistorySuggestions
} from '../src/history-suggestions.js'

// Typing "youtube" offered the last video watched there, not youtube.com.
describe('Address bar history suggestions', function () {
  const page = (url, title, timestamp) => ({ url, title, host: new URL(url).host, timestamp })

  it('reads what was typed as the start of a site name', function () {
    for (const typed of ['you', 'YouTube', 'www.you', 'https://www.you', 'you/']) {
      expect(historySitePrefix(typed), typed).to.equal(typed.toLowerCase().replace(/^https:\/\//, '').replace(/^www\./, '').replace(/\/$/, ''))
    }
    expect(historySitePrefix('youtube.com/watch')).to.equal(null)
    expect(historySitePrefix('two words')).to.equal(null)
    expect(historySitePrefix('  ')).to.equal(null)
  })

  it('puts the site first, as its home page, then its pages, then other matches', function () {
    const pages = [
      page('https://www.youtube.com/watch?v=b', 'Second video', 9),
      page('https://duckduckgo.com/?q=youtube+music', 'youtube music at DuckDuckGo', 8),
      page('https://www.youtube.com/watch?v=a', 'First video', 7),
      page('https://www.youtube.com/', 'YouTube', 6)
    ]
    const sites = [{ host: 'www.youtube.com', protocol: 'https:', visits: 40, latest: 9, title: 'YouTube' }]
    expect(rankHistorySuggestions('youtube', pages, sites).map((item) => item.url)).to.deep.equal([
      'https://www.youtube.com/',
      'https://www.youtube.com/watch?v=b',
      'https://www.youtube.com/watch?v=a',
      'https://duckduckgo.com/?q=youtube+music'
    ])
    expect(rankHistorySuggestions('youtube', pages, sites)[0]).to.deep.equal({
      url: 'https://www.youtube.com/', title: 'YouTube', host: 'www.youtube.com', timestamp: 9
    })
    // A path is past the site's name, so the pages stay as they came.
    expect(rankHistorySuggestions('youtube.com/watch', pages, sites)[0].url).to.equal('https://www.youtube.com/watch?v=b')

    // YouTube from a phone's address, and a site whose name only looks like one.
    const other = [
      { host: 'm.youtube.com', protocol: 'https:', visits: 3, latest: 5, title: '' },
      { host: 'mobile.de', protocol: 'https:', visits: 1, latest: 4, title: '' }
    ]
    expect(rankHistorySuggestions('youtube', [], other).map((item) => [item.url, item.title])).to.deep.equal([['https://m.youtube.com/', 'youtube.com']])
    expect(rankHistorySuggestions('mob', [], other).map((item) => item.url)).to.deep.equal(['https://mobile.de/'])

    // Opened last on a phone's address, but mostly at www: www is offered,
    // and its home page is not listed again further down.
    const both = [...sites, { host: 'm.youtube.com', protocol: 'https:', visits: 2, latest: 10, title: '' }]
    const found = rankHistorySuggestions('youtube', [page('https://m.youtube.com/', 'YouTube', 10), ...pages], both)
    expect(found.map((item) => item.url)).to.deep.equal([
      'https://www.youtube.com/',
      'https://www.youtube.com/watch?v=b',
      'https://www.youtube.com/watch?v=a',
      'https://duckduckgo.com/?q=youtube+music'
    ])
    expect(found[0].timestamp).to.equal(10)
  })

  it('puts the most visited site first, joins www with the bare name, and stops at eight', function () {
    const sites = [
      { host: 'google.com', protocol: 'https:', visits: 12, latest: 50, title: '' },
      { host: 'github.com', protocol: 'https:', visits: 9, latest: 40, title: 'GitHub' },
      { host: 'www.github.com', protocol: 'http:', visits: 9, latest: 30, title: '' },
      { host: 'gardens.example', protocol: 'hyper:', visits: 2, latest: 60, title: 'Gardens' },
      { host: 'gist.example', protocol: 'ftp:', visits: 99, latest: 70, title: '' }
    ]
    const pages = Array.from({ length: 12 }, (_, index) => page(`https://news.example/g-${index}`, `g ${index}`, index))
    const found = rankHistorySuggestions('g', pages, sites)
    expect(found.slice(0, 3).map((item) => [item.url, item.title])).to.deep.equal([
      ['https://github.com/', 'GitHub'],
      ['https://google.com/', 'google.com'],
      ['hyper://gardens.example/', 'Gardens']
    ])
    expect(found).to.have.length(8)
  })

  describe('in the History extension', function () {
    const entries = [
      { url: 'https://www.youtube.com/', title: 'YouTube', host: 'www.youtube.com', protocol: 'https:', timestamp: 1 },
      { url: 'https://www.youtube.com/watch?v=a', title: 'First video', host: 'www.youtube.com', protocol: 'https:', timestamp: 2 },
      { url: 'https://youtube.com/watch?v=b', title: 'Second video', host: 'youtube.com', protocol: 'https:', timestamp: 3 },
      { url: 'https://www.youtube.com/watch?v=a', title: 'First video', host: 'www.youtube.com', protocol: 'https:', timestamp: 4 },
      { url: 'https://yoga.example/', title: 'Yoga', host: 'yoga.example', protocol: 'https:', timestamp: 5 },
      { url: 'https://duckduckgo.com/?q=you', title: 'you at DuckDuckGo', host: 'duckduckgo.com', protocol: 'https:', timestamp: 6 }
    ].map((entry, index) => ({ ...entry, id: index + 1, search: `${entry.url} ${entry.title}` }))

    it('counts the visits to each matching site and finds its home page title', async function () {
      const scope = fakeExtension(entries)
      const result = await lookupHistory({ query: 'you', pattern: 'you', prefix: 'you', pageLimit: 24, siteLimit: 30 }, scope)
      // Newest first, and video a was watched again last.
      expect(result.pages.map((item) => item.url)).to.deep.equal([
        'https://duckduckgo.com/?q=you',
        'https://www.youtube.com/watch?v=a',
        'https://youtube.com/watch?v=b',
        'https://www.youtube.com/'
      ])
      expect(result.sites).to.deep.equal([
        { host: 'youtube.com', protocol: 'https:', visits: 1, latest: 3, title: '' },
        { host: 'www.youtube.com', protocol: 'https:', visits: 3, latest: 4, title: 'YouTube' }
      ])
      expect(rankHistorySuggestions('you', result.pages, result.sites).map((item) => item.url)).to.deep.equal([
        'https://www.youtube.com/',
        'https://www.youtube.com/watch?v=a',
        'https://youtube.com/watch?v=b',
        'https://duckduckgo.com/?q=you'
      ])
    })

    it('runs as text, with nothing from this file, and escapes the pattern', async function () {
      const scope = fakeExtension(entries)
      const asked = []
      const search = scope.search
      Object.assign(globalThis, {
        db: scope.db,
        IDBKeyRange: scope.IDBKeyRange,
        search: (pattern, limit) => { asked.push(pattern); return search(pattern, limit) }
      })
      try {
        const result = await vm.runInThisContext(historyLookupScript('c++ (you'))
        expect(result.error).to.equal(undefined)
        expect(asked).to.deep.equal(['c\\+\\+ \\(you'])
        const sites = await vm.runInThisContext(historyLookupScript('yo'))
        expect(sites.sites.map((site) => site.host)).to.deep.equal(['yoga.example', 'youtube.com', 'www.youtube.com'])
      } finally {
        delete globalThis.db
        delete globalThis.IDBKeyRange
        delete globalThis.search
      }
    })
  })
})

// Just enough of the extension's page: its search, and its database as the
// idb library wraps it, over plain arrays.
function fakeExtension (entries) {
  const IDBKeyRange = {
    only: (value) => ({ includes: (key) => key === value }),
    bound: (lower, upper) => ({ includes: (key) => key >= lower && key <= upper })
  }
  const cursorOver = (rows, at = 0) => (at < rows.length
    ? { key: rows[at].key, value: rows[at].value, continue: async () => cursorOver(rows, at + 1) }
    : null)
  const index = (field) => {
    const rows = (range, direction = 'next') => {
      const sorted = entries
        .filter((entry) => !range || range.includes(entry[field]))
        .map((entry) => ({ key: entry[field], value: entry }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.value.id - b.value.id))
      return direction === 'prev' ? sorted.reverse() : sorted
    }
    return {
      openCursor: async (range, direction) => cursorOver(rows(range, direction)),
      openKeyCursor: async (range, direction) => {
        const all = rows(range, direction)
        return cursorOver(direction === 'nextunique' ? all.filter((row, at) => at === 0 || all[at - 1].key !== row.key) : all)
      },
      count: async (range) => rows(range).length
    }
  }
  const db = { transaction: () => ({ objectStore: () => ({ index }) }) }
  async function * search (pattern, limit) {
    const filter = new RegExp(pattern.split(' ').reduce((result, word) => `${result}.*${word}`, ''), 'iu')
    const seen = new Set()
    for (const entry of [...entries].sort((a, b) => b.timestamp - a.timestamp)) {
      if (!filter.test(entry.search) || seen.has(entry.url)) continue
      seen.add(entry.url)
      yield entry
      if (seen.size >= limit) break
    }
  }
  return { db, search, IDBKeyRange }
}
