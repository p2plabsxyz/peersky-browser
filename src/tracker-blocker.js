/**
 * Supplemental tracker blocker.
 *
 * Loads Ghostery's DNR rule files and provides a shouldBlock() check that
 * can be called from within the existing webRequest.onBeforeRequest handler
 * (in main.js) to block tracker requests when Ghostery's MV3 DNR path cannot
 * run in Electron.
 *
 * This MUST NOT register a separate webRequest handler — doing so would
 * override the existing extension bridge handler's results. Instead, the
 * caller integrates shouldBlock() into the existing handler flow.
 *
 * Element hiding is out of scope here, and currently does not happen at all:
 * Ghostery's service worker crashes a few hundred milliseconds into startup
 * under Electron, before its cosmetic engine loads, so empty ad slots are left
 * behind in the DOM even when the requests behind them are blocked. The upstream
 * fix is not in any Electron release yet.
 * Tracking: https://github.com/electron/electron/issues/52310
 *
 * TODO(peersky): Remove this file and its wiring (https://github.com/p2plabsxyz/peersky-browser/pull/206/)
 * This workaround is required because Electron does not
 * support chrome.declarativeNetRequest — the API Ghostery MV3 uses for
 * rule-based blocking. This is NOT specific to Electron 41; the API is
 * absent in all Electron versions as of v45 nightly (July 2026).
 * Re-evaluate when Electron adds declarativeNetRequest support.
 * Tracking: https://github.com/electron/electron/issues/52265
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createLogger } from './logger.js'

const log = createLogger('tracker-blocker')

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PREINSTALLED_DIR = path.join(__dirname, 'extensions', 'preinstalled-extensions')
const GHOSTERY_DEV_DIST = path.join(PREINSTALLED_DIR, 'ghostery-dist')

const RULE_FILES = [
  'rule_resources/dnr-tracking.json',
  'rule_resources/dnr-ads.json',
  'rule_resources/dnr-annoyances.json'
]

// Known bare TLD entries that appear in Ghostery's requestDomains but are
// not specific tracker domains (e.g. "com", "net" used in redirect rules).
const BARE_TLDS = new Set(['com', 'net', 'org', 'info', 'io', 'co', 'uk', 'de', 'fr', 'eu'])

// Well-known tracker / analytics domains that Ghostery's static DNR rules
// do NOT cover (no requestDomains or urlFilter match) but that Ghostery's
// adblocker engine normally handles at runtime via the service worker.
const MISSING_DOMAINS = new Set([
  'google-analytics.com',
  'googletagmanager.com',
  'facebook.net',
  'fbcdn.net',
  'sentry-cdn.com',
  'sentry.io',
  'nr-data.net',
  'newrelic.com',
  'raygun.io',
  'mouseflow.com',
  'fullstory.com',
  'clicktale.net',
  'crazyegg.com',
  'luckyorange.com',
  'sessioncam.com',
  'inspectlet.com',
  'hotjar.io',
  'smartlook.com',
  'logrocket.com',
  'uxcam.com',
  'heap.com',
  'scorecardresearch.com',
  'comscore.com',
  'bluekai.com',
  'exelator.com',
  'demdex.net',
  'adsrvr.org',
  'adnxs.com',
  'rubiconproject.com',
  'openx.net',
  'pubmatic.com',
  'casalemedia.com',
  'contextweb.com',
  'bidswitch.net',
  'sojern.com',
  'tapad.com',
  'sharethis.com',
  'addthis.com',
  'addthisedge.com'
])

// First-party hosts we refuse to wholesale-block when a Ghostery urlFilter
// names the whole domain (e.g. ||duckduckgo.com/ads^ must not ban duckduckgo.com).
// Path-scoped filters for these hosts are still allowed.
// Intentionally excludes large surveillance platforms.
export const NEVER_BLOCK_HOSTS = new Set([
  'duckduckgo.com',
  'search.brave.com',
  'ecosia.org',
  'startpage.com',
  'swisscows.com',
  'searx.be',
  'en.wikipedia.org',
  'github.com',
  'stackoverflow.com',
  'npmjs.com',
  'docs.npmjs.com',
  'nodejs.org',
  'developer.mozilla.org'
])

function resolveRulesRoot (rulesRoot) {
  if (rulesRoot && fs.existsSync(path.join(rulesRoot, 'manifest.json'))) {
    return rulesRoot
  }
  if (fs.existsSync(path.join(GHOSTERY_DEV_DIST, 'manifest.json'))) {
    return GHOSTERY_DEV_DIST
  }
  return rulesRoot || GHOSTERY_DEV_DIST
}

/**
 * Parse a conservative path-scoped DNR urlFilter: ||host/path (no wildcards).
 * Pure domain filters (||host^) return null — those go through #blockedHosts.
 * @returns {{ host: string, pathPrefix: string } | null}
 */
export function parsePathUrlFilter (urlFilter) {
  if (!urlFilter || typeof urlFilter !== 'string') return null
  const uf = urlFilter.toLowerCase()
  if (!uf.startsWith('||') || uf.includes('*')) return null

  const body = uf.slice(2).replace(/\^+$/, '')
  const slash = body.indexOf('/')
  if (slash <= 0) return null

  const host = body.slice(0, slash)
  const pathPrefix = body.slice(slash)
  if (!host.includes('.') || host.startsWith('.') || BARE_TLDS.has(host)) return null
  if (!pathPrefix.startsWith('/')) return null
  return { host, pathPrefix }
}

