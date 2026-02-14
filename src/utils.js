import { BUILTIN_SEARCH_ENGINES } from './search-engine.js';
// P2P prefixes
const IPFS_PREFIX = 'ipfs://';
const IPNS_PREFIX = 'ipns://';
const HYPER_PREFIX = 'hyper://';
const WEB3_PREFIX = 'web3://';
const BT_PREFIX = 'bt://';
const BITTORRENT_PREFIX = 'bittorrent://';
const MAGNET_PREFIX = 'magnet:';

// Utility functions
function isURL(string) {
  try {
    new URL(string);
    return true;
  } catch {
    return false;
  }
}

function looksLikeDomain(string) {
  return !string.match(/\s/) && string.includes('.');
}

function isBareLocalhost(string) {
  return string.match(/^localhost(:[0-9]+)?\/?$/);
}

function makeHttp(query) {
  return `http://${query}`;
}

function makeHttps(query) {
  return `https://${query}`;
}

function makeSearch(query, engine = 'duckduckgo_noai') {
  const template = BUILTIN_SEARCH_ENGINES[engine] || BUILTIN_SEARCH_ENGINES.duckduckgo_noai;
  return template.replace("%s", encodeURIComponent(query));
}

const PLACEHOLDER_RE = /%s|\{searchTerms\}|\$1/;
const KNOWN_QUERY_KEYS = ["q","query","p","search","s","term","keywords","k","wd","text"];

function buildSearchUrl(template, term) {
  const encoded = encodeURIComponent(term);

  // (1) Replace placeholder if present
  if (PLACEHOLDER_RE.test(template)) {
    return template.replace(PLACEHOLDER_RE, encoded);
  }

  // (2) Structural fallback via URL parsing
  let url;
  try {
    url = new URL(template);
  } catch {
    // Fallback if invalid URL
    return makeSearch(term, 'duckduckgo_noai');
  }

  // (a) Fill first empty param, e.g. ?q=
  for (const [key, value] of url.searchParams.entries()) {
    if (value === "") {
      url.searchParams.set(key, term);
      return url.toString();
    }
  }

  // (b) Overwrite known search-like key if present
  for (const key of KNOWN_QUERY_KEYS) {
    if (url.searchParams.has(key)) {
      url.searchParams.set(key, term);
      return url.toString();
    }
  }

  // (c) Append ?q=<term> if nothing matched
  url.searchParams.set("q", term);
  return url.toString();
}

async function handleURL(rawURL) {
  if (rawURL.endsWith('.eth')) {
    if (rawURL.startsWith(IPFS_PREFIX) || rawURL.startsWith(IPNS_PREFIX)) {
      return rawURL;
    }
    // ENS names are mutable and should be resolved via IPNS.
    return `${IPNS_PREFIX}${rawURL}`;
  } else if (
    rawURL.startsWith(IPFS_PREFIX) || 
    rawURL.startsWith(IPNS_PREFIX) || 
    rawURL.startsWith(HYPER_PREFIX) || 
    rawURL.startsWith(WEB3_PREFIX) ||
    rawURL.startsWith(BT_PREFIX) ||
    rawURL.startsWith(BITTORRENT_PREFIX) ||
    rawURL.startsWith(MAGNET_PREFIX)
  ) {
    return rawURL;
  } else if (isURL(rawURL)) {
    return rawURL;
  } else if (isBareLocalhost(rawURL)) {
    return makeHttp(rawURL);
  } else if (looksLikeDomain(rawURL)) {
    return makeHttps(rawURL);
  } else {
    // For search queries, try to get user's preferred search engine
    try {
      const { ipcRenderer } = require('electron');
      const searchEngine = await ipcRenderer.invoke('settings-get', 'searchEngine');


      if (searchEngine === 'custom') {
        const customTemplate = await ipcRenderer.invoke('settings-get', 'customSearchTemplate');
        if (typeof customTemplate === 'string' && customTemplate.length) {
          return buildSearchUrl(customTemplate, rawURL);
        }
        console.warn('Custom search template missing or invalid, falling back to DuckDuckGo');
        return makeSearch(rawURL, 'duckduckgo');
      }

      return makeSearch(rawURL, searchEngine);
    } catch (error) {
      console.warn('Could not get search engine setting, using DuckDuckGo:', error);
      return makeSearch(rawURL, 'duckduckgo');
    }
  }
}

// Security utilities for preventing XSS attacks

/**
 * Escapes HTML special characters to prevent XSS
 * @param {string} text - The text to escape
 * @returns {string} - The escaped text
 */
function escapeHtml(text) {
  if (typeof text !== 'string') {
    return String(text);
  }
  
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Escapes HTML attributes to prevent XSS in attribute values
 * @param {string} text - The text to escape
 * @returns {string} - The escaped text
 */
function escapeHtmlAttribute(text) {
  if (typeof text !== 'string') {
    return String(text);
  }
  
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Safely sets innerHTML with escaped user content
 * @param {HTMLElement} element - The element to set innerHTML on
 * @param {string} htmlTemplate - HTML template with placeholders
 * @param {Object} data - Data to interpolate (will be escaped)
 */
function safeSetInnerHTML(element, htmlTemplate, data = {}) {
  let safeHtml = htmlTemplate;
  
  // Replace placeholders with escaped data
  for (const [key, value] of Object.entries(data)) {
    const placeholder = new RegExp(`\\$\\{${key}\\}`, 'g');
    safeHtml = safeHtml.replace(placeholder, escapeHtml(value));
    
    const attrPlaceholder = new RegExp(`\\$\\{${key}:attr\\}`, 'g');
    safeHtml = safeHtml.replace(attrPlaceholder, escapeHtmlAttribute(value));
  }
  
  element.innerHTML = safeHtml;
}

/**
 * Creates a safe template literal function for HTML
 * @param {Array} strings - Template literal strings
 * @param {...any} values - Template literal values
 * @returns {string} - Safe HTML string
 */
function html(strings, ...values) {
  let result = strings[0];
  
  for (let i = 0; i < values.length; i++) {
    result += escapeHtml(values[i]) + strings[i + 1];
  }
  
  return result;
}

export {
  IPFS_PREFIX,
  IPNS_PREFIX,
  HYPER_PREFIX,
  WEB3_PREFIX,
  BT_PREFIX,
  BITTORRENT_PREFIX,
  MAGNET_PREFIX,
  isURL,
  looksLikeDomain,
  isBareLocalhost,
  makeHttp,
  makeHttps,
  makeSearch,
  buildSearchUrl,  
  handleURL,
  escapeHtml,
  escapeHtmlAttribute,
  safeSetInnerHTML,
  html,
};
