/**
 * Extension Security - Legacy Security Validation
 * 
 * This module provides backward compatibility for extension security
 * validation during the transition to the new ExtensionManager architecture.
 * 
 * Basic security validation has been moved to the ManifestValidator class
 * to provide unified validation and security checking.
 * 
 * This file serves as a compatibility layer and will be deprecated
 * in favor of the integrated validation approach.
 */

// Re-export ManifestValidator for compatibility
import ManifestValidator from './manifest-validator.js';

/**
 * @deprecated Use ManifestValidator directly for validation
 * This class is kept for compatibility during the transition
 */
class ExtensionSecurity {
  constructor() {
    console.warn('ExtensionSecurity is deprecated. Use ManifestValidator directly for validation.');
    this.manifestValidator = new ManifestValidator();
  }

  /**
   * @deprecated Use ManifestValidator.validate() directly
   */
  async validateManifest(manifest, extensionPath, options = {}) {
    return this.manifestValidator.validate(manifest);
  }
}

export default ExtensionSecurity;