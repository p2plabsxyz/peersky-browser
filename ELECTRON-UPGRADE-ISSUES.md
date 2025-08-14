# Electron v37 Upgrade Issues - Comprehensive Analysis

**Project**: Peersky Browser  
**Upgrade**: Electron v29.0.1 → v37.2.2  
**Date**: August 14, 2025  
**Status**: 🔴 Multiple Critical Issues Identified  

---

## 🚀 **Upgrade Summary**

When upgrading Electron from v29.0.1 to v37.2.2, we automatically received upgrades to all bundled components:

| Component | v29.0.1 | v37.2.2 | Change |
|-----------|---------|---------|---------|
| **Node.js** | v18.18.2 | v20.11.1 | +2 major versions |
| **Chromium** | v120.0.6099.56 | v130.0.6723.58 | +10 major versions |
| **V8 JavaScript** | v12.0.267.8 | v13.0.245.12 | +1 major version |
| **Node ABI** | 115 | 127 | +12 ABI versions |
| **Electron ABI** | 24 | 30 | +6 ABI versions |

---

## 🔴 **Critical Issues (App Broken)**

### 1. IPFS/Helia Database Corruption
**Status**: 🔴 **BLOCKING** - Core protocol completely broken  
**Error**:
```
UnhandledPromiseRejectionWarning: Error: Database is not open
at maybeError (/node_modules/abstract-level/abstract-level.js:806:27)
at ClassicLevel.get (/node_modules/abstract-level/abstract-level.js:282:9)
at assertDatastoreVersionIsCurrent
```

**Root Cause**: Level database created with Node.js v18/V8 v12 cannot be opened by Node.js v20/V8 v13  
**Impact**: IPFS protocol handler completely non-functional  
**Files Affected**: 
- `~/Library/Application Support/peersky-browser/ipfs/datastore/` (corrupted)
- `~/Library/Application Support/peersky-browser/ipfs/blocks/` (corrupted)

**Solution Options**:
- [ ] **Option A**: Database migration script using Helia migration tools
- [ ] **Option B**: Clear existing database (lose IPFS data)
- [ ] **Option C**: Downgrade Helia to compatible version temporarily

### 2. Service Worker Storage Failure
**Status**: 🔴 **BLOCKING** - Extensions system compromised  
**Error**:
```
ERROR:components/services/storage/service_worker/service_worker_storage.cc:1732] 
Failed to delete the database: Database IO error
```

**Root Cause**: Chromium v120→v130 service worker storage format incompatibility  
**Impact**: Chrome extension system may be unstable  
**Files Affected**: 
- `~/Library/Application Support/peersky-browser/Service Worker/` (corrupted)

**Solution Options**:
- [ ] **Option A**: Clear service worker cache directory
- [ ] **Option B**: Implement service worker database migration
- [ ] **Option C**: Disable service workers temporarily

### 3. Build System Failure (sodium-native)
**Status**: 🔴 **BLOCKING** - Cannot create distributions  
**Error**:
```
⨯ node-gyp failed to rebuild '/node_modules/hypercore-protocol/node_modules/sodium-native'
```

**Root Cause**: Native module compiled for ABI 115, needs recompilation for ABI 127  
**Impact**: `npm run build` and `npm run postinstall` completely fail  
**Dependencies Affected**: 7 different dependency chains
- hypercore-crypto → sodium-universal → sodium-native
- hyperdht → sodium-universal → sodium-native  
- hyper-sdk → corestore → sodium-universal → sodium-native
- And 4 more...

**Solution Options**:
- [ ] **Option A**: Replace with `libsodium-wrappers-sumo` (WASM, no compilation needed)
- [ ] **Option B**: Use `prebuild-install` for prebuilt binaries
- [ ] **Option C**: Fix native compilation with proper toolchain
- [ ] **Option D**: Switch to `sodium-universal` (auto-fallback to WASM)

---

## 🟡 **Warning Issues (Working but Fragile)**

### 4. ESM Import Pattern Issues
**Status**: 🟡 **WARNING** - Currently working but could break unexpectedly  
**Problem**: Named imports from CommonJS Electron module using old pattern  

**Files with risky imports**:
```javascript
// ❌ Risky patterns that could break:
src/context-menu.js:           import { Menu, MenuItem, clipboard } from "electron";
src/settings-manager.js:       import { app, ipcMain, BrowserWindow } from 'electron';
src/auto-updater.js:           import { app, dialog } from 'electron';
src/actions.js:                import { app, BrowserWindow, globalShortcut } from "electron";
src/protocols/config.js:       import { app } from "electron";
src/protocols/peersky-protocol.js: import { app } from 'electron';
```

