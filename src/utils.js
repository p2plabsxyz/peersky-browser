import { BUILTIN_SEARCH_ENGINES } from './search-engine.js'
// P2P prefixes
const IPFS_PREFIX = 'ipfs://'
const IPNS_PREFIX = 'ipns://'
const HYPER_PREFIX = 'hyper://'
const WEB3_PREFIX = 'web3://'
const HS_PREFIX = 'hs://'
const BT_PREFIX = 'bt://'
const BITTORRENT_PREFIX = 'bittorrent://'
const MAGNET_PREFIX = 'magnet:'

// Schemes the browser serves. Others may still be handled by the OS.
const NAVIGABLE_SCHEMES = new Set([
  'http:', 'https:', 'about:', 'file:', 'blob:', 'data:',
  'peersky:', 'browser:', 'ipfs:', 'ipns:', 'pubsub:',
  'hyper:', 'hs:', 'web3:', 'bittorrent:', 'bt:', 'magnet:', 'webtorrent:'
])

// Connection labels for the site-info shield. Keep in sync with NAVIGABLE_SCHEMES.
const CONNECTION_BY_PROTOCOL = {
  'http:': { secure: false, label: 'Not secure' },
  'https:': { secure: true, label: 'Connection is secure' },
  'peersky:': { secure: true, label: 'PeerSky page' },
  'browser:': { secure: true, label: 'PeerSky page' },
  'about:': { secure: true, label: 'Browser page' },
  'ipfs:': { secure: true, label: 'IPFS' },
  'ipns:': { secure: true, label: 'IPFS' },
  'pubsub:': { secure: true, label: 'PubSub' },
  'hyper:': { secure: true, label: 'Hypercore' },
  'hs:': { secure: true, label: 'Holesail' },
  'bt:': { secure: true, label: 'BitTorrent' },
  'bittorrent:': { secure: true, label: 'BitTorrent' },
  'magnet:': { secure: true, label: 'BitTorrent' },
  'webtorrent:': { secure: true, label: 'BitTorrent' },
  'web3:': { secure: true, label: 'Web3' },
  'file:': { secure: true, label: 'Local file' },
  'blob:': { secure: true, label: 'Blob' },
  'data:': { secure: false, label: 'Data URL' }
}

function connectionFor (protocol) {
  return CONNECTION_BY_PROTOCOL[protocol] || {
    secure: false,
    label: 'Connection status unknown'
  }
}

// PeerSky's page for a load that failed (renderer.js) stands in for the
// address that failed, which the address bar shows over it. Only an address
// the browser loads, and only on an error page the browser made: any page can
// open peersky://error.html with an address of its own choosing, which would
// put a bank's address over the page's own text. The browser's error pages
// carry a key made at each start (main.js), which pages never see.
let errorPageKey = null

function setErrorPageKey (key) {
  errorPageKey = typeof key === 'string' && key.length >= 32 ? key : null
}

function errorPageKeyOf () {
  return errorPageKey
}

function failedAddressOf (url) {
  try {
    const page = new URL(url)
    if (page.protocol !== 'peersky:' || page.hostname !== 'error.html') return null
    if (!errorPageKey || page.searchParams.get('key') !== errorPageKey) return null
    const failed = page.searchParams.get('url')
    return failed && NAVIGABLE_SCHEMES.has(new URL(failed).protocol) ? failed : null
  } catch {
    return null
  }
}

// The connection the shield shows for a page. An error page is not secure,
// whatever its peersky: address says: a site whose certificate failed showed
// "Connection is secure".
const ERROR_PAGE_CONNECTION = { secure: false, label: 'Not secure' }

function connectionForPage (url) {
  try {
    const page = new URL(url)
    if (page.protocol === 'peersky:' && page.hostname === 'error.html') return ERROR_PAGE_CONNECTION
    return connectionFor(page.protocol)
  } catch {
    return connectionFor('')
  }
}

// A load that fails leaves Chromium's own empty error document in the tab, in
// the history entry of the address that failed. PeerSky's error page takes that
// entry over from inside it, as the page's own location.replace() would, so
// Back and Forward step over the failure as in Chrome, and the entries after it
// stay. Loaded as a new page instead, the error sat after the failed entry: Back
// tried the failed address again and added another error page each time. Only
// that error document is replaced, since the tab may have moved on by the time
// this runs.
const ERROR_DOCUMENT_URL = 'chrome-error://chromewebdata/'

function replaceErrorDocumentScript (target) {
  return `(() => {
    if (location.href !== ${JSON.stringify(ERROR_DOCUMENT_URL)}) return false
    location.replace(${JSON.stringify(String(target))})
    return true
  })()`
}

// Utility functions
function isURL (string) {
  try {
    const { protocol } = new URL(string)
    if (NAVIGABLE_SCHEMES.has(protocol)) return true
    // A "scheme" with a dot in it is a host with a port, as Chrome reads
    // example.com:8080, not an app's scheme.
    if (protocol.includes('.')) return false
    // An unfamiliar scheme with a space is a typed phrase, not an address.
    return !/\s/.test(string)
  } catch {
    return false
  }
}

