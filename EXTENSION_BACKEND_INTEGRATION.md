# Extension System - Demo Week Implementation Guide

## Goal

Finalize the Extension System for this week's demo per mentor guidance. Complete the 9 core requirements to demonstrate Chrome Web Store extension installation, management, and basic functionality within Peersky Browser.

### Demo Scope
**IMPLEMENT THIS WEEK:**
- Runtime upgrade (Electron ≥35) with persistent session
- Validator policy (warn-only for CSP/size/permissions)
- Registry & IPC handlers (5 core endpoints)
- Manual "Update All" functionality
- Default extensions preinstalled list
- Address-bar detection & P2P stubs (TODOs only)
- Disclaimer & developer documentation
- Test targets & validation harness

**NON-GOALS (Defer):**
- Address-bar Web Store detection + 🧩 icon (prepare TODO only)
- P2P "Bodega/Hoard" distribution (keep settings stub/disabled toggle only)

---

## Integration Architecture

### electron-chrome-web-store Integration
The system leverages `electron-chrome-web-store` package to provide Chrome Web Store compatibility:

```javascript
import { installChromeWebStore, installExtension, updateExtensions } from 'electron-chrome-web-store';

// Initialize Chrome Web Store support
await installChromeWebStore({ 
  session: browserSession,
  extensionsPath: path.join(app.getPath('userData'), 'extensions')
});

// Install specific extension
await installExtension('extension-id-here', { session: browserSession });
```

### Persistent Session Management
All extensions use a single persistent session for consistency:

```javascript
const browserSession = session.fromPartition('persist:peersky');

// BrowserWindow configuration
new BrowserWindow({
  webPreferences: {
    session: browserSession,
    sandbox: true,
    contextIsolation: true
  }
});
```

### Data Model - Registry JSON
Extensions metadata stored in `userData/extensions/extensions.json`:

```json
{
  "extensions": [
    {
      "id": "ublock-origin",
      "electronId": "chrome-extension://cjpalhdlnbpafiamejdnhcphjbkeiagm/",
      "name": "uBlock Origin",
      "version": "1.57.2",
      "enabled": true,
      "installedPath": "/path/to/userData/extensions/ublock-origin",
      "iconPath": "/path/to/userData/extensions/ublock-origin/icon_48.png",
      "permissions": ["declarativeNetRequest", "storage"],
      "source": "preinstalled|webstore|unpacked",
      "webStoreUrl": "https://chrome.google.com/webstore/detail/.../cjpalhdlnbpafiamejdnhcphjbkeiagm",
      "update": { 
        "lastChecked": 1698765432000, 
        "lastResult": "ok|skipped|error" 
      }
    }
  ]
}
```

### IPC Contract - 5 Core Handlers

```javascript
// List all installed extensions
extensions-list()
→ { extensions: Extension[] }

// Toggle extension enabled/disabled state
extensions-toggle(id: string, enabled: boolean)
→ { success: boolean, error?: string }

// Uninstall extension completely
extensions-uninstall(id: string)
→ { success: boolean, error?: string }

// Install extension from Chrome Web Store URL or ID
extensions-install-webstore(urlOrId: string)
→ { success: boolean, id?: string, error?: string }

// Update all extensions to latest versions
extensions-update-all()
→ { updated: string[], skipped: string[], errors: Array<{id: string, message: string}> }

// Optional: Update single extension
extensions-update-one(id: string)
→ { updated: boolean, error?: string }
```

### URL/ID Parsing Utility
Shared utility for parsing Chrome Web Store URLs and extension IDs:

```javascript
const ID_RE = /^[a-p]{32}$/i;
const URL_RE = /^https?:\/\/chrome\.google\.com\/webstore\/detail\/[^/]+\/([a-p]{32})(?:\b|\/)?/i;

function parseUrlOrId(input) {
  const s = (input || '').trim();
  const m = s.match(URL_RE); 
  if (m) return m[1].toLowerCase();
  return ID_RE.test(s) ? s.toLowerCase() : null;
}

// Enable "Install" button only if this returns an ID
const extensionId = parseUrlOrId(userInput);
installButton.disabled = !extensionId;
```

---

## Implementation Specifications

### Core Backend Components

#### ExtensionManager Enhancements
**File:** `src/extensions/index.js`