**Solution Options**:
- [ ] **Option A**: Convert all to `import pkg from 'electron'; const { app } = pkg;`
- [ ] **Option B**: Test current patterns and only fix if they break
- [ ] **Option C**: Gradual migration as we touch each file

---

## 🟢 **What's Still Working**

✅ **Core Application**:
- App startup and window creation
- Basic navigation and UI
- Protocol registration (http, https, peersky)
- Settings page and extension UI
- Session management system

✅ **Extension System Frontend**:
- Extension management UI loads
- Install from Chrome Web Store UI
- Extension cards display properly

---

## 🎯 **Priority Action Plan**

### **Phase 1: Restore Core Functionality** (High Priority)
1. **Fix IPFS Database Issue** 
   - Clear corrupted database OR implement migration
   - Test IPFS protocol handler functionality
   - Verify `ipfs://` and `ipns://` URL loading

2. **Resolve sodium-native Build Issues**
   - Implement WASM fallback (recommended: libsodium-wrappers-sumo)
   - Test Hypercore protocol functionality
   - Verify build process works: `npm run build`

3. **Clean Service Worker Storage**
   - Clear corrupted service worker cache
   - Test Chrome extension loading
   - Verify extension system functionality

### **Phase 2: Code Hardening** (Medium Priority)  
4. **Fix ESM Import Patterns**
   - Update risky Electron imports to safe patterns
   - Test all affected modules
   - Verify no runtime errors

### **Phase 3: Validation** (Before Release)
5. **Comprehensive Testing**
   - Test all protocol handlers (ipfs, hyper, web3)
   - Test extension installation and management
   - Test build process on all platforms
   - Test auto-updater functionality

---

## 🛠 **Detailed Solutions**

### Solution 1: IPFS Database Migration
```bash
# Option A: Clear and restart (simplest, loses data)
rm -rf ~/Library/Application\ Support/peersky-browser/ipfs/

# Option B: Migration script (preserves data)
# TODO: Research Helia migration tools for Level database upgrades
```

### Solution 2: sodium-native Replacement
```bash
# Replace with WASM version (no compilation needed)
npm uninstall sodium-native
npm install libsodium-wrappers-sumo

# Update code to use new API
# TODO: Update Hypercore dependencies to use WASM version
```

### Solution 3: ESM Import Fix Template
```javascript
// ❌ Old risky pattern:
import { app, BrowserWindow } from 'electron';

// ✅ New safe pattern:
import pkg from 'electron';
const { app, BrowserWindow } = pkg;
```

---

## 📊 **Risk Assessment**

| Issue | Severity | User Impact | Fix Complexity | ETA |
|-------|----------|-------------|----------------|-----|
| IPFS Database | 🔴 Critical | No IPFS support | Medium | 1-2 days |
| Service Worker | 🔴 Critical | Extension issues | Low | 0.5 day |
| sodium-native | 🔴 Critical | No builds | Medium | 1-2 days |
| ESM Imports | 🟡 Warning | Potential crashes | Low | 0.5 day |

**Total estimated fix time**: 3-5 days

---

## 🧪 **Testing Checklist**

After implementing fixes, verify:

- [ ] **IPFS Protocol**: `ipfs://QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o` loads
- [ ] **Hypercore Protocol**: `hyper://` URLs load correctly  
- [ ] **Extension System**: Can install extensions from Chrome Web Store
- [ ] **Build Process**: `npm run build` completes successfully
- [ ] **Cross-Platform**: Test builds on macOS, Windows, Linux
- [ ] **Auto-Updater**: Update mechanism still functional
- [ ] **Performance**: No significant slowdown from WASM crypto

---

## 📚 **References**

- [Electron Breaking Changes v29→v37](https://www.electronjs.org/docs/latest/breaking-changes)
- [Node.js v18→v20 Migration Guide](https://nodejs.org/en/blog/release/v20.0.0)
- [Chromium v120→v130 Changes](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/security/permissions-policy/README.md)
- [Helia Database Migration](https://github.com/ipfs/helia/blob/main/packages/utils/src/utils/datastore-version.ts)
- [libsodium-wrappers-sumo Documentation](https://www.npmjs.com/package/libsodium-wrappers-sumo)

---

**Last Updated**: August 14, 2025  
**Next Review**: After Phase 1 completion