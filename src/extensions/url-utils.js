/**
 * Chrome Web Store URL/ID Parsing Utilities
 * 
 * Provides utilities for parsing and validating Chrome Web Store URLs and extension IDs
 * according to the standard format used by the Chrome Web Store.
 */

// Chrome Web Store extension ID format: 32 characters, letters a-p only
const ID_RE = /^[a-p]{32}$/i;

// Chrome Web Store URL format with extension ID extraction (supports both domains)
const URL_RE = /^https?:\/\/(?:chrome\.google\.com\/webstore\/detail|chromewebstore\.google\.com\/detail)\/[^/]+\/([a-p]{32})(?:\b|\/)?/i;

// Allowed Chrome Web Store domains (whitelist)
const ALLOWED_DOMAINS = [
  'chrome.google.com',
  'chromewebstore.google.com'
];

// Blocked domains (known malicious or suspicious)
const BLOCKED_DOMAINS = [
  'chrome-store.com',
  'chrome-webstore.com', 
  'google-chrome.com',
  'chromium-store.com',
  'fake-chrome-store.com',
  'malicious-extensions.com'
];

// Suspicious URL patterns
const SUSPICIOUS_PATTERNS = [
  /bit\.ly|tinyurl|t\.co/i,  // URL shorteners
  /[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/,  // IP addresses
  /localhost|127\.0\.0\.1|0\.0\.0\.0/i,  // Local addresses
  /\.tk$|\.ml$|\.ga$|\.cf$/i,  // Suspicious TLDs
];

/**
 * Parse Chrome Web Store URL or extension ID with security validation
 * 
 * @param {string} input - URL or extension ID to parse
 * @returns {string|null} - Extension ID if valid, null if invalid or unsafe
 */
export function parseUrlOrId(input) {
  if (!input || typeof input !== 'string') {
    return null;
  }
  
  const trimmed = input.trim();
  
  // Check for suspicious patterns first
  if (SUSPICIOUS_PATTERNS.some(pattern => pattern.test(trimmed))) {
    console.warn('URL validation: Blocked suspicious URL pattern:', trimmed);
    return null;
  }
  
  // Try to extract ID from URL first
  const urlMatch = trimmed.match(URL_RE);
  if (urlMatch) {
    const url = new URL(trimmed);
    
    // Validate domain is in allowlist
    if (!ALLOWED_DOMAINS.includes(url.hostname.toLowerCase())) {
      console.warn('URL validation: Domain not in allowlist:', url.hostname);
      return null;
    }
    
    // Check domain is not in blocklist
    if (BLOCKED_DOMAINS.includes(url.hostname.toLowerCase())) {
      console.warn('URL validation: Blocked malicious domain:', url.hostname);
      return null;
    }
    
    // Validate HTTPS
    if (url.protocol !== 'https:') {
      console.warn('URL validation: Non-HTTPS URL rejected:', trimmed);
      return null;
    }
    
    return urlMatch[1].toLowerCase();
  }
  
  // Check if input is a direct extension ID
  if (ID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  
  return null;
}

/**
 * Enhanced URL validation with comprehensive security checks
 * 
 * @param {string} url - URL to validate
 * @returns {Object} Validation result with security assessment
 */
export function validateUrl(url) {
  const result = {
    isValid: false,
    isSecure: false,
    errors: [],
    warnings: [],
    riskScore: 0,
    extractedId: null
  };
  
  if (!url || typeof url !== 'string') {
    result.errors.push('URL must be a non-empty string');
    return result;
  }
  
  const trimmed = url.trim();
  
  try {
    const parsedUrl = new URL(trimmed);
    
    // Check protocol
    if (parsedUrl.protocol !== 'https:') {
      result.errors.push('Only HTTPS URLs are allowed');
      result.riskScore += 20;
    }
    
    // Check domain against allowlist
    if (!ALLOWED_DOMAINS.includes(parsedUrl.hostname.toLowerCase())) {
      result.errors.push(`Domain not allowed: ${parsedUrl.hostname}`);
      result.riskScore += 30;
    }
    
    // Check domain against blocklist
    if (BLOCKED_DOMAINS.includes(parsedUrl.hostname.toLowerCase())) {
      result.errors.push(`Blocked malicious domain: ${parsedUrl.hostname}`);
      result.riskScore += 50;
    }
    
    // Check for suspicious patterns
    for (const pattern of SUSPICIOUS_PATTERNS) {
      if (pattern.test(trimmed)) {
        result.warnings.push('URL contains suspicious patterns');
        result.riskScore += 15;
        break;
      }
    }
    
    // Try to extract extension ID
    const urlMatch = trimmed.match(URL_RE);
    if (urlMatch) {
      result.extractedId = urlMatch[1].toLowerCase();
      result.isValid = true;
    } else {
      result.errors.push('URL does not match Chrome Web Store format');
      result.riskScore += 10;
    }
    
    // Determine if URL is secure (low risk)
    result.isSecure = result.riskScore < 15 && result.isValid;
    
  } catch (error) {
    result.errors.push('Invalid URL format');
    result.riskScore += 25;
  }
  
  return result;
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
  console.assert(parseUrlOrId('https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh') === 'ddkjiahejlhfcafbddmgiahcphecmpfh', 'New Chrome Web Store URL format should work');
  console.assert(parseUrlOrId('invalid-id') === null, 'Invalid ID should return null');
  console.assert(parseUrlOrId('') === null, 'Empty string should return null');
  console.assert(parseUrlOrId(null) === null, 'Null input should return null');
  console.assert(isValidExtensionId('cjpalhdlnbpafiamejdnhcphjbkeiagm') === true, 'Valid ID should pass validation');
  console.assert(isValidExtensionId('invalid') === false, 'Invalid ID should fail validation');
  console.assert(buildWebStoreUrl('cjpalhdlnbpafiamejdnhcphjbkeiagm') === 'https://chrome.google.com/webstore/detail/cjpalhdlnbpafiamejdnhcphjbkeiagm', 'URL building should work');
}

// Run tests when module loads
runTests();