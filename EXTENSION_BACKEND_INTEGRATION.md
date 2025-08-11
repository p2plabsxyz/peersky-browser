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

## 1) Runtime & Versions

### Tasks
- **Upgrade Electron to latest stable (≥35)**
  - File: `package.json`
  - Update electron dep and any related builder targets; run `npm install`
  - Current version: `29.0.1` → Target: `≥35.0.0`

- **Ensure runtime flags on all BrowserWindows:**
  ```javascript
  webPreferences: { 
    session: session.fromPartition('persist:peersky'), 
    sandbox: true, 
    contextIsolation: true 
  }
  ```
  - Files: `src/main.js`, any custom window creators

### Acceptance Criteria
✅ App boots with updated Electron  
✅ Persistent session `persist:peersky` is used  
✅ No runtime errors

---

## 2) Validator Policy (Warn, don't block)

### Tasks
- **Update MV3 validator logic to warn (not block) for CSP risks:**
  - `unsafe-eval`, remote scripts/hosts in CSP
  - File: `src/extensions/manifest-validator.js`

- **Enforce required MV3 fields (still blocking if missing):**
  - `manifest_version === 3`, `name`, `version`, `background.service_worker`

- **Add soft limits (warnings only):**
  - Uncompressed size warn at 10-15 MB
  - Permissions warn if `host_permissions` is `<all_urls>` or include "sensitive" APIs
  - Examples: `webRequestBlocking`, `declarativeNetRequestWithHostAccess`

- **Allow all in dev mode:** warnings logged, no block except missing MV3 required fields

### Acceptance Criteria
✅ Invalid MV3 structure blocks install  
✅ CSP/size/permission issues only produce warnings (returned to UI + console)

---

## 3) Registry & IPC (Confirm/Adjust)

### Keep 5 IPC handlers:
- `extensions-list()` → `{ success, extensions }`
- `extensions-toggle(id, enabled)` → `{ success, error? }`
- `extensions-uninstall(id)` → `{ success, error? }`
- `extensions-install-webstore(urlOrId)` → `{ success, id?, error? }`
- `extensions-update-all()` → `{ success, updated: string[], skipped: string[], errors: Array<{id, message}> }`

### Tasks
- **Confirm handlers exist** in `src/ipc-handlers/extensions.js`; align return shapes above
- **In** `src/extensions/index.js`, **ensure:**
  - Atomic install/update (download to temp → validate → move into place → update registry → load if enabled)
  - Per-extension op mutex (avoid concurrent toggle/update/uninstall on same id)
  - `electronId` is stored and re-derived on startup if missing by reloading enabled extensions

### Acceptance Criteria
✅ All IPC endpoints respond  
✅ No partial installs on failure  
✅ Toggles/uninstalls are consistent with registry and session

---

## 4) Manual Update All (single button)

### Tasks
- **Keep only Update All** (no per-extension Update buttons)
- **Backend:** implement/update `updateAllExtensions()` (Web Store sources only)
- **Renderer:** button calls `extensions-update-all()`, shows counts `{updated/skipped/errors}`
- **Files:** `src/extensions/index.js`, `src/pages/static/js/extensions-page.js`
- **Version compare** by `manifest.version`. If newer → replace dir atomically → reload if enabled

### Acceptance Criteria
✅ Clicking "Update All" updates at least one extension when a newer version exists  
✅ Reports summary to UI

---

## 5) Address-bar Detection & P2P Stubs (deferred)

### Tasks
- **Add TODO stubs only:**
  - Address-bar detection placeholder (module/file with TODO & regex used elsewhere). Do not wire into UI
  - P2P settings toggle in UI set to disabled with tooltip "Coming this fall (with Mauve)"
