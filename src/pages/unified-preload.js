/**
 * Unified Preload Script - Context-Aware API Exposure with Enhanced Security
 * 
 * Detects page context and exposes appropriate APIs based on security levels:
 * - Settings pages: Full electronAPI access (getAll, set, reset, clearCache, uploadWallpaper)
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
const isInternal = url.startsWith('peersky://');
const isExternal = !isInternal;

const context = { url, isSettings, isExtensions, isHome, isBookmarks, isInternal, isExternal };

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
      clearCache: () => ipcRenderer.invoke('settings-clear-cache'),
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
        const allowedKeys = ['theme'];
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
  // TODO: Add missing IPC handlers for these APIs (Session 2+)
  // checkForUpdates: () => ipcRenderer.invoke('extensions-check-updates'),
  // toggleP2P: (enabled) => ipcRenderer.invoke('extensions-toggle-p2p', enabled),
  
  // Browser action APIs for extension toolbar integration
  getBrowserActions: () => ipcRenderer.invoke('extensions-list-browser-actions'),
  clickBrowserAction: (actionId) => ipcRenderer.invoke('extensions-click-browser-action', actionId),
  openBrowserActionPopup: (actionId, anchorRect) => ipcRenderer.invoke('extensions-open-browser-action-popup', { actionId, anchorRect }),
  
  // Webview registration APIs for tab context
  registerWebview: (webContentsId) => ipcRenderer.invoke('extensions-register-webview', webContentsId),
  unregisterWebview: (webContentsId) => ipcRenderer.invoke('extensions-unregister-webview', webContentsId),
  
  // TODO: Add extension development APIs
  // reloadExtension: (id) => ipcRenderer.invoke('extensions-reload', id),
  // openExtensionFolder: (id) => ipcRenderer.invoke('extensions-open-folder', id),
  // getExtensionLogs: (id) => ipcRenderer.invoke('extensions-get-logs', id),
  
  // TODO: Add extension security APIs
  // getExtensionPermissions: (id) => ipcRenderer.invoke('extensions-get-permissions', id),
  // validateExtension: (source) => ipcRenderer.invoke('extensions-validate', source),
  // getExtensionSecurityReport: (id) => ipcRenderer.invoke('extensions-security-report', id),
  
  // TODO: Listen for change notifications via ipcRenderer.on()
  // TODO: Hide APIs unless settings.extensionSupport is true
  // TODO: Expose only secure functionality to renderer
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
      onThemeChanged: (callback) => createEventListener('theme-changed', callback),
      onSearchEngineChanged: (callback) => createEventListener('search-engine-changed', callback),
      onShowClockChanged: (callback) => createEventListener('show-clock-changed', callback),
      onWallpaperChanged: (callback) => createEventListener('wallpaper-changed', callback),
      readCSS: cssAPI.readCSS,
      // Extension API - Available under electronAPI.extensions for consistency
      extensions: extensionAPI
    });
    
    console.log('Unified-preload: Full Settings electronAPI and extensionAPI exposed');
    
  } else if (isExtensions) {
    // Extensions pages get full extension API + limited settings API (theme only)
    contextBridge.exposeInMainWorld('electronAPI', {
      settings: settingsAPI, // Limited to theme access only
      onThemeChanged: (callback) => createEventListener('theme-changed', callback),
      readCSS: cssAPI.readCSS,
      // Extension API - Full access for extension management
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
    // TODO: Consider extension integration for bookmark pages
    // - Extension bookmark sync capabilities
    // - Extension bookmark management APIs
    
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
      }
    })
  } else if (isInternal) {
    // TODO: Consider minimal extension APIs for internal pages
    // - Extension theme integration
    // - Extension content script injection
    // - Extension popup support
    
    // Other internal pages get minimal environment + very limited settings
    contextBridge.exposeInMainWorld('peersky', {
      environment: {
        platform: process.platform,
        version: process.versions.electron
      }
    });
    
    // Very minimal electronAPI for theme access only
    if (settingsAPI) {
      contextBridge.exposeInMainWorld('electronAPI', {
        settings: settingsAPI // Uses minimal internal API (theme only)
      });
    }
    
    console.log('Unified-preload: Internal minimal API exposed (theme only)');
    
  } else {
    // TODO: Consider extension content script injection for external pages
    // - Extension content script APIs
    // - Extension message passing
    // - Extension popup and options page support
    
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
  if (isSettings) {
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