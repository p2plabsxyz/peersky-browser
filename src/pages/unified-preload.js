/**
 * Unified Preload Script - Context-Aware API Exposure with Enhanced Security
 * 
 * Detects page context and exposes appropriate APIs based on security levels:
 * - Settings pages: Full electronAPI access (getAll, set, reset, clearBrowserCache, resetP2PData, uploadWallpaper)
 * - Home pages: Limited access (showClock, wallpaper only)
 * - Internal pages: Minimal access (theme only)  
 * - External pages: No settings access
 * 
 * Security Model: Principle of least privilege with granular access control.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Context detection using window.location for immediate synchronous access
const url = window.location.href;
const isSettings = url.startsWith('peersky://settings');
const isExtensions = url.startsWith('peersky://extensions');
const isHome = url.startsWith('peersky://home');
const isBookmarks = url.includes('peersky://bookmarks');
const isTabsPage = url.includes('peersky://tabs');
const isInternal = url.startsWith('peersky://') || url.startsWith('file://') || url.includes('agregore.mauve.moe');
const isExternal = !isInternal;

console.log('Unified-preload: URL detection', { url, isInternal, isExternal });

const isP2P =
  url.startsWith('hyper://') ||
  url.startsWith('ipfs://')  ||
  url.startsWith('ipns://');

const isBitTorrent =
  url.startsWith('bt://') ||
  url.startsWith('bittorrent://') ||
  url.startsWith('magnet:');

// Expose minimal API for BitTorrent pages to open files in new tabs
// Note: window.open() doesn't work for file:// URLs from custom protocols due to Electron security
if (isBitTorrent) {
  contextBridge.exposeInMainWorld('peersky', {
    openInTab: (fileUrl) => ipcRenderer.send('open-url-in-tab', fileUrl)
  });
}

// Expose LLM API for internal pages and Agregore examples
if (isInternal || isP2P || url.includes('agregore.mauve.moe')) {
  console.log('Unified-preload: Exposing LLM API for page:', url);
  // Iterator management for streaming
  const iteratorMaps = new Map();
  let iteratorId = 1;
  
  async function chatStream(args) {
    const { id } = await ipcRenderer.invoke('llm-chat-stream', args);
    const localId = iteratorId++;
    iteratorMaps.set(localId, id);
    return localId;
  }
  
  async function completeStream(prompt, args = {}) {
    const { id } = await ipcRenderer.invoke('llm-complete-stream', { prompt, ...args });
    const localId = iteratorId++;
    iteratorMaps.set(localId, id);
    return localId;
  }
  
  async function iteratorNext(localId) {
    const id = iteratorMaps.get(localId);
    if (!id) throw new Error('Unknown iterator ID');
    return ipcRenderer.invoke('llm-iterate-next', { id });
  }
  
  async function iteratorReturn(localId) {
    const id = iteratorMaps.get(localId);
    if (!id) throw new Error('Unknown iterator ID');
    iteratorMaps.delete(localId);
    return ipcRenderer.invoke('llm-iterate-return', { id });
  }
  
  // Expose LLM API using contextBridge with simpler structure
  // We need to inject a script to create the complex object structure
  contextBridge.exposeInMainWorld('_llmBridge', {
    isSupported: () => ipcRenderer.invoke('llm-supported'),
    chat: (args) => ipcRenderer.invoke('llm-chat', args),
    complete: (args) => ipcRenderer.invoke('llm-complete', args),
    chatStream: chatStream,
    completeStream: completeStream,
    iteratorNext: iteratorNext,
    iteratorReturn: iteratorReturn
  });
  
  const script = document.createElement('script');
  script.textContent = `
    (function() {
      window.llm = {
        isSupported: () => window._llmBridge.isSupported(),
        
        chat: function(args) {
          // Return an object that acts as both a Promise and an async iterator
          const obj = {
            then(onResolve, onReject) {
              window._llmBridge.chat(args).then(onResolve, onReject);
            },
            async *[Symbol.asyncIterator]() {
              const id = await window._llmBridge.chatStream(args);
              try {
                while (true) {
                  const { done, value } = await window._llmBridge.iteratorNext(id);
                  if (done) break;
                  yield value;
                }
              } finally {
                await window._llmBridge.iteratorReturn(id);
              }
            }
          };
          return obj;
        },
        
        complete: function(prompt, args = {}) {
          const obj = {
            then(onResolve, onReject) {
              window._llmBridge.complete({ prompt, ...args }).then(onResolve, onReject);
            },
            async *[Symbol.asyncIterator]() {
              const id = await window._llmBridge.completeStream(prompt, args);
              try {
                while (true) {
                  const { done, value } = await window._llmBridge.iteratorNext(id);
                  if (done) break;
                  yield value;
                }
              } finally {
                await window._llmBridge.iteratorReturn(id);
              }
            }
          };
          return obj;
        }
      };
      console.log('LLM API created via script injection');
    })();
  `;
  
  // Wait for DOM to be ready before injecting script
  const attachScript = () => {
    if (document.head) {
      document.head.appendChild(script);
    } else {
      console.warn('Unified-preload: cannot inject LLM script, document.head not available');
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachScript);
  } else {
    attachScript();
  }
  
  console.log('Unified-preload: LLM API exposed via contextBridge for P2P apps');
} else {
  // Even for external pages, check if they might need LLM API (for testing)
  console.log('Unified-preload: External page, checking if LLM should be exposed:', url);
  
  // We can add more trusted domains here if needed
  const trustedDomains = ['agregore.mauve.moe', 'localhost'];

  let shouldExposeLLM = false;
  try {
    const parsed = new URL(url);
    shouldExposeLLM = trustedDomains.includes(parsed.hostname);
  } catch (e) {
    console.warn('Unified-preload: failed to parse URL for trusted LLM exposure check:', e);
    shouldExposeLLM = false;
  }
  
  if (shouldExposeLLM) {
    console.log('Unified-preload: Exposing LLM API for trusted external page:', url);
    
    // Iterator management for streaming
    const iteratorMaps = new Map();
    let iteratorId = 1;
    
    async function chatStream(args) {
      const { id } = await ipcRenderer.invoke('llm-chat-stream', args);
      const localId = iteratorId++;
      iteratorMaps.set(localId, id);
      return localId;
    }
    
    async function completeStream(prompt, args = {}) {
      const { id } = await ipcRenderer.invoke('llm-complete-stream', { prompt, ...args });
      const localId = iteratorId++;
      iteratorMaps.set(localId, id);
      return localId;
    }
    
    async function iteratorNext(localId) {
      const id = iteratorMaps.get(localId);
      if (!id) throw new Error('Unknown iterator ID');
      return ipcRenderer.invoke('llm-iterate-next', { id });
    }
    
    async function iteratorReturn(localId) {
      const id = iteratorMaps.get(localId);
      if (!id) throw new Error('Unknown iterator ID');
      iteratorMaps.delete(localId);
      return ipcRenderer.invoke('llm-iterate-return', { id });
    }
    
    // Expose LLM API using contextBridge with simpler structure
    contextBridge.exposeInMainWorld('_llmBridge', {
      isSupported: () => ipcRenderer.invoke('llm-supported'),
      chat: (args) => ipcRenderer.invoke('llm-chat', args),
      complete: (args) => ipcRenderer.invoke('llm-complete', args),
      chatStream: chatStream,
      completeStream: completeStream,
      iteratorNext: iteratorNext,
      iteratorReturn: iteratorReturn
    });
    
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        window.llm = {
          isSupported: () => window._llmBridge.isSupported(),
          
          chat: function(args) {
            // Return an object that acts as both a Promise and an async iterator
            const obj = {
              then(onResolve, onReject) {
                window._llmBridge.chat(args).then(onResolve, onReject);
              },
              async *[Symbol.asyncIterator]() {
                const id = await window._llmBridge.chatStream(args);
                try {
                  while (true) {
                    const { done, value } = await window._llmBridge.iteratorNext(id);
                    if (done) break;
                    yield value;
                  }
                } finally {
                  await window._llmBridge.iteratorReturn(id);
                }
              }
            };
            return obj;
          },
          
          complete: function(prompt, args = {}) {
            const obj = {
              then(onResolve, onReject) {
                window._llmBridge.complete({ prompt, ...args }).then(onResolve, onReject);
              },
              async *[Symbol.asyncIterator]() {
                const id = await window._llmBridge.completeStream(prompt, args);
                try {
                  while (true) {
                    const { done, value } = await window._llmBridge.iteratorNext(id);
                    if (done) break;
                    yield value;
                  }
                } finally {
                  await window._llmBridge.iteratorReturn(id);
                }
              }
            };
            return obj;
          }
        };
        console.log('LLM API created via script injection for trusted external page');
      })();
    `;
    
    // Wait for DOM to be ready before injecting script
    const attachScript = () => {
      if (document.head) {
        document.head.appendChild(script);
      } else {
        console.warn('Unified-preload: cannot inject LLM script, document.head not available');
      }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attachScript);
    } else {
      attachScript();
    }
    
    console.log('Unified-preload: LLM API exposed for trusted external page');
  }
}

const context = { url, isSettings, isExtensions, isHome, isBookmarks, isTabsPage, isInternal, isExternal };

console.log(`Unified-preload: Context detection - URL: ${url}`);
console.log(`Unified-preload: isSettings: ${isSettings}, isExtensions: ${isExtensions}, isHome: ${isHome}, isBookmarks: ${isBookmarks}, isInternal: ${isInternal}, isExternal: ${isExternal}`);

// Factory function to create context-appropriate settings API with access control
function createSettingsAPI(pageContext) {
  const baseAPI = {
    get: (key) => {
      if (!key || typeof key !== 'string') {
        throw new Error('Setting key must be a non-empty string');
      }
      return ipcRenderer.invoke('settings-get', key);
    }
  };

  if (pageContext.isSettings) {
    // Full settings API only for settings pages
    return {
      ...baseAPI,
      getAll: () => ipcRenderer.invoke('settings-get-all'),
      set: (key, value) => {
        if (!key || typeof key !== 'string') {
          throw new Error('Setting key must be a non-empty string');
        }
        return ipcRenderer.invoke('settings-set', key, value);
      },
      reset: () => ipcRenderer.invoke('settings-reset'),
      // NEW: browser-only cache
      clearBrowserCache: () => ipcRenderer.invoke('settings-clear-cache'),
      // NEW: P2P reset (identities preserved by default)
      resetP2P: (opts = {}) => ipcRenderer.invoke('settings-reset-p2p', opts),
      uploadWallpaper: (fileData) => {
        if (!fileData || !fileData.name || !fileData.content) {
          throw new Error('File data must include name and content');
        }
        return ipcRenderer.invoke('settings-upload-wallpaper', fileData);
      }
    };
  } else if (pageContext.isExtensions) {
    // Extensions pages get limited settings API - only theme access
    return {
      get: (key) => {
        const allowedKeys = ['theme'];
        if (!allowedKeys.includes(key)) {
          throw new Error(`Access denied: Extensions pages can only access: ${allowedKeys.join(', ')}`);
        }
        return baseAPI.get(key);
      }
    };
  } else if (pageContext.isHome) {
    // Limited API for home pages - only clock and wallpaper
    return {
      get: (key) => {
        const allowedKeys = ['showClock', 'wallpaper'];
        if (!allowedKeys.includes(key)) {
          throw new Error(`Access denied: Home pages can only access: ${allowedKeys.join(', ')}`);
        }
        return baseAPI.get(key);
      }
    };
  } else if (pageContext.isInternal) {
    // Minimal API for other internal pages - only theme
    return {
      get: (key) => {
        const allowedKeys = ['theme','verticalTabs'];
        if (!allowedKeys.includes(key)) {
          throw new Error(`Access denied: Internal pages can only access: ${allowedKeys.join(', ')}`);
        }
        return baseAPI.get(key);
      }
    };
  } else {
    // No settings API for external pages
    return null;
  }
}

// Create safe event listeners with error handling
function createEventListener(eventName, callback) {
  if (typeof callback !== 'function') {
    throw new Error('Callback must be a function');
  }
  
  const wrappedCallback = (event, ...args) => {
    try {
      callback(...args);
    } catch (error) {
      console.error(`${eventName} callback error:`, error);
    }
  };
  
  ipcRenderer.on(eventName, wrappedCallback);
  return () => ipcRenderer.removeListener(eventName, wrappedCallback);
}

// Static APIs for different contexts
const cssAPI = {
  readCSS: (type) => ipcRenderer.invoke('peersky-read-css', type)
};

const environmentAPI = {
  version: process.versions.electron,
  platform: process.platform,
  userAgent: navigator.userAgent
};

const bookmarkAPI = {
  getBookmarks: () => ipcRenderer.invoke('get-bookmarks'),
  deleteBookmark: (url) => ipcRenderer.invoke('delete-bookmark', { url })
};

// Extension API - Available only to settings pages for security
const extensionAPI = {
  listExtensions: () => ipcRenderer.invoke('extensions-list'),
  toggleExtension: (id, enabled) => ipcRenderer.invoke('extensions-toggle', id, enabled),
  installExtension: (source) => ipcRenderer.invoke('extensions-install', source),
  openInstallFileDialog: () => ipcRenderer.invoke('extensions-show-open-dialog'),
  installFromBlob: (name, arrayBuffer) => {
    if (!name || typeof name !== 'string' || !arrayBuffer) {
      throw new Error('Invalid upload arguments');
    }
    const lower = name.toLowerCase();
    const allowed = lower.endsWith('.zip') || lower.endsWith('.crx') || lower.endsWith('.crx3');
    if (!allowed) {
      throw new Error('Unsupported file type');
    }
    const size = typeof arrayBuffer === 'object' && arrayBuffer !== null && typeof arrayBuffer.byteLength === 'number'
      ? arrayBuffer.byteLength
      : 0;
    const MAX_UPLOAD_BYTES = 60 * 1024 * 1024; // 60MB
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error('Invalid file content');
    }
    if (size > MAX_UPLOAD_BYTES) {
      throw new Error(`File too large (max ${MAX_UPLOAD_BYTES} bytes)`);
    }
    return ipcRenderer.invoke('extensions-install-upload', { name, data: arrayBuffer });
  },
  uninstallExtension: (id) => ipcRenderer.invoke('extensions-uninstall', id),
  unpinExtension: (id) => {
    ipcRenderer.invoke("extensions-unpin", id);
    ipcRenderer.send("refresh-browser-actions");
  },
  // Chrome Web Store APIs
  installFromWebStore: (urlOrId) => ipcRenderer.invoke('extensions-install-webstore', urlOrId),
  updateAll: () => ipcRenderer.invoke('extensions-update-all'),
  // Session 1 implemented APIs
  getExtensionInfo: (id) => ipcRenderer.invoke('extensions-get-info', id),
  getStatus: () => ipcRenderer.invoke('extensions-status'),
  // Icon API
  getIconUrl: (id, size) => ipcRenderer.invoke('extensions-get-icon-url', id, size),
  // Registry cleanup API
  cleanupRegistry: () => ipcRenderer.invoke('extensions-cleanup-registry'),
  
  // Browser action APIs for extension toolbar integration
  getBrowserActions: () => ipcRenderer.invoke('extensions-list-browser-actions'),
  clickBrowserAction: (actionId) => ipcRenderer.invoke('extensions-click-browser-action', actionId),
  openBrowserActionPopup: (actionId, anchorRect) => ipcRenderer.invoke('extensions-open-browser-action-popup', { actionId, anchorRect }),
  
  // Webview registration APIs for tab context
  registerWebview: (webContentsId) => ipcRenderer.invoke('extensions-register-webview', webContentsId),
  unregisterWebview: (webContentsId) => ipcRenderer.invoke('extensions-unregister-webview', webContentsId),

  onExtensionChanged: (callback) => createEventListener('extension-changed', callback),
  onExtensionInstalled: (callback) => createEventListener('extension-installed', callback),
  onExtensionUninstalled: (callback) => createEventListener('extension-uninstalled', callback),
  
  // Browser action event listeners
  onBrowserActionChanged: (callback) => createEventListener('browser-action-changed', callback),
  onExtensionError: (callback) => createEventListener('extension-error', callback)
};

// Create context-appropriate APIs
const settingsAPI = createSettingsAPI(context);

// Expose APIs based on context with enhanced granularity
try {
  if (isSettings) {
    // Settings pages get full electronAPI access (exactly what settings.js expects)
    contextBridge.exposeInMainWorld('electronAPI', {
      settings: settingsAPI,
      getTabs: () => ipcRenderer.invoke('get-tabs'),
      closeTab: (id) => ipcRenderer.invoke('close-tab', id),
      activateTab: (id) => ipcRenderer.invoke('activate-tab', id),
      groupAction: (action, groupId) => ipcRenderer.invoke('group-action', { action, groupId }),
      updateGroupProperties: (groupId, properties) => ipcRenderer.send('update-group-properties', groupId, properties),
      onGroupPropertiesUpdated: (callback) => {
        ipcRenderer.on('group-properties-updated', (_, groupId, properties) => {
          callback(groupId, properties);
        });
      },
      onVerticalTabsChanged: (callback) => createEventListener('vertical-tabs-changed', callback),
      hideTabComponents: () => ipcRenderer.send('hide-tab-components'),
      loadTabComponents: () => ipcRenderer.send('load-tab-components'),
      onThemeChanged: (callback) => createEventListener('theme-changed', callback),
      onSearchEngineChanged: (callback) => createEventListener('search-engine-changed', callback),
      onShowClockChanged: (callback) => createEventListener('show-clock-changed', callback),
      onWallpaperChanged: (callback) => createEventListener('wallpaper-changed', callback),
      readCSS: cssAPI.readCSS,
      extensions: extensionAPI,
      llm: {
        isSupported: () => ipcRenderer.invoke('llm-supported'),
        chat: (messages, options) => ipcRenderer.invoke('llm-chat', messages, options),
        complete: (prompt, options) => ipcRenderer.invoke('llm-complete', prompt, options),
        updateSettings: (settings) => ipcRenderer.invoke('llm-update-settings', settings),
        testConnection: () => ipcRenderer.invoke('llm-test-connection')
      },
      onLLMDownloadProgress: (callback) => {
        ipcRenderer.on('llm-download-progress', (_, progress) => callback(progress));
      },
      onLLMModelsUpdated: (callback) => {
        ipcRenderer.on('llm-models-updated', (_, data) => callback(data));
      },
      onCheckBuiltInEngine: (template) => ipcRenderer.invoke('check-built-in-engine', template),
      on: (channel, listener) => {
        const validChannels = ['reload-ui-after-cache']; // whitelist
        if (validChannels.includes(channel)) {
          const wrapped = (_, ...args) => listener(...args);
          ipcRenderer.on(channel, wrapped);
          return () => ipcRenderer.removeListener(channel, wrapped);
        }
      },
    });
    
    console.log('Unified-preload: Full Settings electronAPI exposed with extension and LLM APIs');
    
  } else if (isExtensions) {
    // Extensions pages get full extension API + limited settings API (theme only)
    contextBridge.exposeInMainWorld('electronAPI', {
      settings: settingsAPI, // Limited to theme access only
      onThemeChanged: (callback) => createEventListener('theme-changed', callback),
      readCSS: cssAPI.readCSS,
      extensions: extensionAPI
    });
    
    console.log('Unified-preload: Extensions electronAPI and full extensionAPI exposed');
    
  } else if (isHome) {
    // Home pages need browser action APIs for extension toolbar integration
    
    // Zero-flicker wallpaper injection for home pages
    // Get wallpaper URL synchronously but inject when DOM is ready
    let wallpaperURL = null;
    try {
      wallpaperURL = ipcRenderer.sendSync('settings-get-wallpaper-url-sync');
      console.log('Unified-preload: Wallpaper URL retrieved:', wallpaperURL);
    } catch (error) {
      console.warn('Unified-preload: Failed to get wallpaper URL:', error.message);
    }

    // Function to inject wallpaper style
    const injectWallpaper = () => {
      if (wallpaperURL && typeof wallpaperURL === 'string') {
        const wallpaperStyle = document.createElement('style');
        wallpaperStyle.id = 'zero-flicker-wallpaper';
        wallpaperStyle.textContent = `
          body {
            background-image: url("${wallpaperURL.replace(/"/g, '\\"')}");
            background-size: cover;
            background-position: center;
            background-repeat: no-repeat;
            background-attachment: fixed;
          }
        `;
        
        // Inject at the very beginning of head to load before CSS imports
        const head = document.head || document.getElementsByTagName('head')[0];
        if (head) {
          head.insertBefore(wallpaperStyle, head.firstChild);
          console.log('Unified-preload: Zero-flicker wallpaper injected:', wallpaperURL);
        } else {
          console.warn('Unified-preload: No head element found for wallpaper injection');
        }
      } else {
        console.log('Unified-preload: No wallpaper URL available, using CSS fallback');
      }
    };

    // Inject wallpaper immediately if DOM is ready, otherwise wait
    if (document.head || document.readyState !== 'loading') {
      injectWallpaper();
    } else {
      document.addEventListener('DOMContentLoaded', injectWallpaper);
    }
    
    // Home pages get basic environment + CSS + limited settings
    contextBridge.exposeInMainWorld('peersky', {
      environment: environmentAPI,
      css: cssAPI
    });
    
    // Home electronAPI with browser action support for extension toolbar
    contextBridge.exposeInMainWorld('electronAPI', {
      settings: settingsAPI, // Uses limited home API automatically
      getWallpaperUrl: () => ipcRenderer.invoke('settings-get-wallpaper-url'),
      onShowClockChanged: (callback) => createEventListener('show-clock-changed', callback),
      onWallpaperChanged: (callback) => createEventListener('wallpaper-changed', callback),
      // Extension browser action APIs for home page toolbar
      extensions: {
        getBrowserActions: () => ipcRenderer.invoke('extensions-list-browser-actions'),
        clickBrowserAction: (actionId) => ipcRenderer.invoke('extensions-click-browser-action', actionId),
        openBrowserActionPopup: (actionId, anchorRect) => ipcRenderer.invoke('extensions-open-browser-action-popup', { actionId, anchorRect }),
        onBrowserActionChanged: (callback) => createEventListener('browser-action-changed', callback),
        // Webview registration APIs for tab context
        registerWebview: (webContentsId) => ipcRenderer.invoke('extensions-register-webview', webContentsId),
        unregisterWebview: (webContentsId) => ipcRenderer.invoke('extensions-unregister-webview', webContentsId),
      }
    });
    
    console.log('Unified-preload: Home APIs exposed (showClock, wallpaper, browser actions)');
    
  } else if (isBookmarks) {
    // Bookmark pages get bookmark API + minimal environment
    contextBridge.exposeInMainWorld('peersky', {
      environment: environmentAPI,
      css: cssAPI
    });
    
    contextBridge.exposeInMainWorld('electronAPI', {
      getBookmarks: bookmarkAPI.getBookmarks,
      deleteBookmark: bookmarkAPI.deleteBookmark
    });
    
    console.log('Unified-preload: Bookmark APIs exposed (getBookmarks, deleteBookmark)');
    
  } else if (isTabsPage) {
    contextBridge.exposeInMainWorld('electronAPI', {
      getTabs: () => ipcRenderer.invoke('get-tabs'),
      closeTab: (id) => ipcRenderer.invoke('close-tab', id),
      activateTab: (id) => ipcRenderer.invoke('activate-tab', id),
      groupAction: (action, groupId) => ipcRenderer.invoke('group-action', { action, groupId }),
      updateGroupProperties: (groupId, properties) => ipcRenderer.send('update-group-properties', groupId, properties),
      onGroupPropertiesUpdated: (callback) => {
        ipcRenderer.on('group-properties-updated', (_, groupId, properties) => {
          callback(groupId, properties);
        });
      },
      hideTabComponents: () => ipcRenderer.send('hide-tab-components'),
      loadTabComponents: () => ipcRenderer.send('load-tab-components'),
      onVerticalTabsChanged: (callback) => createEventListener('vertical-tabs-changed', callback)
    })
  } else if (isInternal) {
    // Other internal pages get minimal environment + very limited settings
    contextBridge.exposeInMainWorld('peersky', {
      environment: {
        platform: process.platform,
        version: process.versions.electron
      },
      // LLM API for P2P apps
      llm: {
        isSupported: () => ipcRenderer.invoke('llm-supported'),
        chat: (messages, options) => ipcRenderer.invoke('llm-chat', messages, options),
        complete: (prompt, options) => ipcRenderer.invoke('llm-complete', prompt, options)
      }
    });
    
    // Very minimal electronAPI for theme and tabs settings
    if (settingsAPI) {
      contextBridge.exposeInMainWorld('electronAPI', {
        settings: settingsAPI // Uses minimal internal API (theme, verticalTabs)
      });
    }
    
    console.log('Unified-preload: Internal minimal API exposed (theme only)');
    
  } else {
    // External pages get almost nothing - no settings API at all
    contextBridge.exposeInMainWorld('peersky', {
      environment: {
        platform: process.platform
      }
    });
    
    console.log('Unified-preload: External minimal API exposed (no settings access)');
  }
  
} catch (error) {
  console.error('Unified-preload: Failed to expose APIs via contextBridge:', error);
  
  // Fallback only for settings pages in development
  if (isSettings && process?.env?.NODE_ENV === 'development') {
    try {
      window.electronIPC = ipcRenderer;
      console.log('Unified-preload: Fallback IPC exposed for settings (development mode)');
    } catch (fallbackError) {
      console.error('Unified-preload: Fallback failed:', fallbackError);
    }
  }
}

// CSS injection logic (for pages that need it)
window.addEventListener('DOMContentLoaded', async () => {
  try {
    // Initialize theme on page load for internal pages
    if (isInternal) {
      // Disable transitions temporarily for non-settings internal pages
      if (!isSettings) {
        document.body.classList.add('transition-disabled');
      }
      
      // Always initialize theme for all internal pages FIRST
      let currentTheme = 'dark'; // default fallback
      try {
        const themeFromSettings = await ipcRenderer.invoke('settings-get', 'theme');
        if (themeFromSettings) {
          currentTheme = themeFromSettings;
          document.documentElement.setAttribute('data-theme', currentTheme);
        }
      } catch (error) {
        console.warn('Failed to initialize theme:', error);
      }

      // Only show loader on settings page where theme switching occurs
      if (isSettings) {
        // Create and show loader with theme-appropriate background
        const loader = document.createElement('div');
        loader.id = 'theme-loader';
        const loaderBg = currentTheme === 'light' ? '#ffffff' : '#18181b';
        const loaderTextColor = currentTheme === 'light' ? '#374151' : '#9ca3af';
        loader.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: ${loaderBg};
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 9999;
          font-family: sans-serif;
          font-size: 14px;
          color: ${loaderTextColor};
        `;
        loader.textContent = 'Loading...';
        document.body.appendChild(loader);

        // Hide main content initially (after theme is applied)
        document.body.style.visibility = 'hidden';
      }
      
      // Re-enable transitions after theme is applied (only for non-settings pages)
      if (!isSettings) {
        setTimeout(() => {
          document.body.classList.remove('transition-disabled');
        }, 50);
      }

      // Show content and remove loader (only if settings page)
      if (isSettings) {
        document.body.style.visibility = 'visible';
        const loader = document.getElementById('theme-loader');
        if (loader) {
          loader.style.opacity = '0';
          setTimeout(() => loader.remove(), 200);
        }
      }
    }
    
    // Check if page already has stylesheets
    const hasStylesheets = [...document.styleSheets].some(s => {
      try { return !!s.cssRules } catch { return false }
    }) || !!document.querySelector('style,link[rel="stylesheet"]');
    
    if (!hasStylesheets) {
      // Inject base styles for pages without CSS
      const [varsCss, baseCss] = await Promise.all([
        ipcRenderer.invoke('peersky-read-css', 'vars'),
        ipcRenderer.invoke('peersky-read-css', 'base')
      ]);

      const style = document.createElement('style');
      style.textContent = varsCss + '\n' + baseCss;
      document.head.appendChild(style);
      
      console.log('Unified-preload: Default CSS injected');
    }
    
    // Special handling for XML content
    if (window.location.pathname.endsWith('.xml') || 
        document.querySelector('rss, feed, body > pre') !== null) {
      const sheet = document.styleSheets[document.styleSheets.length - 1];
      if (sheet) {
        sheet.insertRule('body { background: #000; color: #fff }', sheet.cssRules.length);
        console.log('Unified-preload: XML styling applied');
      }
    }
    
  } catch (error) {
    console.error('Unified-preload: Error injecting default styles:', error);
  }
});