```javascript
class ExtensionManager {
  constructor() {
    this.session = null;
    this.chromeWebStoreEnabled = false;
  }
  
  async initialize(electronSession) {
    this.session = electronSession;
    
    // Initialize Chrome Web Store support
    await installChromeWebStore({ 
      session: this.session,
      extensionsPath: EXTENSIONS_DATA_PATH 
    });
    this.chromeWebStoreEnabled = true;
  }
  
  // Install from Chrome Web Store URL or ID
  async installFromWebStore(urlOrId) {
    const extensionId = parseUrlOrId(urlOrId);
    if (!extensionId) throw new Error('Invalid Chrome Web Store URL or ID');
    
    const extension = await installExtension(extensionId, { 
      session: this.session 
    });
    
    // Add to registry and return metadata
    return await this._addToRegistry(extension);
  }
  
  // Update all extensions
  async updateAllExtensions() {
    return await updateExtensions({ session: this.session });
  }
}
```

#### Chrome Web Store Integration Wrapper
**File:** `src/extensions/chrome-web-store.js` (NEW)

```javascript
import { installExtension, updateExtensions } from 'electron-chrome-web-store';

export class ChromeWebStoreManager {
  constructor(session) {
    this.session = session;
  }
  
  async installById(extensionId) {
    return await installExtension(extensionId, { session: this.session });
  }
  
  async updateAll() {
    return await updateExtensions({ session: this.session });
  }
  
  async fetchManifest(extensionId) {
    // Fetch extension info without installing
  }
}
```

#### Manifest V3 Validator Enhancements
**File:** `src/extensions/manifest-validator.js`

```javascript
export class ManifestValidator {
  validate(manifest) {
    const errors = [];
    const warnings = [];
    
    // MV3 Requirements
    if (manifest.manifest_version !== 3) {
      errors.push('Must use Manifest V3');
    }
    
    if (!manifest.name || !manifest.version) {
      errors.push('Missing required name or version');
    }
    
    if (!manifest.background?.service_worker) {
      errors.push('Must define background.service_worker for MV3');
    }
    
    // Security checks
    if (manifest.content_security_policy?.includes('unsafe-eval')) {
      warnings.push('CSP contains unsafe-eval');
    }
    
    return { isValid: errors.length === 0, errors, warnings };
  }
}
```

## 📦 Loading Extensions via Electron Modules

### @iamevan/electron-chrome-web-store Integration (v0.11.2)

**Implementation-ready module** providing Chrome Web Store compatibility:

```javascript
import { installChromeWebStore, installExtension, updateExtensions } from '@iamevan/electron-chrome-web-store'

// Drop-in configuration for Peersky
await installChromeWebStore({
  session: session.defaultSession,  // Use Peersky's existing session
  extensionsPath: path.join(app.getPath('userData'), 'extensions', 'webstore'),
  loadExtensions: false,      // Peersky calls session.loadExtension manually
  autoUpdate: false,          // Peersky handles "Update All" manually
  allowlist: undefined,       // No restrictions
  denylist: undefined,        // No restrictions
  minimumManifestVersion: 2   // Support MV2 and MV3
})
```

**API Return Values:**
- `installExtension()`: `Promise<Electron.Extension>` with `{id, name, version, url}` 
- `updateExtensions()`: `Promise<void>` (silent success/failure)
- **Error Types**: `{code: 'INSTALL_ERROR'|'BLOCKED_BY_POLICY'|'EXTENSION_NOT_FOUND', message}`

**Preload Script Requirements:**
- **File**: Copy `./dist/chrome-web-store.preload.js` to build output
- **What it injects**: `chrome.webstorePrivate` API + user agent spoofing  
- **Risk**: LOW - only Chrome Web Store specific APIs, no contextBridge conflicts

**Loading Behavior:**
- `loadExtensions: false` prevents startup auto-loading
- `installExtension()` **always** calls `session.loadExtension()` regardless of setting

**Auto-Update Control:**
- **Disable**: `autoUpdate: false` prevents 5-hour scheduling
- **Manual**: `updateExtensions()` works independently  
- **Targets**: All loaded extensions in session

**Concurrency:** ⚠️ **NO internal serialization** - wrap all installs/updates in `KeyedMutex`

**Storage:** Isolated subdirectory (`extensions/webstore/`) recommended for Web Store extensions

### Dependencies & Setup

#### Package.json Updates
```json
{
  "dependencies": {
    "@iamevan/electron-chrome-web-store": "^0.11.2",
    "electron-chrome-extensions": "^3.0.0", 
    "crx3": "^1.0.0"
  }
}
```

