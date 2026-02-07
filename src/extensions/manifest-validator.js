function escapeRegExpLike(s) {
  try {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  } catch (_) {
    return String(s || '');
  }
}

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
 * 
 * Consolidated validation system that handles:
 * - Manifest V3 validation
 * - Chrome Web Store URL parsing
 * - Basic file security validation
 * - Permission risk assessment
 */
class ManifestValidator {
  constructor(policy) {
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

    // Chrome Web Store URL parsing
    this.webStore = {
      // Chrome Web Store extension ID format: 32 characters, letters a-p only
      idPattern: /^[a-p]{32}$/i,
      
      // Chrome Web Store URL format with extension ID extraction
      urlPattern: /^https?:\/\/(?:chrome\.google\.com\/webstore\/detail|chromewebstore\.google\.com\/detail)\/[^/]+\/([a-p]{32})(?:\b|\/)?/i,
      
      // Allowed domains
      allowedDomains: [
        'chrome.google.com',
        'chromewebstore.google.com'
      ],
      
      // Blocked malicious domains
      // Note: allowlist is primary; this blocklist is a small extra guard.
      // Maintained source: Hagezi DNS Blocklists (domains)
      // https://github.com/hagezi/dns-blocklists
      // Raw (Multi PRO Domains):
      // https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/pro.txt
      blockedDomains: [
        'chrome-store.com',
        'chrome-webstore.com', 
        'google-chrome.com',
        'chromium-store.com',
        'fake-chrome-store.com',
        'malicious-extensions.com'
      ],
      
      // Suspicious URL patterns
      suspiciousPatterns: [
        /bit\.ly|tinyurl|t\.co/i,  // URL shorteners
        /[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/,  // IP addresses
        /localhost|127\.0\.0\.1|0\.0\.0\.0/i,  // Local addresses
        /\.tk$|\.ml$|\.ga$|\.cf$/i,  // Suspicious TLDs
      ]
    };

    // Optional embedded snapshot: paste Hagezi PRO (Domains) here (one per line).
    // Manual refresh: copy from the raw URL above and rebuild.
    const EMBEDDED_HAGEZI_SNAPSHOT = `
    `;
    if (EMBEDDED_HAGEZI_SNAPSHOT.trim().length) {
      const extra = this._parseDomainList(EMBEDDED_HAGEZI_SNAPSHOT);
      if (extra.length) {
        this.webStore.blockedDomains = Array.from(new Set([...(this.webStore.blockedDomains || []), ...extra]));
      }
    }

    // Build a Set for fast suffix checks
    this.blockedDomainsSet = new Set((this.webStore.blockedDomains || [])
      .map(d => String(d).trim().toLowerCase())
      .filter(Boolean));

    // Policy and derived file validation settings
    this.policy = policy || {};
    this.fileValidation = {
      allowedExtensions: this.policy.files?.allowedExtensions || [],
      allowedBasenames: this.policy.files?.allowBasenames || [],
      blockedExtensions: this.policy.files?.blockedExtensions || [],
      blockedPatterns: (this.policy.files?.blockedPatterns || []).map((p) => new RegExp(escapeRegExpLike(p))),
      maxFileSizeWarn: this.policy.files?.maxFileSizeWarn ?? (20 * 1024 * 1024),
      maxFileSizeBlock: this.policy.files?.maxFileSizeBlock ?? (60 * 1024 * 1024),
      maxTotalFilesWarn: this.policy.files?.maxTotalFilesWarn ?? 10000,
      maxTotalFilesBlock: this.policy.files?.maxTotalFilesBlock ?? 50000,
      maxTotalBytesWarn: this.policy.files?.maxTotalBytesWarn ?? (200 * 1024 * 1024),
      maxTotalBytesBlock: this.policy.files?.maxTotalBytesBlock ?? (750 * 1024 * 1024),
      warnUnknownExtensions: this.policy.files?.warnUnknownExtensions !== false
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

  // Parse a simple domain list text (one domain per line, '#' comments allowed)
  _parseDomainList(text) {
    try {
      if (!text) return [];
      const out = [];
      for (const line of String(text).split(/\r?\n/)) {
        const s = String(line).trim();
        if (!s || s.startsWith('#') || s.startsWith('!')) continue;
        // Accept plain "domain.tld" or hosts-style "0.0.0.0 domain.tld"
        const token = s.includes(' ') ? s.split(/\s+/).pop() : s.replace(/^0\.0\.0\.0\s+/, '');
        const d = String(token || '').toLowerCase();
        if (d && /^[a-z0-9.-]+$/.test(d)) out.push(d);
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  // Suffix-match helper: returns true if host or any parent domain is in the blocked set
  _isBlockedHost(host) {
    try {
      const h = String(host || '').toLowerCase();
      if (!h || !this.blockedDomainsSet) return false;
      const parts = h.split('.');
      for (let i = 0; i < parts.length - 1; i++) {
        const cand = parts.slice(i).join('.');
        if (this.blockedDomainsSet.has(cand)) return true;
      }
      // also check TLD+label exact host if single dot (redundant but harmless)
      return this.blockedDomainsSet.has(h);
    } catch (_) {
      return false;
    }
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
      const requireMV3 = this.policy?.manifest?.requireMV3 !== false;
      if (requireMV3 && manifest.manifest_version !== 3) {
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

    const blocked = new Set((this.policy?.permissions?.blocked) || []);
    const dangerous = new Set((this.policy?.permissions?.dangerous) || []);
    const behavior = this.policy?.behavior || {};

    for (const permission of permissions) {
      if (typeof permission !== 'string') {
        result.errors.push('All permissions must be strings');
        result.allowed = false;
        continue;
      }

      if (blocked.has(permission)) {
        result.errors.push(`Blocked permission: ${permission}`);
        result.allowed = false;
        result.riskScore += 60;
        continue;
      }
      if (dangerous.has(permission)) {
        const mode = behavior.onDangerousPermission || 'warn';
        if (mode === 'confirm') {
          result.warnings.push(`Dangerous permission (confirmation may be required): ${permission}`);
        } else {
          result.warnings.push(`Dangerous permission: ${permission}`);
        }
        result.riskScore += 25;
        continue;
      }
      // Default: unknown permissions as medium warning
      result.warnings.push(`Unknown or unclassified permission: ${permission}`);
      result.riskScore += 10;
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

  /**
   * Parse Chrome Web Store URL or extension ID with security validation
   * 
   * @param {string} input - URL or extension ID to parse
   * @returns {string|null} - Extension ID if valid, null if invalid or unsafe
   */
  parseWebStoreUrl(input) {
    if (!input || typeof input !== 'string') {
      return null;
    }
    
    const trimmed = input.trim();
    
    // Check for suspicious patterns first
    if (this.webStore.suspiciousPatterns.some(pattern => pattern.test(trimmed))) {
      console.warn('ManifestValidator: Blocked suspicious URL pattern:', trimmed);
      return null;
    }
    
    // If input looks like a URL, parse and extract ID with robust fallbacks
    const looksLikeUrl = /^\w+:\/\//.test(trimmed);
    if (looksLikeUrl) {
      try {
        const url = new URL(trimmed);

        // Validate domain is in allowlist
        const host = url.hostname.toLowerCase();
        if (!this.webStore.allowedDomains.includes(host)) {
          console.warn('ManifestValidator: Domain not in allowlist:', host);
          return null;
        }

        // Defense-in-depth: check suffix against local blocklist set
        if (this._isBlockedHost(host)) {
          console.warn('ManifestValidator: Blocked malicious domain:', host);
          return null;
        }

        // Validate HTTPS
        if (url.protocol !== 'https:') {
          console.warn('ManifestValidator: Non-HTTPS URL rejected:', trimmed);
          return null;
        }

        // Primary extraction using legacy pattern (current known structure)
        const legacyMatch = trimmed.match(this.webStore.urlPattern);
        if (legacyMatch) {
          return legacyMatch[1].toLowerCase();
        }

        // Fallback 1: scan path segments for a valid extension ID
        const segments = url.pathname.split('/').filter(Boolean);
        for (let i = segments.length - 1; i >= 0; i--) {
          const seg = segments[i];
          if (this.webStore.idPattern.test(seg)) {
            return seg.toLowerCase();
          }
        }

        // Fallback 2: scan query parameter values for a valid extension ID
        for (const [, value] of url.searchParams) {
          if (this.webStore.idPattern.test(value)) {
            return value.toLowerCase();
          }
        }

        // Fallback 3: last-resort search within the full URL (still same host)
        const anyMatch = trimmed.match(/[a-p]{32}/i);
        if (anyMatch) {
          return anyMatch[0].toLowerCase();
        }

        return null;
      } catch (error) {
        console.warn('ManifestValidator: Invalid URL format:', trimmed);
        return null;
      }
    }
    
    // Check if input is a direct extension ID
    if (this.webStore.idPattern.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    
    return null;
  }

  /**
   * Validate Chrome Web Store extension ID format
   * 
   * @param {string} id - Extension ID to validate
   * @returns {boolean} - True if valid format
   */
  isValidExtensionId(id) {
    return this.webStore.idPattern.test(id);
  }

  /**
   * Build Chrome Web Store URL from extension ID
   * 
   * @param {string} id - Extension ID
   * @returns {string} - Chrome Web Store URL
   */
  buildWebStoreUrl(id) {
    if (!this.isValidExtensionId(id)) {
      throw new Error('Invalid extension ID format');
    }
    return `https://chrome.google.com/webstore/detail/${id}`;
  }

  /**
   * Validate extension files for basic security issues
   * Simplified version focusing on essential security checks
   * 
   * @param {string} extensionPath - Extension directory path
   * @returns {Promise<Object>} Validation result
   */
  async validateExtensionFiles(extensionPath) {
    const result = {
      isValid: true,
      errors: [],
      warnings: [],
      fileCount: 0,
      totalBytes: 0
    };

    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      // Capture validation config to avoid "this" context issues in nested functions
      const f = this.fileValidation;
      
      // Recursively check files
      const checkDirectory = async (dirPath) => {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          const relativePath = path.relative(extensionPath, fullPath);
          // Normalize for cross-platform pattern matching (use POSIX separators)
          const relativePathPosix = String(relativePath).split(path.sep).join('/');
          
          if (entry.isDirectory()) {
            // Skip hidden directories and node_modules
            if (entry.name.startsWith('.') || entry.name === 'node_modules') {
              continue;
            }
            await checkDirectory(fullPath);
          } else {
            result.fileCount++;
            
            // Count-based thresholds
            if (result.fileCount > f.maxTotalFilesBlock) {
              if (!result.errors.some(e => e.startsWith('Too many files in extension'))) {
                result.errors.push(`Too many files in extension (max: ${f.maxTotalFilesBlock})`);
              }
              result.isValid = false;
              return;
            }
            if (result.fileCount > f.maxTotalFilesWarn) {
              if (!result.warnings.some(e => e.startsWith('High file count'))) {
                result.warnings.push(`High file count: ${result.fileCount} (warn at ${f.maxTotalFilesWarn})`);
              }
            }
            
            // Check file extension
            const ext = path.extname(entry.name).toLowerCase();
            const base = (ext ? entry.name.slice(0, -ext.length) : entry.name).toLowerCase();
            if (f.blockedExtensions.includes(ext)) {
              result.errors.push(`Blocked file type: ${relativePathPosix}`);
              result.isValid = false;
            } else if (f.blockedPatterns.some((re) => re.test(relativePathPosix))) {
              result.errors.push(`Blocked file pattern: ${relativePathPosix}`);
              result.isValid = false;
            } else {
              const isKnown = f.allowedExtensions.includes(ext) || f.allowedBasenames?.includes(base);
              if (!isKnown && f.warnUnknownExtensions) {
                result.warnings.push(`Unknown file type: ${relativePathPosix}`);
              }
            }
            
            // Check for dangerous patterns already handled above via f.blockedPatterns
            
            // Check file size
            const stats = await fs.stat(fullPath);
            result.totalBytes += stats.size;
            if (stats.size > f.maxFileSizeBlock) {
              result.errors.push(`File too large: ${relativePathPosix} (${stats.size} bytes, max: ${f.maxFileSizeBlock})`);
              result.isValid = false;
            } else if (stats.size > f.maxFileSizeWarn) {
              result.warnings.push(`Large file: ${relativePathPosix} (${stats.size} bytes)`);
            }
          }
        }
      };
      
      await checkDirectory(extensionPath);
      
      // Total size thresholds
      if (result.totalBytes > f.maxTotalBytesBlock) {
        result.errors.push(`Extension too large: ${result.totalBytes} bytes (max: ${f.maxTotalBytesBlock})`);
        result.isValid = false;
      } else if (result.totalBytes > f.maxTotalBytesWarn) {
        result.warnings.push(`Large extension size: ${result.totalBytes} bytes (warn at ${f.maxTotalBytesWarn})`);
      }
      
      if (result.isValid) {
        console.log(`ManifestValidator: Validated ${result.fileCount} files - all passed security checks`);
      }
      
    } catch (error) {
      console.error('ManifestValidator: File validation failed:', error);
      result.errors.push(`File validation failed: ${error.message}`);
      result.isValid = false;
    }

    return result;
  }

  /**
   * Comprehensive extension validation - single entry point
   * 
   * @param {string} extensionPath - Extension directory path  
   * @param {Object} manifest - Extension manifest object
   * @param {string} [sourceUrl] - Optional Chrome Web Store URL for validation
   * @returns {Promise<Object>} Complete validation result
   */
  async validateExtension(extensionPath, manifest, sourceUrl = null) {
    const result = {
      isValid: true,
      errors: [],
      warnings: [],
      manifestValidation: null,
      fileValidation: null,
      urlValidation: null,
      outcome: 'allow'
    };

    try {
      // 1. Validate manifest
      result.manifestValidation = this.validate(manifest);
      if (!result.manifestValidation.isValid) {
        result.errors.push(...result.manifestValidation.errors);
        result.isValid = false;
      }
      result.warnings.push(...result.manifestValidation.warnings);

      // 2. Validate files
      result.fileValidation = await this.validateExtensionFiles(extensionPath);
      if (!result.fileValidation.isValid) {
        result.errors.push(...result.fileValidation.errors);
        result.isValid = false;
      }
      result.warnings.push(...result.fileValidation.warnings);

      // 3. Validate source URL if provided
      if (sourceUrl) {
        const parsedId = this.parseWebStoreUrl(sourceUrl);
        result.urlValidation = {
          isValid: parsedId !== null,
          parsedExtensionId: parsedId,
          originalUrl: sourceUrl
        };
        
        if (!result.urlValidation.isValid) {
          result.errors.push('Invalid Chrome Web Store URL format');
          result.isValid = false;
        }
      }

      // Determine final outcome
      if (!result.isValid) {
        result.outcome = 'deny';
      } else {
        // If any dangerous permissions and policy requires confirm
        const hasDangerous = (result.manifestValidation?.securityInfo?.warnings || [])
          .some(w => /Dangerous permission/i.test(w));
        const needConfirm = this.policy?.behavior?.onDangerousPermission === 'confirm' && hasDangerous;
        result.outcome = needConfirm ? 'confirm' : 'allow';
      }

      console.log(`ManifestValidator: Complete validation ${result.isValid ? 'passed' : 'failed'} for ${manifest.name || 'unknown'} (outcome=${result.outcome})`);
      return result;

    } catch (error) {
      console.error('ManifestValidator: Extension validation error:', error);
      result.errors.push('Internal validation error');
      result.isValid = false;
      return result;
    }
  }
}

export default ManifestValidator;
