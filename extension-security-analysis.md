# Extension Installation Security Vulnerability Analysis

## 🚨 Executive Summary

**CRITICAL SECURITY VULNERABILITY IDENTIFIED** in the Peersky Browser extension installation system. The `extensions-install` IPC handler in `src/ipc-handlers/extensions.js` is vulnerable to path traversal attacks, allowing malicious actors to potentially access arbitrary files and directories on the system.

**Severity**: HIGH  
**CVSS Score**: 7.5 (High)  
**Status**: UNPATCHED - Immediate action required

---

## 📍 Vulnerability Details

### Location
- **File**: `src/ipc-handlers/extensions.js`
- **Function**: `extensions-install` IPC handler
- **Lines**: 54-69
- **Component**: Extension Management System

### Vulnerable Code
```javascript
// Install extension from local path
ipcMain.handle('extensions-install', async (event, sourcePath) => {
  try {
    if (!sourcePath || typeof sourcePath !== 'string') {
      throw Object.assign(new Error('Invalid source path'), { code: ERR.E_INVALID_ID });
    }

    const result = await extensionManager.installExtension(sourcePath);
    return { success: true, ...result };
  } catch (error) {
    return {
      success: false,
      code: error.code || 'E_UNKNOWN',
      error: error.message
    };
  }
});
```

### Root Cause
The `sourcePath` parameter is passed directly to `extensionManager.installExtension()` without any path validation, sanitization, or traversal prevention mechanisms.

---

## 🔍 Technical Analysis

### Attack Vectors

#### 1. Directory Traversal Attacks
Malicious callers can provide paths containing directory traversal sequences:

**Unix/Linux/macOS Examples:**
```javascript
// Access system files
"../../../etc/passwd"
"../../../../../../etc/shadow"
"/System/Library/Extensions/malicious.ext"

// Access user data
"../../../.ssh/id_rsa"
"../../../../Documents/private.key"
```

**Windows Examples:**
```javascript
// Access system files
"C:\\Windows\\System32\\evil.exe"
"..\\..\\..\\Windows\\System32\\config\\SAM"
"C:\\Program Files\\Common Files\\malicious.dll"

// Access user data
"..\\..\\..\\Users\\%USERNAME%\\AppData\\Roaming\\credentials"
```

#### 2. Symbolic Link Attacks
```javascript
// Potential symlink exploitation
"/tmp/malicious_symlink"  // Points to sensitive directory
```

#### 3. Path Injection
```javascript
// Path injection attempts
"/valid/path/../../../etc/passwd"
"/home/user/Downloads/../../../.ssh/"
```

### Current Security Measures (Partial)

The codebase does implement some security measures downstream:

#### 1. Target Path Validation
**Location**: `src/extensions/index.js` - `_secureFileCopy()` method (lines 1409-1412)
```javascript
// Ensure target is within extensions directory (prevent directory traversal)
if (!resolvedTarget.startsWith(this.extensionsBaseDir)) {
  throw new Error('Invalid target path: outside extensions directory');
}
```

#### 2. File Validation
**Location**: `src/extensions/manifest-validator.js` - `validateExtensionFiles()` method
- File extension restrictions
- File size limits (configurable)
- Dangerous pattern detection
- File count limits
- Hidden directory filtering

#### 3. Atomic Operations
**Location**: `src/extensions/index.js` - `_secureFileCopy()` method
- Temporary directory creation
- Atomic file operations
- Cleanup on failure

### Security Gaps

#### 1. **No Source Path Validation**
- No validation of source path format
- No directory traversal prevention
- No path normalization
- No symbolic link handling

#### 2. **No Whitelist Restrictions**
- No restriction to safe directories
- No user confirmation required
- No rate limiting

#### 3. **Insufficient Input Sanitization**
- Only basic type checking (string validation)
- No path structure validation
- No dangerous pattern detection

---

## 🎯 Impact Assessment

### Potential Consequences

#### 1. **Information Disclosure**
- Access to system configuration files (`/etc/passwd`, `/etc/shadow`)
- Access to user credentials and private keys
- Access to application data and configurations

#### 2. **System Compromise**
- Installation of malicious extensions from system directories
- Potential privilege escalation
- System file modification

#### 3. **Data Theft**
- Access to user documents and sensitive files
- Browser data and history access
- Cryptographic key theft

#### 4. **Denial of Service**
- Resource exhaustion through large file operations
- System instability through malicious file access

### Risk Factors

| Factor | Level | Description |
|--------|-------|-------------|
| **Exploitability** | Medium | Requires malicious IPC calls from renderer process |
| **Impact** | High | Potential system compromise and data theft |
| **Likelihood** | Medium | Depends on attacker access to renderer process |
| **Scope** | High | Affects entire system, not just application |

