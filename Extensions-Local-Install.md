# Extensions: Local ZIP/CRX Install, Policy, i18n, and Popups

This document explains the changes that enable robust local extension installs (ZIP/CRX), policy‑driven validation, localized manifest string resolution, and resilient popup handling in Peersky Browser.

## Overview

Goals achieved:

- Install from `.zip` and `.crx` locally (drag‑and‑drop or Choose File).
- Preserve Chrome IDs when possible (CRX public key → manifest.key).
- Load extensions immediately and on restart (registry‑driven loader).
- Policy‑driven validation (deny only truly dangerous, warn otherwise).
- Localized `__MSG_...__` manifest strings resolved to user locale.
- Reliable toolbar popups (verify/resolve popup HTML path before open).
- Consistent `userData/extensions` layout and icon protocol handling.

## Files and Responsibilities

- `src/extensions/index.js` (ExtensionManager)
  - Install flow for directory, ZIP, and CRX (`_prepareFromDirectory`, `_prepareFromArchive`).
  - Resolves manifest i18n placeholders → `displayName`, `displayDescription`.
  - On install: loads extension, reconciles Chromium ID, and reloads if path moved.
  - List/enable/disable/uninstall; auto‑pin newly installed extensions exposing a browser action (if <6 pinned).
  - Popup handling: verifies `action.default_popup` exists; resolves alternate paths; creates popup window on fallback.
  - Registry I/O; loader on startup.

- `src/extensions/manifest-validator.js` (Validator)
  - Constructed with a policy (see below). Returns `{ isValid, warnings, errors, outcome }` where outcome ∈ {allow, deny, confirm}.
  - Files: deny only when matching `blockedExtensions/blockedPatterns` or exceeding “Block” thresholds; warning for unknown types / large sizes / many files.
  - Permissions: deny a small hard‑blocked set; warning for dangerous (e.g., `<all_urls>`, `webRequest`).

- `src/extensions/policy.js` (Policy)
  - Loads a default policy and merges with user overrides at `userData/extensions/policy.json`.
  - Defaults: deny only truly dangerous; warn at sensible thresholds; allow install with warnings. Tunable without code changes.

- `src/extensions/crx.js` and `src/extensions/zip.js`
  - CRX header parse (v2/v3), extract embedded ZIP; write `manifest.key` when public key is found. Safe ZIP extraction with zip‑slip prevention.

- `src/extensions/extensions-ipc.js`
  - IPC for list/toggle/install/uninstall; native open dialog (`extensions-show-open-dialog`); blob upload install (`extensions-install-upload`).

- `src/protocols/peersky-protocol.js`
  - Serves extension icons from `userData/extensions/<id>/<version>/...` (lowercase "extensions").

- UI: `src/pages/extensions.html` + `src/pages/static/js/extensions-page.js`
  - Drag‑and‑drop and Choose File. If `File.path` is unavailable (sandboxed), falls back to blob upload → main process staging.
  - Install success shows warning count if any. Uninstall/toggle messages use `displayName` when available.

## Directory Layout and IDs

- All installs use `userData/extensions/<id>/<version>_0/`.
- CRX installs preserve ID when possible via `manifest.key` injection (CRX v2 guaranteed; CRX v3 best‑effort).
- If the initial load yields a different Chromium ID than our provisional ID, the manager:
  1) Moves the directory to the final `<id>` path,
  2) Removes the extension from Electron,
  3) Loads the extension again from the new path.
  This avoids `ERR_FILE_NOT_FOUND` when the popup loads resources.

## Policy‑Driven Validation

Defaults (overridable via `userData/extensions/policy.json`):

- Files
  - Block: executable/script types (`.exe`, `.dll`, `.dmg`, `.bat`, `.cmd`, `.sh`, `.ps1`, `.vbs`, `.bin`, `.jar`, `.msi`, `.pkg`, `.dylib`, `.so`).
  - Patterns: e.g., `node_modules/.bin/`.
  - Allow common assets and docs; warn for unknown extensions.
  - Thresholds: warn/block limits for file size, total files, and total extension size.
- Permissions
  - Block: `nativeMessaging`, `debugger`, `desktopCapture`, `fileSystem`, `fileSystemProvider`.
  - Warn: `<all_urls>`, `webRequest`, `webRequestBlocking`, `proxy`, `privacy`, `enterprise.platformKeys`.
- Behavior
  - Non‑critical issues → install with warnings; critical → deny.

Outcome handling:

- `outcome: 'deny'` → installation fails with a clear message.
- `outcome: 'allow'` → install succeeds; warnings stored in registry; toast shows “installed with N warnings”.
- `outcome: 'confirm'` → policy hook for future prompt; current defaults treat as warn/allow.

## i18n (__MSG__) Resolution

- For manifests using `__MSG_xxx__` placeholders and `_locales/<locale>/messages.json`:
  - We resolve and persist `displayName` and `displayDescription` using app locale fallbacks.
  - UI and logs use `displayName` when available; original strings remain in `name`/`description`.

## Popup Handling

- Before opening a popup, we:
  - Verify `action.default_popup` exists relative to the installed path.
  - If missing, search common alternates (`popup.html`, `popup/index.html`, `ui/popup.html`, `dist/popup.html`, `build/popup.html`) or locate the filename within two directory levels.
  - If the file is found, open it; otherwise fall back to a regular click or show a friendly warning.

## UI/UX Notes

- Drag & drop and file input work even when `File.path` is unavailable: we upload the file buffer to main, stage it under `userData`, and install from there.
- Install banners show success or success-with-warnings.
- Uninstall/toggle messages use the resolved display name.
- Newly installed extensions exposing a browser action are auto‑pinned if fewer than 6 are pinned.

## Troubleshooting

- `ERR_FILE_NOT_FOUND` on popup:
  - Usually a missing or nested popup HTML path. The manager now resolves alternates; ensure the bundle actually includes a popup HTML. If it’s a dev zip (not a built bundle), build the extension first.
- `__MSG_...__` shown in UI:
  - Resolved at install and at registry load. If you still see placeholders, the extension may have missing `_locales` data; check its package.
- Validation failures:
  - Check the toast and logs. Adjust `userData/extensions/policy.json` if you need to tune thresholds or behavior.

## Testing

- Manual:
  - Install CRX and ZIP across a few popular MV3 extensions; verify toolbar pin, popup, toggles, and persistence after restart.
  - Try malformed zips; confirm denied with clear error, and safe cleanup.
  - Verify i18n by changing system locale (or override policy to test different locales).
- Unit (suggested):
  - Policy loading/merge.
  - Validator outcomes on synthetic trees (file counts/size; blocked extensions; unknown types).
  - CRX v2/v3 extraction with sample fixtures; manifest.key injection.
  - i18n resolver on sample _locales layout.

## Migration

- Path casing unified to `userData/extensions`. If your environment still contains `userData/Extensions` (uppercase), you can manually move it or ask us to add a one‑time migration.

## Appendix: Key API Contracts

- Renderer (`window.electronAPI.extensions`):
  - `listExtensions()` → `{ success, extensions }`
  - `installExtension(sourcePath)` → `{ success, extension }`
  - `installFromBlob(name, arrayBuffer)` → `{ success, extension }`
  - `openInstallFileDialog()` → `{ success, path }`
  - `toggleExtension(id, enabled)` / `uninstallExtension(id)`
  - `updateAll()`

## Summary

These changes make local extension installs practical and resilient while maintaining a safe baseline. The policy system prevents churn, i18n ensures user‑friendly names, and popup resolution avoids brittle path assumptions.

