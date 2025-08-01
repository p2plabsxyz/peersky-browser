/**
 * Manifest Validator - Extension Manifest Validation
 * 
 * This module provides validation for WebExtension manifest files,
 * ensuring compliance with Manifest V3 specifications and basic
 * security requirements.
 * 
 * Key Features:
 * - Manifest V3 schema validation
 * - Required field verification
 * - Permission validation
 * - Version format validation
 * - Security requirement checking
 * 
 * Validation Approach:
 * - Comprehensive field validation
 * - Security-focused permission checking
 * - Clear error reporting
 * - Performance-optimized validation
 * - Extensible validation framework
 */

/**
 * ManifestValidator - Extension manifest validation engine
 * 
 * Provides comprehensive validation of extension manifests with detailed
 * error reporting and security-focused validation rules.
 */
class ManifestValidator {
  constructor() {
    // Required fields for validation
    this.requiredFields = [
      'manifest_version',
      'name',
      'version'
    ];
    
    // Validation patterns
    this.patterns = {
      version: /^\d+(\.\d+)*$/,
      name: /^[\w\s\-\.]{1,50}$/
    };
  }

  /**
   * Validate a manifest object
   * 
   * @param {Object} manifest - Parsed manifest.json object
   * @returns {Object} Validation result with errors and warnings
   */
  validate(manifest) {
    const result = {
      isValid: true,
      errors: [],
      warnings: []
    };

    try {
      // Basic structure validation
      if (!manifest || typeof manifest !== 'object') {
        result.errors.push('Manifest must be a valid JSON object');
        result.isValid = false;
        return result;
      }

      // Required fields validation
      for (const field of this.requiredFields) {
        if (!(field in manifest)) {
          result.errors.push(`Required field missing: ${field}`);
          result.isValid = false;
        }
      }

      // Manifest version validation
      if (manifest.manifest_version !== 3) {
        result.errors.push('Only Manifest V3 is supported (manifest_version: 3)');
        result.isValid = false;
      }

      // Name validation
      if (manifest.name) {
        if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
          result.errors.push('Name must be a non-empty string');
          result.isValid = false;
        } else if (manifest.name.length > 50) {
          result.errors.push('Name must be 50 characters or less');
          result.isValid = false;
        }
      }

      // Version validation
      if (manifest.version) {
        if (!this.patterns.version.test(manifest.version)) {
          result.errors.push('Version must follow semantic versioning (e.g., 1.0.0)');
          result.isValid = false;
        }
      }

      // Basic permissions validation
      if (manifest.permissions && !Array.isArray(manifest.permissions)) {
        result.errors.push('Permissions must be an array');
        result.isValid = false;
      }

      if (manifest.host_permissions && !Array.isArray(manifest.host_permissions)) {
        result.errors.push('Host permissions must be an array');
        result.isValid = false;
      }

      // Background script validation
      if (manifest.background) {
        if (!manifest.background.service_worker) {
          result.warnings.push('Background scripts should use service_worker in Manifest V3');
        }
      }

      console.log(`ManifestValidator: Validation ${result.isValid ? 'passed' : 'failed'} for ${manifest.name || 'unknown'}`);
      return result;

    } catch (error) {
      console.error('ManifestValidator: Validation error:', error);
      result.errors.push('Internal validation error');
      result.isValid = false;
      return result;
    }
  }

  /**
   * Get basic manifest information for display
   * 
   * @param {Object} manifest - Parsed manifest.json object
   * @returns {Object} Basic manifest info for UI display
   */
  getBasicInfo(manifest) {
    if (!manifest || typeof manifest !== 'object') {
      return null;
    }

    return {
      name: manifest.name || 'Unknown Extension',
      version: manifest.version || '0.0.0',
      description: manifest.description || 'No description provided',
      manifestVersion: manifest.manifest_version,
      permissions: manifest.permissions || [],
      hostPermissions: manifest.host_permissions || []
    };
  }
}

export default ManifestValidator;