#### Runtime Requirements
- **Electron ≥ 35** (MV3 service worker support)
- **BrowserWindow configuration:**
  ```javascript
  webPreferences: {
    sandbox: true,
    contextIsolation: true,
    session: session.fromPartition('persist:peersky')
  }
  ```

#### Licensing Considerations
- `electron-chrome-extensions` is GPL-3 licensed
- Document Peersky Browser's compatibility with GPL-3
- Consider proprietary licensing if needed

---

## File-by-File Implementation Guide

### src/main.js - Extension System Initialization
```javascript
// Add to main.js initialization
import extensionManager from './extensions/index.js';

app.whenReady().then(async () => {
  // Create persistent session
  const browserSession = session.fromPartition('persist:peersky');
  
  // Initialize extension system
  try {
    console.log('Initializing extension system...');
    await extensionManager.initialize(browserSession);
    console.log('Extension system initialized successfully');
  } catch (error) {
    console.error('Failed to initialize extension system:', error);
  }
});

// Shutdown handling
app.on('before-quit', async () => {
  await extensionManager.shutdown();
});
```

### src/extensions/index.js - Core Manager Logic
**Enhancements to existing ExtensionManager:**

```javascript
// Add Chrome Web Store support
import { installChromeWebStore, installExtension, updateExtensions } from 'electron-chrome-web-store';

class ExtensionManager {
  async initialize(electronSession) {
    // ... existing initialization ...
    
    // Initialize Chrome Web Store
    await installChromeWebStore({
      session: electronSession,
      extensionsPath: EXTENSIONS_DATA_PATH,
      autoUpdate: false // Manual updates only for MVP
    });
    
    // Load preinstalled extensions
    await this._loadPreinstalledExtensions();
  }
  
  async installFromWebStore(urlOrId) {
    const extensionId = parseUrlOrId(urlOrId);
    if (!extensionId) {
      throw new Error('Invalid Chrome Web Store URL or extension ID');
    }
    
    try {
      // Install via electron-chrome-web-store
      const result = await installExtension(extensionId, { 
        session: this.session 
      });
      
      // Add to registry
      const extensionData = await this._createRegistryEntry(result);
      await this._saveExtensionMetadata(extensionData);
      
      return { success: true, extension: extensionData };
    } catch (error) {
      console.error('Chrome Web Store installation failed:', error);
      throw error;
    }
  }
  
  async updateAllExtensions() {
    try {
      const result = await updateExtensions({ session: this.session });
      
      // Update registry with new versions
      await this._updateRegistryVersions(result);
      
      return {
        updated: result.updated || [],
        skipped: result.skipped || [],
        errors: result.errors || []
      };
    } catch (error) {
      console.error('Extension update failed:', error);
      throw error;
    }
  }
  
  async _loadPreinstalledExtensions() {
    const preinstalledPath = path.join(EXTENSIONS_DATA_PATH, 'preinstalled.json');
    
    if (await fs.pathExists(preinstalledPath)) {
      const preinstalled = await fs.readJson(preinstalledPath);
      
      for (const ext of preinstalled.extensions || []) {
        if (!this.loadedExtensions.has(ext.id)) {
          await this._installPreinstalledExtension(ext);
        }
      }
    }
  }
}
```

### src/ipc-handlers/extensions.js - IPC Handlers Implementation
**Complete implementation of 5 core handlers:**