- **Files:** `src/pages/extensions.html`, `src/pages/static/js/extensions-page.js` (UI stub), `src/pages/theme/extensions-page.css` (minor style), and a small module `src/extensions/p2p-stub.js` exporting constants/TODO
- **Add issue references** in comments (link to p2p Issue #42)

### Acceptance Criteria
✅ Toggle visible but disabled with tooltip  
✅ No functionality  
✅ Code contains TODO with links

---

## 6) Default Extensions (preinstalled list)

### Tasks
- **Create/Update** `userData/extensions/preinstalled.json` (or repo-bundled equivalent used on first run) with mentor's list:
  - uBlock Origin
  - https://github.com/p2plabsxyz/extension-peersky-history
  - https://github.com/p2plabsxyz/extension-consent-autodeny
  - https://archiveweb.page/
  - https://linguister.io/
  - https://github.com/darkreader/darkreader

- **On first run:**
  - Install/register these; set `source: "preinstalled"` (or `"unpacked"` if bundled paths)
  - Enable default ones per mentor preference (uBlock: enabled; Dark Reader: off by default is common; others: enabled unless known conflicts)

### Acceptance Criteria
✅ Fresh profile shows the default list (never empty)  
✅ No duplicate reinstalls on restart

---

## 7) Disclaimer & Dev Docs

### Tasks
- **Add a small disclaimer** in `peersky://extensions` (top right, subtle secondary text):
  "Some Chrome extension APIs are not fully supported in Electron. Certain features may not function. See docs."

- **Add a "Known Limitations" section** to `EXTENSION_BACKEND_INTEGRATION.md`:
  - Partial API parity (examples: chrome.webRequest behavior may differ; devtools APIs limited; identity/gcm unsupported)
  - Non-HTTP protocols caveat (peersky/ipfs/hyper content scripts & request interception may vary)
  - Policy: CSP/size/permissions warnings, not blockers (except core MV3)

- **Add "Pass Criteria" section** matching mentor's text:
  - Installs without error; can enable/disable; survives update; loads UI/permissions manifest
  - Runtime APIs can be partial; no guarantee of full feature parity for all extensions

### Acceptance Criteria
✅ Disclaimer visible on page  
✅ Docs include limitations & pass criteria exactly

---

## 8) Test Targets & Quick Harness

### Tasks
- **Add a markdown test checklist** `docs/extension-test-plan.md` with rows for each default extension and columns: Install/Enable/Update/Uninstall/Notes/Protocols tested

- **Provide a minimal "test harness" page** or instructions to verify:
  - uBlock blocks on a known ad test page over http(s) OR note peersky protocol limitation if http is not routed; include a fallback (static HTML with ad selectors in the app or doc guidance)
  - Dark Reader toggles theme on a standard page
  - Peersky History and Consent Autodeny load UI and permissions

### Acceptance Criteria
✅ Tester can follow the doc to validate pass criteria quickly  
✅ Results recorded

---

## 9) Code Edits Summary (paths)

### Files to Modify
- `package.json`: bump Electron; install/update deps used for CRX fetching if any
- `src/main.js`: ensure persistent session + flags; init ExtensionManager
- `src/extensions/index.js`: atomic install/update; mutex; registry sync; load/remove
- `src/extensions/manifest-validator.js`: warn-not-block policy + required MV3 fields
- `src/ipc-handlers/extensions.js`: verify 5 handlers, shapes; error handling
- `src/pages/extensions.html`: disclaimer + Update All button; P2P toggle (disabled)
- `src/pages/static/js/extensions-page.js`: wire IPC; status messages; disable controls in-flight; handle Update All; keep no per-item update
- `src/pages/theme/extensions-page.css`: minor styles for disclaimer and disabled toggle tooltip
- `userData/extensions/preinstalled.json`: default list
- `docs/EXTENSION_BACKEND_INTEGRATION.md`: add "Known Limitations", "Pass Criteria", and updated policy sections
- `docs/extension-test-plan.md`: test checklist

---

## Demo Acceptance Criteria

✅ **Extensions install without error**, enable/disable, survive Update All, and load UI/permissions manifest  
✅ **Page shows disclaimer** about partial API support  
✅ **Default extensions present** on first run  
✅ **Validator warns (not blocks)** for CSP/size/permissions; blocks only for missing MV3 core fields  
✅ **Electron upgraded**; persistent session + security flags confirmed  
✅ **Address-bar detection & P2P** left as stubs with clear TODOs

### Notes
- If any extension from the default list fails outright, log a brief reason and proceed (mentor will propose alternatives)
- If some chrome.webRequest listeners don't fire due to architecture, document in the Known Limitations and keep going (acceptable for demo)

---

## Known Limitations

### Partial Chrome Extension API Support
- **chrome.webRequest behavior may differ**: Some request interception patterns work differently in Electron vs Chrome
- **devtools APIs limited**: Chrome DevTools extension APIs have reduced functionality
- **identity/gcm unsupported**: Google Identity and Google Cloud Messaging APIs are not available
- **Background page vs service worker**: MV2 background pages may not behave identically to MV3 service workers

### Non-HTTP Protocols Caveat
- **peersky/ipfs/hyper content scripts**: Content script injection on non-HTTP protocols may vary
- **Request interception**: Extension request blocking/modification on custom protocols is limited
- **Protocol-specific permissions**: Extension permissions may not apply consistently across all protocol schemes

### Validation Policy
- **CSP/size/permissions warnings, not blockers** (except core MV3 requirements)
- **Extensions may install but not function fully** if they rely on unsupported APIs
- **Dev mode allows all extensions** with warnings logged

## Pass Criteria

### Core Functionality Requirements
✅ **Installs without error**: Extension downloads, extracts, and registers successfully  
✅ **Can enable/disable**: Extensions load/unload from browser session correctly  
✅ **Survives update**: Extensions persist through "Update All" operations  
✅ **Loads UI/permissions manifest**: Extension popup, options, and permissions display properly

### Runtime API Expectations
✅ **Runtime APIs can be partial**: Extensions may have reduced functionality compared to Chrome  
✅ **No guarantee of full feature parity**: Some advanced extension features may not work  
✅ **Basic functionality sufficient**: Core extension purposes (ad blocking, theme switching, etc.) should work

### Demo Success Criteria
- Extension installation from Chrome Web Store URLs completes without crashes
- Installed extensions appear in management UI with correct metadata
- Enable/disable toggles affect browser behavior (e.g., ad blocker starts/stops blocking)
- Default extensions load automatically on first run
- "Update All" button functions and reports results

---

## Technical Implementation Details
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

### URL/ID Parsing Utility ✅ **COMPLETED**
Shared utility for parsing Chrome Web Store URLs and extension IDs implemented in `src/extensions/util.js`:

**✅ Implementation Status:**
- **Core utilities module**: `src/extensions/util.js` with full ESM support
- **Chrome Web Store validation**: Exact regex patterns (`WEBSTORE_ID_RE`, `WEBSTORE_URL_RE`)
- **ID/URL parsing**: `parseUrlOrId()` with URL-first parsing, case normalization
- **Sanitization functions**: `sanitizeId()`, `sanitizeUrlOrId()` with error codes
- **Atomic file operations**: `writeJsonAtomic()`, `atomicReplaceDir()` for safe installs
- **Concurrency control**: `KeyedMutex` class for operation serialization  
- **Test coverage**: 18 unit tests with 100% pass rate (`npm run test:unit`)

**Implementation Notes:**
```javascript
// Available imports from src/extensions/util.js
import {
  WEBSTORE_ID_RE, WEBSTORE_URL_RE, ERR,
  parseUrlOrId, sanitizeId, sanitizeUrlOrId,
  ensureDir, readJsonSafe, writeJsonAtomic, atomicReplaceDir,
  KeyedMutex
} from './extensions/util.js';

// Enable "Install" button only if this returns an ID
const extensionId = parseUrlOrId(userInput);
installButton.disabled = !extensionId;
```

**Files Added:**
- `src/extensions/util.js` - Core utilities module
- `tests/run-util-tests.js` - Test suite (18 tests)
- `tests/fixtures/` - Test data files  
- `package.json` - Added `test:unit` npm script

**Ready for Integration:** Backend ExtensionManager can now use these utilities for Chrome Web Store URL processing, atomic extension installs, and operation serialization.

**End of Demo Week Implementation Guide**

---

*This document provides the complete specification for implementing Chrome Web Store extension support in Peersky Browser for the demo week milestone. Follow the 9 numbered sections above to complete all requirements.*