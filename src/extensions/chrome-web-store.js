/**
 * Chrome Web Store Manager - Wrapper for electron-chrome-web-store
 * 
 * Provides a clean abstraction over the electron-chrome-web-store package
 * with error handling and session management for Peersky Browser.
 *
 * Note: We lazy-load electron-chrome-web-store via dynamic import so that
 * unit tests can import this module without requiring Electron runtime.
 */

/**
 * Chrome Web Store Manager
 * Wraps electron-chrome-web-store APIs with session management
 */
export class ChromeWebStoreManager {
  /**
   * Create a new Chrome Web Store manager
   * 
   * @param {Electron.Session} session - Electron session to use for extension operations
   */
  constructor(session) {
    this.session = session;
    this.isInitialized = false;
  }

  /**
   * Create a shim session that exposes only the modern extension APIs and
   * intentionally omits the legacy `session.extensions` object to avoid
   * conflicts with other libraries. The web store helpers prefer
   * `session.extensions || session`, so by passing this shim (without
   * `.extensions`) we ensure it uses the real Session methods.
   */
  _getSessionShim() {
    const s = this.session;
    // Use bracket access to avoid TS deprecated signature warnings in editors.
    const shim = {
      // @ts-expect-error Electron typings mark getAllExtensions deprecated; still required by dependency
      getAllExtensions: (...args) => s["getAllExtensions"]?.(...args),
      getExtension: (...args) => s["getExtension"]?.(...args),
      loadExtension: (...args) => s["loadExtension"]?.(...args),
      removeExtension: (...args) => s["removeExtension"]?.(...args)
    };
    return Object.freeze(shim);
  }

  /**
   * Install extension by ID from Chrome Web Store
   * 
   * @param {string} extensionId - Chrome Web Store extension ID
   * @returns {Promise<Electron.Extension>} - Installed extension object
   * @throws {Error} - If installation fails
   */
  async installById(extensionId) {
    if (!this.session) {
      throw new Error('Session not initialized');
    }

    try {
      const { installExtension } = await import('electron-chrome-web-store');
      console.log(`[ChromeWebStore] Installing extension: ${extensionId}`);
      const extension = await installExtension(extensionId, { 
        session: this._getSessionShim() 
      });
      console.log(`[ChromeWebStore] Successfully installed: ${extension.name} v${extension.version}`);
      return extension;
    } catch (error) {
      console.error(`[ChromeWebStore] Installation failed for ${extensionId}:`, error);
      
      // Provide more specific error messages
      if (error.message.includes('EXTENSION_NOT_FOUND')) {
        throw new Error(`Extension ${extensionId} not found in Chrome Web Store`);
      } else if (error.message.includes('BLOCKED_BY_POLICY')) {
        throw new Error(`Extension ${extensionId} blocked by policy`);
      } else if (error.message.includes('INSTALL_ERROR')) {
        throw new Error(`Failed to install extension ${extensionId}: ${error.message}`);
      }
      
      throw new Error(`Chrome Web Store installation failed: ${error.message}`);
    }
  }

  /**
   * Update all installed extensions
   * 
   * @returns {Promise<{updated: string[], skipped: string[], errors: Array<{id: string, message: string}>}>}
   */
  async updateAll() {
    if (!this.session) {
      throw new Error('Session not initialized');
    }

    try {
      const { updateExtensions } = await import('electron-chrome-web-store');
      console.log('[ChromeWebStore] Checking for extension updates...');
      await updateExtensions(this._getSessionShim());
      
      // Note: The updateExtensions API doesn't return detailed results
      // We'll need to track this at the ExtensionManager level
      console.log('[ChromeWebStore] Extension update check completed');
      return {
        updated: [],
        skipped: [],
        errors: []
      };
    } catch (error) {
      console.error('[ChromeWebStore] Update check failed:', error);
      throw new Error(`Extension update failed: ${error.message}`);
    }
  }

  /**
   * Uninstall extension by ID
   * 
   * @param {string} extensionId - Extension ID to uninstall
   * @returns {Promise<boolean>} - True if uninstalled successfully
   */
  async uninstallById(extensionId) {
    if (!this.session) {
      throw new Error('Session not initialized');
    }

    try {
      const { uninstallExtension } = await import('electron-chrome-web-store');
      console.log(`[ChromeWebStore] Uninstalling extension: ${extensionId}`);
      await uninstallExtension(extensionId, { session: this._getSessionShim() });
      console.log(`[ChromeWebStore] Successfully uninstalled: ${extensionId}`);
      return true;
    } catch (error) {
      console.error(`[ChromeWebStore] Uninstallation failed for ${extensionId}:`, error);
      throw new Error(`Extension uninstall failed: ${error.message}`);
    }
  }

  /**
   * Get session being used
   * 
   * @returns {Electron.Session} - Current session
   */
  getSession() {
    return this.session;
  }
}

export default ChromeWebStoreManager;
