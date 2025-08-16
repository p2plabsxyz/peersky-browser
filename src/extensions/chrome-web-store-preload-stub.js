/**
 * Chrome Web Store Preload Stub
 * 
 * Simple stub to satisfy the electron-chrome-web-store package's 
 * internal preload resolution without breaking functionality.
 * 
 * Supports both CommonJS and ESM import patterns for maximum compatibility.
 */

// This is a minimal stub that satisfies the package's require.resolve()
// The actual Chrome Web Store functionality works fine without preload scripts
console.log('Chrome Web Store preload stub loaded');

// Create stub object with zero side effects
const stub = {};

// Export for CommonJS (require) and ESM (import)
module.exports = stub;
module.exports.default = stub;