// Extension Security - Centralized security validation and enforcement
// Handles Manifest V3 validation, permission checking, CSP policies, and signature verification
// Ensures extensions meet security standards before loading

import { promises as fs } from 'fs';
import crypto from 'crypto';
import path from 'path';

class ExtensionSecurity {
  constructor() {
    this.manifestV3Schema = this.initManifestV3Schema();
    this.dangerousPermissions = this.initDangerousPermissions();
    this.cspPolicies = new Map(); // extensionId -> CSP policy
  }

  async validateManifestV3(manifestPath) {
    // TODO: Strict Manifest V3 validation
    // - Check manifest_version === 3
    // - Validate required fields (name, version)
    // - Check for deprecated V2 fields
    // - Validate permissions and host_permissions
    // - Ensure service_worker instead of background scripts
    console.log(`TODO: Validate Manifest V3: ${manifestPath}`);
    
    try {
      const manifestContent = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestContent);
      
      const errors = [];
      
      // Check manifest version
      if (manifest.manifest_version !== 3) {
        errors.push(`Invalid manifest_version: ${manifest.manifest_version}. Must be 3.`);
      }
      
      // Check required fields
      if (!manifest.name || typeof manifest.name !== 'string') {
        errors.push('Missing or invalid "name" field');
      }
      
      if (!manifest.version || typeof manifest.version !== 'string') {
        errors.push('Missing or invalid "version" field');
      }
      
      // Check for deprecated V2 fields
      const deprecatedFields = ['background.scripts', 'background.page', 'background.persistent'];
      for (const field of deprecatedFields) {
        if (this.getNestedProperty(manifest, field) !== undefined) {
          errors.push(`Deprecated Manifest V2 field: ${field}. Use background.service_worker instead.`);
        }
      }
      
      // Validate permissions
      if (manifest.permissions) {
        const permissionErrors = this.validatePermissions(manifest.permissions);
        errors.push(...permissionErrors);
      }
      
      // Validate host permissions
      if (manifest.host_permissions) {
        const hostErrors = this.validateHostPermissions(manifest.host_permissions);
        errors.push(...hostErrors);
      }
      
      // Validate background field
      if (manifest.background) {
        const backgroundErrors = this.validateBackground(manifest.background);
        errors.push(...backgroundErrors);
      }
      
      return {
        valid: errors.length === 0,
        errors,
        manifest: errors.length === 0 ? manifest : null
      };
      
    } catch (error) {
      return {
        valid: false,
        errors: [`Failed to read or parse manifest: ${error.message}`],
        manifest: null
      };
    }
  }

  validatePermissions(permissions) {
    // TODO: Check permission safety and validate against allowed list
    // - Check for dangerous permissions
    // - Validate permission syntax
    // - Warn about broad permissions
    console.log('TODO: Validate extension permissions');
    
    const errors = [];
    
    if (!Array.isArray(permissions)) {
      errors.push('Permissions must be an array');
      return errors;
    }
    
    for (const permission of permissions) {
      if (typeof permission !== 'string') {
        errors.push(`Invalid permission type: ${typeof permission}. Must be string.`);
        continue;
      }
      
      // Check against dangerous permissions
      if (this.dangerousPermissions.includes(permission)) {
        errors.push(`Dangerous permission detected: ${permission}. Consider alternatives.`);
      }
      
      // Validate permission format
      if (!this.isValidPermissionFormat(permission)) {
        errors.push(`Invalid permission format: ${permission}`);
      }
    }
    
    return errors;
  }

  validateHostPermissions(hostPermissions) {
    // TODO: Validate host permission patterns
    // - Check for overly broad patterns (*://*/*)
    // - Validate URL pattern syntax
    // - Warn about sensitive hosts
    console.log('TODO: Validate host permissions');
    
    const errors = [];
    
    if (!Array.isArray(hostPermissions)) {
      errors.push('Host permissions must be an array');
      return errors;
    }
    
    for (const pattern of hostPermissions) {
      if (typeof pattern !== 'string') {
        errors.push(`Invalid host permission type: ${typeof pattern}. Must be string.`);
        continue;
      }
      
      // Check for overly broad patterns
      if (pattern === '*://*/*' || pattern === '<all_urls>') {
        errors.push(`Overly broad host permission: ${pattern}. Consider restricting to specific domains.`);
      }
      
      // Validate URL pattern syntax
      if (!this.isValidUrlPattern(pattern)) {
        errors.push(`Invalid URL pattern: ${pattern}`);
      }
      
      // Check for sensitive hosts
      if (this.isSensitiveHost(pattern)) {
        errors.push(`Sensitive host permission: ${pattern}. Extra scrutiny required.`);
      }
    }
    
    return errors;
  }

  validateBackground(background) {
    // TODO: Validate background field for Manifest V3
    // - Ensure service_worker is used instead of scripts
    // - Check service worker file exists
    // - Validate type field
    console.log('TODO: Validate background configuration');
    
    const errors = [];
    
    if (typeof background !== 'object' || background === null) {
      errors.push('Background field must be an object');
      return errors;
    }
    
    // Check for service_worker
    if (!background.service_worker) {
      errors.push('Background must specify service_worker for Manifest V3');
    } else if (typeof background.service_worker !== 'string') {
      errors.push('service_worker must be a string path');
    }
    
    // Check type field if present
    if (background.type && background.type !== 'module') {
      errors.push('background.type must be "module" if specified');
    }
    
    return errors;
  }

  async createCSPPolicy(extensionId, manifest) {
    // TODO: Generate CSP headers for extension
    // - Create restrictive default policy
    // - Allow necessary sources based on manifest
    // - Store policy for runtime enforcement
    console.log(`TODO: Create CSP policy for: ${extensionId}`);
    
    const basePolicy = [
      "default-src 'self'",
      "script-src 'self'",
      "object-src 'none'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self' https:"
    ];
    
    // Modify policy based on manifest permissions
    if (manifest.permissions?.includes('webRequest')) {
      basePolicy.push("connect-src 'self' https: http:");
    }
    
    const cspPolicy = basePolicy.join('; ');
    this.cspPolicies.set(extensionId, cspPolicy);
    
    return cspPolicy;
  }

  async validateSignature(data, signature, publicKey = null) {
    // TODO: Verify P2P extension signatures
    // - Support common signature formats (RSA, ECDSA)
    // - Validate against known publisher keys
    // - Handle keyring management for verification
    console.log('TODO: Validate extension signature');
    
    if (!signature || !data) {
      return { valid: false, error: 'Missing signature or data' };
    }
    
    try {
      // For now, return placeholder validation
      // In real implementation, would verify against actual signatures
      return {
        valid: false, // Default to unverified for safety
        error: 'Signature verification not yet implemented',
        verified: false
      };
    } catch (error) {
      return {
        valid: false,
        error: `Signature validation failed: ${error.message}`,
        verified: false
      };
    }
  }

  async computeSHA256(filePath) {
    // TODO: Generate/verify file hashes for integrity checking
    // - Read file in chunks for large files
    // - Return hex-encoded hash
    // - Handle file read errors gracefully
    console.log(`TODO: Compute SHA256 for: ${filePath}`);
    
    try {
      const data = await fs.readFile(filePath);
      const hash = crypto.createHash('sha256');
      hash.update(data);
      return hash.digest('hex');
    } catch (error) {
      throw new Error(`Failed to compute SHA256: ${error.message}`);
    }
  }

  async createSandboxPolicy(extensionId, manifest) {
    // TODO: Define runtime restrictions for extension
    // - Limit file system access
    // - Restrict network access based on permissions
    // - Set memory and CPU limits
    // - Define allowed APIs based on manifest
    console.log(`TODO: Create sandbox policy for: ${extensionId}`);
    
    const policy = {
      fileSystemAccess: 'none', // No direct file access
      networkAccess: this.determineNetworkAccess(manifest),
      apiAccess: this.determineApiAccess(manifest),
      memoryLimit: '100MB', // Default memory limit
      cpuQuota: 0.1, // 10% CPU quota
      allowedOrigins: manifest.host_permissions || []
    };
    
    return policy;
  }

  async validateP2PSource(ipfsHash, hyperKey) {
    // TODO: Verify P2P integrity and source authenticity
    // - Validate hash/key format
    // - Check against known malicious sources
    // - Verify content integrity
    // - Check source reputation if available
    console.log(`TODO: Validate P2P source - IPFS: ${ipfsHash}, Hyper: ${hyperKey}`);
    
    const validation = {
      valid: true,
      warnings: [],
      errors: []
    };
    
    // Validate IPFS hash format
    if (ipfsHash && !this.isValidIPFSHash(ipfsHash)) {
      validation.valid = false;
      validation.errors.push(`Invalid IPFS hash format: ${ipfsHash}`);
    }
    
    // Validate Hyper key format
    if (hyperKey && !this.isValidHyperKey(hyperKey)) {
      validation.valid = false;
      validation.errors.push(`Invalid Hyper key format: ${hyperKey}`);
    }
    
    // TODO: Check against malicious source database
    // TODO: Verify content integrity
    // TODO: Check source reputation
    
    return validation;
  }

  // Helper methods

  initManifestV3Schema() {
    // TODO: Define comprehensive Manifest V3 schema for validation
    return {
      required: ['manifest_version', 'name', 'version'],
      properties: {
        manifest_version: { type: 'number', value: 3 },
        name: { type: 'string', minLength: 1 },
        version: { type: 'string', pattern: /^\d+(\.\d+)*$/ }
      }
    };
  }

  initDangerousPermissions() {
    // TODO: Define list of permissions requiring extra scrutiny
    return [
      'debugger',
      'desktopCapture',
      'fileSystem',
      'fileSystemProvider',
      'management',
      'nativeMessaging',
      'privacy',
      'proxy',
      'system.cpu',
      'system.memory',
      'system.storage',
      'tabCapture',
      'webAuthenticationProxy'
    ];
  }

  getNestedProperty(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  isValidPermissionFormat(permission) {
    // TODO: Validate permission string format
    // - Check against Chrome extension permission patterns
    // - Validate API names and patterns
    const validPatterns = [
      /^[a-zA-Z][a-zA-Z0-9]*$/, // Simple API names
      /^[a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/, // Namespaced APIs
      /^https?:\/\/[^\/]+\/.*$/ // URL permissions
    ];
    
    return validPatterns.some(pattern => pattern.test(permission));
  }

  isValidUrlPattern(pattern) {
    // TODO: Validate URL pattern syntax for host permissions
    // - Support Chrome extension URL pattern format
    // - Check scheme, host, and path components
    try {
      // Basic validation - real implementation would be more comprehensive
      if (pattern === '<all_urls>') return true;
      if (pattern.includes('*://')) return true;
      if (pattern.startsWith('http://') || pattern.startsWith('https://')) return true;
      return false;
    } catch {
      return false;
    }
  }

  isSensitiveHost(pattern) {
    // TODO: Check if host pattern accesses sensitive domains
    const sensitiveHosts = [
      'chrome://',
      'chrome-extension://',
      'moz-extension://',
      'file://',
      'localhost',
      '127.0.0.1',
      '*.gov',
      '*.mil',
      '*.bank'
    ];
    
    return sensitiveHosts.some(host => pattern.includes(host));
  }

  determineNetworkAccess(manifest) {
    // TODO: Determine allowed network access based on manifest
    if (manifest.host_permissions?.includes('<all_urls>')) {
      return 'unrestricted';
    } else if (manifest.host_permissions?.length > 0) {
      return 'restricted';
    } else {
      return 'none';
    }
  }

  determineApiAccess(manifest) {
    // TODO: Determine allowed Chrome APIs based on permissions
    const allowedApis = [];
    
    if (manifest.permissions) {
      for (const permission of manifest.permissions) {
        if (permission === 'storage') allowedApis.push('chrome.storage');
        if (permission === 'tabs') allowedApis.push('chrome.tabs');
        if (permission === 'activeTab') allowedApis.push('chrome.tabs.query');
        // Add more API mappings as needed
      }
    }
    
    return allowedApis;
  }

  isValidIPFSHash(hash) {
    // TODO: Validate IPFS hash format (CID v0/v1)
    return /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(hash) || // CID v0
           /^[a-z2-7]{59}$/.test(hash); // CID v1 base32
  }

  isValidHyperKey(key) {
    // TODO: Validate Hypercore key format
    return /^[a-f0-9]{64}$/.test(key); // 64-character hex string
  }
}

export default ExtensionSecurity;