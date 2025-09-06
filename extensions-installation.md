# Extensions: Preinstalled + Drag-and-Drop (ZIP/CRX)

This document proposes a complete workflow and implementation plan to:

- Ship preinstalled extensions with the app.
- Support drag-and-drop of local `.zip` and `.crx` files onto an extensions management page to install them.
- Achieve behavior as close as possible to installing the same extension from the Chrome Web Store, within Electron’s constraints.

The plan aligns with this repo’s structure and policies (ESM, Prettier defaults, `getBrowserSession()`, `contextIsolation: true`, `sandbox: true`). It also standardizes on the `chrome-extension-fetch` library for CRX/ZIP acquisition and parsing where applicable.


## Goals

- Preinstall a curated set of extensions bundled with the app.
- Let users install extensions by dropping `.zip` or `.crx` onto the Extensions page.
- Preserve the same extension ID as Chrome when possible to maximize parity (e.g., for sync’d settings or extension data reuse).
- Provide enable/disable/remove/reload UI and basic health indicators.
- Persist install state and loaded paths per user profile (`userData`).


## Electron Compatibility & Parity Notes

Electron supports many, but not all, Chrome extension APIs. Behavior can differ from Chrome due to:

- Partial API surface: Common APIs such as `runtime`, `storage`, `alarms`, `contextMenus`, `i18n`, content scripts, and MV3 service workers generally work; others are missing or limited (e.g., enterprise, identity OAuth UI, some devtools APIs, `chrome.gcm`, `chrome.webstore`, and certain `tabs` sub-APIs).
- Background context: MV3 background service workers are supported in modern Electron, but lifecycle and timing can differ from Chrome.
- Installation flow: There is no Chrome Web Store prompt/UI; we implement our own installer and persistence.
- CRX loading: Electron’s `session.loadExtension` loads unpacked directories; CRX must be extracted first.

Despite these constraints, we can get very close to Chrome behavior for a large class of extensions (ad blockers, content script tools, password managers with basic storage, UI addons). We call out edge cases below.


## Proposed Workflow

### 1) Preinstalled Extensions

- Bundle unpacked extensions under app resources and load them on first run of a profile.
- Copy to `app.getPath("userData")/Extensions/<extension-id>/<version>/` and load from there, to keep runtime writable and upgradeable without modifying asar.
- Use `session.loadExtension(dir, { allowFileAccess: true })` via `getBrowserSession()`.
- Persist registry state (enabled, path, version, meta) in a JSON file in `userData`.

### 2) Drag-and-Drop Install (ZIP/CRX)

- Extensions page (`src/pages/extensions/`) provides a drop zone. Users drop a `.zip` or `.crx`.
- Renderer sends the file path via IPC: `ipcRenderer.invoke("extensions:installFromFile", filePath)`.
- Main process validates and extracts to a staging dir under `userData/Extensions/_staging/<uuid>`.
- For ZIP: Unzip; for CRX: Use `chrome-extension-fetch`’s CRX parsing utilities (or a compatible adapter) to parse the CRX header, extract the embedded ZIP, and recover the public key.
- If a public key is available (CRX), add or preserve `manifest.key` before loading to keep the Chrome Web Store ID stable (Chrome derives the extension ID from the public key).
- Detect manifest (MV2 vs MV3), normalize fields, and move the unpacked directory to `userData/Extensions/<id>/<version>/`.
- Load with `session.loadExtension` and persist registry record. Return extension metadata to the renderer for UI update.

### 3) Manage State (Enable/Disable/Remove/Reload)

- Enable: `loadExtension` for the extension’s current version folder, update registry.
- Disable: `removeExtension(id)` and mark disabled in registry.
- Remove: `removeExtension(id)`, delete data folder (optional), update registry.
- Reload: `removeExtension(id)` then `loadExtension(path)`.

### 4) Updates & Versioning

- Allow side-by-side versions under `userData/Extensions/<id>/<version>/`.
- On install of a new version, disable the old version and enable the new version.
- Future work: optional update checks for preinstalled extensions.


## Architecture & Files

Main process (ESM):

- `src/extensions/install.js`: Orchestrates install, enable/disable/remove/reload, persistence.
- `src/extensions/crx.js`: Thin wrapper around `chrome-extension-fetch` for CRX parsing to extract ZIP + public key (to preserve `manifest.key`).
- `src/extensions/zip.js`: ZIP extract helper (either via `chrome-extension-fetch` ZIP output or a small unzip library).
- `src/ipc/extensions.js`: IPC handlers and channel names for renderer↔main.
- Wireup in `src/main.js`: initialize IPC and preinstalled loader after session creation.

