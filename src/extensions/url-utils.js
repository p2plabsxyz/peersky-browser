/**
 * Chrome Web Store URL/ID Parsing Utilities
 * 
 * Provides utilities for parsing and validating Chrome Web Store URLs and extension IDs
 * according to the standard format used by the Chrome Web Store.
 */

// Chrome Web Store extension ID format: 32 characters, letters a-p only
const ID_RE = /^[a-p]{32}$/i;

// Chrome Web Store URL format with extension ID extraction
const URL_RE = /^https?:\/\/chrome\.google\.com\/webstore\/detail\/[^/]+\/([a-p]{32})(?:\b|\/)?/i;

/**
 * Parse Chrome Web Store URL or extension ID
 * 
 * @param {string} input - URL or extension ID to parse
 * @returns {string|null} - Extension ID if valid, null if invalid
 */
export function parseUrlOrId(input) {
  if (!input || typeof input !== 'string') {
    return null;
  }
  
  const trimmed = input.trim();
  
  // Try to extract ID from URL first
  const urlMatch = trimmed.match(URL_RE);
  if (urlMatch) {
    return urlMatch[1].toLowerCase();
  }
  
  // Check if input is a direct extension ID
  if (ID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  
  return null;
}

/**
 * Validate Chrome Web Store extension ID format
 * 
 * @param {string} id - Extension ID to validate
 * @returns {boolean} - True if valid format
 */
export function isValidExtensionId(id) {
  return ID_RE.test(id);
}

/**
 * Build Chrome Web Store URL from extension ID
 * 
 * @param {string} id - Extension ID
 * @returns {string} - Chrome Web Store URL
 */
export function buildWebStoreUrl(id) {
  if (!isValidExtensionId(id)) {
    throw new Error('Invalid extension ID format');
  }
  return `https://chrome.google.com/webstore/detail/${id}`;
}

// Inline validation tests
function runTests() {
  console.assert(parseUrlOrId('cjpalhdlnbpafiamejdnhcphjbkeiagm') === 'cjpalhdlnbpafiamejdnhcphjbkeiagm', 'Direct ID should work');
  console.assert(parseUrlOrId('https://chrome.google.com/webstore/detail/ublock-origin/cjpalhdlnbpafiamejdnhcphjbkeiagm') === 'cjpalhdlnbpafiamejdnhcphjbkeiagm', 'Full URL should work');
  console.assert(parseUrlOrId('https://chrome.google.com/webstore/detail/ublock-origin/cjpalhdlnbpafiamejdnhcphjbkeiagm/') === 'cjpalhdlnbpafiamejdnhcphjbkeiagm', 'URL with trailing slash should work');
  console.assert(parseUrlOrId('invalid-id') === null, 'Invalid ID should return null');
  console.assert(parseUrlOrId('') === null, 'Empty string should return null');
  console.assert(parseUrlOrId(null) === null, 'Null input should return null');
  console.assert(isValidExtensionId('cjpalhdlnbpafiamejdnhcphjbkeiagm') === true, 'Valid ID should pass validation');
  console.assert(isValidExtensionId('invalid') === false, 'Invalid ID should fail validation');
  console.assert(buildWebStoreUrl('cjpalhdlnbpafiamejdnhcphjbkeiagm') === 'https://chrome.google.com/webstore/detail/cjpalhdlnbpafiamejdnhcphjbkeiagm', 'URL building should work');
}

// Run tests when module loads
runTests();