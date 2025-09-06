/**
 * Session Management Utility - Single Source of Truth
 * 
 * Provides centralized session management with feature flag support
 * for gradual rollout of persist:peersky session usage.
 * 
 * Feature Flag: PEERSKY_USE_PERSIST_SESSION
 * - 'true': Use session.fromPartition('persist:peersky') 
 * - undefined/false: Use session.defaultSession (safe fallback)
 * 
 * This allows safe deployment with instant rollback capability.
 */

import electron from 'electron';
const { session } = electron;

/**
 * Check if persist session mode is enabled
 * 
 * @returns {boolean} True if using persist:peersky session
 */
export function usePersist() {
  return process.env.PEERSKY_USE_PERSIST_SESSION === 'true';
}

/**
 * Get partition string for webview elements
 * 
 * @returns {string} Partition string for webview elements
 */
export function getPartition() {
  return usePersist() ? 'persist:peersky' : ''; // '' => defaultSession
}

/**
 * Get the browser session based on feature flag
 * 
 * @returns {Electron.Session} The session to use for browser operations
 */
export function getBrowserSession() {
  if (usePersist()) {
    console.log('[Session] Using persist:peersky session');
    return session.fromPartition('persist:peersky');
  } else {
    console.log('[Session] Using defaultSession (feature flag disabled)');
    return session.defaultSession;
  }
}

/**
 * Runtime assertion to verify session consistency
 * 
 * @param {Electron.Session} actualSession - Session to verify
 * @throws {Error} If session mismatch detected
 */
export function assertSessionConsistency(actualSession) {
  const expectedSession = getBrowserSession();
  const usePersist = process.env.PEERSKY_USE_PERSIST_SESSION === 'true';
  
  if (usePersist) {
    const actualPartition = actualSession.getPartition?.() || 'unknown';
    if (actualPartition !== 'persist:peersky') {
      throw new Error(`Session mismatch: expected 'persist:peersky', got '${actualPartition}'`);
    }
  }
  
  console.log('[Session] Consistency check passed');
}

/**
 * Get session partition string for webview usage
 * 
 * @returns {string} Partition string for webview elements
 */
export function getWebViewPartition() {
  const usePersist = process.env.PEERSKY_USE_PERSIST_SESSION === 'true';
  return usePersist ? 'persist:peersky' : '';
}