```javascript
import { ipcMain } from 'electron';
import extensionManager from '../extensions/index.js';

export function setupExtensionIpcHandlers() {
  // List all extensions
  ipcMain.handle('extensions-list', async () => {
    try {
      const extensions = await extensionManager.listExtensions();
      return { success: true, extensions };
    } catch (error) {
      console.error('ExtensionIPC: extensions-list failed:', error);
      return { success: false, error: error.message, extensions: [] };
    }
  });
  
  // Toggle extension state
  ipcMain.handle('extensions-toggle', async (event, id, enabled) => {
    try {
      await extensionManager.toggleExtension(id, enabled);
      return { success: true };
    } catch (error) {
      console.error('ExtensionIPC: extensions-toggle failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Uninstall extension
  ipcMain.handle('extensions-uninstall', async (event, id) => {
    try {
      await extensionManager.uninstallExtension(id);
      return { success: true };
    } catch (error) {
      console.error('ExtensionIPC: extensions-uninstall failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Install from Chrome Web Store
  ipcMain.handle('extensions-install-webstore', async (event, urlOrId) => {
    try {
      const result = await extensionManager.installFromWebStore(urlOrId);
      return { success: true, id: result.extension.id };
    } catch (error) {
      console.error('ExtensionIPC: extensions-install-webstore failed:', error);
      return { success: false, error: error.message };
    }
  });
  
  // Update all extensions
  ipcMain.handle('extensions-update-all', async () => {
    try {
      const result = await extensionManager.updateAllExtensions();
      return { success: true, ...result };
    } catch (error) {
      console.error('ExtensionIPC: extensions-update-all failed:', error);
      return { success: false, error: error.message, updated: [], skipped: [], errors: [] };
    }
  });
  
  // Optional: Update single extension
  ipcMain.handle('extensions-update-one', async (event, id) => {
    try {
      const result = await extensionManager.updateExtension(id);
      return { success: true, updated: result.updated };
    } catch (error) {
      console.error('ExtensionIPC: extensions-update-one failed:', error);
      return { success: false, error: error.message, updated: false };
    }
  });
}
```

### userData/extensions/preinstalled.json - Preinstalled Extensions Config
**File:** `userData/extensions/preinstalled.json` (NEW)

```json
{
  "extensions": [
    {
      "id": "ublock-origin",
      "name": "uBlock Origin",
      "version": "1.57.2",
      "webStoreId": "cjpalhdlnbpafiamejdnhcphjbkeiagm",
      "enabled": true,
      "description": "Ad blocker for a cleaner web experience"
    },
    {
      "id": "dark-reader",
      "name": "Dark Reader", 
      "version": "4.9.80",
      "webStoreId": "eimadpbcbfnmbkopoojfekhnkhdbieeh",
      "enabled": false,
      "description": "Dark theme for every website"
    }
  ]
}
```

---

## Frontend Integration Points

### src/pages/static/js/extensions-page.js - Replace Mock Data

**Key modifications to existing extensions-page.js:**

```javascript
// Remove mock EXTENSIONS array, replace with IPC calls
let EXTENSIONS = [];
let extensionStates = {};

// Load real extension data
async function loadExtensions() {
  try {
    const result = await window.electronAPI.extensions.listExtensions();
    if (result.success) {
      EXTENSIONS = result.extensions;
      initializeStates();
      renderExtensions();
    } else {
      showError('Failed to load extensions: ' + result.error);
    }
  } catch (error) {
    console.error('Failed to load extensions:', error);
    showError('Failed to load extensions');
  }
}

// Connect Install from URL to backend
async function handleInstallFromURL() {
  const urlInput = document.getElementById('install-url');
  const url = urlInput.value.trim();
  
  if (!url) return;
  
  // Show installing status
  showStatus('Installing extension...', 'info');
  
  try {
    const result = await window.electronAPI.extensions.installFromWebStore(url);
    if (result.success) {
      showStatus(`Extension installed successfully!`, 'success');
      await loadExtensions(); // Refresh list
      urlInput.value = '';
    } else {
      showStatus('Installation failed: ' + result.error, 'error');
    }
  } catch (error) {
    console.error('Installation error:', error);
    showStatus('Installation failed', 'error');
  }
}

// Connect toggle to backend
async function handleToggleChange(event) {
  const extensionId = event.target.dataset.extensionId;
  const isEnabled = event.target.checked;
  
  try {
    const result = await window.electronAPI.extensions.toggleExtension(extensionId, isEnabled);
    if (result.success) {
      // Update local state
      extensionStates[extensionId] = isEnabled;
      const extension = EXTENSIONS.find(ext => ext.id === extensionId);
      if (extension) extension.enabled = isEnabled;
    } else {
      // Revert toggle on failure
      event.target.checked = !isEnabled;
      showError('Failed to toggle extension: ' + result.error);
    }
  } catch (error) {
    event.target.checked = !isEnabled;
    showError('Failed to toggle extension');
  }
}

// Connect remove to backend
async function handleRemoveExtension(extensionId) {
  const extension = EXTENSIONS.find(ext => ext.id === extensionId);
  if (!extension) return;
  
  const confirmed = confirm(`Remove "${extension.name}" extension?\n\nThis action cannot be undone.`);
  if (confirmed) {
    try {
      const result = await window.electronAPI.extensions.uninstallExtension(extensionId);
      if (result.success) {
        await loadExtensions(); // Refresh list
        showStatus('Extension removed successfully', 'success');
      } else {
        showError('Failed to remove extension: ' + result.error);
      }
    } catch (error) {
      showError('Failed to remove extension');
    }
  }
}

// Add Update All functionality
async function handleUpdateAll() {
  showStatus('Checking for updates...', 'info');
  
  try {
    const result = await window.electronAPI.extensions.updateAll();
    if (result.success) {
      const { updated, skipped, errors } = result;
      let message = `Update complete: ${updated.length} updated, ${skipped.length} skipped`;
      if (errors.length > 0) message += `, ${errors.length} errors`;
      
      showStatus(message, updated.length > 0 ? 'success' : 'info');
      
      if (updated.length > 0) {
        await loadExtensions(); // Refresh if updates occurred
      }
    } else {
      showError('Update failed: ' + result.error);
    }
  } catch (error) {
    showError('Update failed');
  }
}

// Status messaging system
function showStatus(message, type = 'info') {
  // Implementation for showing status messages
  console.log(`[${type.toUpperCase()}] ${message}`);
  // TODO: Add visual status display to UI
}

// Initialize with real data
async function init() {
  await loadExtensions();
  
  // ... rest of existing event listeners ...
  
  // Add Update All button event listener
  const updateAllBtn = document.getElementById('update-all-btn');
  if (updateAllBtn) {
    updateAllBtn.addEventListener('click', handleUpdateAll);
  }
}
```

