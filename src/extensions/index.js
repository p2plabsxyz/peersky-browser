/**
 * Extension Manager - Core Extension System
 * 
 * This module provides the main extension management system for Peersky Browser.
 * It handles extension lifecycle, loading, validation, and metadata management.
 * 
 * Key Features:
 * - Extension installation and management
 * - Manifest validation and metadata handling
 * - Extension enable/disable functionality
 * - Browser action integration
 * - Settings UI integration via IPC
 * 
 * Architecture:
 * - ExtensionManager: Main class handling all extension operations
 * - ManifestValidator: Manifest V3 validation and compliance checking
 * - Electron integration: Built-in extension system integration
 * - IPC communication: UI integration for extension management
 * 
 * Usage:
 * ```javascript
 * import extensionManager from './extensions/index.js';
 * await extensionManager.initialize();
 * ```
 */

import electron from 'electron';
const { app, BrowserWindow, webContents } = electron;
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { installChromeWebStore } from 'electron-chrome-web-store';
import { ElectronChromeExtensions } from 'electron-chrome-extensions';
import ManifestValidator from './manifest-validator.js';
import { loadPolicy } from './policy.js';
import { ensureDir, KeyedMutex, ERR } from './util.js';
// (archive handling moved to services)
import ChromeWebStoreManager from './chrome-web-store.js';
// URL parsing now handled by ManifestValidator
import { withInstallLock, withUpdateLock } from './mutex.js';
import { generateSecureExtensionId } from './utils/ids.js';
import { resolveManifestStrings } from './utils/strings.js';
import * as RegistryService from './services/registry.js';
import * as LoaderService from './services/loader.js';
import * as BrowserActions from './services/browser-actions.js';
import { installExtensionPopupGuards as installPopupGuards } from './services/popup-guards.js';
import * as WebStoreService from './services/webstore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Alternate manifest handling moved to installers/directory.js

/**
 * ExtensionManager - Main extension management class
 * 
 * Handles all extension operations including installation, validation,
 * lifecycle management, and integration with Electron's extension system.
 */
class ExtensionManager {
  constructor() {
    this.isInitialized = false;
    this.loadedExtensions = new Map();
    this.manifestValidator = null;
    this.initializationPromise = null;
    this.mutex = new KeyedMutex();

    // Session and app (set in initialize)
    this.session = null;
    this.app = null;

    // Chrome Web Store manager
    this.chromeWebStore = null;

    // ElectronChromeExtensions for browser actions
    this.electronChromeExtensions = null;

    // Track active popups for auto-close on tab switch
    this.activePopups = new Set();

    // Paths (set in initialize)
    this.extensionsBaseDir = null;
    this.extensionsRegistryFile = null;
  }

