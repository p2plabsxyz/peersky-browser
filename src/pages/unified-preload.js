/**
 * Unified Preload Script - Context-Aware API Exposure with Security
 * 
 * Immediately detects page context and exposes appropriate APIs:
 * - Settings pages: Full electronAPI access
 * - Home pages: Basic environment + CSS
 * - Other internal pages: Minimal environment  
 * - External pages: Very minimal access
 * 
 * Eliminates need for preload switching while maintaining security.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Determine context IMMEDIATELY when preload runs
const url = window.location.href;
const isSettings = url.startsWith('peersky://settings');
const isHome = url.startsWith('peersky://home');
const isInternal = url.startsWith('peersky://');
const isExternal = !isInternal;

console.log(`Unified-preload: Context detection - URL: ${url}`);
console.log(`Unified-preload: isSettings: ${isSettings}, isHome: ${isHome}, isInternal: ${isInternal}, isExternal: ${isExternal}`);

// Settings API (only for settings pages)
const settingsAPI = {
  getAll: () => ipcRenderer.invoke('settings-get-all'),
  
  get: (key) => {
    if (!key || typeof key !== 'string') {
      throw new Error('Setting key must be a non-empty string');
    }
    return ipcRenderer.invoke('settings-get', key);
  },
  
  set: (key, value) => {
    if (!key || typeof key !== 'string') {
      throw new Error('Setting key must be a non-empty string');
    }
    return ipcRenderer.invoke('settings-set', key, value);
  },
  
  reset: () => ipcRenderer.invoke('settings-reset')
};

// Helper function to create safe event listeners (only for settings pages)
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

// CSS API (for internal pages)
const cssAPI = {
  readCSS: (type) => ipcRenderer.invoke('peersky-read-css', type)
};

// Environment API (basic info)
const environmentAPI = {
  version: process.versions.electron,
  platform: process.platform,
  userAgent: navigator.userAgent
};

// Expose APIs based on context - IMMEDIATELY
try {
  if (isSettings) {
    // Settings pages get full electronAPI access (exactly what settings.js expects)
    contextBridge.exposeInMainWorld('electronAPI', {
      settings: settingsAPI,
      onThemeChanged: (callback) => createEventListener('theme-changed', callback),
      onSearchEngineChanged: (callback) => createEventListener('search-engine-changed', callback),
      onShowClockChanged: (callback) => createEventListener('show-clock-changed', callback),
      onWallpaperChanged: (callback) => createEventListener('wallpaper-changed', callback),
      readCSS: cssAPI.readCSS
    });
    
    console.log('Unified-preload: Settings electronAPI exposed');
    
  } else if (isHome) {
    // Home pages get basic environment + CSS + clock settings
    contextBridge.exposeInMainWorld('peersky', {
      environment: environmentAPI,
      css: cssAPI
    });
    
    // Also expose minimal electronAPI for clock functionality
    contextBridge.exposeInMainWorld('electronAPI', {
      settings: {
        get: (key) => {
          // Only allow getting showClock setting for home pages
          if (key === 'showClock') {
            return ipcRenderer.invoke('settings-get', key);
          }
          throw new Error('Access denied: Home pages can only access showClock setting');
        }
      },
      onShowClockChanged: (callback) => createEventListener('show-clock-changed', callback)
    });
    
    console.log('Unified-preload: Home peersky + limited electronAPI exposed');
    
  } else if (isInternal) {
    // Other internal pages get minimal environment
    contextBridge.exposeInMainWorld('peersky', {
      environment: {
        platform: process.platform,
        version: process.versions.electron
      }
    });
    
    console.log('Unified-preload: Internal minimal API exposed');
    
  } else {
    // External pages get almost nothing
    contextBridge.exposeInMainWorld('peersky', {
      environment: {
        platform: process.platform
      }
    });
    
    console.log('Unified-preload: External minimal API exposed');
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