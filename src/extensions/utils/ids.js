// Secure extension ID utilities
// Generates a deterministic 32-char ID from manifest metadata

import { createHash } from 'crypto';

/**
 * Generate secure extension ID using cryptographic hashing
 * @param {Object} manifest
 * @returns {string} 32-char hex ID
 */
export function generateSecureExtensionId(manifest) {
  const safe = (s) => (typeof s === 'string' ? s : '');
  const payload = {
    name: safe(manifest?.name),
    version: safe(manifest?.version),
    description: safe(manifest?.description),
    author: safe(manifest?.author),
    homepage_url: safe(manifest?.homepage_url)
  };
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const id = hash.substring(0, 32);
  try {
    if (manifest?.name) {
      // Keep a similar log behavior to original implementation
      console.log(`ExtensionManager: Generated secure ID for "${manifest.name}": ${id}`);
    }
  } catch (_) {}
  return id;
}

