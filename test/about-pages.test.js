/**
 * peersky://about is the only index of the browser's own pages, so it goes stale
 * the moment someone adds a page and forgets it. It had drifted to six entries
 * while nine more were reachable, including peersky://plan1, which nothing in
 * the tree links to at all.
 *
 * The peersky: handler serves any <name>.html or <name>/index.html under
 * src/pages, plus a few special routes, so that directory listing is the source
 * of truth for what has to appear on the page.
 */

import { expect } from 'chai'
import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import path from 'path'

const PAGES = path.resolve('src/pages')
const about = readFileSync(path.join(PAGES, 'about.html'), 'utf8')

// Routes the handler answers without a file of their own.
const SPECIAL_ROUTES = ['history']

/**
 * Pages that must stay off the list, with the reason each one is unusable as a
 * destination. Anything else new has to be added to about.html.
 */
const NOT_A_DESTINATION = {
  index: 'the browser shell itself, so it would nest the whole UI inside a tab',
  error: 'reads its title and message from the query string, so it is stuck on "Loading Error Details..." when opened bare'
}

const CHECK_PATHS = [p => p, p => p + '/index.html', p => p + '.html']

function servablePages () {
  const names = [...SPECIAL_ROUTES]
  for (const entry of readdirSync(PAGES, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.html')) {
      names.push(entry.name.replace(/\.html$/, ''))
    } else if (entry.isDirectory() && existsSync(path.join(PAGES, entry.name, 'index.html'))) {
      names.push(entry.name)
    }
  }
  return names.sort()
}

function listedPages () {
  return [...about.matchAll(/href="peersky:\/\/([^"/]+)"/g)].map(m => m[1])
}

describe('peersky://about lists the browser pages', function () {
  it('links every page the protocol serves', function () {
    const listed = new Set(listedPages())
    const missing = servablePages().filter(
      name => !listed.has(name) && !(name in NOT_A_DESTINATION)
    )
    expect(missing, `add these to src/pages/about.html: ${missing.join(', ')}`).to.deep.equal([])
  })

  it('leaves out the pages that are not destinations', function () {
    const listed = new Set(listedPages())
    for (const [name, why] of Object.entries(NOT_A_DESTINATION)) {
      expect(listed.has(name), `peersky://${name} is ${why}`).to.equal(false)
    }
  })

  it('only links pages that actually resolve', function () {
    for (const name of listedPages()) {
      if (SPECIAL_ROUTES.includes(name)) continue
      const resolved = CHECK_PATHS
        .map(c => path.join(PAGES, c(name)))
        .find(p => existsSync(p) && statSync(p).isFile())
      expect(resolved, `peersky://${name} resolves to no file under src/pages`).to.be.a('string')
    }
  })

  it('keeps the list alphabetical so it stays scannable', function () {
    const listed = listedPages()
    expect(listed).to.deep.equal([...listed].sort())
  })

  it('points at the peerchat status check', function () {
    expect(about).to.contain('hyper://chat/?action=net-status')
  })
})
