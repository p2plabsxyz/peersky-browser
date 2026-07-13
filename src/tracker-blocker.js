/**
 * Supplemental tracker blocker.
 *
 * Loads Ghostery's DNR rule files and provides a shouldBlock() check that
 * can be called from within the existing webRequest.onBeforeRequest handler
 * (in main.js) to block tracker requests that Ghostery's DNR rules don't
 * cover (because the MV3 service worker cannot start in Electron 41).
 *
 * This MUST NOT register a separate webRequest handler — doing so would
 * override the existing extension bridge handler's results. Instead, the
 * caller integrates shouldBlock() into the existing handler flow.
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
  'rule_resources/dnr-annoyances.json',
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
  'addthisedge.com',
])

// Safety whitelist: never block navigation to these well-known domains.
// This prevents accidentally blocking major sites due to overly broad
// urlFilter extraction from Ghostery's DNR rules (e.g., a rule like
// ||duckduckgo.com/ads^ should only block the ad path, not the entire domain).
const SAFE_DOMAINS = new Set([
  'duckduckgo.com',
  'google.com',
  'bing.com',
  'search.yahoo.com',
  'search.brave.com',
  'ecosia.org',
  'yandex.com',
  'startpage.com',
  'swisscows.com',
  'searx.be',
  'en.wikipedia.org',
  'github.com',
  'stackoverflow.com',
  'reddit.com',
  'youtube.com',
  'npmjs.com',
  'docs.npmjs.com',
  'nodejs.org',
  'developer.mozilla.org',
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

export class TrackerBlocker {
  #blockedHosts = new Set()
  #initialized = false

  /**
   * Load Ghostery DNR rules and build the hostname blocklist.
   * @param {string|null|undefined} rulesRoot - Installed Ghostery extension path
   * @returns {Promise<TrackerBlocker>}
   */
  async init (rulesRoot) {
    if (this.#initialized) return this

    const root = resolveRulesRoot(rulesRoot)
    const start = Date.now()
    let totalRules = 0

    for (const relPath of RULE_FILES) {
      const absPath = path.join(root, relPath)
      try {
        const raw = fs.readFileSync(absPath, 'utf8')
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

          // Extract hostnames from urlFilter (||domain.com^ pattern).
          // IMPORTANT: Only add the domain if the urlFilter is a pure
          // domain-level pattern (no path component). A pattern like
          // ||duckduckgo.com/ads^ should NOT block all duckduckgo.com
          // traffic—it only targets the ad path. We only extract patterns
          // where the full urlFilter matches a domain-level request.
          if (c.urlFilter) {
            let uf = c.urlFilter.toLowerCase()
            if (uf.startsWith('||') && !uf.includes('*')) {
              // Check if this is a pure domain pattern (no path after domain)
              const afterHost = uf.slice(2) // remove leading ||
              const endCh = afterHost.slice(-1)
              // Pure domain pattern: ends with ^ or is just the domain
              // e.g. ||google-analytics.com^  — no /path
              if (endCh === '^' && !afterHost.slice(0, -1).includes('/')) {
                const dom = afterHost.replace(/[\^]+$/, '')
                if (dom.includes('.') && !dom.startsWith('.') && !BARE_TLDS.has(dom) && !SAFE_DOMAINS.has(dom)) {
                  this.#blockedHosts.add(dom)
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
      `Loaded ${totalRules} rules, built blocklist with ${this.#blockedHosts.size} unique hosts in ${Date.now() - start}ms`,
    )

    this.#initialized = true
    return this
  }

  /**
   * Check whether a URL should be blocked.
   * Matches the hostname against the blocklist (exact or subdomain match).
   */
  shouldBlock (url) {
    if (!this.#initialized) return false
    if (!url || typeof url !== 'string') return false

    let host
    try {
      host = new URL(url).hostname.toLowerCase()
    } catch {
      return false
    }
    if (!host) return false

    // Exact match
    if (this.#blockedHosts.has(host)) return true

    // Safety check: never block safe domains (search engines, etc.)
    // or their subdomains.
    if (SAFE_DOMAINS.has(host)) return false

    // Subdomain check: walk up the domain hierarchy.
    // Only match parent domains that themselves contain a dot
    // (prevents accidentally matching bare TLDs like "com" or "net").
    // Also skip any parent domain that is a safe domain.
    let rest = host
    while (rest.includes('.')) {
      const dotIndex = rest.indexOf('.')
      rest = rest.slice(dotIndex + 1)
      if (rest.includes('.') && !SAFE_DOMAINS.has(rest) && this.#blockedHosts.has(rest)) return true
    }

    return false
  }
}

/** Singleton instance. */
export const trackerBlocker = new TrackerBlocker()