Renderer (Extensions page):

- `src/pages/extensions/index.html|css|js`: DnD UI, list installed extensions, toggles, remove, reload.
- `src/pages/extensions/api.js`: Small wrapper around `ipcRenderer` channels.

Persistence:

- `userData/Extensions/registry.json`: `{ [id]: { enabled, path, version, name, description, icons, mv, installSource, installTime } }`.

Packaging:

- Place preinstalled unpacked extensions under `src/extensions/preinstalled/*`.
- Use electron-builder `extraResources` or `asarUnpack` so directories are available at runtime (e.g. `resources/extensions/preinstalled`).


## Detailed Steps

1) Session & Loader

- Always get session via `getBrowserSession()` (do not use `session.defaultSession`).
- On app ready (or profile init), read registry, ensure enabled preinstalled entries are loaded, reconcile missing paths.

2) IPC Contract

- `extensions:list` → returns registry entries + live loaded list from `session.getAllExtensions()`.
- `extensions:installFromFile(path)` → installs from ZIP/CRX, returns extension metadata.
- `extensions:enable(id)` / `extensions:disable(id)` / `extensions:remove(id)` / `extensions:reload(id)`.
- Validate inputs, sanitize paths, and catch/load errors; return structured results.

3) CRX Handling

- Detect CRX magic (`Cr24`) and version (v2 or v3) using `chrome-extension-fetch` helpers. Extract ZIP to staging folder and read the embedded public key.
- If public key present, write `manifest.key` if missing so the ID matches Chrome’s when `session.loadExtension` computes its internal ID.
- Note: Without the public key (e.g., plain ZIP), Electron computes an ID based on path; the ID will differ from Chrome’s unless the `manifest.key` is present.

4) ZIP Handling

- Validate `manifest.json` presence and minimum fields (`name`, `version`, `manifest_version`, `action` or `browser_action` if present, `background`, `permissions`/`host_permissions`). For ZIP produced by `chrome-extension-fetch`, treat it the same as a local ZIP.
- Move to `userData/Extensions/<id>/<version>/` and load.

5) UI

- Drop zone accepts `.zip` and `.crx` with progress feedback.
- Table/list of extensions: icon, name, version, ID, MV2/MV3, enabled state.
- Actions: enable/disable toggle, reload, remove.
- Error states: invalid manifest, incompatible API, load failure.

6) Security Defaults

- Keep `contextIsolation: true`, `sandbox: true`. Do not expose Node in renderers.
- Disallow file URLs in content scripts unless required; if needed, use `loadExtension({ allowFileAccess: true })` per extension policy.
- Treat dropped files as untrusted: scan/validate manifest, block native bindings, and avoid executing arbitrary code on the main thread.

7) Packaging Preinstalled

- Include `src/extensions/preinstalled/...` via `extraResources`: e.g.
  - `"extraResources": [{ "from": "src/extensions/preinstalled", "to": "extensions/preinstalled" }]`
- Resolve runtime path via `process.resourcesPath`.
- On first run, copy to `userData/Extensions/<id>/<version>/` and register as enabled by default (or per policy).


## Error Handling & Edge Cases

- Bad archives: reject with clear UI message and log.
- Missing/invalid manifest: reject; show helpful hints.
- Duplicate version: replace or keep both; default to activating the newer semver (configurable policy).
- MV2 deprecations: Support if Electron version still supports MV2. Prefer MV3 long term.
- Conflicting host permissions: Surface in UI; document that granular Chrome permission prompts are not implemented.
- Background service worker races: On enable/reload, add a small delay/retry to wait for service worker start.


## Testing Plan

- Unit tests (where feasible):
- CRX handling via `chrome-extension-fetch` with known fixtures (v2, v3), including public key extraction and manifest.key preservation.
  - ZIP extraction and manifest normalization.
  - Registry read/write and migration.
  - IPC handlers happy-path and error-path.
- Manual tests:
  - Install from ZIP (MV3 and MV2), CRX (popular extensions).
  - Enable/disable/reload flows; verify content scripts activate.
  - Preinstalled load on first run, upgrades between versions.


## Estimated Lines of Code (LOC)

Two scenarios: with small dependencies vs. no-deps for CRX/ZIP.

- With `chrome-extension-fetch` (preferred):
  - Main process install/registry orchestration: 150–220 LOC
  - IPC handlers + wiring: 60–100 LOC
  - CRX/ZIP helpers (thin wrappers around the library): 20–50 LOC
  - Renderer Extensions page (UI + IPC glue): 220–350 LOC
  - Preinstall loader + packaging hooks: 20–40 LOC
  - Tests (unit + a few integration): 120–200 LOC
  - Total: ~590–960 LOC