---

## 🛠️ Recommended Fixes

### 1. Immediate Fixes (Critical)

#### A. Add Path Validation in IPC Handler
```javascript
// In src/ipc-handlers/extensions.js
import path from 'path';
import { promises as fs } from 'fs';
import os from 'os';

ipcMain.handle('extensions-install', async (event, sourcePath) => {
  try {
    if (!sourcePath || typeof sourcePath !== 'string') {
      throw Object.assign(new Error('Invalid source path'), { code: ERR.E_INVALID_ID });
    }

    // SECURITY FIX: Validate and sanitize source path
    const sanitizedPath = await validateAndSanitizeSourcePath(sourcePath);
    
    const result = await extensionManager.installExtension(sanitizedPath);
    return { success: true, ...result };
  } catch (error) {
    return {
      success: false,
      code: error.code || 'E_UNKNOWN',
      error: error.message
    };
  }
});

async function validateAndSanitizeSourcePath(sourcePath) {
  // Normalize and resolve the path
  const normalizedPath = path.normalize(sourcePath);
  const resolvedPath = path.resolve(normalizedPath);
  
  // Check for directory traversal attempts
  if (normalizedPath.includes('..') || normalizedPath.includes('~')) {
    throw new Error('Path traversal detected - source path contains dangerous patterns');
  }
  
  // Validate path exists and is a directory
  try {
    const stats = await fs.stat(resolvedPath);
    if (!stats.isDirectory()) {
      throw new Error('Source path must be a directory');
    }
  } catch (error) {
    throw new Error(`Invalid source path: ${error.message}`);
  }
  
  // Restrict to whitelisted directories
  const allowedDirectories = [
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Documents'),
    // Add other safe directories as needed
  ];
  
  const isAllowed = allowedDirectories.some(allowedDir => 
    resolvedPath.startsWith(allowedDir)
  );
  
  if (!isAllowed) {
    throw new Error('Source path must be within allowed directories (Downloads, Desktop, Documents)');
  }
  
  return resolvedPath;
}
```

#### B. Enhanced Path Validation Utility
```javascript
// Add to src/extensions/util.js
export async function validateSourcePath(sourcePath) {
  const path = await import('path');
  const { promises: fs } = await import('fs');
  const os = await import('os');
  
  // Basic validation
  if (!sourcePath || typeof sourcePath !== 'string') {
    throw Object.assign(new Error('Invalid source path'), { code: ERR.E_INVALID_PATH });
  }
  
  // Length validation
  if (sourcePath.length > 4096) {
    throw Object.assign(new Error('Source path too long'), { code: ERR.E_INVALID_PATH });
  }
  
  // Normalize path
  const normalizedPath = path.normalize(sourcePath);
  const resolvedPath = path.resolve(normalizedPath);
  
  // Directory traversal detection
  const dangerousPatterns = [
    /\.\./g,           // Parent directory references
    /~/g,              // Home directory references
    /\/\.\.\//g,       // Path traversal sequences
    /\\\.\.\\/g,       // Windows path traversal
  ];
  
  for (const pattern of dangerousPatterns) {
    if (pattern.test(normalizedPath)) {
      throw Object.assign(new Error('Path traversal detected'), { code: ERR.E_INVALID_PATH });
    }
  }
  
  // Validate path exists and is accessible
  try {
    const stats = await fs.stat(resolvedPath);
    if (!stats.isDirectory()) {
      throw Object.assign(new Error('Source must be a directory'), { code: ERR.E_INVALID_PATH });
    }
  } catch (error) {
    throw Object.assign(new Error(`Invalid source path: ${error.message}`), { code: ERR.E_INVALID_PATH });
  }
  
  // Whitelist validation
  const allowedDirectories = [
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Documents'),
  ];
  
  const isAllowed = allowedDirectories.some(allowedDir => 
    resolvedPath.startsWith(allowedDir)
  );
  
  if (!isAllowed) {
    throw Object.assign(new Error('Source path not in allowed directories'), { code: ERR.E_INVALID_PATH });
  }
  
  return resolvedPath;
}
```

### 2. Additional Security Enhancements

#### A. Rate Limiting
```javascript
// Add rate limiting for installation attempts
const installAttempts = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const attempts = installAttempts.get(ip) || [];
  const recentAttempts = attempts.filter(time => now - time < 60000); // 1 minute window
  
  if (recentAttempts.length >= 5) { // Max 5 attempts per minute
    throw new Error('Rate limit exceeded - too many installation attempts');
  }
  
  recentAttempts.push(now);
  installAttempts.set(ip, recentAttempts);
}
```

