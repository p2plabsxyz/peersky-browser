/**
 * Extension File Handler - Legacy File Operations
 * 
 * This module provides backward compatibility for extension file operations
 * during the transition to the new ExtensionManager architecture.
 * 
 * Basic file operations are handled directly in the ExtensionManager class
 * to provide unified extension lifecycle management. ZIP/CRX handling
 * is planned for future implementation.
 * 
 * This file serves as a compatibility layer and will be deprecated
 * in favor of the integrated approach.
 */

/**
 * @deprecated File operations moved to ExtensionManager
 * This class is kept for compatibility during the transition
 */
class ExtensionFileHandler {
  constructor() {
    console.warn('ExtensionFileHandler is deprecated. File operations are handled by ExtensionManager.');
  }

  /**
   * @deprecated Functionality moved to ExtensionManager
   */
  async initialize() {
    // No-op for compatibility
  }

  /**
   * @deprecated ZIP/CRX support planned for future implementation
   */
  async extractCRX() {
    throw new Error('CRX extraction not implemented - use directory installation');
  }

  /**
   * @deprecated ZIP/CRX support planned for future implementation
   */
  async extractZIP() {
    throw new Error('ZIP extraction not implemented - use directory installation');
  }
}

export default ExtensionFileHandler;