// The public suffix list, through tldts, tells a site's name from a word with
// a dot in it. The window's pages have Node's require, where a bare import
// cannot be resolved; main and the tests reach it through createRequire.
let publicSuffixes

function loadPublicSuffixes () {
  if (publicSuffixes === undefined) {
    try {
      const load = typeof require === 'function'
        ? require
        : globalThis.process?.getBuiltinModule?.('module')?.createRequire(import.meta.url)
      publicSuffixes = load ? load('tldts') : null
    } catch {
      publicSuffixes = null
    }
  }
  return publicSuffixes
}

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const HOST_LABELS_RE = /^[\p{L}\p{N}\p{M}_-]+(?:\.[\p{L}\p{N}\p{M}_-]+)+$/u

// Whether text typed with no scheme names a site, as Chrome reads it: a host
// whose last label is a real top-level domain, an IP address, or any dotted
// host with a port or a slash at the end of its path. node.js or index.html
// is a search, where it went to https://node.js/ and an error page. A phrase
// with a space is a search too, and user@host reads as a mail address.
function looksLikeDomain (string) {
  if (typeof string !== 'string' || /\s/.test(string)) return false
  const [, authority, rest = ''] = /^([^/?#]*)(.*)$/s.exec(string)
  if (!authority || authority.includes('@')) return false
  const parts = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(authority)
  if (!parts) return false
  const host = parts[1].replace(/\.$/, '')
  const port = parts[2]
  if (port !== undefined && (port === '' || Number(port) > 65535)) return false
  if (host.startsWith('[')) {
    try {
      return new URL(`http://${host}/`).hostname === host.toLowerCase()
    } catch {
      return false
    }
  }
  if (!HOST_LABELS_RE.test(host)) return false
  // An address starting 0. is never one to visit, but 0.0.0.0 is this computer.
  if (IPV4_RE.test(host)) return !host.startsWith('0.') || host === '0.0.0.0'
  // 3.14 and 1.2.3 are numbers, not addresses.
  if (/^[\d.]+$/.test(host)) return false
  if (port !== undefined || /\/$/.test(rest.split(/[?#]/)[0])) return true
  const tldts = loadPublicSuffixes()
  // Without the list, any dotted host, as before.
  if (!tldts) return true
  const { domain, isIcann } = tldts.parse(host)
  return Boolean(domain && isIcann)
}

// new URL('localhost:3000') parses as the scheme "localhost", so isURL() claims
// it is already navigable and the browser is handed a scheme nothing serves.
// Loopback authorities are matched before that, and over http: a dev server on
// https is the exception, not the rule. Every name under localhost is this
// computer too.
const LOOPBACK_RE = /^((?:[a-z0-9-]+\.)*localhost|127(?:\.[0-9]{1,3}){3}|\[::1\])(:[0-9]{1,5})?(\/.*)?$/i

function isLoopbackAddress (string) {
  return LOOPBACK_RE.test(string)
}

function makeHttp (query) {
  return `http://${query}`
}

function makeHttps (query) {
  return `https://${query}`
}

function makeSearch (query, engine = 'duckduckgo_noai') {
  const template = BUILTIN_SEARCH_ENGINES[engine] || BUILTIN_SEARCH_ENGINES.duckduckgo_noai
  return template.replace('%s', encodeURIComponent(query))
}

const PLACEHOLDER_RE = /%s|\{searchTerms\}|\$1/

// A search goes wherever its template points, in the open tab, so a template
// must be an address pages are fetched from: a javascript: one ran its code in
// whatever page was open.
const SEARCH_TEMPLATE_PROTOCOLS = ['https:', 'http:', 'hyper:', 'ipfs:', 'ipns:', 'hs:']

function isSearchTemplate (template) {
  if (typeof template !== 'string' || !template.trim() || template.length >= 2048) return false
  try {
    return SEARCH_TEMPLATE_PROTOCOLS.includes(new URL(template.trim()).protocol)
  } catch {
    return false
  }
}
const KNOWN_QUERY_KEYS = ['q', 'query', 'p', 'search', 's', 'term', 'keywords', 'k', 'wd', 'text']

function buildSearchUrl (template, term) {
  const encoded = encodeURIComponent(term)

  // (1) Replace placeholder if present
  if (PLACEHOLDER_RE.test(template)) {
    return template.replace(PLACEHOLDER_RE, encoded)
  }

  // (2) Structural fallback via URL parsing
  let url
  try {
    url = new URL(template)
  } catch {
    // Fallback if invalid URL
    return makeSearch(term, 'duckduckgo_noai')
  }

  // (a) Fill first empty param, e.g. ?q=
  for (const [key, value] of url.searchParams.entries()) {
    if (value === '') {
      url.searchParams.set(key, term)
      return url.toString()
    }
  }

  // (b) Overwrite known search-like key if present
  for (const key of KNOWN_QUERY_KEYS) {
    if (url.searchParams.has(key)) {
      url.searchParams.set(key, term)
      return url.toString()
    }
  }

  // (c) Append ?q=<term> if nothing matched
  url.searchParams.set('q', term)
  return url.toString()
}

async function handleURL (rawURL) {
  if (rawURL.endsWith('.eth')) {
    if (rawURL.startsWith(IPFS_PREFIX) || rawURL.startsWith(IPNS_PREFIX)) {
      return rawURL
    }
    // ENS names are mutable and should be resolved via IPNS.
    return `${IPNS_PREFIX}${rawURL}`
  } else if (
    rawURL.startsWith(IPFS_PREFIX) ||
    rawURL.startsWith(IPNS_PREFIX) ||
    rawURL.startsWith(HYPER_PREFIX) ||
    rawURL.startsWith(WEB3_PREFIX) ||
    rawURL.startsWith(HS_PREFIX) ||
    rawURL.startsWith(BT_PREFIX) ||
    rawURL.startsWith(BITTORRENT_PREFIX) ||
    rawURL.startsWith(MAGNET_PREFIX)
  ) {
    return rawURL
  } else if (isLoopbackAddress(rawURL)) {
    return makeHttp(rawURL)
  } else if (isURL(rawURL)) {
    return rawURL
  } else if (looksLikeDomain(rawURL)) {
    return makeHttps(rawURL)
  } else {
    // For search queries, try to get user's preferred search engine
    try {
      const { ipcRenderer } = require('electron')
      const searchEngine = await ipcRenderer.invoke('settings-get', 'searchEngine')

      if (searchEngine === 'custom') {
        const customTemplate = await ipcRenderer.invoke('settings-get', 'customSearchTemplate')
        if (isSearchTemplate(customTemplate)) {
          return buildSearchUrl(customTemplate, rawURL)
        }
        console.warn('Custom search template missing or invalid, falling back to DuckDuckGo')
        return makeSearch(rawURL, 'duckduckgo')
      }

      return makeSearch(rawURL, searchEngine)
    } catch (error) {
      console.warn('Could not get search engine setting, using DuckDuckGo:', error)
      return makeSearch(rawURL, 'duckduckgo')
    }
  }
}

// Security utilities for preventing XSS attacks

/**
 * Escapes HTML special characters to prevent XSS
 * @param {string} text - The text to escape
 * @returns {string} - The escaped text
 */
function escapeHtml (text) {
  if (typeof text !== 'string') {
    return String(text)
  }

  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

/**
 * Escapes HTML attributes to prevent XSS in attribute values
 * @param {string} text - The text to escape
 * @returns {string} - The escaped text
 */
function escapeHtmlAttribute (text) {
  if (typeof text !== 'string') {
    return String(text)
  }

  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Safely sets innerHTML with escaped user content
 * @param {HTMLElement} element - The element to set innerHTML on
 * @param {string} htmlTemplate - HTML template with placeholders
 * @param {Object} data - Data to interpolate (will be escaped)
 */
function safeSetInnerHTML (element, htmlTemplate, data = {}) {
  let safeHtml = htmlTemplate

  // Replace placeholders with escaped data
  for (const [key, value] of Object.entries(data)) {
    const placeholder = new RegExp(`\\$\\{${key}\\}`, 'g')
    safeHtml = safeHtml.replace(placeholder, escapeHtml(value))

    const attrPlaceholder = new RegExp(`\\$\\{${key}:attr\\}`, 'g')
    safeHtml = safeHtml.replace(attrPlaceholder, escapeHtmlAttribute(value))
  }

  element.innerHTML = safeHtml
}

/**
 * Creates a safe template literal function for HTML
 * @param {Array} strings - Template literal strings
 * @param {...any} values - Template literal values
 * @returns {string} - Safe HTML string
 */
function html (strings, ...values) {
  let result = strings[0]

  for (let i = 0; i < values.length; i++) {
    result += escapeHtml(values[i]) + strings[i + 1]
  }

  return result
}

export {
  IPFS_PREFIX,
  IPNS_PREFIX,
  HYPER_PREFIX,
  WEB3_PREFIX,
  HS_PREFIX,
  BT_PREFIX,
  BITTORRENT_PREFIX,
  MAGNET_PREFIX,
  isURL,
  NAVIGABLE_SCHEMES,
  CONNECTION_BY_PROTOCOL,
  connectionFor,
  connectionForPage,
  failedAddressOf,
  setErrorPageKey,
  errorPageKeyOf,
  ERROR_DOCUMENT_URL,
  replaceErrorDocumentScript,
  looksLikeDomain,
  isLoopbackAddress,
  makeHttp,
  makeHttps,
  makeSearch,
  buildSearchUrl,
  isSearchTemplate,
  handleURL,
  escapeHtml,
  escapeHtmlAttribute,
  safeSetInnerHTML,
  html
}