### Add Update All Button to HTML
**Modification to** `src/pages/extensions.html`:

```html
<!-- Add near the title -->
<div class="extension-header-controls">
  <h1 class="section-title">Extension Management</h1>
  <button type="button" id="update-all-btn" class="btn btn-secondary">Update All</button>
</div>
```

---

## Key Integration Features

### Chrome Web Store Integration Workflow

1. **URL/ID Input Parsing:**
   ```javascript
   const extensionId = parseUrlOrId(userInput);
   // Validates and extracts Chrome Web Store extension ID
   ```

2. **Extension Installation:**
   ```javascript
   // Frontend → IPC → Backend
   extensions-install-webstore(urlOrId) → installFromWebStore() → installExtension()
   ```

3. **CRX Processing:**
   - `electron-chrome-web-store` handles CRX download
   - Automatic extraction to `userData/extensions/{id}/`
   - Manifest validation and registry update
   - Load into Electron session if enabled

4. **Update System:**
   ```javascript
   // Manual update all extensions
   updateExtensions() → compare manifest.version → replace if newer → reload if enabled
   ```

### Extension Management Lifecycle

#### Installation Flow
1. User enters Chrome Web Store URL
2. Frontend validates URL and extracts extension ID
3. IPC call to `extensions-install-webstore`
4. Backend downloads CRX via electron-chrome-web-store
5. Extract, validate manifest (MV3 compliance)
6. Add to registry JSON and load into session
7. Update UI with new extension

#### Enable/Disable Flow
1. User toggles extension switch
2. IPC call to `extensions-toggle` 
3. Backend calls `session.loadExtension()` or `session.removeExtension()`
4. Update registry enabled state
5. Confirm toggle state in UI

#### Uninstall Flow
1. User clicks Remove button with confirmation
2. IPC call to `extensions-uninstall`
3. Backend removes from session and deletes files
4. Remove from registry JSON
5. Refresh extension list in UI

#### Update Flow
1. User clicks "Update All" button  
2. IPC call to `extensions-update-all`
3. Backend fetches latest versions for all extensions
4. Compare `manifest.version` with installed versions
5. Download and replace extensions with newer versions
6. Reload updated extensions in session
7. Show update results in UI status message

---

## Implementation Priority

### Phase 1: Core Backend Wiring (Week 1)
**Priority: Critical**
1. Modify `src/main.js` to initialize extension system with persistent session
2. Enhance `src/extensions/index.js` with Chrome Web Store integration
3. Implement all 5 IPC handlers in `src/ipc-handlers/extensions.js`
4. Create URL/ID parsing utility functions
5. **Copy `chrome-web-store.preload.js` to build output** (required for Web Store API)
6. **Wrap all extension installs/updates in `KeyedMutex`** (module lacks concurrency control)
7. Test basic extension loading and session integration

### Phase 2: Chrome Web Store Integration (Week 1-2) 
**Priority: High**
1. Create `src/extensions/chrome-web-store.js` wrapper
2. Implement `installFromWebStore()` method with CRX handling
3. Add manifest validation for MV3 compliance
4. Test installation from Chrome Web Store URLs and IDs
5. Implement registry JSON management

