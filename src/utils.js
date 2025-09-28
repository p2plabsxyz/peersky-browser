// P2P prefixes
const IPFS_PREFIX = 'ipfs://';
const IPNS_PREFIX = 'ipns://';
const HYPER_PREFIX = 'hyper://';
const WEB3_PREFIX = 'web3://';

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

function makeDuckDuckGo(query) {
  return `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
}

function makeEcosia(query) {
  return `https://www.ecosia.org/search?q=${encodeURIComponent(query)}`;
}

function makeKagi(query) {
  return `https://kagi.com/search?q=${encodeURIComponent(query)}`;
}

function makeStartpage(query) {
  return `https://www.startpage.com/do/search?query=${encodeURIComponent(query)}`;
}


function makeSearch(query, engine = 'duckduckgo') {
  switch (engine) {
    case 'ecosia':
      return makeEcosia(query);
    case 'kagi':
      return makeKagi(query);
    case 'startpage':
      return makeStartpage(query);
    case 'duckduckgo':
    default:
      return makeDuckDuckGo(query);
  }
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
    rawURL.startsWith(WEB3_PREFIX)
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
      return makeSearch(rawURL, searchEngine);
    } catch (error) {
      console.warn('Could not get search engine setting, using DuckDuckGo:', error);
      return makeDuckDuckGo(rawURL);
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
  isURL,
  looksLikeDomain,
  isBareLocalhost,
  makeHttp,
  makeHttps,
  makeDuckDuckGo,
  makeEcosia,
  makeKagi,
  makeStartpage,
  makeSearch,
  handleURL,
  escapeHtml,
  escapeHtmlAttribute,
  safeSetInnerHTML,
  html,
};
