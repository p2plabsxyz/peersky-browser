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

    // Permission security configuration
    this.permissionConfig = {
      // Safe permissions (low risk)
      safe: {
        'storage': { risk: 'low', description: 'Local storage access' },
        'alarms': { risk: 'low', description: 'Schedule alarms' },
        'notifications': { risk: 'low', description: 'Show notifications' },
        'idle': { risk: 'low', description: 'Detect idle state' },
        'power': { risk: 'low', description: 'Override power management' },
        'system.cpu': { risk: 'low', description: 'CPU information' },
        'system.memory': { risk: 'low', description: 'Memory information' },
        'system.storage': { risk: 'low', description: 'Storage information' }
      },
      
      // Medium risk permissions (require justification)
      medium: {
        'activeTab': { risk: 'medium', description: 'Current active tab access' },
        'tabs': { risk: 'medium', description: 'Tab information access' },
        'bookmarks': { risk: 'medium', description: 'Bookmark access' },
        'history': { risk: 'medium', description: 'Browsing history access' },
        'contextMenus': { risk: 'medium', description: 'Context menu creation' },
        'cookies': { risk: 'medium', description: 'Cookie access' },
        'downloads': { risk: 'medium', description: 'Download management' },
        'webNavigation': { risk: 'medium', description: 'Navigation events' }
      },
      
      // High risk permissions (dangerous, require special approval)
      dangerous: {
        '<all_urls>': { risk: 'high', description: 'Access to all websites' },
        'webRequest': { risk: 'high', description: 'Intercept web requests' },
        'webRequestBlocking': { risk: 'high', description: 'Block web requests' },
        'proxy': { risk: 'high', description: 'Proxy configuration' },
        'privacy': { risk: 'high', description: 'Privacy settings access' },
        'management': { risk: 'high', description: 'Extension management' },
        'system.display': { risk: 'high', description: 'Display configuration' },
        'enterprise.platformKeys': { risk: 'high', description: 'Platform keys access' }
      },
      
      // Blocked permissions (not allowed)
      blocked: {
        'nativeMessaging': { risk: 'critical', description: 'Native application communication' },
        'debugger': { risk: 'critical', description: 'Debugger API access' },
        'desktopCapture': { risk: 'critical', description: 'Desktop capture' },
        'experimental': { risk: 'critical', description: 'Experimental APIs' },
        'mdns': { risk: 'critical', description: 'Multicast DNS access' },
        'serial': { risk: 'critical', description: 'Serial port access' },
        'usb': { risk: 'critical', description: 'USB device access' },
        'fileSystem': { risk: 'critical', description: 'File system access' },
        'fileSystemProvider': { risk: 'critical', description: 'File system provider' }
      }
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

      // Comprehensive permission security validation
      const permissionValidation = this.validatePermissions(manifest.permissions || []);
      if (!permissionValidation.allowed) {
        result.errors.push(...permissionValidation.errors);
        result.isValid = false;
      }
      result.warnings.push(...permissionValidation.warnings);
      result.securityInfo = permissionValidation;

      // Host permissions validation with security checks
      const hostValidation = this.validateHostPermissions(manifest.host_permissions || []);
      if (!hostValidation.allowed) {
        result.errors.push(...hostValidation.errors);
        result.isValid = false;
      }
      result.warnings.push(...hostValidation.warnings);
      
      // Combine security risk scores
      result.riskScore = (permissionValidation.riskScore || 0) + (hostValidation.riskScore || 0);

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
   * Validate extension permissions with security risk assessment
   * 
   * @param {Array} permissions - Array of permission strings
   * @returns {Object} Validation result with risk assessment
   */
  validatePermissions(permissions) {
    const result = {
      allowed: true,
      errors: [],
      warnings: [],
      riskScore: 0,
      riskLevel: 'low',
      permissionDetails: []
    };

    if (!Array.isArray(permissions)) {
      result.errors.push('Permissions must be an array');
      result.allowed = false;
      return result;
    }

    for (const permission of permissions) {
      if (typeof permission !== 'string') {
        result.errors.push('All permissions must be strings');
        result.allowed = false;
        continue;
      }

      const permissionInfo = this.assessPermission(permission);
      result.permissionDetails.push(permissionInfo);
      
      // Handle different risk levels
      if (permissionInfo.category === 'blocked') {
        result.errors.push(`Blocked permission: ${permission} - ${permissionInfo.description}`);
        result.allowed = false;
        result.riskScore += 50;
      } else if (permissionInfo.category === 'dangerous') {
        result.warnings.push(`High-risk permission: ${permission} - ${permissionInfo.description}`);
        result.riskScore += 20;
      } else if (permissionInfo.category === 'medium') {
        result.warnings.push(`Medium-risk permission: ${permission} - ${permissionInfo.description}`);
        result.riskScore += 10;
      } else if (permissionInfo.category === 'safe') {
        result.riskScore += 2;
      } else {
        result.warnings.push(`Unknown permission: ${permission} - Please verify this is a valid Chrome extension permission`);
        result.riskScore += 15;
      }
    }

    // Determine overall risk level
    if (result.riskScore >= 50) {
      result.riskLevel = 'critical';
    } else if (result.riskScore >= 30) {
      result.riskLevel = 'high';
    } else if (result.riskScore >= 15) {
      result.riskLevel = 'medium';
    } else {
      result.riskLevel = 'low';
    }

    return result;
  }

  /**
   * Validate host permissions with domain security checking
   * 
   * @param {Array} hostPermissions - Array of host permission patterns
   * @returns {Object} Validation result with security assessment
   */
  validateHostPermissions(hostPermissions) {
    const result = {
      allowed: true,
      errors: [],
      warnings: [],
      riskScore: 0,
      hostDetails: []
    };

    if (!Array.isArray(hostPermissions)) {
      result.errors.push('Host permissions must be an array');
      result.allowed = false;
      return result;
    }

    // Dangerous host patterns
    const dangerousPatterns = [
      '<all_urls>',
      '*://*/*',
      'http://*/*',
      'https://*/*',
      'file:///*'
    ];

    // Suspicious domains (known malicious or high-risk)
    const suspiciousDomains = [
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      '*.local'
    ];

    for (const hostPattern of hostPermissions) {
      if (typeof hostPattern !== 'string') {
        result.errors.push('All host permissions must be strings');
        result.allowed = false;
        continue;
      }

      const hostInfo = {
        pattern: hostPattern,
        risk: 'low',
        description: ''
      };

      // Check for dangerous patterns
      if (dangerousPatterns.includes(hostPattern)) {
        hostInfo.risk = 'high';
        hostInfo.description = 'Broad access pattern - can access any website';
        result.warnings.push(`High-risk host permission: ${hostPattern} - ${hostInfo.description}`);
        result.riskScore += 25;
      }
      // Check for suspicious domains
      else if (suspiciousDomains.some(domain => hostPattern.includes(domain))) {
        hostInfo.risk = 'medium';
        hostInfo.description = 'Local/internal network access';
        result.warnings.push(`Medium-risk host permission: ${hostPattern} - ${hostInfo.description}`);
        result.riskScore += 10;
      }
      // Check for overly broad wildcards
      else if (hostPattern.includes('*://*/') || hostPattern.includes('*.*')) {
        hostInfo.risk = 'medium';
        hostInfo.description = 'Broad wildcard pattern';
        result.warnings.push(`Medium-risk host permission: ${hostPattern} - ${hostInfo.description}`);
        result.riskScore += 8;
      }
      else {
        hostInfo.risk = 'low';
        hostInfo.description = 'Specific domain access';
        result.riskScore += 2;
      }

      result.hostDetails.push(hostInfo);
    }

    return result;
  }

  /**
   * Assess individual permission risk and category
   * 
   * @param {string} permission - Permission string to assess
   * @returns {Object} Permission assessment details
   */
  assessPermission(permission) {
    // Check each category
    for (const [category, permissions] of Object.entries(this.permissionConfig)) {
      if (permissions[permission]) {
        return {
          permission,
          category,
          risk: permissions[permission].risk,
          description: permissions[permission].description
        };
      }
    }

    // Unknown permission
    return {
      permission,
      category: 'unknown',
      risk: 'medium',
      description: 'Unknown or experimental permission'
    };
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