### Phase 3: UI-Backend Connection (Week 2)
**Priority: High**  
1. Replace mock data in `src/pages/static/js/extensions-page.js`
2. Connect Install from URL input to IPC handlers
3. Implement real extension toggle/remove functionality
4. Add status messaging for installation and errors
5. Test complete user workflow from UI to backend

### Phase 4: Preinstalled Extensions (Week 2-3)
**Priority: Medium**
1. Create `userData/extensions/preinstalled.json` configuration
2. Implement preinstalled extension loading on first run
3. Add common extensions (uBlock Origin, Dark Reader) as defaults
4. Test preinstalled extension workflow

### Phase 5: Manual Update System (Week 3)
**Priority: Medium**
1. Implement `updateAllExtensions()` method
2. Add "Update All" button to UI
3. Create update status messaging
4. Test extension version comparison and updating
5. Handle update errors gracefully

---

## Acceptance Criteria

### Core Backend Integration
- ✅ **Persistent session loading works:** Extensions persist across browser restarts using `persist:peersky` session
- ✅ **Extension registry functional:** Extensions metadata properly stored/loaded from `userData/extensions/extensions.json`
- ✅ **IPC handlers operational:** All 5 core IPC handlers (`list`, `toggle`, `uninstall`, `install-webstore`, `update-all`) respond correctly
- ✅ **Basic error handling:** IPC handlers return proper error responses, don't crash on invalid input

### Chrome Web Store Integration  
- ✅ **Install from URL/ID functional:** Users can install extensions using Chrome Web Store URLs or extension IDs
- ✅ **URL parsing works:** `parseUrlOrId()` correctly extracts extension IDs from Chrome Web Store URLs
- ✅ **CRX download/extraction:** `electron-chrome-web-store` successfully downloads and extracts extension files
- ✅ **Session loading:** Installed extensions properly load into Electron session and function correctly

### Extension Management
- ✅ **Toggle functionality works:** Extensions can be enabled/disabled via UI with session load/unload
- ✅ **Uninstall cleanup:** Extensions are completely removed (files, registry, session) when uninstalled
- ✅ **Extension metadata display:** UI shows real extension data (name, version, description, enabled state) from backend

### Preinstalled Extensions
- ✅ **First-run loading:** Preinstalled extensions from `preinstalled.json` are installed on first browser launch
- ✅ **Default extensions available:** At least 2 common extensions (uBlock Origin, Dark Reader) available as defaults
- ✅ **No duplicate installations:** Preinstalled extensions don't reinstall if already present

### Update System
- ✅ **Manual Update All functional:** "Update All" button successfully checks and updates outdated extensions
- ✅ **Version comparison works:** System correctly identifies extensions that need updates by comparing `manifest.version`
- ✅ **Update status reporting:** UI shows meaningful update results (X updated, Y skipped, Z errors)

### Manifest V3 Validation
- ✅ **MV3 compliance blocking:** Extensions with invalid Manifest V3 structure are rejected during installation
- ✅ **Required field validation:** Extensions missing `name`, `version`, or `background.service_worker` are blocked
- ✅ **CSP security checking:** Extensions with unsafe CSP policies generate warnings or are blocked

### UI Integration
- ✅ **Real extension data display:** UI shows actual installed extensions, not mock data
- ✅ **Install input validation:** Install button is disabled unless valid Chrome Web Store URL/ID is entered  
- ✅ **Status messaging works:** Users receive feedback for installation progress, success, and error states
- ✅ **Extension list refresh:** UI automatically updates when extensions are installed/uninstalled/updated

---

## Definition of MVP Complete

The extension system MVP is considered complete when:

1. **Core Installation:** Users can install Chrome Web Store extensions via URL input
2. **Extension Management:** Users can enable/disable and uninstall extensions through UI
3. **Persistence:** Extensions remain installed and maintain state across browser restarts
4. **Updates:** Users can manually update all extensions via "Update All" button
5. **Preinstalled Support:** Default extensions are automatically installed on first run
6. **Error Handling:** System gracefully handles invalid extensions and network failures
7. **Session Integration:** Extensions properly integrate with browser tabs and functionality

This MVP provides the essential foundation for Chrome extension compatibility while deferring advanced features like P2P distribution, automatic updates, and advanced permissions management for future iterations.