/**
 * Keyed Mutex - Prevent race conditions in extension operations
 * 
 * Provides a simple keyed mutex implementation to prevent concurrent
 * operations on the same extension or operation type.
 * 
 * This is necessary because electron-chrome-web-store has no internal
 * serialization, so multiple simultaneous installs/updates can conflict.
 */

// Map of operation keys to their pending promises
const locks = new Map();

/**
 * Execute a function with a keyed lock to prevent race conditions
 * 
 * @param {string} key - Unique key for the operation (e.g., extension ID, "install", "updateAll")
 * @param {Function} fn - Async function to execute with the lock
 * @returns {Promise<any>} - Result of the function execution
 */
export async function withLock(key, fn) {
  // Get the current lock promise for this key, or resolve immediately if none
  const previousLock = locks.get(key) || Promise.resolve();
  
  let releaseLock;
  const newLock = new Promise(resolve => {
    releaseLock = resolve;
  });
  
  // Set the new lock for this key
  locks.set(key, previousLock.then(() => newLock));
  
  try {
    // Wait for the previous operation to complete
    await previousLock;
    
    // Execute our function
    return await fn();
  } finally {
    // Release the lock
    releaseLock();
    
    // Clean up the lock if it's still ours
    if (locks.get(key) === newLock) {
      locks.delete(key);
    }
  }
}

/**
 * Execute a function with a lock specific to an extension ID
 * 
 * @param {string} extensionId - Extension ID to lock on
 * @param {Function} fn - Async function to execute
 * @returns {Promise<any>} - Result of the function execution
 */
export async function withExtensionLock(extensionId, fn) {
  return withLock(`extension:${extensionId}`, fn);
}

/**
 * Execute a function with a global installation lock
 * 
 * @param {Function} fn - Async function to execute
 * @returns {Promise<any>} - Result of the function execution
 */
export async function withInstallLock(fn) {
  return withLock('global:install', fn);
}

/**
 * Execute a function with a global update lock
 * 
 * @param {Function} fn - Async function to execute
 * @returns {Promise<any>} - Result of the function execution
 */
export async function withUpdateLock(fn) {
  return withLock('global:update', fn);
}

/**
 * Get the number of active locks (for debugging)
 * 
 * @returns {number} - Number of active locks
 */
export function getActiveLockCount() {
  return locks.size;
}

/**
 * Clear all locks (for testing or emergency cleanup)
 * 
 * @returns {void}
 */
export function clearAllLocks() {
  locks.clear();
  console.warn('[Mutex] All locks cleared - this should only be used for testing');
}

export default {
  withLock,
  withExtensionLock,
  withInstallLock,
  withUpdateLock,
  getActiveLockCount,
  clearAllLocks
};