  /**
   * Initialize the extension system
   * 
   * @param {Object} options - Configuration options
   * @param {Electron.App} options.app - Electron app instance
   * @param {Electron.Session} options.session - Electron session for extension loading
   */
  async initialize(options) {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }
    this.initializationPromise = this._doInitialize(options);
    return this.initializationPromise;
  }

  async _doInitialize(options) {
    try {
      console.log('ExtensionManager: Starting extension system initialization...');

      // Store references
      this.app = options.app;
      this.session = options.session;

      // Set up paths
      this.extensionsBaseDir = path.join(this.app.getPath('userData'), 'extensions');
      this.extensionsRegistryFile = path.join(this.extensionsBaseDir, 'extensions.json');

      // Create directories
      await ensureDir(this.extensionsBaseDir);

      // Initialize Chrome Web Store support
      console.log('ExtensionManager: Initializing Chrome Web Store support...');
      try {
        await installChromeWebStore({
          session: this.session,
          extensionsPath: this.extensionsBaseDir,
          autoUpdate: false, // Manual updates only for MVP
          loadExtensions: false, // We'll handle loading manually
          allowlist: [], // No restrictions for MVP
          denylist: [] // No restrictions for MVP
        });
        this.chromeWebStore = new ChromeWebStoreManager(this.session);
        console.log('ExtensionManager: Chrome Web Store support initialized');
      } catch (error) {
        console.warn('ExtensionManager: Chrome Web Store initialization failed:', error.message);
        console.warn('ExtensionManager: Continuing without Chrome Web Store support');
        this.chromeWebStore = null;
      }

      // Initialize ElectronChromeExtensions for browser actions
      console.log('ExtensionManager: Initializing ElectronChromeExtensions...');
      try {
        // Provide minimal impl so extensions can open tabs
        this.electronChromeExtensions = new ElectronChromeExtensions({
          session: this.session,
          license: "GPL-3.0", // Compatible with MIT open source Peersky Browser
          /**
           * Create a new tab in the existing window and return [tabWebContents, window].
           * details: { url?: string, active?: boolean, windowId?: number }
           */
          createTab: async (details = {}) => {
            try {
              console.log("[ExtensionManager] createTab called with:", details);

              const url = typeof details.url === "string" && details.url.length > 0 ? details.url : "peersky://home";

              // Find the main Peersky window (the one with the tabbar)
              // Important: Skip small popup windows - they're likely extension popups
              const allWindows = BrowserWindow.getAllWindows();
              let windowWithTabbar = null;

              for (const w of allWindows) {
                if (w.isDestroyed()) continue;

                // Skip small windows (likely extension popups)
                const bounds = w.getBounds();
                if (bounds.width < 500 || bounds.height < 400) {
                  console.log("[ExtensionManager] Skipping small window:", bounds);
                  continue;
                }

                try {
                  const hasTabBar = await w.webContents.executeJavaScript(`
                    !!(document.getElementById('tabbar') && typeof document.getElementById('tabbar').addTab === 'function')
                  `, true);
                  if (hasTabBar) {
                    windowWithTabbar = w;
                    console.log("[ExtensionManager] Found window with tabbar:", w.id);
                    break;
                  }
                } catch (e) {
                  console.log("[ExtensionManager] Window check failed:", e.message);
                }
              }

              if (!windowWithTabbar) {
                console.error("[ExtensionManager] No window with tabbar found!");
                throw new Error("No browser window with tabbar available for createTab");
              }

              // Use direct JavaScript call to tabBar.addTab - more reliable than IPC
              console.log("[ExtensionManager] Creating tab via direct JS for URL:", url);
              const addTabJs = `
                (function() {
                  const tabBar = document.getElementById('tabbar');
                  if (!tabBar || typeof tabBar.addTab !== 'function') {
                    console.error('No tabBar found for addTab');
                    return null;
                  }
                  const tabId = tabBar.addTab(${JSON.stringify(url)}, "New Tab");
                  console.log('[createTab] Added tab:', tabId);
                  return tabId;
                })();
              `;

              const tabId = await windowWithTabbar.webContents.executeJavaScript(addTabJs, true);
              console.log("[ExtensionManager] Tab created with ID:", tabId);

              // Brief delay to let the webview initialize
              await new Promise(r => setTimeout(r, 300));

              // Try to get the tab's webContents
              const getWcJs = `
                (function() {
                  const tabBar = document.getElementById('tabbar');
                  if (!tabBar) return null;
                  const wv = tabBar.getWebviewForTab && tabBar.getWebviewForTab('${tabId}');
                  if (wv && typeof wv.getWebContentsId === 'function') {
                    return wv.getWebContentsId();
                  }
                  // Fallback to active webview
                  const activeWv = tabBar.getActiveWebview && tabBar.getActiveWebview();
                  return activeWv && typeof activeWv.getWebContentsId === 'function' ? activeWv.getWebContentsId() : null;
                })();
              `;

              let wcId = null;
              try {
                wcId = await windowWithTabbar.webContents.executeJavaScript(getWcJs, true);
              } catch (_) { }

              let tabWc = wcId ? webContents.fromId(wcId) : null;

              // Fallback: return the window's webContents
              const retWc = tabWc && !tabWc.isDestroyed() ? tabWc : windowWithTabbar.webContents;
              return [retWc, windowWithTabbar];
            } catch (err) {
              console.error("[ExtensionManager] createTab impl failed:", err);
              throw err;
            }
          },


          /**
           * Select/focus a tab given its WebContents
           */
          selectTab: async (tab, win) => {
            try {
              if (!win || win.isDestroyed()) return;
              const tabId = tab && typeof tab.id === "number" ? tab.id : null;
              if (!tabId) return;
              const js = `
                (function () {
                  const tabBar = document.getElementById('tabbar');
                  if (!tabBar) return false;
                  try {
                    for (const [tid, wv] of tabBar.webviews.entries()) {
                      if (wv && typeof wv.getWebContentsId === 'function' && wv.getWebContentsId() === ${String(tabId)}) {
                        if (typeof tabBar.selectTab === 'function') {
                          tabBar.selectTab(tid);
                        }
                        return true;
                      }
                    }
                  } catch (_) {}
                  return false;
                })();
              `;
              await win.webContents.executeJavaScript(js, true);
            } catch (err) {
              console.warn("[ExtensionManager] selectTab impl failed:", err);
            }
          },

          /**
           * Remove/close a tab given its WebContents
           * Called when extensions use chrome.tabs.remove()
           */
          removeTab: async (tab, win) => {
            try {
              console.log("[ExtensionManager] removeTab called for webContents:", tab?.id);
              
              if (!tab || (typeof tab.isDestroyed === 'function' && tab.isDestroyed())) {
                console.warn("[ExtensionManager] removeTab: tab already destroyed");
                return;
              }

              const wcId = typeof tab.id === "number" ? tab.id : null;
              if (!wcId) {
                console.warn("[ExtensionManager] removeTab: no valid webContents ID");
                return;
              }

              // Find the main window with tabbar
              const allWindows = BrowserWindow.getAllWindows();
              let windowWithTabbar = win && !win.isDestroyed() ? win : null;

              // If win is not valid, find a suitable window
              if (!windowWithTabbar) {
                for (const w of allWindows) {
                  if (w.isDestroyed()) continue;
                  const bounds = w.getBounds();
                  if (bounds.width < 500 || bounds.height < 400) continue;
                  
                  try {
                    const hasTabBar = await w.webContents.executeJavaScript(`
                      !!(document.getElementById('tabbar') && typeof document.getElementById('tabbar').closeTab === 'function')
                    `, true);
                    if (hasTabBar) {
                      windowWithTabbar = w;
                      break;
                    }
                  } catch (_) { }
                }
              }

              if (!windowWithTabbar) {
                console.warn("[ExtensionManager] removeTab: no window with tabbar found");
                return;
              }

              // Find and close the tab by matching webContents ID
              const closeTabJs = `
                (function() {
                  const tabBar = document.getElementById('tabbar');
                  if (!tabBar) {
                    console.error('[removeTab] No tabBar found');
                    return false;
                  }
                  
                  // Find the tab that has this webContents ID
                  if (tabBar.webviews && typeof tabBar.webviews.entries === 'function') {
                    for (const [tabId, wv] of tabBar.webviews.entries()) {
                      if (wv && typeof wv.getWebContentsId === 'function' && wv.getWebContentsId() === ${wcId}) {
                        console.log('[removeTab] Found tab to close:', tabId);
                        if (typeof tabBar.closeTab === 'function') {
                          tabBar.closeTab(tabId);
                          return true;
                        }
                      }
                    }
                  }
                  
                  console.warn('[removeTab] Tab with webContentsId ${wcId} not found');
                  return false;
                })();
              `;

              const result = await windowWithTabbar.webContents.executeJavaScript(closeTabJs, true);
              console.log("[ExtensionManager] removeTab result:", result);
              
            } catch (err) {
              console.error("[ExtensionManager] removeTab impl failed:", err);
            }
          },

          /**
           * Create a new window (for chrome.windows.create)
           * details: { url?: string, type?: 'normal'|'popup'|'panel', width?: number, height?: number, left?: number, top?: number, focused?: boolean }
           * Returns: [tabWebContents, window]
           */
          createWindow: async (details = {}) => {
            try {
              console.log("[ExtensionManager] createWindow called with:", details);

              const url = typeof details.url === "string" && details.url.length > 0 ? details.url : "about:blank";
              const type = details.type || "normal";
              const width = details.width || 400;
              const height = details.height || 600;
              const left = details.left;
              const top = details.top;
              const focused = details.focused !== false; // default true

              // For 'popup' type, create a frameless or minimal window
              const isPopup = type === "popup" || type === "panel";

              const windowOptions = {
                width,
                height,
                x: typeof left === "number" ? left : undefined,
                y: typeof top === "number" ? top : undefined,
                show: false, // Show after load
                frame: !isPopup, // Popup windows are frameless
                titleBarStyle: isPopup ? "hidden" : "default",
                autoHideMenuBar: true,
                resizable: !isPopup,
                minimizable: !isPopup,
                maximizable: !isPopup,
                alwaysOnTop: isPopup,
                skipTaskbar: isPopup,
                webPreferences: {
                  nodeIntegration: false,
                  contextIsolation: true,
                  sandbox: true,
                  partition: this.session ? this.session.partition : undefined,
                }
              };

              // Center window if no position specified
              if (typeof left !== "number" || typeof top !== "number") {
                windowOptions.center = true;
              }

              const newWindow = new BrowserWindow(windowOptions);
              
              console.log("[ExtensionManager] Created new window:", newWindow.id, "type:", type);

              // Track this window for cleanup
              if (this.activePopups) {
                this.activePopups.add(newWindow);
                newWindow.on('closed', () => this.activePopups.delete(newWindow));
              }

              // Register with extension system
              try {
                if (this.electronChromeExtensions) {
                  this.electronChromeExtensions.addTab(newWindow.webContents, newWindow);
                }
              } catch (regErr) {
                console.warn("[ExtensionManager] Failed to register new window with extension system:", regErr);
              }

              // Load the URL
              await newWindow.loadURL(url);

              // Show the window
              if (focused) {
                newWindow.show();
                newWindow.focus();
              } else {
                newWindow.showInactive();
              }

              console.log("[ExtensionManager] Window created and loaded:", url);
              return [newWindow.webContents, newWindow];
              
            } catch (err) {
              console.error("[ExtensionManager] createWindow impl failed:", err);
              throw err;
            }
          },

          /**
           * Remove/close a window (for chrome.windows.remove)
           */
          removeWindow: async (win) => {
            try {
              console.log("[ExtensionManager] removeWindow called for window:", win?.id);
              
              if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
                console.warn("[ExtensionManager] removeWindow: window already destroyed");
                return;
              }

              // Close the window
              win.close();
              console.log("[ExtensionManager] Window closed:", win.id);
              
            } catch (err) {
              console.error("[ExtensionManager] removeWindow impl failed:", err);
            }
          },
        });
        console.log('ExtensionManager: ElectronChromeExtensions initialized');

        try {
          const api = this.electronChromeExtensions?.api?.browserAction;
          if (api && typeof api.onUpdate === 'function' && !api.__peerskyOnUpdatePatched) {
            const originalOnUpdate = api.onUpdate.bind(api);
            api.onUpdate = (...args) => {
              const res = originalOnUpdate(...args);
              this._broadcastBrowserActionUpdated();
              return res;
            };
            api.__peerskyOnUpdatePatched = true;
          }
        } catch (_) { }
      } catch (error) {
        console.warn('ExtensionManager: ElectronChromeExtensions initialization failed:', error.message);
        console.warn('ExtensionManager: Continuing without browser action support');
        this.electronChromeExtensions = null;
      }

      // Initialize validator with policy
      try {
        this.policy = await loadPolicy(this.app);
      } catch (_) {
        this.policy = null;
      }
      this.manifestValidator = new ManifestValidator(this.policy || undefined);

      // Load registry
      await this._readRegistry();

      // Install bundled preinstalled extensions (one-time import)
      try {
        await this._installBundledPreinstalled();
      } catch (err) {
        console.warn('ExtensionManager: Preinstalled import skipped:', err.message || err);
      }

      // Load enabled extensions
      await this._loadExtensionsIntoElectron();

      // Attach navigation guards for extension popups so external URLs open in tabs
      try { installPopupGuards(this); } catch (guardErr) { console.warn('[ExtensionManager] Failed to install popup navigation guards:', guardErr); }

      this.isInitialized = true;
      console.log('ExtensionManager: Extension system initialized successfully');

    } catch (error) {
      console.error('ExtensionManager: Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Import bundled preinstalled extensions from src/preinstalled-extensions
   * Copies into userData if not already present, marks as system/non-removable.
   */
  async _installBundledPreinstalled() {
    // Read manifest generated by postinstall script
    const preDir = path.join(__dirname, 'preinstalled-extensions');
    const jsonPath = path.join(preDir, 'preinstalled.json');
    let manifest;
    try {
      const raw = await fs.readFile(jsonPath, 'utf8');
      manifest = JSON.parse(raw);
    } catch (_) {
      return; // no manifest => nothing to apply
    }

    const entries = Array.isArray(manifest.extensions) ? manifest.extensions : [];
    const desiredIds = new Set(entries.map(e => e.id));

    // Prune removed preinstalled
    const toPrune = Array.from(this.loadedExtensions.values())
      .filter(ext => (ext.source === 'preinstalled' || ext.isSystem === true))
      .filter(ext => !desiredIds.has(ext.id));
    for (const ext of toPrune) {
      try {
        if (this.session && ext.electronId) {
          try { await this.session.removeExtension(ext.electronId); } catch (_) { }
        }
        const extPath = path.join(this.extensionsBaseDir, ext.id);
        await fs.rm(extPath, { recursive: true, force: true });
        this.loadedExtensions.delete(ext.id);
        await this._writeRegistry();
        console.log('ExtensionManager: Pruned removed preinstalled extension:', ext.displayName || ext.name);
      } catch (err) {
        console.warn('ExtensionManager: Failed to prune preinstalled extension', ext.id, err.message || err);
      }
    }

    // Install missing preinstalled
    for (const entry of entries) {
      try {
        if (this.loadedExtensions.has(entry.id)) continue;
        const sourceRef = typeof entry.archive === 'string' && entry.archive.length ? entry.archive : entry.dir;
        if (!sourceRef) {
          console.warn('ExtensionManager: Preinstalled entry missing source reference');
          continue;
        }

        const sourcePath = path.join(preDir, sourceRef);
        let stat;
        try {
          stat = await fs.stat(sourcePath);
        } catch (statErr) {
          console.warn('ExtensionManager: Preinstalled source missing:', sourceRef, statErr.message || statErr);
          continue;
        }

        let extData;
        if (stat.isDirectory()) {
          extData = await this._prepareFromDirectory(sourcePath);
        } else {
          extData = await this._prepareFromArchive(sourcePath);
        }

        // Respect ID from postinstall manifest
        if (entry.id) {
          extData.id = entry.id;
        }
        extData.isSystem = true;
        extData.removable = false;
        extData.source = 'preinstalled';
        await this._saveExtensionMetadata(extData);
        if (this.session && extData.enabled) {
          try {
            const electronExtension = await this.session.loadExtension(extData.installedPath, { allowFileAccess: false });
            extData.electronId = electronExtension.id;
          } catch (loadErr) {
            console.warn('ExtensionManager: Failed to load preinstalled extension:', loadErr.message);
          }
        }
        this.loadedExtensions.set(extData.id, extData);
        await this._writeRegistry();
        console.log('ExtensionManager: Preinstalled extension imported:', extData.displayName || extData.name);
      } catch (err) {
        const ref = entry && (entry.archive || entry.dir || entry.id || 'unknown');
        console.warn('ExtensionManager: Skipped preinstalled entry:', ref, err.message || err);
      }
    }
  }

  /**
   * Install global guards so that extension popups cannot directly navigate to
   * external URLs. Instead, open those URLs in a regular Peersky tab.
   */
  _installExtensionPopupGuards() {
    // Backwards compatibility: delegate to service
    installPopupGuards(this);
  }

  /**
   * Install extension from local directory
   * 
   * @param {string} sourcePath - Path to extension directory
   * @returns {Promise<Object>} Installation result
   */
  async installExtension(sourcePath) {
    return this.mutex.run('install-' + sourcePath, async () => {
      await this.initialize();

      try {
        console.log('ExtensionManager: Installing extension from:', sourcePath);

        // Validate and prepare extension
        const extensionData = await this._prepareExtension(sourcePath);

        // Prevent duplicate installs by internal ID
        if (this.loadedExtensions.has(extensionData.id)) {
          throw Object.assign(new Error(`Extension ${extensionData.id} is already installed`), { code: ERR.E_ALREADY_EXISTS });
        }

        // Use consolidated validation
        const validationResult = await this.manifestValidator.validateExtension(
          extensionData.installedPath,
          extensionData.manifest
        );
        if (validationResult.outcome === 'deny') {
          throw new Error(`Extension validation failed: ${validationResult.errors.join(', ')}`);
        }
        // Attach warnings and risk info for UI/registry
        if (Array.isArray(validationResult.warnings) && validationResult.warnings.length) {
          extensionData.warnings = validationResult.warnings.slice(0, 50);
        }
        if (typeof validationResult.manifestValidation?.riskScore === 'number') {
          extensionData.riskScore = validationResult.manifestValidation.riskScore;
        }

        // Save extension metadata
        await this._saveExtensionMetadata(extensionData);

        // Load extension into Electron's extension system with security restrictions
        if (this.session && extensionData.enabled) {
          try {
            console.log(`ExtensionManager: Loading installed extension into Electron: ${extensionData.name}`);
            let electronExtension = await this.session.loadExtension(extensionData.installedPath, {
              allowFileAccess: false  // Restrict file system access for security
            });
            extensionData.electronId = electronExtension.id;

            // If Chromium computed an ID (e.g., via manifest.key) different from our provisional ID,
            // relocate directory to keep path and icon handling consistent.
            if (electronExtension.id && electronExtension.id !== extensionData.id) {
              const oldId = extensionData.id;
              const versionDirName = path.basename(extensionData.installedPath);
              const newRoot = path.join(this.extensionsBaseDir, electronExtension.id);
              const newVersionPath = path.join(newRoot, versionDirName);
              try {
                await ensureDir(newRoot);
                await fs.rename(extensionData.installedPath, newVersionPath);
                extensionData.installedPath = newVersionPath;
                extensionData.id = electronExtension.id;
                // Move map entry
                this.loadedExtensions.delete(oldId);

                // Reload extension from its new path so resource URLs resolve correctly
                try {
                  await this.session.removeExtension(electronExtension.id);
                } catch (_) { }
                try {
                  electronExtension = await this.session.loadExtension(newVersionPath, { allowFileAccess: false });
                  extensionData.electronId = electronExtension.id;
                } catch (reErr) {
                  console.warn(`ExtensionManager: Reload after relocate failed for ${extensionData.name}:`, reErr);
                }
              } catch (mvErr) {
                console.warn(`ExtensionManager: Could not relocate extension folder to new ID path:`, mvErr);
              }
            }

            // Compute icon path with cache-busting
            const icons = extensionData.manifest?.icons || {};
            const sizes = ['64', '48', '32', '16'];
            for (const s of sizes) {
              if (icons[s]) {
                const v = extensionData.version ? `?v=${encodeURIComponent(extensionData.version)}` : '';
                extensionData.iconPath = `peersky://extension-icon/${extensionData.id}/${s}${v}`;
                break;
              }
            }

            console.log(`ExtensionManager: Extension loaded in Electron: ${extensionData.name} (${electronExtension.id})`);

            // Detect conflicts with existing preinstalled/system extension by Chrome/Electron ID
            const conflict = Array.from(this.loadedExtensions.values()).find(ext => ext.electronId && ext.electronId === extensionData.electronId);
            if (conflict && (conflict.isSystem === true || conflict.source === 'preinstalled')) {
              console.warn(`ExtensionManager: Detected conflict with system extension (${conflict.displayName || conflict.name}). Reverting install.`);
              try {
                // Remove the newly loaded duplicate from Electron
                await this.session.removeExtension(extensionData.electronId);
              } catch (_) { }
              try {
                // Ensure system extension is (re)loaded
                const ee = await this.session.loadExtension(conflict.installedPath, { allowFileAccess: false });
                conflict.electronId = ee.id;
              } catch (reloadErr) {
                console.warn('ExtensionManager: Failed to reload system extension after conflict:', reloadErr);
              }
              // Remove the newly installed files and abort install
              try { await fs.rm(path.join(this.extensionsBaseDir, extensionData.id), { recursive: true, force: true }); } catch (_) { }
              throw Object.assign(new Error('Extension already installed as a system extension'), { code: ERR.E_ALREADY_EXISTS });
            }
          } catch (error) {
            console.error(`ExtensionManager: Failed to load extension into Electron:`, error);
          }
        }

        this.loadedExtensions.set(extensionData.id, extensionData);

        // Auto-pin newly installed extensions that expose a browser action, if pin slots available
        try {
          const action = extensionData.manifest?.action || extensionData.manifest?.browser_action;
          if (action) {
            const pinned = await this.getPinnedExtensions();
            if (pinned.length < 6 && !pinned.includes(extensionData.id)) {
              await this.pinExtension(extensionData.id);
            }
          }
        } catch (_) { }

        // Persist final state
        await this._writeRegistry();
        console.log('ExtensionManager: Extension installed successfully:', extensionData.name);
        return { success: true, extension: extensionData };

      } catch (error) {
        console.error('ExtensionManager: Installation failed:', error);
        throw error;
      }
    });
  }

  /**
   * Enable or disable an extension
   * 
   * @param {string} extensionId - Extension identifier
   * @param {boolean} enabled - Whether to enable or disable
   * @returns {Promise<boolean>} Success status
   */
  async toggleExtension(extensionId, enabled) {
    return this.mutex.run(extensionId, async () => {
      await this.initialize();

      try {
        const extension = this._getById(extensionId);
        if (!extension) {
          throw Object.assign(new Error(`Extension not found: ${extensionId}`), { code: ERR.E_INVALID_ID });
        }

        extension.enabled = enabled;

        if (this.session) {
          try {
            if (enabled) {
              const electronExtension = await this.session.loadExtension(extension.installedPath, {
                allowFileAccess: false  // Restrict file system access for security
              });
              extension.electronId = electronExtension.id;
            } else {
              if (extension.electronId) {
                await this.session.removeExtension(extension.electronId);
              }
            }
          } catch (error) {
            throw Object.assign(
              new Error(enabled ? 'Failed to load extension' : 'Failed to remove extension'),
              { code: enabled ? ERR.E_LOAD_FAILED : ERR.E_REMOVE_FAILED }
            );
          }
        }

        await this._writeRegistry();
        return true;

      } catch (error) {
        console.error('ExtensionManager: Toggle failed:', error);
        throw error;
      }
    });
  }

  /**
   * List all installed extensions
   * 
   * @returns {Promise<Array>} Array of extension metadata
   */
  async listExtensions() {
    await this.initialize();

    try {
      return Array.from(this.loadedExtensions.values());
    } catch (error) {
      console.error('ExtensionManager: List failed:', error);
      throw error;
    }
  }

  /**
   * Get browser actions for current window
   * 
   * @param {Object} window - Window instance
   * @returns {Promise<Array>} Array of browser actions
   */
  async listBrowserActions(window) {
    await this.initialize();
    try { return await BrowserActions.listBrowserActions(this, window); } catch (error) { console.error('ExtensionManager: Failed to list browser actions:', error); return []; }
  }

  /**
   * Handle browser action click
   * 
   * @param {string} actionId - Browser action identifier
   * @param {Object} window - Window instance
   */
  async clickBrowserAction(actionId, window) {
    await this.initialize();
    // Delegate to the browser-actions service which has improved triggering methods
    try {
      await BrowserActions.clickBrowserAction(this, actionId, window);
    } catch (error) {
      console.error('ExtensionManager: Browser action click failed:', error);
    }
  }

  /**
   * Open browser action popup
   * 
   * @param {string} actionId - Browser action identifier
   * @param {Object} window - Window instance
   * @param {Object} anchorRect - Anchor rectangle for popup positioning
   * @returns {Promise<Object>} Success result
   */
  async openBrowserActionPopup(actionId, window, anchorRect = {}) {
    await this.initialize();
    return BrowserActions.openBrowserAction(this, actionId, window, anchorRect);
  }

  /**
   * Register a window with ElectronChromeExtensions for browser action support
   * 
   * @param {Electron.BrowserWindow} window - Window to register
   * @param {Electron.WebContents} webContents - WebContents to register as tab
   */
  addWindow(window, webContents) {
    if (this.electronChromeExtensions) {
      try {
        this.electronChromeExtensions.addTab(webContents, window);
        console.log(`[ExtensionManager] Registered webContents ${webContents.id} with extension system`);
      } catch (error) {
        console.error(`[ExtensionManager] Failed to register window:`, error);
      }
    } else {
      console.warn('[ExtensionManager] ElectronChromeExtensions not available');
    }
  }

  /**
   * Unregister a window from ElectronChromeExtensions
   * 
   * @param {Electron.WebContents} webContents - WebContents to unregister
   */
  removeWindow(webContents) {
    if (!this.electronChromeExtensions || !webContents) {
      return; // Extension system not available or webContents is null
    }

    try {
      // Additional safety check for destroyed webContents
      if (webContents.isDestroyed && webContents.isDestroyed()) {
        console.debug(`[ExtensionManager] Skipping unregister of destroyed webContents`);
        return;
      }

      this.electronChromeExtensions.removeTab(webContents);
      console.log(`[ExtensionManager] Unregistered webContents ${webContents.id} from extension system`);
    } catch (error) {
      // During shutdown, this is expected and not an error
      console.debug(`[ExtensionManager] Extension system cleanup during shutdown:`, error.message);
    }
  }


  /**
   * Uninstall an extension
   * 
   * @param {string} extensionId - Extension identifier
   * @returns {Promise<boolean>} Success status
   */
  async uninstallExtension(extensionId) {
    return this.mutex.run(extensionId, async () => {
      await this.initialize();

      try {
        const extension = this.loadedExtensions.get(extensionId);
        if (!extension) {
          throw new Error(`Extension not found: ${extensionId}`);
        }

        // Prevent uninstall of system/preinstalled extensions
        if (extension.isSystem === true || extension.removable === false || extension.source === 'preinstalled') {
          throw Object.assign(new Error('Cannot uninstall a system extension'), { code: ERR.E_INVALID_STATE });
        }

        // Unload extension from Electron's system
        if (this.session && extension.electronId) {
          try {
            console.log(`ExtensionManager: Unloading extension from Electron: ${extension.displayName || extension.name}`);
            await this.session.removeExtension(extension.electronId);
          } catch (error) {
            console.error(`ExtensionManager: Failed to unload extension from Electron:`, error);
          }
        }

        // Clear extension storage data (localStorage, IndexedDB, cookies, etc.)
        if (this.session) {
          try {
            const extensionOrigin = `chrome-extension://${extensionId}`;
            console.log(`ExtensionManager: Clearing storage data for: ${extensionOrigin}`);
            await this.session.clearStorageData({
              origin: extensionOrigin,
              storages: [
                'cookies',
                'localstorage',
                'indexdb',
                'filesystem',
                'serviceworkers',
                'cachestorage',
                'websql',
                'shadercache'
              ],
              quotas: ['persistent', 'temporary']
            });
            // Flush storage to ensure changes are written
            if (this.session.flushStorageData) {
              await this.session.flushStorageData();
            }
            console.log(`ExtensionManager: Storage data cleared for: ${extensionId}`);
          } catch (error) {
            console.error(`ExtensionManager: Failed to clear storage data for ${extensionId}:`, error);
            // Continue with uninstall regardless
          }
        }

        // Clear extension's chrome.storage data from disk (LevelDB files)
        // These are stored in session storage paths under "Local Extension Settings" and "Sync Extension Settings"
        try {
          const userData = this.app.getPath('userData');
          // Try multiple possible locations where extension storage might be
          const storagePaths = [
            // Default session path
            path.join(userData, 'Local Extension Settings', extensionId),
            path.join(userData, 'Sync Extension Settings', extensionId),
            // Partition session paths (for persist:peersky)
            path.join(userData, 'Partitions', 'persist%3Apeersky', 'Local Extension Settings', extensionId),
            path.join(userData, 'Partitions', 'persist%3Apeersky', 'Sync Extension Settings', extensionId),
            // IndexedDB for extension
            path.join(userData, 'IndexedDB', `chrome-extension_${extensionId}_0.indexeddb.leveldb`),
            path.join(userData, 'Partitions', 'persist%3Apeersky', 'IndexedDB', `chrome-extension_${extensionId}_0.indexeddb.leveldb`),
            // Extension state
            path.join(userData, 'Extension State', extensionId),
            path.join(userData, 'Partitions', 'persist%3Apeersky', 'Extension State', extensionId),
          ];

          for (const storagePath of storagePaths) {
            try {
              await fs.rm(storagePath, { recursive: true, force: true });
            } catch (e) {
              // Silently ignore non-existent paths
            }
          }
          console.log(`ExtensionManager: Removed extension storage data for: ${extensionId}`);
        } catch (error) {
          console.warn(`ExtensionManager: Failed to remove extension storage data for ${extensionId}:`, error.message);
        }

        // If installed from Chrome Web Store, uninstall there as well
        if (extension.source === 'webstore' && this.chromeWebStore) {
          try {
            console.log(`ExtensionManager: Uninstalling from Chrome Web Store: ${extension.name} (${extensionId})`);
            await this.chromeWebStore.uninstallById(extensionId);
          } catch (error) {
            console.error(`ExtensionManager: Chrome Web Store uninstall failed for ${extension.displayName || extension.name}:`, error);
            // Continue with local removal regardless
          }
        }

        // Remove extension files
        const extensionPath = path.join(this.extensionsBaseDir, extensionId);
        await fs.rm(extensionPath, { recursive: true, force: true });

        // Remove from loaded extensions
        this.loadedExtensions.delete(extensionId);

        // Update registry file
        await this._writeRegistry();

        // Also remove from pinned list if present
        try {
          const pins = await RegistryService.getPinned(this.extensionsBaseDir);
          const idx = pins.indexOf(extensionId);
          if (idx !== -1) {
            pins.splice(idx, 1);
            await RegistryService.setPinned(this.extensionsBaseDir, pins);
          }
        } catch (_) { }

        console.log('ExtensionManager: Extension uninstalled:', extensionId);
        return true;

      } catch (error) {
        console.error('ExtensionManager: Uninstall failed:', error);
        throw error;
      }
    });
  }

  /**
   * Install extension from Chrome Web Store URL or ID
   * 
   * @param {string} urlOrId - Chrome Web Store URL or extension ID
   * @returns {Promise<Object>} Installation result with extension metadata
   */
  async installFromWebStore(urlOrId) {
    return withInstallLock(async () => { await this.initialize(); return WebStoreService.installFromWebStore(this, urlOrId); });
  }

  /**
   * Update all extensions to latest versions
   * 
   * @returns {Promise<Object>} Update results with counts and errors
   */
  async updateAllExtensions() {
    return withUpdateLock(async () => { await this.initialize(); return WebStoreService.updateAllExtensions(this); });
  }

  /**
   * Update extension system configuration
   * 
   * @param {Object} newConfig - Configuration updates
   */
  updateConfig(newConfig) {
    try {
      console.log('ExtensionManager: Updating configuration:', newConfig);
      this.config = { ...this.config, ...newConfig };
    } catch (error) {
      console.error('ExtensionManager: Configuration update failed:', error);
      throw error;
    }
  }

  /**
   * Get system status and health information
   * 
   * @returns {Object} System status
   */
  getStatus() {
    try {
      return {
        initialized: this.isInitialized,
        config: this.config,
        extensionCount: this.loadedExtensions.size,
        enabledCount: Array.from(this.loadedExtensions.values()).filter(ext => ext.enabled).length
      };
    } catch (error) {
      console.error('ExtensionManager: Status check failed:', error);
      throw error;
    }
  }

  /**
   * Shutdown the extension system
   */
  async shutdown() {
    try {
      console.log('ExtensionManager: Shutting down extension system...');

      if (this.isInitialized) {
        // Save final registry
        await this._writeRegistry();

        // Unload all extensions from Electron's system
        if (this.session) {
          try {
            console.log('ExtensionManager: Unloading all extensions from Electron...');
            for (const extension of this.loadedExtensions.values()) {
              if (extension.electronId) {
                try {
                  await this.session.removeExtension(extension.electronId);
                  console.log(`ExtensionManager: Extension unloaded: ${extension.displayName || extension.name}`);
                } catch (error) {
                  console.error(`ExtensionManager: Failed to unload extension ${extension.displayName || extension.name}:`, error);
                }
              }
            }
          } catch (error) {
            console.error('ExtensionManager: Failed to unload extensions from Electron:', error);
          }
        }
      }

      this.isInitialized = false;
      console.log('ExtensionManager: Extension system shutdown complete');

    } catch (error) {
      console.error('ExtensionManager: Shutdown failed:', error);
      throw error;
    }
  }

  /**
   * Read registry from file with validation
   */
  async _readRegistry() {
    return RegistryService.loadRegistry(this);
  }

  /**
   * Write registry to file
   */
  async _writeRegistry() {
    return RegistryService.writeRegistry(this);
  }

  /**
   * Validate and clean registry by removing entries with missing directories
   * @returns {Object} Cleanup results
   */
  async validateAndCleanRegistry() {
    return RegistryService.validateAndClean(this);
  }

  /**
   * Get extension by ID, internal helper
   */
  _getById(extensionId) {
    return this.loadedExtensions.get(extensionId);
  }

  /**
   * Generate secure extension ID using cryptographic hashing
   * Prevents path traversal attacks through malicious extension names
   * 
   * @param {Object} manifest - Extension manifest object
   * @returns {string} Secure 32-character hexadecimal extension ID
   */
  _generateSecureExtensionId(manifest) {
    // Delegate to utils to keep a single source of truth
    try { return generateSecureExtensionId(manifest); } catch (e) {
      console.error('ExtensionManager: Failed to generate secure extension ID:', e);
      throw new Error('Failed to generate secure extension ID');
    }
  }

  /**
   * Securely copy extension files with path validation and atomic operations
   * Prevents directory traversal and malicious file injection
   * 
   * @param {string} sourcePath - Source directory path
   * @param {string} targetPath - Target directory path
   * @param {Object} manifest - Extension manifest for validation
   * @returns {Promise<void>}
   */
  async _secureFileCopy(sourcePath, targetPath, manifest) {
    try {
      // Validate source and target paths
      const resolvedSource = path.resolve(sourcePath);
      const resolvedTarget = path.resolve(targetPath);

      // Ensure target is within extensions directory (prevent directory traversal)
      if (!resolvedTarget.startsWith(this.extensionsBaseDir)) {
        throw new Error('Invalid target path: outside extensions directory');
      }

      // Validate source directory exists and is readable
      const sourceStats = await fs.stat(resolvedSource);
      if (!sourceStats.isDirectory()) {
        throw new Error('Source must be a directory');
      }

      // Basic file validation is now handled by ManifestValidator.validateExtension()

      // Use atomic operations: copy to temporary location first
      const tempPath = `${resolvedTarget}.tmp.${Date.now()}`;

      try {
        // Copy to temporary location
        await fs.cp(resolvedSource, tempPath, { recursive: true });

        // Remove target if it exists
        try {
          await fs.rm(resolvedTarget, { recursive: true, force: true });
        } catch (error) {
          // Target might not exist, which is fine
        }

        // Atomic move from temp to final location
        await fs.rename(tempPath, resolvedTarget);

        console.log(`ExtensionManager: Securely copied extension to: ${resolvedTarget}`);

      } catch (error) {
        // Clean up temp directory on error
        try {
          await fs.rm(tempPath, { recursive: true, force: true });
        } catch (cleanupError) {
          console.warn('ExtensionManager: Failed to cleanup temp directory:', cleanupError);
        }
        throw error;
      }

    } catch (error) {
      console.error('ExtensionManager: Secure file copy failed:', error);
      throw new Error(`Secure file copy failed: ${error.message}`);
    }
  }

  // File validation methods removed - now handled by ManifestValidator.validateExtensionFiles()

  /**
   * Load extensions into Electron's extension system
   */
  async _loadExtensionsIntoElectron() {
    return LoaderService.loadExtensionsIntoElectron(this);
  }

  /**
   * Prepare extension from source path (directory or ZIP/CRX file)
   */
  async _prepareExtension(sourcePath) {
    const stats = await fs.stat(sourcePath);
    if (stats.isDirectory()) { return (await import('./services/installers/directory.js')).prepareFromDirectory(this, sourcePath); }
    return (await import('./services/installers/archive.js')).prepareFromArchive(this, sourcePath);
  }

  /**
   * Prepare extension from directory (secured)
   */
  async _prepareFromDirectory(dirPath) { return (await import('./services/installers/directory.js')).prepareFromDirectory(this, dirPath); }

  /**
   * Prepare extension from ZIP/CRX archive
   */
  async _prepareFromArchive(archivePath) {
    return (await import('./services/installers/archive.js')).prepareFromArchive(this, archivePath);
  }

  /**
   * Save extension metadata (deprecated - use _writeRegistry)
   */
  async _saveExtensionMetadata(extensionData) {
    this.loadedExtensions.set(extensionData.id, extensionData);
    await this._writeRegistry();
  }

  /**
   * Resolve i18n placeholders from _locales messages.json
   * Supports manifest.default_locale and app locale fallbacks.
   */
  async _resolveManifestStrings(installedPath, manifest) {
    try { const appLocale = (this.app && typeof this.app.getLocale === 'function') ? this.app.getLocale() : 'en'; return await resolveManifestStrings(installedPath, manifest, appLocale, 'en'); } catch (_) { return { name: manifest?.name, description: manifest?.description || '' }; }
  }

  /**
   * Save all extension metadata (deprecated - use _writeRegistry)
   */
  async _saveAllExtensionMetadata() {
    await this._writeRegistry();
  }

  /**
   * Get the active webview and register it with the extension system
   * Uses the same reliable approach as bookmarks
   * 
   * @param {Electron.BrowserWindow} window - Browser window
   * @returns {Promise<Electron.WebContents|null>} Active webview WebContents or null
   */
  async _getAndRegisterActiveWebview(window) { return (await import('./services/browser-actions.js')).getAndRegisterActiveWebview(this, window); }

  async _doesExtensionFileExist(root, rel) { return (await import('./services/browser-actions.js')).doesExtensionFileExist(root, rel); }

  async _resolvePopupRelativePath(root, desiredRel) { return (await import('./services/browser-actions.js')).resolvePopupRelativePath(root, desiredRel); }

  async _findFileByName(_dir, _name, _depth) { return null; }

  _broadcastBrowserActionChanged() {
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win || win.isDestroyed()) continue;
        const wc = win.webContents;
        if (!wc || wc.isDestroyed()) continue;
        wc.send('browser-action-changed', { t: Date.now() });
        wc.send('refresh-browser-actions');
      }
    } catch (_) { }
  }

  _broadcastBrowserActionUpdated() {
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win || win.isDestroyed()) continue;
        const wc = win.webContents;
        if (!wc || wc.isDestroyed()) continue;
        wc.send('browser-action-updated', { t: Date.now() });
      }
    } catch (_) { }
  }

  /**
   * Close all active extension popups
   */
  closeAllPopups() {
    if (this.activePopups.size > 0) {
      console.log(`[ExtensionManager] Closing ${this.activePopups.size} active popups`);

      for (const popup of this.activePopups) {
        try {
          if (!popup.isDestroyed()) {
            popup.close();
          }
        } catch (error) {
          console.warn('[ExtensionManager] Error closing popup:', error);
        }
      }

      this.activePopups.clear();
    }
  }

  /**
   * Get list of pinned extension IDs
   * 
   * @returns {Promise<Array<string>>} Array of pinned extension IDs
   */
  async getPinnedExtensions() {
    await this.initialize();

    try {
      const raw = await RegistryService.getPinned(this.extensionsBaseDir);
      const filtered = Array.isArray(raw)
        ? raw.filter(id => {
          const ext = this.loadedExtensions.get(id);
          return !!(ext && ext.enabled);
        })
        : [];
      if (filtered.length !== raw.length) {
        try { await RegistryService.setPinned(this.extensionsBaseDir, filtered); } catch (_) { }
      }
      return filtered;
    } catch (error) {
      console.warn('[ExtensionManager] Error reading pinned extensions:', error);
      return [];
    }
  }

  /**
   * Pin extension to toolbar (max 6 extensions)
   * 
   * @param {string} extensionId - Extension ID to pin
   * @returns {Promise<boolean>} Success status
   */
  async pinExtension(extensionId) {
    await this.initialize();

    try {
      // Validate extension exists and is enabled
      const extension = this._getById(extensionId);
      if (!extension) {
        throw Object.assign(new Error(`Extension not found: ${extensionId}`), { code: ERR.E_INVALID_ID });
      }

      if (!extension.enabled) {
        throw Object.assign(new Error('Cannot pin disabled extension'), { code: ERR.E_INVALID_STATE });
      }

      // Get current pinned extensions (auto-healed list)
      const pinnedExtensions = await this.getPinnedExtensions();

      // Check if already pinned
      if (pinnedExtensions.includes(extensionId)) {
        console.log(`[ExtensionManager] Extension ${extensionId} is already pinned`);
        return true;
      }

      // Check pin limit (max 6 extensions)
      if (pinnedExtensions.length >= 6) {
        throw Object.assign(new Error('Maximum 6 extensions can be pinned'), { code: ERR.E_PIN_LIMIT });
      }

      // Add to pinned list
      pinnedExtensions.push(extensionId);

      // Save pinned extensions
      await RegistryService.setPinned(this.extensionsBaseDir, pinnedExtensions);

      console.log(`[ExtensionManager] Extension ${extensionId} pinned successfully`);
      this._broadcastBrowserActionChanged();
      return true;

    } catch (error) {
      console.error('[ExtensionManager] Pin extension failed:', error);
      throw error;
    }
  }

  /**
   * Unpin extension from toolbar
   * 
   * @param {string} extensionId - Extension ID to unpin
   * @returns {Promise<boolean>} Success status
   */
  async unpinExtension(extensionId) {
    await this.initialize();

    try {
      // Get current pinned extensions (auto-healed list)
      const pinnedExtensions = await this.getPinnedExtensions();

      // Check if extension is pinned
      const pinnedIndex = pinnedExtensions.indexOf(extensionId);
      if (pinnedIndex === -1) {
        console.log(`[ExtensionManager] Extension ${extensionId} is not pinned`);
        return true;
      }

      // Remove from pinned list
      pinnedExtensions.splice(pinnedIndex, 1);

      // Save pinned extensions
      await RegistryService.setPinned(this.extensionsBaseDir, pinnedExtensions);

      console.log(`[ExtensionManager] Extension ${extensionId} unpinned successfully`);
      this._broadcastBrowserActionChanged();
      return true;

    } catch (error) {
      console.error('[ExtensionManager] Unpin extension failed:', error);
      throw error;
    }
  }
}

// Create singleton instance
const extensionManager = new ExtensionManager();

// Export individual components for direct use if needed
export {
  ManifestValidator
};

// Export singleton manager instance as default
export default extensionManager;

// Export manager instance with explicit name for clarity
export { extensionManager };
