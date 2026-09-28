// Secure extension ID utilities
// Generates a deterministic 32-char ID from manifest metadata

import { createHash } from 'crypto'
import { createLogger } from '../../logger.js'

const log = createLogger('extensions')

/**
 * Generate secure extension ID using cryptographic hashing
 * @param {Object} manifest
 * @returns {string} 32-char hex ID
 */
export function generateSecureExtensionId (manifest) {
  const safe = (s) => (typeof s === 'string' ? s : '')
  const payload = {
    name: safe(manifest?.name),
    version: safe(manifest?.version),
    description: safe(manifest?.description),
    author: safe(manifest?.author),
    homepage_url: safe(manifest?.homepage_url)
  }
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  const id = hash.substring(0, 32)
  try {
    if (manifest?.name) {
      // Keep a similar log behavior to original implementation
      log.info(`ExtensionManager: Generated secure ID for "${manifest.name}": ${id}`)
    }
  } catch (_) {}
  return id
}

/**
 * The ID Chromium assigns an extension whose manifest carries this key.
 * @param {string} key - Base64 DER public key from manifest.key
 * @returns {string|null}
 */
export function chromeIdFromKey (key) {
  if (typeof key !== 'string' || !key) return null
  const der = Buffer.from(key, 'base64')
  if (!der.length) return null
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32)
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
}