/** Path prefix match with a boundary so /ads does not match /adsfoobar. */
export function pathPrefixMatches (pathname, pathPrefix) {
  if (!pathname || !pathPrefix) return false
  if (pathname === pathPrefix) return true
  if (!pathname.startsWith(pathPrefix)) return false
  if (pathPrefix.endsWith('/')) return true
  const next = pathname[pathPrefix.length]
  return next === undefined || next === '/'
}

export class TrackerBlocker {
  #blockedHosts = new Set()
  /** @type {Map<string, Set<string>>} filterHost -> path prefixes */
  #pathFiltersByHost = new Map()
  #initialized = false
  #initPromise = null

  /**
   * Load Ghostery DNR rules and build the hostname + path-filter blocklists.
   * @param {string|null|undefined} rulesRoot - Installed Ghostery extension path
   * @returns {Promise<TrackerBlocker>}
   */
  init (rulesRoot) {
    if (this.#initialized) return Promise.resolve(this)
    if (this.#initPromise) return this.#initPromise
    this.#initPromise = this.#doInit(rulesRoot)
    return this.#initPromise
  }

  async #doInit (rulesRoot) {
    const root = resolveRulesRoot(rulesRoot)
    const start = Date.now()
    let totalRules = 0
    let pathFilterCount = 0

    for (const relPath of RULE_FILES) {
      const absPath = path.join(root, relPath)
      try {
        const raw = await fs.promises.readFile(absPath, 'utf8')
        const rules = JSON.parse(raw)
        totalRules += rules.length

        for (const rule of rules) {
          if (rule.action?.type !== 'block') continue

          const c = rule.condition || {}

          // Extract from requestDomains (most precise tracker identifiers)
          if (Array.isArray(c.requestDomains)) {
            for (const d of c.requestDomains) {
              const dl = d.toLowerCase()
              // Skip bare TLD entries like "com", "net", "org"
              if (dl.includes('.') && !BARE_TLDS.has(dl) && !dl.startsWith('xn--')) {
                this.#blockedHosts.add(dl)
              }
            }
          }

          if (c.urlFilter) {
            const uf = c.urlFilter.toLowerCase()
            if (uf.startsWith('||') && !uf.includes('*')) {
              const afterHost = uf.slice(2)
              const endCh = afterHost.slice(-1)
              // Pure domain pattern: ||google-analytics.com^
              if (endCh === '^' && !afterHost.slice(0, -1).includes('/')) {
                const dom = afterHost.replace(/[\^]+$/, '')
                if (dom.includes('.') && !dom.startsWith('.') && !BARE_TLDS.has(dom) && !NEVER_BLOCK_HOSTS.has(dom)) {
                  this.#blockedHosts.add(dom)
                }
              } else {
                // Path-scoped: ||host/path (no *) — do not wholesale-block the host
                const parsed = parsePathUrlFilter(uf)
                if (parsed) {
                  let prefixes = this.#pathFiltersByHost.get(parsed.host)
                  if (!prefixes) {
                    prefixes = new Set()
                    this.#pathFiltersByHost.set(parsed.host, prefixes)
                  }
                  if (!prefixes.has(parsed.pathPrefix)) {
                    prefixes.add(parsed.pathPrefix)
                    pathFilterCount++
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        log.warn(`Failed to load ${relPath}:`, err.message)
      }
    }

    // Add missing domains
    for (const d of MISSING_DOMAINS) {
      this.#blockedHosts.add(d.toLowerCase())
    }

    log.info(
      `Loaded ${totalRules} rules, ${this.#blockedHosts.size} hosts, ${pathFilterCount} path filters in ${Date.now() - start}ms`
    )

    this.#initialized = true
    return this
  }

  #isHostBlocked (host) {
    if (this.#blockedHosts.has(host)) return true

    let rest = host
    while (rest.includes('.')) {
      const dotIndex = rest.indexOf('.')
      rest = rest.slice(dotIndex + 1)
      if (rest.includes('.') && !NEVER_BLOCK_HOSTS.has(rest) && this.#blockedHosts.has(rest)) {
        return true
      }
    }
    return false
  }

  #isNeverBlockHost (host) {
    if (NEVER_BLOCK_HOSTS.has(host)) return true
    let rest = host
    while (rest.includes('.')) {
      rest = rest.slice(rest.indexOf('.') + 1)
      if (NEVER_BLOCK_HOSTS.has(rest)) return true
    }
    return false
  }

  #pathFilterMatches (host, pathname) {
    let candidate = host
    while (true) {
      const prefixes = this.#pathFiltersByHost.get(candidate)
      if (prefixes) {
        for (const prefix of prefixes) {
          if (pathPrefixMatches(pathname, prefix)) return true
        }
      }
      const dot = candidate.indexOf('.')
      if (dot === -1) break
      const parent = candidate.slice(dot + 1)
      // Stop before bare TLDs
      if (!parent.includes('.')) break
      candidate = parent
    }
    return false
  }

  /**
   * Check whether a URL should be blocked.
   * Matches hostname blocklist or path-scoped urlFilters.
   */
  shouldBlock (url) {
    if (!this.#initialized) return false
    if (!url || typeof url !== 'string') return false

    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return false
    }

    const host = parsed.hostname.toLowerCase()
    if (!host) return false

    const pathname = parsed.pathname || '/'

    // Path-scoped filters apply even on never-block hosts (e.g. /ads paths).
    if (this.#pathFilterMatches(host, pathname)) return true

    // Wholesale host blocks — skip never-block first-party hosts.
    if (this.#isNeverBlockHost(host)) return false
    return this.#isHostBlocked(host)
  }
}

/** Singleton instance. */
export const trackerBlocker = new TrackerBlocker()