- No external deps (roll our own CRX/ZIP):
  - CRX parser (v2/v3) + ID preservation: 180–250 LOC
  - ZIP extractor (Node-only streams): 120–180 LOC
  - Other components same as above
  - Total: ~850–1,250 LOC

Notes:
- Ranges assume concise ESM modules and minimal UI framework (vanilla DOM + small CSS). Using a UI framework would increase LOC.
- The renderer UI can be lean if we start with a basic list and buttons; richer UI (search, filters, error banners) adds ~100–200 LOC.


## Implementation Sketches (Pseudocode)

Main loader (preinstalled):

```js
// src/extensions/install.js
import { app } from "electron";
import { loadExtension, removeExtension, getLoadedExtensions } from "./session-ext.js";
import { readRegistry, writeRegistry } from "./registry.js";
import { resolvePreinstalled } from "./preinstalled.js";

export async function initExtensions(session) {
  const registry = await readRegistry();
  const preinstalled = await resolvePreinstalled();
  // Seed registry on first run
  for (const ext of preinstalled) {
    if (!registry[ext.id]) registry[ext.id] = { ...ext, enabled: true };
  }
  // Load enabled
  for (const [id, meta] of Object.entries(registry)) {
    if (meta.enabled) await loadExtension(session, meta.path);
  }
  await writeRegistry(registry);
}
```

Install from file (ZIP/CRX):

```js
// src/ipc/extensions.js
ipcMain.handle("extensions:installFromFile", async (_evt, filePath) => {
  const { type, stagingDir } = await detectAndExtract(filePath); // ZIP or CRX→ZIP via chrome-extension-fetch
  const { id, version, finalDir, manifest } = await normalizeAndStage(stagingDir);
  await loadExtension(session, finalDir, { allowFileAccess: true });
  await upsertRegistry({ id, version, path: finalDir, meta: manifest, enabled: true, installSource: type });
  return { id, version, name: manifest.name, mv: manifest.manifest_version };
});
```

Renderer DnD:

```js
// src/pages/extensions/js/index.js
const dropZone = document.getElementById("drop-zone");
dropZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  const filePath = e.dataTransfer.files?.[0]?.path;
  if (!filePath) return;
  const result = await window.extensions.installFromFile(filePath);
  renderList(await window.extensions.list());
});
```

CRX parsing with `chrome-extension-fetch` (outline):

```js
// src/extensions/crx.js (thin wrapper)
import * as cef from "chrome-extension-fetch";

export async function parseCrxAndExtract(fileBuffer) {
  // Pseudocode: adapt to cef actual API
  // const { zipBuffer, publicKey } = await cef.parseCrx(fileBuffer);
  // return { zipBuffer, publicKeyPem: publicKey };
}

export async function extractZipFromId(extensionId) {
  // Optional future: fetch from Web Store (if/when allowed)
  // const { zipBuffer, publicKey } = await cef.fetchAsZip({ id: extensionId });
  // return { zipBuffer, publicKeyPem: publicKey };
}
```


## Security Considerations

- Treat all dropped files as untrusted. Validate manifests and restrict write locations to `userData`.
- Do not grant Node.js in extension contexts; keep isolation and sandboxing defaults.
- Carefully gate `allowFileAccess`; enable only when necessary.
- Consider a simple allowlist of permissions in manifests; warn on riskier ones (e.g., `*://*/*`, `webRequestBlocking`).
- Ensure IPC only accepts expected inputs and paths (no path traversal outside `userData`).

Additional notes when using `chrome-extension-fetch`:
- Prefer passing local file buffers for CRX parsing (no network) to keep installs purely local.
- If fetching from the Web Store is later enabled, validate TLS and pin domains, and keep a clear separation between local installs and remote fetches.


## Milestones

- M1: Preinstalled loader + registry + wiring (no UI).
- M2: Extensions page with list, enable/disable/remove.
- M3: ZIP installation via drag-and-drop.
- M4: CRX installation with ID preservation (manifest.key from CRX public key).
- M5: Polish: reload, error surfaces, basic tests, docs.


## Known Limitations (Chrome Parity)

- Some Chrome APIs will remain unsupported in Electron.
- Permission prompts differ; we will treat declared permissions as granted at install time and surface them in the UI, not as modal prompts.
- Web Store auto-updates are not implemented; future work could add update feeds for preinstalled.


## Next Steps

- Confirm Electron version to finalize MV3 support assumptions and API coverage.
- Decide on dependency policy (allow small libs for CRX/ZIP or not).
- Approve file structure above; I can scaffold the modules and the Extensions page next.
