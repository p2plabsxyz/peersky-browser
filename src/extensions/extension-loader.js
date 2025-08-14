/**
 * Extension Loader - Legacy Compatibility Layer
 * 
 * This module provides backward compatibility for the extension system
 * during the transition to the new ExtensionManager architecture.
 * 
 * The main functionality has been moved to the ExtensionManager class
 * in index.js to provide a unified extension management interface.
 * 
 * This file serves as a compatibility layer and will be deprecated
 * in favor of the direct ExtensionManager approach.
 */

// Re-export the main ExtensionManager for backward compatibility
import extensionManager from './index.js';

/**
 * @deprecated Use ExtensionManager from index.js instead
 * This class is kept for compatibility during the transition
 */
class ExtensionLoader {
  constructor() {
    console.warn('ExtensionLoader is deprecated. Use ExtensionManager from index.js instead.');
    this.extensionManager = extensionManager;
  }

  /**
   * @deprecated Use extensionManager.initialize() instead
   */
  async initialize() {
    return this.extensionManager.initialize();
  }

  /**
   * @deprecated Use extensionManager.installExtension() instead
   */
  async installExtension(sourcePath) {
    return this.extensionManager.installExtension(sourcePath);
  }

  /**
   * @deprecated Use extensionManager.toggleExtension() instead
   */
  async toggleExtension(extensionId, enabled) {
    return this.extensionManager.toggleExtension(extensionId, enabled);
  }

  /**
   * @deprecated Use extensionManager.uninstallExtension() instead
   */
  async uninstallExtension(extensionId) {
    return this.extensionManager.uninstallExtension(extensionId);
  }

  /**
   * @deprecated Use extensionManager.listExtensions() instead
   */
  async listExtensions() {
    return this.extensionManager.listExtensions();
  }
}

// Export singleton instance
export default new ExtensionLoader();