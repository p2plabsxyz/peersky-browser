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
import { createHash } from 'crypto';
import { Menu } from "electron"; // for context menu
import { installChromeWebStore } from 'electron-chrome-web-store';
import { ElectronChromeExtensions } from 'electron-chrome-extensions';
import ManifestValidator from './manifest-validator.js';
import { ensureDir, readJsonSafe, writeJsonAtomic, KeyedMutex, ERR } from './util.js';
import ChromeWebStoreManager from './chrome-web-store.js';
// URL parsing now handled by ManifestValidator
import { withExtensionLock, withInstallLock, withUpdateLock } from './mutex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

      // Initialize validator
      this.manifestValidator = new ManifestValidator();

      // Load registry
      await this._readRegistry();

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
        if (!validationResult.isValid) {
          throw new Error(`Extension validation failed: ${validationResult.errors.join(', ')}`);
        }

        // Save extension metadata
        await this._saveExtensionMetadata(extensionData);

        // Load extension into Electron's extension system with security restrictions
        if (this.session && extensionData.enabled) {
          try {
            console.log(`ExtensionManager: Loading installed extension into Electron: ${extensionData.name}`);
            const electronExtension = await this.session.loadExtension(extensionData.installedPath, {
              allowFileAccess: false  // Restrict file system access for security
            });
            extensionData.electronId = electronExtension.id;
            console.log(`ExtensionManager: Extension loaded in Electron: ${extensionData.name} (${electronExtension.id})`);
          } catch (error) {
            console.error(`ExtensionManager: Failed to load extension into Electron:`, error);
          }
        }

        this.loadedExtensions.set(extensionData.id, extensionData);
        
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
      
      // Get all enabled extensions with browser actions
      for (const extension of this.loadedExtensions.values()) {
        if (extension.enabled && extension.manifest) {
          // Check for action (MV3) or browser_action (MV2)
          const action = extension.manifest.action || extension.manifest.browser_action;
          if (action) {
            actions.push({
              id: extension.id,
              extensionId: extension.electronId,
              name: extension.name,
              title: action.default_title || extension.name,
              icon: extension.iconPath,
              popup: action.default_popup,
              badgeText: '', // TODO: Get actual badge text from extension
              badgeBackgroundColor: '#666', // Default badge color
              enabled: true
            });
          }
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
          console.log(`ExtensionManager: Triggering browser action click for ${extension.name}`);
          
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
                console.log(`ExtensionManager: Browser action API triggered for ${extension.name}`);
                return;
              }
              
              // Alternative: Try to simulate a click event
              if (browserActionAPI.click) {
                await browserActionAPI.click(extension.electronId, tabInfo);
                console.log(`ExtensionManager: Browser action click API called for ${extension.name}`);
                return;
              }
            } catch (apiError) {
              console.warn(`ExtensionManager: Browser action API failed for ${extension.name}:`, apiError);
            }
          }
          
          // Try to get and trigger the browser action
          if (this.electronChromeExtensions.getBrowserAction) {
            const browserAction = this.electronChromeExtensions.getBrowserAction(extension.electronId);
            if (browserAction && browserAction.onClicked) {
              const tabInfo = { id: activeTab.id, windowId: window.id, url: activeTab.getURL() };
              browserAction.onClicked.trigger(tabInfo);
              console.log(`ExtensionManager: Browser action onClicked triggered for ${extension.name}`);
              return;
            }
          }
          
          console.warn(`ExtensionManager: No suitable browser action trigger found for ${extension.name}`);
          
        } catch (error) {
          console.error(`ExtensionManager: Failed to trigger browser action for ${extension.name}:`, error);
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
        console.log(`ExtensionManager: Extension ${extension.name} has no popup, triggering click instead`);
        await this.clickBrowserAction(actionId, window);
        return { success: true };
      }

      // Open popup via ElectronChromeExtensions
      if (this.electronChromeExtensions && extension.electronId) {
        try {
          console.log(`ExtensionManager: Opening popup for ${extension.name} at`, anchorRect);
          
          // Find and register the active webview with the extension system
          const activeWebview = await this._getAndRegisterActiveWebview(window);
          const activeTab = activeWebview || window.webContents; // Use webview if available, fallback to main window
          
          if (!activeWebview) {
            console.warn(`[ExtensionManager] No active webview found for ${extension.name} popup, using main window fallback`);
          } else {
            console.log(`[ExtensionManager] Using active webview for ${extension.name} popup: ${activeTab.getURL()}`);
            
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
          if (this.electronChromeExtensions.getBrowserAction) {
            const browserAction = this.electronChromeExtensions.getBrowserAction(extension.electronId);
            if (browserAction && browserAction.onClicked) {
              // Trigger the browser action click which should open popup using the active webview
              browserAction.onClicked.trigger(activeTab);
              console.log(`ExtensionManager: Browser action triggered for ${extension.name}`);
              return { success: true };
            }
          }
          
          // Fallback: Try direct ElectronChromeExtensions API
          if (this.electronChromeExtensions.api) {
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
                      newWindow.setOpacity(0);
                      newWindow.once("show", () => {
                        const setPositionSafely = (attempt = 1) => {
                          if (newWindow.isDestroyed()) return;

                          const mainBounds = window.getBounds();
                          const popupBounds = newWindow.getBounds();

                          const targetX =
                            mainBounds.x +
                            anchorRect.x -
                            popupBounds.width +
                            anchorRect.width;
                          const targetY = mainBounds.y + anchorRect.y + 35;

                          newWindow.setBounds({
                            x: targetX,
                            y: targetY,
                          });

                          const actualBounds = newWindow.getBounds();
                          const positionCorrect =
                            Math.abs(actualBounds.x - targetX) < 2 &&
                            Math.abs(actualBounds.y - targetY) < 2;

                          if (!positionCorrect && attempt < 5) {
                            setTimeout(
                              () => setPositionSafely(attempt + 1),
                              50
                            );
                          } else {
                            newWindow.setOpacity(1);
                          }
                        };
                        setTimeout(() => setPositionSafely(), 50);
                      });

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
                console.log(`ExtensionManager: Popup opened directly for ${extension.name}`);
                return { success: true };
              }
            } catch (directError) {
              console.warn(`ExtensionManager: Direct popup API failed for ${extension.name}:`, directError);
            }
          }
          
          // Final fallback: trigger a regular click which should open popup
          console.log(`ExtensionManager: Falling back to regular click for ${extension.name}`);
          await this.clickBrowserAction(actionId, window);
          
          // Ultimate fallback: Try to open popup by simulating Chrome extension behavior
          if (action.default_popup) {
            console.log(`ExtensionManager: Attempting manual popup creation for ${extension.name}`);
            try {
              // Create a popup window manually if all else fails
              const popupUrl = `chrome-extension://${extension.electronId}/${action.default_popup}`;
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
              
              console.log(`ExtensionManager: Manual popup created for ${extension.name}`);
              return { success: true };
              
            } catch (manualError) {
              console.error(`ExtensionManager: Manual popup creation failed for ${extension.name}:`, manualError);
            }
          }
          
          return { success: true };
          
        } catch (error) {
          console.error(`ExtensionManager: Failed to open popup for ${extension.name}:`, error);
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

        // Unload extension from Electron's system
        if (this.session && extension.electronId) {
          try {
            console.log(`ExtensionManager: Unloading extension from Electron: ${extension.name}`);
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
            console.error(`ExtensionManager: Chrome Web Store uninstall failed for ${extension.name}:`, error);
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
          version: electronExtension.version,
          description: electronExtension.manifest?.description || '',
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
            const extRoot = path.join(userDataDir, 'Extensions', ext.id);
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
                  console.log(`ExtensionManager: Extension unloaded: ${extension.name}`);
                } catch (error) {
                  console.error(`ExtensionManager: Failed to unload extension ${extension.name}:`, error);
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
            console.log(`ExtensionManager: Loading extension into Electron: ${extension.name}`);
            const electronExtension = await this.session.loadExtension(extension.installedPath, {
              allowFileAccess: false  // Restrict file system access for security
            });
            extension.electronId = electronExtension.id;
            console.log(`ExtensionManager: Extension loaded successfully: ${extension.name} (${electronExtension.id})`);
          } catch (error) {
            console.error(`ExtensionManager: Failed to load extension ${extension.name}:`, error);
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
    const manifestPath = path.join(dirPath, 'manifest.json');
    const stats = await fs.stat(manifestPath).catch(() => null);
    if (!stats) {
      throw new Error('No manifest.json found in extension directory');
    }

    const manifestContent = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestContent);
    
    // Generate secure extension ID using cryptographic hashing
    const extensionId = this._generateSecureExtensionId(manifest);
    
    // Copy extension to extensions directory (validation happens in installExtension)
    const targetPath = path.join(this.extensionsBaseDir, extensionId);
    await this._secureFileCopy(dirPath, targetPath, manifest);

    return {
      id: extensionId,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      manifest,
      installedPath: targetPath,
      enabled: true,
      source: 'unpacked',
      installDate: new Date().toISOString()
    };
  }

  /**
   * Prepare extension from ZIP/CRX archive
   */
  async _prepareFromArchive(_archivePath) {
    // TODO: Implement ZIP/CRX extraction
    // For now, throw error indicating this needs implementation
    throw new Error('ZIP/CRX installation not yet implemented - use directory installation');
  }

  /**
   * Save extension metadata (deprecated - use _writeRegistry)
   */
  async _saveExtensionMetadata(extensionData) {
    this.loadedExtensions.set(extensionData.id, extensionData);
    await this._writeRegistry();
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
