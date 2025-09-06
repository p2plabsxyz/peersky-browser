/**
 * Extension IPC Handlers - Extension System Communication
 *
 * This module provides IPC handlers for extension operations,
 * enabling communication between the main process and renderer
 * for extension management functionality.
 *
 * Key Features:
 * - Extension listing and information retrieval
 * - Extension installation from local sources
 * - Extension enable/disable operations
 * - Extension uninstallation
 * - Error handling and validation
 *
 * Implementation Approach:
 * - Direct integration with ExtensionManager
 * - Comprehensive input validation
 * - Detailed error reporting
 * - Secure IPC communication
 * - Performance-optimized handlers
 */

import electron from "electron";
const { ipcMain, BrowserWindow, dialog, app } = electron;
import { ERR, validateInstallSource, sha256Hex } from "./util.js";
import path from "path";

// Simple in-memory rate limiter for install attempts per sender WebContents
const INSTALL_RATE_WINDOW_MS = 60_000; // 1 minute window
const INSTALL_RATE_LIMIT = 5;          // up to 5 attempts per window
/** @type {Map<number, number[]>} */
const installAttempts = new Map();

// Upload size cap (bytes) for in-memory payloads
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024; // 60 MB

function checkInstallRateLimit(senderId) {
  const now = Date.now();
  const times = installAttempts.get(senderId) || [];
  const recent = times.filter((t) => now - t < INSTALL_RATE_WINDOW_MS);
  if (recent.length >= INSTALL_RATE_LIMIT) {
    throw Object.assign(new Error("Too many installation attempts"), { code: ERR.E_RATE_LIMIT });
  }
  recent.push(now);
  installAttempts.set(senderId, recent);
}

/**
 * Setup extension IPC handlers
 *
 * Registers all IPC handlers for extension management operations,
 * providing secure communication between main and renderer processes.
 *
 * @param {ExtensionManager} extensionManager - Extension manager instance
 */
