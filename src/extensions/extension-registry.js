/**
 * Extension Registry - Legacy Metadata Management
 * 
 * This module provides backward compatibility for extension metadata
 * management during the transition to the new ExtensionManager architecture.
 * 
 * Extension metadata persistence has been integrated into the ExtensionManager
 * class to provide unified extension lifecycle management.
 * 
 * This file serves as a compatibility layer and will be deprecated
 * in favor of the integrated approach.
 */

/**
 * @deprecated Use ExtensionManager for metadata management
 * This class is kept for compatibility during the transition
 */
class ExtensionRegistry {
  constructor() {
    console.warn('ExtensionRegistry is deprecated. Use ExtensionManager for metadata management.');
  }

  /**
   * @deprecated Functionality moved to ExtensionManager
   */
  async initialize() {
    // No-op for compatibility
  }

  /**
   * @deprecated Functionality moved to ExtensionManager
   */
  async getInstalledExtensions() {
    return [];
  }
}

export default ExtensionRegistry;