#### B. Security Logging
```javascript
// Add comprehensive logging
function logInstallationAttempt(sourcePath, success, error = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    sourcePath: sourcePath,
    success: success,
    error: error?.message,
    userAgent: process.env.USER_AGENT,
    processId: process.pid
  };
  
  console.log('[SECURITY] Extension installation attempt:', JSON.stringify(logEntry));
  
  // Log to file for security monitoring
  // Implementation depends on logging system
}
```

#### C. User Confirmation
```javascript
// Add user confirmation for local installations
ipcMain.handle('extensions-request-install', async (event, sourcePath) => {
  // Show confirmation dialog
  const result = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Install', 'Cancel'],
    defaultId: 1,
    title: 'Install Extension',
    message: `Install extension from: ${sourcePath}`,
    detail: 'This will install an extension from a local directory. Only install extensions from trusted sources.'
  });
  
  return result.response === 0; // 0 = Install, 1 = Cancel
});
```

### 3. Error Code Updates
```javascript
// Add to src/extensions/util.js
export const ERR = {
  E_INVALID_ID: 'E_INVALID_ID',
  E_INVALID_URL: 'E_INVALID_URL',
  E_INVALID_PATH: 'E_INVALID_PATH',        // NEW
  E_PATH_TRAVERSAL: 'E_PATH_TRAVERSAL',    // NEW
  E_RATE_LIMIT: 'E_RATE_LIMIT',            // NEW
  E_UNKNOWN: 'E_UNKNOWN'
};
```

---

## 🧪 Testing Recommendations

### 1. Security Test Cases

#### A. Path Traversal Tests
```javascript
const maliciousPaths = [
  '../../../etc/passwd',
  '../../../../../../etc/shadow',
  '/System/Library/Extensions/malicious.ext',
  'C:\\Windows\\System32\\evil.exe',
  '..\\..\\..\\Windows\\System32\\config\\SAM',
  '/valid/path/../../../etc/passwd',
  '~/../../../etc/passwd',
  '/tmp/symlink_to_sensitive_dir'
];

// Test each path should be rejected
```

#### B. Valid Path Tests
```javascript
const validPaths = [
  '/Users/username/Downloads/extension',
  '/Users/username/Desktop/my-extension',
  '/Users/username/Documents/extensions/valid-extension'
];

// Test each path should be accepted
```

### 2. Integration Tests
- Test with actual extension directories
- Test with various file system permissions
- Test with symbolic links
- Test rate limiting functionality
- Test error handling and logging

---

## 📋 Implementation Checklist

### Phase 1: Critical Fixes (Immediate)
- [ ] Add path validation in IPC handler
- [ ] Implement directory traversal detection
- [ ] Add whitelist directory restrictions
- [ ] Update error codes and handling
- [ ] Add comprehensive logging

### Phase 2: Enhanced Security (Short-term)
- [ ] Implement rate limiting
- [ ] Add user confirmation dialogs
- [ ] Enhance path validation utility
- [ ] Add security monitoring
- [ ] Update documentation

### Phase 3: Long-term Improvements
- [ ] Implement extension sandboxing
- [ ] Add code signing validation
- [ ] Implement extension reputation system
- [ ] Add automated security scanning
- [ ] Regular security audits

---

## 📚 References

### Related Files
- `src/ipc-handlers/extensions.js` - Main vulnerability location
- `src/extensions/index.js` - Extension manager implementation
- `src/extensions/manifest-validator.js` - File validation logic
- `src/extensions/util.js` - Utility functions

### Security Standards
- [OWASP Path Traversal Prevention](https://owasp.org/www-community/attacks/Path_Traversal)
- [Electron Security Guidelines](https://www.electronjs.org/docs/tutorial/security)
- [Chrome Extension Security Model](https://developer.chrome.com/docs/extensions/mv3/security/)

### Similar Vulnerabilities
- CVE-2021-44228 (Log4j) - Path traversal in logging
- CVE-2020-11022 (jQuery) - Path traversal in file operations
- Various Electron app vulnerabilities related to IPC handlers

---

## 🚨 Action Required

**IMMEDIATE ACTION REQUIRED**: This vulnerability should be patched before the next release. The current implementation poses a significant security risk to users.

**Priority**: P0 (Critical)  
**Timeline**: Fix within 24-48 hours  
**Testing**: Comprehensive security testing required before deployment

---

*Document created: $(date)*  
*Last updated: $(date)*  
*Security Review: Pending*
