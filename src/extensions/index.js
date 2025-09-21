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
import { createHash, randomBytes } from 'crypto';
import { Menu } from "electron"; // for context menu
import { installChromeWebStore } from 'electron-chrome-web-store';
import { ElectronChromeExtensions } from 'electron-chrome-extensions';
import ManifestValidator from './manifest-validator.js';
import { loadPolicy } from './policy.js';
import { ensureDir, readJsonSafe, writeJsonAtomic, KeyedMutex, ERR, atomicReplaceDir } from './util.js';
import { extractZipFile, extractZipBuffer } from './zip.js';
import { isCrx, extractCrx, derToBase64 } from './crx.js';
import ChromeWebStoreManager from './chrome-web-store.js';
// URL parsing now handled by ManifestValidator
import { withExtensionLock, withInstallLock, withUpdateLock } from './mutex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Recognized alternate manifest filenames in preference order.
// Firefox variant is last-resort and may be incompatible with Chromium/Electron.
const PREFERRED_MANIFEST_ALTS = [
  'manifest.chromium.json',
  'manifest.chrome.json',
  'manifest.chrome-mv3.json',
  'manifest.mv3.json',
  'manifest.v3.json',
  'manifest.firefox.json'
];

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
              // Resolve target window
              let win = null;
              if (details.windowId && typeof details.windowId === "number") {
                win = BrowserWindow.fromId(details.windowId) || null;
              }
              if (!win) {
                win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
              }
              if (!win) {
                throw new Error("No browser window available for createTab");
              }

              // Ensure we are targeting a Peersky window that contains the tab bar
              const hasTabBar = async (w) => {
                try {
                  return await w.webContents.executeJavaScript(`
                    (function () {
                      const tb = document.getElementById('tabbar');
                      return !!(tb && typeof tb.addTab === 'function');
                    })();
                  `, true);
                } catch (_) { return false; }
              };

              if (!(await hasTabBar(win))) {
                const parent = win.getParentWindow && win.getParentWindow();
                if (parent && await hasTabBar(parent)) {
                  win = parent;
                } else {
                  const windows = BrowserWindow.getAllWindows();
                  for (const w of windows) {
                    if (await hasTabBar(w)) { win = w; break; }
                  }
                }
              }

              const url = typeof details.url === "string" && details.url.length > 0 ? details.url : "peersky://home";
              const js = `
                (async () => {
                  const tabBar = document.getElementById('tabbar');
                  if (!tabBar || typeof tabBar.addTab !== 'function') {
                    return { tabId: null, webContentsId: null };
                  }
                  const tabId = tabBar.addTab(${JSON.stringify(url)}, "New Tab");
                  const getId = () => {
                    try {
                      const wv = tabBar.getWebviewForTab(tabId);
                      if (wv && typeof wv.getWebContentsId === 'function') {
                        return wv.getWebContentsId();
                      }
                    } catch (_) {}
                    return null;
                  };
                  let webContentsId = getId();
                  let attempts = 0;
                  while (!webContentsId && attempts < 200) { // wait up to ~10s
                    await new Promise(r => setTimeout(r, 50));
                    webContentsId = getId();
                    attempts++;
                  }
                  return { tabId, webContentsId };
                })();
              `;

              const result = await win.webContents.executeJavaScript(js, true);
              const wcId = result && typeof result.webContentsId === "number" ? result.webContentsId : null;
              let tabWc = wcId ? webContents.fromId(wcId) : null;

              // Fallback: try to locate the webview by scanning all webContents
              if (!tabWc) {
                try {
                  const all = webContents.getAllWebContents();
                  const candidates = all.filter(wc => {
                    try { 
                      return wc.getType && wc.getType() === 'webview'; 
                    } catch (_) { 
                      return false; 
                    }
                  });
                  // Prefer webviews whose host is this window
                  const byHost = candidates.filter(wc => wc.hostWebContents && wc.hostWebContents.id === win.webContents.id);
                  // If URL is already set, try to match it
                  tabWc = byHost.find(wc => {
                    try { 
                      return typeof wc.getURL === 'function' && wc.getURL() === url; 
                    } catch (_) { 
                      return false; 
                    }
                  }) || byHost[0] || candidates[0] || null;
                } catch (scanErr) {
                  console.warn('[ExtensionManager] createTab fallback scan failed:', scanErr);
                }
              }

              // Fallback to the window's webContents if we couldn't get the webview yet
              const retWc = tabWc && !tabWc.isDestroyed() ? tabWc : win.webContents;
              return [retWc, win];
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
        });
        console.log('ExtensionManager: ElectronChromeExtensions initialized');
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
      try {
        this._installExtensionPopupGuards();
      } catch (guardErr) {
        console.warn('[ExtensionManager] Failed to install popup navigation guards:', guardErr);
      }

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
          try { await this.session.removeExtension(ext.electronId); } catch (_) {}
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
        const dir = path.join(preDir, entry.dir);
        const extData = await this._prepareFromDirectory(dir);
        // Respect ID from postinstall manifest
        extData.id = entry.id;
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
        console.warn('ExtensionManager: Skipped preinstalled entry:', entry && entry.dir, err.message || err);
      }
    }
  }

  /**
   * Install global guards so that extension popups cannot directly navigate to
   * external URLs. Instead, open those URLs in a regular Peersky tab.
   */
  _installExtensionPopupGuards() {
    if (!this.app) return;

    const isExternalUrl = (url) => /^(https?:|ipfs:|ipns:|hyper:|web3:)/i.test(url);

    const openInPeerskyTab = async (url) => {
      try {
        if (this.electronChromeExtensions && this.electronChromeExtensions.createTab) {
          await this.electronChromeExtensions.createTab({ url, active: true });
          return true;
        }
      } catch (err) {
        console.warn('[ExtensionManager] createTab failed, falling back to UI script:', err);
      }

      // Fallback: find a peersky window with a tab bar
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win || win.isDestroyed()) continue;
        try {
          const ok = await win.webContents.executeJavaScript(`
            (function () {
              const tabBar = document.getElementById('tabbar');
              if (tabBar && typeof tabBar.addTab === 'function') {
                tabBar.addTab(${JSON.stringify(url)}, 'New Tab');
                return true;
              }
              return false;
            })();
          `, true);
          if (ok) return true;
        } catch (_) {}
      }
      return false;
    };

    const attachGuards = (wc) => {
      // Only attach once
      if (wc.__peerskyPopupGuardsInstalled) return;
      wc.__peerskyPopupGuardsInstalled = true;

      let isExtensionPopup = false;

      // Determine if this contents is an extension popup when navigation starts
      wc.on('did-start-navigation', (_e, url, _isInPlace, isMainFrame) => {
        if (!isMainFrame) return;
        if (url && url.startsWith('chrome-extension://')) {
          isExtensionPopup = true;
        }
      });

      // Guard window.open from popups
      wc.setWindowOpenHandler((details) => {
        if (isExtensionPopup && isExternalUrl(details.url)) {
          openInPeerskyTab(details.url);
          return { action: 'deny' };
        }
        return { action: 'allow' };
      });

      // Guard top-level navigation from popups
      wc.on('will-navigate', (event, url) => {
        if (isExtensionPopup && isExternalUrl(url)) {
          event.preventDefault();
          openInPeerskyTab(url);
          const popupWin = BrowserWindow.fromWebContents(wc);
          if (popupWin && !popupWin.isDestroyed()) {
            try { popupWin.close(); } catch (_) {}
          }
        }
      });
    };

    this.app.on('web-contents-created', (_e, wc) => {
      // Only act on BrowserWindow webContents; ignore webviews (handled in tab-bar)
      try { attachGuards(wc); } catch (_) {}
    });
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
                } catch (_) {}
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
            const sizes = ['64','48','32','16'];
            for (const s of sizes) {
              if (icons[s]) {
                const v = extensionData.version ? `?v=${encodeURIComponent(extensionData.version)}` : '';
                extensionData.iconPath = `peersky://extension-icon/${extensionData.id}/${s}${v}`;
                break;
              }
            }

            console.log(`ExtensionManager: Extension loaded in Electron: ${extensionData.name} (${electronExtension.id})`);
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
        } catch (_) {}
        
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
    
    try {
      const actions = [];
      
      // Get all enabled extensions; mark whether they expose a browser action
      for (const extension of this.loadedExtensions.values()) {
        if (extension.enabled && extension.manifest) {
          // Check for action (MV3) or browser_action (MV2)
          const action = extension.manifest.action || extension.manifest.browser_action;
          actions.push({
            id: extension.id,
            extensionId: extension.electronId,
            name: extension.displayName || extension.name,
            title: (action && (action.default_title || extension.displayName || extension.name)) || (extension.displayName || extension.name),
            icon: extension.iconPath,
            popup: action ? action.default_popup : undefined,
            // Badge text can be populated from extension state when available
            badgeText: '',
            badgeBackgroundColor: '#666', // Default badge color
            enabled: true,
            hasAction: Boolean(action)
          });
        }
      }
      
      if (actions.length > 0) {
        console.log(`ExtensionManager: Found ${actions.length} browser actions`);
      }
      return actions;
      
    } catch (error) {
      console.error('ExtensionManager: Failed to list browser actions:', error);
      return [];
    }
  }

  /**
   * Handle browser action click
   * 
   * @param {string} actionId - Browser action identifier
   * @param {Object} window - Window instance
   */
  async clickBrowserAction(actionId, window) {
    await this.initialize();
    
    try {
      const extension = this.loadedExtensions.get(actionId);
      if (!extension || !extension.enabled) {
        console.warn(`ExtensionManager: Extension ${actionId} not found or disabled`);
        return;
      }

      const action = extension.manifest?.action || extension.manifest?.browser_action;
      if (!action) {
        console.warn(`ExtensionManager: Extension ${actionId} has no browser action`);
        return;
      }

      // Trigger browser action click event via ElectronChromeExtensions
      if (this.electronChromeExtensions && extension.electronId) {
        try {
          console.log(`ExtensionManager: Triggering browser action click for ${extension.displayName || extension.name}`);
          
          // Get the active tab for the browser action context
          const activeTab = window.webContents;
          
          // Try using the browserAction API directly
          if (this.electronChromeExtensions.api && this.electronChromeExtensions.api.browserAction) {
            const browserActionAPI = this.electronChromeExtensions.api.browserAction;
            
            // Create tab context for the browser action
            const tabInfo = { 
              id: activeTab.id, 
              windowId: window.id,
              url: activeTab.getURL(),
              active: true
            };
            
            try {
              // Try to trigger browser action click via the API
              if (browserActionAPI.onClicked) {
                browserActionAPI.onClicked.trigger(tabInfo);
                console.log(`ExtensionManager: Browser action API triggered for ${extension.displayName || extension.name}`);
                return;
              }
              
              // Alternative: Try to simulate a click event
              if (browserActionAPI.click) {
                await browserActionAPI.click(extension.electronId, tabInfo);
                console.log(`ExtensionManager: Browser action click API called for ${extension.displayName || extension.name}`);
                return;
              }
            } catch (apiError) {
              console.warn(`ExtensionManager: Browser action API failed for ${extension.displayName || extension.name}:`, apiError);
            }
          }
          
          // Try to get and trigger the browser action
          if (this.electronChromeExtensions.getBrowserAction) {
            const browserAction = this.electronChromeExtensions.getBrowserAction(extension.electronId);
            if (browserAction && browserAction.onClicked) {
              const tabInfo = { id: activeTab.id, windowId: window.id, url: activeTab.getURL() };
              browserAction.onClicked.trigger(tabInfo);
              console.log(`ExtensionManager: Browser action onClicked triggered for ${extension.displayName || extension.name}`);
              return;
            }
          }
          
          console.warn(`ExtensionManager: No suitable browser action trigger found for ${extension.displayName || extension.name}`);
          
        } catch (error) {
          console.error(`ExtensionManager: Failed to trigger browser action for ${extension.displayName || extension.name}:`, error);
        }
      }
      
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
    
    try {
      const extension = this.loadedExtensions.get(actionId);
      if (!extension || !extension.enabled) {
        console.warn(`ExtensionManager: Extension ${actionId} not found or disabled`);
        return { success: false, error: 'Extension not found or disabled' };
      }

      const action = extension.manifest?.action || extension.manifest?.browser_action;
      if (!action) {
        console.warn(`ExtensionManager: Extension ${actionId} has no browser action`);
        return { success: false, error: 'No browser action found' };
      }

      // Check if action has a popup
      if (!action.default_popup) {
        console.log(`ExtensionManager: Extension ${extension.displayName || extension.name} has no popup, triggering click instead`);
        await this.clickBrowserAction(actionId, window);
        return { success: true };
      }

      // Resolve popup path before triggering (handle missing/relocated files)
      const popupRelRaw = String(action.default_popup || '').replace(/^\//, '');
      const popupExists = await this._doesExtensionFileExist(extension.installedPath, popupRelRaw);
      let resolvedPopupRel = popupRelRaw;
      if (!popupExists) {
        const alt = await this._resolvePopupRelativePath(extension.installedPath, popupRelRaw);
        if (alt) {
          console.warn(`ExtensionManager: Manifest popup missing (${popupRelRaw}), using detected ${alt}`);
          resolvedPopupRel = alt;
        }
      }

      // Open popup via ElectronChromeExtensions
      if (this.electronChromeExtensions && extension.electronId) {
        try {
          console.log(`ExtensionManager: Opening popup for ${extension.displayName || extension.name} at`, anchorRect);
          
          // Find and register the active webview with the extension system
          const activeWebview = await this._getAndRegisterActiveWebview(window);
          const activeTab = activeWebview || window.webContents; // Use webview if available, fallback to main window
          
          if (!activeWebview) {
            console.warn(`[ExtensionManager] No active webview found for ${extension.displayName || extension.name} popup, using main window fallback`);
          } else {
            console.log(`[ExtensionManager] Using active webview for ${extension.displayName || extension.name} popup: ${activeTab.getURL()}`);
            
            // Try to set active tab in ElectronChromeExtensions if methods are available
            try {
              if (this.electronChromeExtensions.setActiveTab) {
                this.electronChromeExtensions.setActiveTab(activeTab);
              } else if (this.electronChromeExtensions.activateTab) {
                this.electronChromeExtensions.activateTab(activeTab);
              } else if (this.electronChromeExtensions.selectTab) {
                this.electronChromeExtensions.selectTab(activeTab);
              }
            } catch (error) {
              console.warn(`[ExtensionManager] Could not set active tab:`, error);
            }
          }
          
          // Try to trigger the browser action via ElectronChromeExtensions
          // This should open the popup if the extension has one
          if (this.electronChromeExtensions.getBrowserAction && popupExists) {
            const browserAction = this.electronChromeExtensions.getBrowserAction(extension.electronId);
            if (browserAction && browserAction.onClicked) {
              // Trigger the browser action click which should open popup using the active webview
              browserAction.onClicked.trigger(activeTab);
              console.log(`ExtensionManager: Browser action triggered for ${extension.displayName || extension.name}`);
              return { success: true };
            }
          }
          
          // Fallback: Try direct ElectronChromeExtensions API
          if (this.electronChromeExtensions.api && popupExists) {
            try {
              // Attempt to open popup directly if possible
              const api = this.electronChromeExtensions.api;
              if (api.browserAction && api.browserAction.openPopup) {
                // ElectronChromeExtensions openPopup expects an event object with extension context
                // Use a one-time listener to avoid accumulating global handlers per popup open
                app.once("browser-window-created", (event, newWindow) => {
                  newWindow.webContents.once("did-finish-load", () => {
                    const url = newWindow.webContents.getURL();
                    if (
                      url.includes(
                        `chrome-extension://${extension.electronId}/`
                      )
                    ) {
                      // Register popup window with extension system so chrome.* APIs work reliably
                      try {
                        this.addWindow(newWindow, newWindow.webContents);
                      } catch (_) {}
                      // Add a context menu consistent with main window behavior
                      newWindow.webContents.on(
                        "context-menu",
                        (evt, params) => {
                          const menu = Menu.buildFromTemplate([
                            {
                              label: "Inspect",
                              click: () => {
                                try {
                                  if (!newWindow.webContents.isDevToolsOpened()) {
                                    newWindow.webContents.openDevTools({ mode: "detach" });
                                  }
                                } catch (_) {}
                                try {
                                  newWindow.webContents.inspectElement(params.x, params.y);
                                } catch (_) {}
                              },
                            },
                          ]);
                          // Position the menu at the click location within the popup window
                          try {
                            menu.popup({ window: newWindow, x: params.x, y: params.y });
                          } catch (_) {
                            // Fallback to default popup if coordinates are unavailable
                            menu.popup({ window: newWindow });
                          }
                        }
                      );
                      function lockWindowPosition(win, getPosition) {
                        if (!win || win.isDestroyed()) return;

                        const _setBounds = win.setBounds.bind(win);

                        const _setBoundsSafe = (newBounds) => {
                          if (win.isDestroyed()) return;

                          const pos = getPosition(newBounds);

                          _setBounds({
                            x: pos.x,
                            y: pos.y,
                            width: newBounds.width,
                            height: newBounds.height,
                          });
                        };

                        win.setBounds = _setBoundsSafe;
                      }

                      const calcPosition = (popupBounds) => {
                        const mainBounds = window.getBounds();
                        return {
                          x:
                            mainBounds.x +
                            anchorRect.x -
                            popupBounds.width +
                            anchorRect.width,
                          y: mainBounds.y + anchorRect.y + 38,
                        };
                      };

                      lockWindowPosition(newWindow, calcPosition);

                      newWindow.on("closed", () => {
                        const mainWindow = BrowserWindow.getAllWindows().find(
                          (w) => !w.isDestroyed()
                        );
                        if (mainWindow) {
                          mainWindow.webContents.send("remove-all-tempIcon");
                        }
                      });
                    }
                  });
                });
                    
                await api.browserAction.openPopup(
                  { extension: { id: extension.electronId } }, 
                  { windowId: window.id }
                );
                console.log(`ExtensionManager: Popup opened directly for ${extension.displayName || extension.name}`);
                return { success: true };
              }
            } catch (directError) {
              console.warn(`ExtensionManager: Direct popup API failed for ${extension.displayName || extension.name}:`, directError);
            }
          }
          
          // Final fallback: trigger a regular click which should open popup
          console.log(`ExtensionManager: Falling back to regular click for ${extension.displayName || extension.name}`);
          await this.clickBrowserAction(actionId, window);
          
          // Ultimate fallback: Try to open popup by simulating Chrome extension behavior
          if (resolvedPopupRel) {
            console.log(`ExtensionManager: Attempting manual popup creation for ${extension.displayName || extension.name}`);
            try {
              // Create a popup window manually if all else fails
              const popupUrl = `chrome-extension://${extension.electronId}/${resolvedPopupRel}`;
              const popupWindow = new (await import('electron')).BrowserWindow({
                width: 400,
                height: 600,
                x: Math.round(anchorRect.x),
                y: Math.round(anchorRect.bottom + 5),
                show: false,
                frame: false,
                resizable: false,
                webPreferences: {
                  nodeIntegration: false,
                  contextIsolation: true,
                  enableRemoteModule: false,
                  partition: window.webContents.session.partition
                }
              });

              // Register popup with extension system prior to load
              try {
                this.addWindow(popupWindow, popupWindow.webContents);
              } catch (_) {}

              // Ensure external URLs from popup open in regular tabs
              const isExternalUrl = (u) => /^(https?:|ipfs:|ipns:|hyper:|web3:)/i.test(u);
              popupWindow.webContents.setWindowOpenHandler(({ url }) => {
                if (isExternalUrl(url)) {
                  // Prefer built-in createTab; fallback to injecting addTab
                  if (this.electronChromeExtensions && this.electronChromeExtensions.createTab) {
                    this.electronChromeExtensions.createTab({ url, active: true });
                  } else {
                    window.webContents.executeJavaScript(
                      `(() => { 
                        const tabBar = document.getElementById('tabbar'); 
                        if (tabBar && tabBar.addTab) { 
                          tabBar.addTab(${JSON.stringify(url)}, 'New Tab'); 
                          return true; 
                        } 
                        return false; 
                      })()`,
                      true
                    ).catch(() => {});
                  }
                  return { action: 'deny' };
                }
                return { action: 'allow' };
              });
              popupWindow.webContents.on('will-navigate', (evt, targetUrl) => {
                if (isExternalUrl(targetUrl)) {
                  evt.preventDefault();
                  if (this.electronChromeExtensions && this.electronChromeExtensions.createTab) {
                    this.electronChromeExtensions.createTab({ url: targetUrl, active: true });
                  } else {
                    window.webContents.executeJavaScript(
                      `(() => { 
                        const tabBar = document.getElementById('tabbar'); 
                        if (tabBar && tabBar.addTab) { 
                          tabBar.addTab(${JSON.stringify(targetUrl)}, 'New Tab'); 
                          return true; 
                        } 
                        return false; 
                      })()`,
                      true
                    ).catch(() => {});
                  }
                  try { popupWindow.close(); } catch (_) {}
                }
              });

              await popupWindow.loadURL(popupUrl);
              popupWindow.show();
              
              // Track this popup for auto-close on tab switch
              this.activePopups.add(popupWindow);
              
              // Remove from tracking when closed
              popupWindow.on('closed', () => {
                this.activePopups.delete(popupWindow);
              });
              
              // Auto-close popup when main window loses focus or after timeout
              setTimeout(() => {
                if (!popupWindow.isDestroyed()) {
                  popupWindow.close();
                }
              }, 30000); // 30 second timeout
              
              console.log(`ExtensionManager: Manual popup created for ${extension.displayName || extension.name}`);
              return { success: true };
              
            } catch (manualError) {
              console.error(`ExtensionManager: Manual popup creation failed for ${extension.displayName || extension.name}:`, manualError);
            }
          }
          
          return { success: true };
          
        } catch (error) {
          console.error(`ExtensionManager: Failed to open popup for ${extension.displayName || extension.name}:`, error);
          return { success: false, error: error.message };
        }
      }

      return { success: false, error: 'Extension system not available' };
      
    } catch (error) {
      console.error('ExtensionManager: Browser action popup failed:', error);
      return { success: false, error: error.message };
    }
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
    return withInstallLock(async () => {
      await this.initialize();
      
      try {
        console.log('ExtensionManager: Installing from Chrome Web Store:', urlOrId);

        // Parse URL or ID using consolidated validator
        const extensionId = this.manifestValidator.parseWebStoreUrl(urlOrId);
        if (!extensionId) {
          throw Object.assign(
            new Error('Invalid Chrome Web Store URL or extension ID format'),
            { code: ERR.E_INVALID_URL }
          );
        }

        // Check if already installed
        const existing = this.loadedExtensions.get(extensionId);
        if (existing) {
          throw Object.assign(
            new Error(`Extension ${extensionId} is already installed`),
            { code: ERR.E_ALREADY_EXISTS }
          );
        }

        // Check if Chrome Web Store is available
        if (!this.chromeWebStore) {
          throw Object.assign(
            new Error('Chrome Web Store support not available - check startup logs for initialization errors'),
            { code: ERR.E_NOT_AVAILABLE }
          );
        }

        // Install via Chrome Web Store
        const electronExtension = await this.chromeWebStore.installById(extensionId);
        
        // Resolve localized strings (displayName/description)
        let displayName = electronExtension.name;
        let displayDescription = electronExtension.manifest?.description || '';
        try {
          const resolved = await this._resolveManifestStrings(electronExtension.path, electronExtension.manifest || {});
          displayName = resolved.name || displayName;
          displayDescription = resolved.description || displayDescription;
        } catch (_) {}

        // Extract icon path from manifest (prefer larger sizes)
        let iconPath = null;
        const icons = electronExtension.manifest?.icons;
        if (icons) {
          // Try to get the best icon size (64, 48, 32, 16)
          const iconSizes = ['64', '48', '32', '16'];
          for (const size of iconSizes) {
            if (icons[size]) {
              // Use peersky protocol and append version for cache-busting
              iconPath = `peersky://extension-icon/${extensionId}/${size}?v=${encodeURIComponent(electronExtension.version)}`;
              break;
            }
          }
        }

        // Create extension metadata
        const extensionData = {
          id: extensionId,
          name: electronExtension.name,
          displayName,
          version: electronExtension.version,
          description: electronExtension.manifest?.description || '',
          displayDescription,
          enabled: true,
          installedPath: electronExtension.path,
          iconPath: iconPath,
          source: 'webstore',
          webStoreUrl: this.manifestValidator.buildWebStoreUrl(extensionId),
          electronId: electronExtension.id,
          permissions: electronExtension.manifest?.permissions || [],
          manifest: electronExtension.manifest,
          installDate: new Date().toISOString(),
          update: {
            lastChecked: Date.now(),
            lastResult: 'installed'
          }
        };

        // Add to loaded extensions and save registry
        this.loadedExtensions.set(extensionId, extensionData);
        await this._writeRegistry();

        console.log('ExtensionManager: Chrome Web Store installation successful:', extensionData.name);
        return { success: true, extension: extensionData };
        
      } catch (error) {
        console.error('ExtensionManager: Chrome Web Store installation failed:', error);
        throw error;
      }
    });
  }

  /**
   * Update all extensions to latest versions
   * 
   * @returns {Promise<Object>} Update results with counts and errors
   */
  async updateAllExtensions() {
    return withUpdateLock(async () => {
      await this.initialize();
      
      try {
        console.log('ExtensionManager: Checking for extension updates...');

        if (!this.chromeWebStore) {
          throw Object.assign(new Error('Chrome Web Store support not available'), { code: ERR.E_NOT_AVAILABLE });
        }

        // Consider only extensions installed from the Web Store
        const webStoreExtensions = Array.from(this.loadedExtensions.values()).filter(ext => ext.source === 'webstore');

        const updated = [];
        const skipped = [];
        const errors = [];

        // Snapshot current versions
        const beforeVersions = new Map();
        for (const ext of webStoreExtensions) {
          beforeVersions.set(ext.id, String(ext.version || ''));
        }

        // Trigger update across all webstore extensions
        await this.chromeWebStore.updateAll();

        const userDataDir = this.app.getPath('userData');

        // For each webstore extension, identify latest installed version and reload if required
        for (const ext of webStoreExtensions) {
          try {
            const extRoot = path.join(userDataDir, 'extensions', ext.id);
            const entries = await fs.readdir(extRoot).catch(() => []);
            if (!entries || entries.length === 0) {
              skipped.push({ id: ext.id, reason: 'no-installation-dir' });
              continue;
            }

            const chooseLatest = (dirs) => {
              const parseVer = (d) => {
                const base = String(d).split('_')[0];
                return base.split('.').map(n => parseInt(n, 10) || 0);
              };
              return dirs
                .filter(Boolean)
                .sort((a, b) => {
                  const va = parseVer(a);
                  const vb = parseVer(b);
                  const len = Math.max(va.length, vb.length);
                  for (let i = 0; i < len; i++) {
                    const ai = va[i] || 0; const bi = vb[i] || 0;
                    if (ai !== bi) return bi - ai;
                  }
                  return 0;
                })[0];
            };

            const latestDir = chooseLatest(entries);
            if (!latestDir) {
              skipped.push({ id: ext.id, reason: 'no-version-dir' });
              continue;
            }

            const latestPath = path.join(extRoot, latestDir);
            const manifestPath = path.join(latestPath, 'manifest.json');
            const manifestRaw = await fs.readFile(manifestPath, 'utf8');
            const manifest = JSON.parse(manifestRaw);
            const newVersion = String(manifest.version || '').trim();
            const oldVersion = beforeVersions.get(ext.id) || '';
            const versionChanged = newVersion && newVersion !== oldVersion;

            // Refresh icon path with version cache-busting
            let iconPath = ext.iconPath || null;
            const icons = manifest.icons || {};
            if (icons) {
              const sizes = ['64', '48', '32', '16'];
              for (const s of sizes) {
                if (icons[s]) {
                  iconPath = `peersky://extension-icon/${ext.id}/${s}?v=${encodeURIComponent(newVersion || oldVersion)}`;
                  break;
                }
              }
            }

            // Update registry metadata
            ext.installedPath = latestPath;
            ext.version = newVersion || ext.version;
            ext.manifest = manifest;
            if (iconPath) ext.iconPath = iconPath;

            // Clean reload when version changed and extension is enabled
            if (ext.enabled && versionChanged) {
              try {
                if (ext.electronId) {
                  await this.session.removeExtension(ext.electronId);
                } else if (this.session.getExtension && this.session.getExtension(ext.id)) {
                  await this.session.removeExtension(ext.id);
                }
              } catch (rmErr) {
                console.warn(`ExtensionManager: removeExtension failed for ${ext.name}:`, rmErr);
              }
              try {
                const electronExtension = await this.session.loadExtension(latestPath, { allowFileAccess: false });
                ext.electronId = electronExtension.id;
              } catch (ldErr) {
                throw Object.assign(new Error(`Reload failed for ${ext.name}`), { cause: ldErr, code: ERR.E_LOAD_FAILED });
              }
            }

            if (versionChanged) {
              updated.push({ id: ext.id, name: ext.name, from: oldVersion, to: newVersion });
            } else {
              skipped.push({ id: ext.id, reason: 'already-latest' });
            }
          } catch (e) {
            console.error('ExtensionManager: Update handling failed:', e);
            errors.push({ id: ext.id, message: e?.message || 'update failed' });
          }
        }

        // Mark non-webstore extensions as skipped (preinstalled/unpacked)
        for (const ext of this.loadedExtensions.values()) {
          if (ext.source !== 'webstore') {
            skipped.push({ id: ext.id, reason: 'skipped-preinstalled' });
          }
        }

        await this._writeRegistry();

        console.log('ExtensionManager: Extension update check completed');
        return { updated, skipped, errors };

      } catch (error) {
        console.error('ExtensionManager: Extension updates failed:', error);
        throw error;
      }
    });
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
    try {
      const registry = await readJsonSafe(this.extensionsRegistryFile, { extensions: [] });
      this.loadedExtensions.clear();
      const validExtensions = [];
      
      for (const extensionData of registry.extensions || []) {
        // Validate that extension directory exists
        try {
          if (extensionData.installedPath) {
            const fs = await import('fs/promises');
            await fs.access(extensionData.installedPath);
          }
          
          // If display strings are missing, resolve from _locales
          if ((!extensionData.displayName || !extensionData.displayDescription) && extensionData.installedPath && extensionData.manifest) {
            try {
              const resolved = await this._resolveManifestStrings(extensionData.installedPath, extensionData.manifest);
              extensionData.displayName = extensionData.displayName || resolved.name;
              extensionData.displayDescription = extensionData.displayDescription || resolved.description;
            } catch (_) {}
          }

          // Fix legacy icon paths to use peersky:// protocol with cache-busting by version
          if (extensionData.iconPath && (extensionData.iconPath.startsWith('file://') || extensionData.iconPath.startsWith('chrome-extension://'))) {
            const icons = extensionData.manifest?.icons;
            if (icons) {
              const iconSizes = ['64', '48', '32', '16'];
              for (const size of iconSizes) {
                if (icons[size]) {
                  const v = extensionData.version ? `?v=${encodeURIComponent(String(extensionData.version))}` : '';
                  extensionData.iconPath = `peersky://extension-icon/${extensionData.id}/${size}${v}`;
                  break;
                }
              }
            }
          }
          
          this.loadedExtensions.set(extensionData.id, extensionData);
          validExtensions.push(extensionData);
        } catch (accessError) {
          console.log(`ExtensionManager: Removing stale registry entry for ${extensionData.name} (${extensionData.id}) - directory not found`);
        }
      }
      
      console.log(`ExtensionManager: Loaded ${this.loadedExtensions.size} extensions from registry`);
      
      // If we removed any stale entries, save the cleaned registry
      const originalCount = (registry.extensions || []).length;
      if (validExtensions.length !== originalCount) {
        console.log(`ExtensionManager: Cleaned ${originalCount - validExtensions.length} stale entries from registry`);
        await this._writeRegistry();
      }
    } catch (error) {
      console.error('ExtensionManager: Failed to read registry:', error);
    }
  }

  /**
   * Write registry to file
   */
  async _writeRegistry() {
    const registry = {
      extensions: Array.from(this.loadedExtensions.values())
    };
    await writeJsonAtomic(this.extensionsRegistryFile, registry);
  }

  /**
   * Validate and clean registry by removing entries with missing directories
   * @returns {Object} Cleanup results
   */
  async validateAndCleanRegistry() {
    try {
      const fs = await import('fs/promises');
      const initialCount = this.loadedExtensions.size;
      const removedExtensions = [];
      
      for (const [extensionId, extensionData] of this.loadedExtensions.entries()) {
        try {
          if (extensionData.installedPath) {
            await fs.access(extensionData.installedPath);
          }
        } catch (accessError) {
          console.log(`ExtensionManager: Removing stale entry: ${extensionData.name} (${extensionId})`);
          removedExtensions.push({
            id: extensionId,
            name: extensionData.name,
            reason: 'Directory not found'
          });
          this.loadedExtensions.delete(extensionId);
        }
      }
      
      // Save cleaned registry if changes were made
      if (removedExtensions.length > 0) {
        await this._writeRegistry();
      }
      
      return {
        initialCount,
        finalCount: this.loadedExtensions.size,
        removedCount: removedExtensions.length,
        removedExtensions
      };
    } catch (error) {
      console.error('ExtensionManager: Failed to validate registry:', error);
      throw error;
    }
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
    try {
      // Create deterministic hash based on extension metadata
      const hashContent = JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        description: manifest.description || '',
        author: manifest.author || '',
        homepage_url: manifest.homepage_url || ''
      });
      
      // Generate SHA-256 hash and use first 32 characters for compatibility
      const hash = createHash('sha256').update(hashContent).digest('hex');
      const extensionId = hash.substring(0, 32);
      
      console.log(`ExtensionManager: Generated secure ID for "${manifest.name}": ${extensionId}`);
      return extensionId;
      
    } catch (error) {
      console.error('ExtensionManager: Failed to generate secure extension ID:', error);
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
    if (!this.session) {
      console.warn('ExtensionManager: No session available for extension loading');
      return;
    }

    try {
      // Load all enabled extensions into Electron's session
      for (const extension of this.loadedExtensions.values()) {
        if (extension.enabled && extension.installedPath) {
          try {
            console.log(`ExtensionManager: Loading extension into Electron: ${extension.displayName || extension.name}`);
            const electronExtension = await this.session.loadExtension(extension.installedPath, {
              allowFileAccess: false  // Restrict file system access for security
            });
            extension.electronId = electronExtension.id;
            console.log(`ExtensionManager: Extension loaded successfully: ${extension.displayName || extension.name} (${electronExtension.id})`);
          } catch (error) {
            console.error(`ExtensionManager: Failed to load extension ${extension.displayName || extension.name}:`, error);
          }
        }
      }
      // Save updated registry with electronIds
      await this._writeRegistry();
    } catch (error) {
      console.error('ExtensionManager: Error loading extensions into Electron:', error);
    }
  }

  /**
   * Prepare extension from source path (directory or ZIP/CRX file)
   */
  async _prepareExtension(sourcePath) {
    const stats = await fs.stat(sourcePath);
    
    if (stats.isDirectory()) {
      return this._prepareFromDirectory(sourcePath);
    } else {
      return this._prepareFromArchive(sourcePath);
    }
  }

  /**
   * Prepare extension from directory (secured)
   */
  async _prepareFromDirectory(dirPath) {
    let manifestPath = path.join(dirPath, 'manifest.json');
    let stats = await fs.stat(manifestPath).catch(() => null);
    let manifestContent;
    let altManifestContent = null;
    if (!stats) {
      let foundAlt = null;
      for (const name of PREFERRED_MANIFEST_ALTS) {
        const p = path.join(dirPath, name);
        const st = await fs.stat(p).catch(() => null);
        if (st) { foundAlt = p; break; }
      }
      if (foundAlt) {
        if (foundAlt.endsWith('manifest.firefox.json')) {
          console.warn('[ExtensionManager] Falling back to manifest.firefox.json. Extension may be incompatible with Chromium/Electron.');
        }
        altManifestContent = await fs.readFile(foundAlt, 'utf8');
        manifestContent = altManifestContent;
      } else {
        throw new Error('No manifest.json found in extension directory');
      }
    } else {
      manifestContent = await fs.readFile(manifestPath, 'utf8');
    }
    const manifest = JSON.parse(manifestContent);
    
    // Normalize version if invalid (some prebuilt zips use placeholders)
    const semverLike = (v) => typeof v === 'string' && /^\d+(\.\d+)*$/.test(v);
    if (!semverLike(manifest.version)) {
      manifest.version = '1.0.0';
    }

    // Generate secure extension ID using cryptographic hashing
    const extensionId = this._generateSecureExtensionId(manifest);
    const version = String(manifest.version || '').trim() || '0.0.0';
    const versionDirName = `${version}_0`;
    
    // Copy to versioned directory for consistency with webstore installs
    const targetPath = path.join(this.extensionsBaseDir, extensionId, versionDirName);
    await ensureDir(path.dirname(targetPath));
    // Copy directory contents to a temp dir then atomically move into place
    const tempDir = path.join(this.extensionsBaseDir, '_staging', `dir-${Date.now()}-${randomBytes(4).toString('hex')}`);
    await ensureDir(tempDir);
    await fs.cp(dirPath, tempDir, { recursive: true });
    // Ensure normalized manifest is written into installed copy
    try {
      await fs.writeFile(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    } catch (_) {}
    // Ensure manifest.json exists in the installed copy even if an alternate was used
    if (altManifestContent) {
      const destManifestPath = path.join(tempDir, 'manifest.json');
      try { await fs.access(destManifestPath); } catch (_) {
        await fs.writeFile(destManifestPath, altManifestContent, 'utf8');
      }
    }
    await ensureDir(path.dirname(targetPath));
    await atomicReplaceDir(tempDir, targetPath);

    const { name: displayName, description: displayDescription } = await this._resolveManifestStrings(targetPath, manifest);

    // Verify referenced files exist; record warnings if missing
    const missing = [];
    const checkFile = async (rel) => {
      if (!rel) return;
      try { await fs.stat(path.join(targetPath, rel)); } catch (_) { missing.push(rel); }
    };
    try {
      const icons = manifest.icons || {};
      for (const rel of Object.values(icons)) await checkFile(rel);
      const bg = manifest.background && manifest.background.service_worker;
      await checkFile(bg);
      const cs = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
      for (const c of cs) {
        for (const rel of (c.js || [])) await checkFile(rel);
        for (const rel of (c.css || [])) await checkFile(rel);
      }
      const popup = manifest.action && manifest.action.default_popup;
      await checkFile(popup);
    } catch (_) {}

    const ext = {
      id: extensionId,
      name: manifest.name,
      displayName,
      version,
      description: manifest.description,
      displayDescription,
      manifest,
      installedPath: targetPath,
      enabled: true,
      source: 'unpacked',
      installDate: new Date().toISOString()
    };

    if (missing.length) {
      ext.warnings = (ext.warnings || []).concat(missing.slice(0, 20).map(m => `Missing file: ${m}`));
    }

    // Compute iconPath if icons exist in manifest
    try {
      const icons = manifest.icons || {};
      const sizes = ['128', '64', '48', '32', '16'];
      for (const s of sizes) {
        if (icons[s]) {
          const v = ext.version ? `?v=${encodeURIComponent(String(ext.version))}` : '';
          ext.iconPath = `peersky://extension-icon/${ext.id}/${s}${v}`;
          break;
        }
      }
    } catch (_) {}

    return ext;
  }

  /**
   * Prepare extension from ZIP/CRX archive
   */
  async _prepareFromArchive(archivePath) {
    const lower = archivePath.toLowerCase();
    const isZip = lower.endsWith('.zip');
    const isCrxFile = lower.endsWith('.crx') || lower.endsWith('.crx3') || await isCrx(archivePath).catch(() => false);

    if (!isZip && !isCrxFile) {
      throw new Error('Unsupported archive type; expected .zip or .crx');
    }

    // Staging directory
    const stagingRoot = path.join(this.extensionsBaseDir, '_staging');
    await ensureDir(stagingRoot);
    const stagingDir = path.join(stagingRoot, `arc-${Date.now()}-${randomBytes(4).toString('hex')}`);
    await ensureDir(stagingDir);

    let sourceType = 'file-zip';
    let publicKeyDer = null;

    if (isZip) {
      await extractZipFile(archivePath, stagingDir);
    } else {
      const meta = await extractCrx(archivePath, stagingDir, extractZipBuffer);
      publicKeyDer = meta.publicKeyDer || null;
      sourceType = 'file-crx';
    }

    // Validate manifest exists (support archives that contain a single top-level folder)
    let manifestBaseDir = stagingDir;
    let manifestPath = path.join(manifestBaseDir, 'manifest.json');
    let manifestStat = await fs.stat(manifestPath).catch(() => null);

    async function tryResolveAlternateManifest(baseDir) {
      for (const name of PREFERRED_MANIFEST_ALTS) {
        const p = path.join(baseDir, name);
        const st = await fs.stat(p).catch(() => null);
        if (st) {
          if (name === 'manifest.firefox.json') {
            console.warn('[ExtensionManager] Falling back to manifest.firefox.json. Extension may be incompatible with Chromium/Electron.');
          }
          const content = await fs.readFile(p, 'utf8');
          await fs.writeFile(path.join(baseDir, 'manifest.json'), content, 'utf8');
          return await fs.stat(path.join(baseDir, 'manifest.json')).catch(() => null);
        }
      }
      return null;
    }

    if (!manifestStat) {
      const entries = await fs.readdir(stagingDir).catch(() => []);
      if (entries.length === 1) {
        const only = entries[0];
        const candidate = path.join(stagingDir, only);
        const st = await fs.stat(candidate).catch(() => null);
        if (st && st.isDirectory()) {
          const altManifest = path.join(candidate, 'manifest.json');
          const altStat = await fs.stat(altManifest).catch(() => null);
          if (altStat) {
            manifestBaseDir = candidate;
            manifestPath = altManifest;
            manifestStat = altStat;
          } else {
            const resolved = await tryResolveAlternateManifest(candidate);
            if (resolved) {
              manifestBaseDir = candidate;
              manifestPath = path.join(candidate, 'manifest.json');
              manifestStat = resolved;
            }
          }
        }
      }
      if (!manifestStat) {
        // Try alternate manifests at the root as well
        const resolved = await tryResolveAlternateManifest(stagingDir);
        if (resolved) {
          manifestBaseDir = stagingDir;
          manifestPath = path.join(stagingDir, 'manifest.json');
          manifestStat = resolved;
        }
      }
    }
    if (!manifestStat) {
      throw new Error('No manifest.json found in archive');
    }

    // Load and update manifest (inject key if available to preserve ID)
    const manifestRaw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw);
    // Normalize version if invalid
    const semverLike = (v) => typeof v === 'string' && /^\d+(\.\d+)*$/.test(v);
    if (!semverLike(manifest.version)) {
      manifest.version = '1.0.0';
      try { await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8'); } catch (_) {}
    }
    if (publicKeyDer && !manifest.key) {
      manifest.key = derToBase64(publicKeyDer);
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    }

    // Provisional ID; may be updated after load if Electron computes different ID
    const provisionalId = this._generateSecureExtensionId(manifest);
    const version = String(manifest.version || '').trim() || '0.0.0';
    const versionDirName = `${version}_0`;
    const finalDir = path.join(this.extensionsBaseDir, provisionalId, versionDirName);
    await ensureDir(path.dirname(finalDir));
    await atomicReplaceDir(manifestBaseDir, finalDir);

    // Resolve localized display strings
    const { name: displayName, description: displayDescription } = await this._resolveManifestStrings(finalDir, manifest);

    // Verify referenced files exist; record warnings if missing
    const missing = [];
    const checkFile = async (rel) => {
      if (!rel) return;
      try { await fs.stat(path.join(finalDir, rel)); } catch (_) { missing.push(rel); }
    };
    try {
      const icons = manifest.icons || {};
      for (const rel of Object.values(icons)) await checkFile(rel);
      const bg = manifest.background && manifest.background.service_worker;
      await checkFile(bg);
      const cs = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
      for (const c of cs) {
        for (const rel of (c.js || [])) await checkFile(rel);
        for (const rel of (c.css || [])) await checkFile(rel);
      }
      const popup = manifest.action && manifest.action.default_popup;
      await checkFile(popup);
    } catch (_) {}

    // Build initial extension metadata
    const ext = {
      id: provisionalId,
      name: manifest.name,
      displayName,
      version,
      description: manifest.description || '',
      displayDescription,
      manifest,
      installedPath: finalDir,
      enabled: true,
      source: sourceType,
      installDate: new Date().toISOString()
    };

    if (missing.length) {
      ext.warnings = (ext.warnings || []).concat(missing.slice(0, 20).map(m => `Missing file: ${m}`));
    }

    // Compute iconPath if icons exist in manifest
    try {
      const icons = manifest.icons || {};
      const sizes = ['128', '64', '48', '32', '16'];
      for (const s of sizes) {
        if (icons[s]) {
          const v = ext.version ? `?v=${encodeURIComponent(String(ext.version))}` : '';
          ext.iconPath = `peersky://extension-icon/${ext.id}/${s}${v}`;
          break;
        }
      }
    } catch (_) {}

    return ext;
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
    try {
      const defaultLocale = String(manifest.default_locale || '').trim() || 'en';
      const appLocale = (this.app && typeof this.app.getLocale === 'function') ? this.app.getLocale() : 'en';
      const candidates = this._buildLocaleCandidates(appLocale, defaultLocale);
      const pathMod = await import('path');
      const fs = await import('fs/promises');

      let messages = null;
      for (const loc of candidates) {
        try {
          const p = pathMod.join(installedPath, '_locales', loc, 'messages.json');
          const raw = await fs.readFile(p, 'utf8');
          messages = JSON.parse(raw);
          break;
        } catch (_) {}
      }

      const resolveMsg = (val) => {
        if (!val || typeof val !== 'string') return val || '';
        const m = /^__MSG_([A-Za-z0-9_]+)__$/i.exec(val);
        if (!m || !messages) return val;
        const key = m[1];
        const entry = messages[key];
        const text = entry && (entry.message || entry.value);
        return typeof text === 'string' && text.length ? text : val;
      };

      return {
        name: resolveMsg(manifest.name),
        description: resolveMsg(manifest.description)
      };
    } catch (_) {
      return { name: manifest.name, description: manifest.description || '' };
    }
  }

  _buildLocaleCandidates(appLocale, defaultLocale) {
    const norm = (s) => String(s || '').replace('-', '_');
    const lc = norm(appLocale);
    const base = lc.split(/[-_]/)[0];
    const def = norm(defaultLocale);
    const out = [];
    const push = (x) => { if (x && !out.includes(x)) out.push(x); };
    push(lc);
    push(base);
    push(def);
    push('en');
    return out;
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
  async _getAndRegisterActiveWebview(window) {
    try {
      // Use the same approach that bookmarks use - simple and reliable
      const activeTabData = await window.webContents.executeJavaScript(`
        (function() {
          try {
            const tabBar = document.querySelector('#tabbar');
            if (!tabBar || !tabBar.getActiveTab) return null;
            
            // Use the same method bookmarks use
            const activeTab = tabBar.getActiveTab();
            if (!activeTab) return null;
            
            // Also get the webview for this tab
            const activeWebview = tabBar.getActiveWebview();
            if (!activeWebview) return null;
            
            return {
              tabId: activeTab.id,
              url: activeTab.url,
              title: activeTab.title,
              webContentsId: activeWebview.getWebContentsId()
            };
          } catch (error) {
            console.error('[ExtensionManager] Error getting active tab:', error);
            return null;
          }
        })();
      `);

      if (!activeTabData || !activeTabData.webContentsId) {
        return null;
      }

      // Get the actual WebContents object
      const { webContents } = await import('electron');
      const activeWebviewContents = webContents.fromId(activeTabData.webContentsId);
      
      if (!activeWebviewContents) {
        console.warn(`[ExtensionManager] WebContents ${activeTabData.webContentsId} not found`);
        return null;
      }

      // Register this webview with the extension system
      this.addWindow(window, activeWebviewContents);
      return activeWebviewContents;
    } catch (error) {
      console.error('[ExtensionManager] Failed to get and register active webview:', error);
      return null;
    }
  }

  async _doesExtensionFileExist(root, rel) {
    try {
      const fs = await import('fs/promises');
      const pathMod = await import('path');
      const p = pathMod.join(root, rel);
      await fs.access(p);
      return true;
    } catch (_) { return false; }
  }

  async _resolvePopupRelativePath(root, desiredRel) {
    const fs = await import('fs/promises');
    const pathMod = await import('path');
    const desiredBase = desiredRel ? pathMod.basename(desiredRel) : 'popup.html';
    const candidates = [desiredRel, 'popup.html', 'popup/index.html', 'ui/popup.html', 'dist/popup.html', 'build/popup.html'];
    for (const rel of candidates) {
      if (!rel) continue;
      try { await fs.access(pathMod.join(root, rel)); return rel; } catch (_) {}
    }
    // Shallow search for basename within two levels
    try {
      const found = await this._findFileByName(root, desiredBase, 2);
      if (found) return pathMod.relative(root, found);
    } catch (_) {}
    return null;
  }

  async _findFileByName(dir, name, depth) {
    const fs = await import('fs/promises');
    const pathMod = await import('path');
    if (depth < 0) return null;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = pathMod.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name.startsWith('.')) continue;
          const r = await this._findFileByName(full, name, depth - 1);
          if (r) return r;
        } else if (e.name === name) {
          return full;
        }
      }
    } catch (_) {}
    return null;
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
      // Read pinned extensions from registry or separate file
      const pinnedData = await readJsonSafe(path.join(this.extensionsBaseDir, 'pinned.json'));
      return pinnedData?.pinnedExtensions || [];
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

      // Get current pinned extensions
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
      const pinnedFilePath = path.join(this.extensionsBaseDir, 'pinned.json');
      await writeJsonAtomic(pinnedFilePath, { pinnedExtensions });
      
      console.log(`[ExtensionManager] Extension ${extensionId} pinned successfully`);
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
      // Get current pinned extensions
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
      const pinnedFilePath = path.join(this.extensionsBaseDir, 'pinned.json');
      await writeJsonAtomic(pinnedFilePath, { pinnedExtensions });
      
      console.log(`[ExtensionManager] Extension ${extensionId} unpinned successfully`);
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