export function setupExtensionIpcHandlers(extensionManager) {
  console.log("ExtensionIPC: Setting up extension IPC handlers...");

  try {
    // List all installed extensions
    ipcMain.handle("extensions-list", async () => {
      try {
        const extensions = await extensionManager.listExtensions();
        return { success: true, extensions };
      } catch (error) {
        return {
          success: false,
          code: error.code || "E_UNKNOWN",
          error: error.message
        };
      }
    });

    // Show native open file dialog for installing extensions from files
    ipcMain.handle("extensions-show-open-dialog", async () => {
      try {
        const result = await dialog.showOpenDialog({
          title: "Select extension file",
          properties: ["openFile"],
          filters: [
            { name: "Extensions", extensions: ["zip", "crx", "crx3"] }
          ]
        });
        if (result.canceled || !result.filePaths?.length) {
          return { success: false, canceled: true };
        }
        return { success: true, path: result.filePaths[0] };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Install extension from uploaded blob (ArrayBuffer) from renderer
    ipcMain.handle("extensions-install-upload", async (event, payload) => {
      try {
        // Rate limit per sender
        try { checkInstallRateLimit(event.sender.id); } catch (rlErr) {
          console.warn("[ExtensionIPC] Upload install rate limited:", rlErr.message);
          throw rlErr;
        }

        // Basic payload validation
        if (!payload || typeof payload.name !== "string" || !payload.data) {
          throw Object.assign(new Error("Invalid upload payload"), { code: ERR.E_INVALID_PATH });
        }
        const name = String(payload.name);
        const lower = name.toLowerCase();
        const allowed = lower.endsWith('.zip') || lower.endsWith('.crx') || lower.endsWith('.crx3');
        if (!allowed) {
          throw Object.assign(new Error("Unsupported file type"), { code: ERR.E_INVALID_PATH });
        }

        // Enforce size cap before buffering/writing
        const dataAny = payload.data;
        const byteLength = Buffer.isBuffer(dataAny)
          ? dataAny.length
          : (typeof dataAny === 'object' && dataAny !== null && typeof dataAny.byteLength === 'number')
            ? dataAny.byteLength
            : (ArrayBuffer.isView(dataAny) ? dataAny.byteLength : 0);
        if (!Number.isFinite(byteLength) || byteLength <= 0) {
          throw Object.assign(new Error("Invalid upload data"), { code: ERR.E_INVALID_PATH });
        }
        if (byteLength > MAX_UPLOAD_BYTES) {
          throw Object.assign(new Error(`Upload too large (max ${MAX_UPLOAD_BYTES} bytes)`), { code: ERR.E_INVALID_PATH });
        }

        // Create uploads dir inside userData/extensions/_uploads
        const uploadsDir = path.join(app.getPath('userData'), 'extensions', '_uploads');
        await (await import('fs/promises')).mkdir(uploadsDir, { recursive: true });
        const ext = lower.endsWith('.zip') ? '.zip' : (lower.endsWith('.crx3') ? '.crx3' : '.crx');
        const tmpName = `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
        const destPath = path.join(uploadsDir, tmpName);

        // Write file
        const buf = Buffer.isBuffer(payload.data)
          ? payload.data
          : Buffer.from(Buffer.from(payload.data instanceof ArrayBuffer ? new Uint8Array(payload.data) : payload.data));
        await (await import('fs/promises')).writeFile(destPath, buf);

        // Install using manager
        const result = await extensionManager.installExtension(destPath);

        // Cleanup temp file best-effort
        try { await (await import('fs/promises')).unlink(destPath); } catch (_) {}

        return { success: true, ...result };
      } catch (error) {
        return { success: false, code: error.code || "E_UNKNOWN", error: error.message };
      }
    });

    // Install extension from local path
    ipcMain.handle("extensions-install", async (event, sourcePath) => {
      try {
        // Rate limit per sender
        try { checkInstallRateLimit(event.sender.id); } catch (rlErr) {
          console.warn("[ExtensionIPC] Install rate limited:", rlErr.message);
          throw rlErr;
        }

        // Validate and sanitize path before passing to manager (allow directories or CRX/ZIP files)
        const sanitizedPath = await validateInstallSource(sourcePath, {
          allowDirectories: true,
          allowFiles: true,
          allowedFileExtensions: [".zip", ".crx", ".crx3"]
        });

        // Logging hygiene: only basename + hash by default
        const baseName = path.basename(sanitizedPath);
        const realpathHash = sha256Hex(sanitizedPath).slice(0, 16);
        const debugExt = process.env.DEBUG_EXT === "1";
        if (debugExt) {
          console.log("[ExtensionIPC] Install request", { senderId: event.sender.id, baseName, realpathHash, fullPath: sanitizedPath });
        } else {
          console.log("[ExtensionIPC] Install request", { senderId: event.sender.id, baseName, realpathHash });
        }

        const result = await extensionManager.installExtension(sanitizedPath);
        return { success: true, ...result };
      } catch (error) {
        return {
          success: false,
          code: error.code || "E_UNKNOWN",
          error: error.message
        };
      }
    });

    // Toggle extension enabled/disabled state
    ipcMain.handle("extensions-toggle", async (event, extensionId, enabled) => {
      try {
        if (!extensionId || typeof extensionId !== "string") {
          throw Object.assign(new Error("Invalid extension ID"), { code: ERR.E_INVALID_ID });
        }
        if (typeof enabled !== "boolean") {
          throw Object.assign(new Error("Enabled status must be boolean"), { code: ERR.E_INVALID_ID });
        }

        const result = await extensionManager.toggleExtension(extensionId, enabled);
        return { success: true, result };
      } catch (error) {
        return {
          success: false,
          code: error.code || "E_UNKNOWN",
          error: error.message
        };
      }
    });

    // Uninstall extension
    ipcMain.handle("extensions-uninstall", async (event, extensionId) => {
      try {
        if (!extensionId || typeof extensionId !== "string") {
          throw Object.assign(new Error("Invalid extension ID"), { code: ERR.E_INVALID_ID });
        }

        const result = await extensionManager.uninstallExtension(extensionId);
        return { success: true, result };
      } catch (error) {
        return {
          success: false,
          code: error.code || "E_UNKNOWN",
          error: error.message
        };
      }
    });

    // Get extension system status
    ipcMain.handle("extensions-status", async () => {
      try {
        const status = extensionManager.getStatus();
        return { success: true, status };
      } catch (error) {
        return {
          success: false,
          code: error.code || "E_UNKNOWN",
          error: error.message
        };
      }
    });

    // Get extension info
    ipcMain.handle("extensions-get-info", async (event, extensionId) => {
      try {
        if (!extensionId || typeof extensionId !== "string") {
          throw Object.assign(new Error("Invalid extension ID"), { code: ERR.E_INVALID_ID });
        }

        const extensions = await extensionManager.listExtensions();
        const extension = extensions.find(ext => ext.id === extensionId);
        
        if (!extension) {
          throw Object.assign(new Error("Extension not found"), { code: ERR.E_INVALID_ID });
        }

        return { success: true, extension };
      } catch (error) {
        return {
          success: false,
          code: error.code || "E_UNKNOWN",
          error: error.message
        };
      }
    });

    // Install extension from Chrome Web Store URL or ID
    ipcMain.handle("extensions-install-webstore", async (event, urlOrId) => {
      try {
        // Rate limit per sender
        try { checkInstallRateLimit(event.sender.id); } catch (rlErr) {
          console.warn("[ExtensionIPC] Webstore install rate limited:", rlErr.message);
          throw rlErr;
        }
        if (!urlOrId || typeof urlOrId !== "string") {
          throw Object.assign(new Error("Invalid Chrome Web Store URL or ID"), { code: ERR.E_INVALID_URL });
        }

        const result = await extensionManager.installFromWebStore(urlOrId);
        return { success: true, id: result.extension.id, extension: result.extension };
      } catch (error) {
        return {
          success: false,
          code: error.code || "E_UNKNOWN",
          error: error.message
        };
      }
    });

    // Update all extensions
    ipcMain.handle("extensions-update-all", async () => {
      try {
        const result = await extensionManager.updateAllExtensions();
        return { success: true, ...result };
      } catch (error) {
        return {
          success: false,
          code: error.code || "E_UNKNOWN",
          error: error.message,
          updated: [],
          skipped: [],
          errors: []
        };
      }
    });

    // Get extension icon URL via peersky protocol
    ipcMain.handle("extensions-get-icon-url", async (event, extensionId, size = "64") => {
      try {
        if (!extensionId || typeof extensionId !== "string") {
          throw Object.assign(new Error("Invalid extension ID"), { code: ERR.E_INVALID_ID });
        }

        const extensions = await extensionManager.listExtensions();
        const extension = extensions.find(ext => ext.id === extensionId);
        
        if (!extension) {
          throw Object.assign(new Error("Extension not found"), { code: ERR.E_INVALID_ID });
        }

        // Validate size parameter
        const validSizes = ["16", "32", "48", "64", "128"];
        const iconSize = validSizes.includes(size) ? size : "64";

        // Return peersky protocol URL for extension icon
        const iconUrl = `peersky://extension-icon/${extensionId}/${iconSize}`;
        
        return { success: true, iconUrl };
      } catch (error) {
        return {
          success: false,
          code: error.code || "E_UNKNOWN",
          error: error.message,
          iconUrl: null
        };
      }
    });

    // Clean up registry by removing entries with missing directories
    ipcMain.handle("extensions-cleanup-registry", async () => {
      try {
        const result = await extensionManager.validateAndCleanRegistry();
        return { success: true, ...result };
      } catch (error) {
        return {
          success: false,
          code: error.code || "E_UNKNOWN",
          error: error.message,
          initialCount: 0,
          finalCount: 0,
          removedCount: 0,
          removedExtensions: []
        };
      }
    });

    // List browser actions for current window
    ipcMain.handle("extensions-list-browser-actions", async (event) => {
      try {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const actions = await extensionManager.listBrowserActions(senderWindow);
        return { success: true, actions };
      } catch (error) {
        console.error("ExtensionIPC: extensions-list-browser-actions failed:", error);
        return { 
          success: false, 
          code: error.code || "E_UNKNOWN",
          error: error.message,
          actions: []
        };
      }
    });

    // Handle browser action click
    ipcMain.handle("extensions-click-browser-action", async (event, actionId) => {
      try {
        if (!actionId || typeof actionId !== "string") {
          throw Object.assign(new Error("Invalid action ID"), { code: ERR.E_INVALID_ID });
        }

        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        await extensionManager.clickBrowserAction(actionId, senderWindow);
        return { success: true };
      } catch (error) {
        console.error("ExtensionIPC: extensions-click-browser-action failed:", error);
        return {
          success: false,
          code: error.code || "E_UNKNOWN", 
          error: error.message
        };
      }
    });

    // Handle browser action popup
    ipcMain.handle("extensions-open-browser-action-popup", async (event, { actionId, anchorRect }) => {
      try {
        if (!actionId || typeof actionId !== "string") {
          throw Object.assign(new Error("Invalid action ID"), { code: ERR.E_INVALID_ID });
        }

        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        
        // Validate anchorRect has required fields
        const safeRect = anchorRect && typeof anchorRect === "object" ? {
          x: Number(anchorRect.x) || 100,
          y: Number(anchorRect.y) || 40,
          width: Number(anchorRect.width) || 20,
          height: Number(anchorRect.height) || 20,
          left: Number(anchorRect.left) || 100,
          top: Number(anchorRect.top) || 40,
          right: Number(anchorRect.right) || 120,
          bottom: Number(anchorRect.bottom) || 60
        } : { x: 100, y: 40, width: 20, height: 20, left: 100, top: 40, right: 120, bottom: 60 };
        
        const result = await extensionManager.openBrowserActionPopup(actionId, senderWindow, safeRect);
        return result || { success: true };
      } catch (error) {
        console.error("ExtensionIPC: extensions-open-browser-action-popup failed:", error);
        return { success: false, error: error.message };
      }
    });

    // Register webview with extension system for tab context
    ipcMain.handle("extensions-register-webview", async (event, webContentsId) => {
      try {
        if (!webContentsId || typeof webContentsId !== "number") {
          throw Object.assign(new Error("Invalid webContents ID"), { code: ERR.E_INVALID_ID });
        }

        // Get the webview's WebContents by ID
        const { webContents } = await import("electron");
        const webviewContents = webContents.fromId(webContentsId);
        if (!webviewContents) {
          throw Object.assign(new Error("WebContents not found"), { code: ERR.E_INVALID_ID });
        }

        // Verify ownership/embedding relationship
        const host = webviewContents.hostWebContents || BrowserWindow.fromWebContents(webviewContents)?.webContents;
        if (!host || (host.id !== event.sender.id && BrowserWindow.fromWebContents(webviewContents) !== BrowserWindow.fromWebContents(event.sender))) {
          throw Object.assign(new Error("WebContents not owned by sender"), { code: ERR.E_INVALID_ID });
        }

        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        // Register webview with extension system
        extensionManager.addWindow(senderWindow, webviewContents);
        return { success: true };
      } catch (error) {
        console.error(`[ExtensionIPC] extensions-register-webview failed:`, error);
        return {
          success: false,
          code: error.code || "E_UNKNOWN",
          error: error.message
        };
      }
    });

    // Unregister webview from extension system
    ipcMain.handle("extensions-unregister-webview", async (event, webContentsId) => {
      try {
        if (!webContentsId || typeof webContentsId !== "number") {
          throw Object.assign(new Error("Invalid webContents ID"), { code: ERR.E_INVALID_ID });
        }

        // Get the webview's WebContents by ID
        const { webContents } = await import("electron");
        const webviewContents = webContents.fromId(webContentsId);
        if (!webviewContents) {
          // WebContents might already be destroyed, which is fine
          return { success: true };
        }

        // Verify ownership/embedding relationship before unregistering
        const host = webviewContents.hostWebContents || BrowserWindow.fromWebContents(webviewContents)?.webContents;
        if (!host || (host.id !== event.sender.id && BrowserWindow.fromWebContents(webviewContents) !== BrowserWindow.fromWebContents(event.sender))) {
          throw Object.assign(new Error("WebContents not owned by sender"), { code: ERR.E_INVALID_ID });
        }

        // Unregister webview from extension system
        extensionManager.removeWindow(webviewContents);
        return { success: true };
      } catch (error) {
        console.error(`[ExtensionIPC] extensions-unregister-webview failed:`, error);
        return {
          success: false,
          code: error.code || "E_UNKNOWN",
          error: error.message
        };
      }
    });

    // Close all extension popups (for tab switches)
    ipcMain.handle("extensions-close-all-popups", async () => {
      try {
        extensionManager.closeAllPopups();
        return { success: true };
      } catch (error) {
        console.error("[ExtensionIPC] extensions-close-all-popups failed:", error);
        return {
          success: false,
          code: error.code || "E_UNKNOWN",
          error: error.message
        };
      }
    });

    // Get pinned extensions list
    ipcMain.handle("extensions-get-pinned", async () => {
      try {
        const pinnedExtensions = await extensionManager.getPinnedExtensions();
        return { success: true, pinnedExtensions };
      } catch (error) {
        console.error("[ExtensionIPC] extensions-get-pinned failed:", error);
        return {
          success: false,
          code: error.code || "E_UNKNOWN",
          error: error.message,
          pinnedExtensions: []
        };
      }
    });

    // Pin extension to toolbar
    ipcMain.handle("extensions-pin", async (event, extensionId) => {
      try {
        if (!extensionId || typeof extensionId !== "string") {
          throw Object.assign(new Error("Invalid extension ID"), { code: ERR.E_INVALID_ID });
        }

        const result = await extensionManager.pinExtension(extensionId);
        return { success: true, pinned: result };
      } catch (error) {
        console.error("[ExtensionIPC] extensions-pin failed:", error);
        return {
          success: false,
          code: error.code || "E_UNKNOWN",
          error: error.message
        };
      }
    });

    // Unpin extension from toolbar
    ipcMain.handle("extensions-unpin", async (event, extensionId) => {
      try {
        if (!extensionId || typeof extensionId !== "string") {
          throw Object.assign(new Error("Invalid extension ID"), { code: ERR.E_INVALID_ID });
        }

        const result = await extensionManager.unpinExtension(extensionId);
        return { success: true, unpinned: result };
      } catch (error) {
        console.error("[ExtensionIPC] extensions-unpin failed:", error);
        return {
          success: false,
          code: error.code || "E_UNKNOWN",
          error: error.message
        };
      }
    });

    console.log("ExtensionIPC: Extension IPC handlers registered successfully");
    
  } catch (error) {
    console.error("ExtensionIPC: Failed to register IPC handlers:", error);
    throw error;
  }
}

// Export internal for lightweight tests (no Electron side-effects)
export { checkInstallRateLimit };
