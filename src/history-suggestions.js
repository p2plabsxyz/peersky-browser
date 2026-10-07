// Address bar suggestions from the PeerSky History extension.
//
// Typing "youtube" offered the last video watched there, a whole address,
// where other browsers offer youtube.com. A site whose name starts with what
// was typed now comes first, as its home page, the most visited site before
// the others. Pages on those sites follow, then anything else that matches,
// newest first. Shared in spirit with the phone (app/history/browser-history.mjs).

export const MAX_HISTORY_SUGGESTIONS = 8
// Pages to read before sorting, so pages on a matching site can go ahead of
// newer pages that only mention it.
const PAGE_LOOKUP = 24
const SITE_LOOKUP = 30

// What was typed, as the start of a site's name: "https://www.you" is "you".
// Anything with a path or a space in it is not a site name.
export function historySitePrefix (query) {
  const value = String(query || '').trim().toLowerCase()
    .replace(/^(?:https?|hyper):\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
  return value && !/[\s/?#]/.test(value) ? value : null
}

// www.youtube.com, m.youtube.com and youtube.com are one site. mobile.de
// keeps its name: what is left has to be a name too.
function siteName (host) {
  const name = String(host || '').toLowerCase()
  const rest = name.replace(/^(?:www|m|mobile)\./, '')
  return rest !== name && rest.includes('.') ? rest : name
}

function hostOf (url) {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export function rankHistorySuggestions (query, pages = [], sites = [], limit = MAX_HISTORY_SUGGESTIONS) {
  const prefix = historySitePrefix(query)
  const byName = new Map()

  for (const site of prefix ? sites : []) {
    const name = siteName(site?.host)
    if (!name || !name.startsWith(prefix) || !/^(?:https?|hyper):$/.test(site.protocol)) continue
    const variant = {
      url: `${site.protocol}//${site.host}/`,
      host: site.host,
      visits: Number(site.visits) || 0,
      latest: Number(site.latest) || 0,
      title: site.title || ''
    }
    if (byName.has(name)) byName.get(name).push(variant)
    else byName.set(name, [variant])
  }

  const homes = [...byName].map(([name, variants]) => {
    // One site under www, m or neither, over http or https: the address used
    // most is the one offered.
    const [home] = [...variants].sort((a, b) => b.visits - a.visits || b.latest - a.latest)
    const latest = Math.max(...variants.map((variant) => variant.latest))
    return {
      visits: variants.reduce((sum, variant) => sum + variant.visits, 0),
      latest,
      suggestion: {
        url: home.url,
        title: home.title || variants.find((variant) => variant.title)?.title || name,
        host: home.host,
        timestamp: latest
      }
    }
  })
    .sort((a, b) => b.visits - a.visits || b.latest - a.latest)
    .map((site) => site.suggestion)

  // A home page under any of its addresses is already offered as the site.
  const seen = new Set([...byName.values()].flat().map((variant) => variant.url))
  const sitePages = []
  const otherPages = []
  for (const page of pages) {
    if (!page?.url || seen.has(page.url)) continue
    seen.add(page.url)
    const onSite = byName.has(siteName(page.host || hostOf(page.url)))
    ;(onSite ? sitePages : otherPages).push(page)
  }

  return [...homes, ...sitePages, ...otherPages].slice(0, limit)
}

// The script run in the History extension's own page, where its database is.
// Kept as a function so it is real code, and sent as text.
export function historyLookupScript (query) {
  const options = {
    query,
    // The extension builds a pattern from the words typed, so a bracket or a
    // plus sign in them threw instead of matching.
    pattern: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    prefix: historySitePrefix(query),
    pageLimit: PAGE_LOOKUP,
    siteLimit: SITE_LOOKUP
  }
  return `(${lookupHistory.toString()})(${JSON.stringify(options)})`
}

// Runs inside the extension, so it uses nothing from this file.
export async function lookupHistory ({ query, pattern, prefix, pageLimit, siteLimit }, scope = globalThis) {
  const pick = (entry) => ({
    url: entry.url || '',
    title: entry.title || '',
    host: entry.host || '',
    timestamp: entry.timestamp || 0
  })

  try {
    const pages = []
    if (typeof scope.search === 'function') {
      for await (const entry of scope.search(pattern, pageLimit)) pages.push(pick(entry))
    } else if (scope.db) {
      // Every word typed has to appear, checked with includes rather than a pattern.
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10)
      const seen = new Set()
      const index = scope.db.transaction('navigated', 'readonly').objectStore('navigated').index('timestamp')
      let cursor = await index.openCursor(null, 'prev')
      while (cursor && pages.length < pageLimit) {
        const entry = cursor.value
        const text = (entry.search || `${entry.url} ${entry.title}`).toLowerCase()
        if (!seen.has(entry.url) && terms.every((term) => text.includes(term))) {
          seen.add(entry.url)
          pages.push(pick(entry))
        }
        cursor = await cursor.continue()
      }
    } else {
      return { error: 'search function and db not available' }
    }

    // Each visit is a row, so the rows for a host count its visits.
    const sites = []
    if (prefix && scope.db) {
      const Range = scope.IDBKeyRange
      const store = scope.db.transaction('navigated', 'readonly').objectStore('navigated')
      const hosts = store.index('host')
      const urls = store.index('url')
      const found = new Set()
      for (const start of [prefix, `www.${prefix}`, `m.${prefix}`, `mobile.${prefix}`]) {
        let cursor = await hosts.openKeyCursor(Range.bound(start, `${start}￿`), 'nextunique')
        while (cursor && found.size < siteLimit) {
          found.add(cursor.key)
          cursor = await cursor.continue()
        }
      }
      for (const host of found) {
        const visits = await hosts.count(Range.only(host))
        const last = await hosts.openCursor(Range.only(host), 'prev')
        if (!last) continue
        const { protocol, timestamp } = last.value
        const home = await urls.openCursor(Range.only(`${protocol}//${host}/`), 'prev')
        sites.push({ host, protocol, visits, latest: timestamp || 0, title: home?.value?.title || '' })
      }
    }

    return { pages, sites }
  } catch (error) {
    console.error('[peersky-history] Search error:', error)
    return { error: error.message || 'Search failed' }
  }
}
