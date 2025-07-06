/**
 * Settings Preload Script - Secure IPC Bridge for Settings Page
 * 
 * Provides secure access to settings IPC methods via contextBridge.
 * Migrated from iframe (insecure) to webview with context isolation.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Helper function to create safe event listeners
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

// Expose secure API to main world
try {
  contextBridge.exposeInMainWorld('electronAPI', {
    // Settings management with input validation and error handling
    settings: {
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
    },
    
    // Event listeners with automatic cleanup
    onThemeChanged: (callback) => createEventListener('theme-changed', callback),
    onSearchEngineChanged: (callback) => createEventListener('search-engine-changed', callback),
    onShowClockChanged: (callback) => createEventListener('show-clock-changed', callback),
    onWallpaperChanged: (callback) => createEventListener('wallpaper-changed', callback),
    
    // CSS theming support
    readCSS: (type) => ipcRenderer.invoke('peersky-read-css', type)
  });

} catch (error) {
  console.error('Settings-preload: Failed to expose API via contextBridge:', error);
  
  // Development fallback
  try {
    window.electronIPC = ipcRenderer;
    console.log('Settings-preload: Using fallback electronIPC (development mode)');
  } catch (fallbackError) {
    console.error('Settings-preload: Fallback failed:', fallbackError);
  }
}

// Inject default styles if page doesn't have any
window.addEventListener('DOMContentLoaded', async () => {
  try {
    // Check if page already has stylesheets
    const hasStylesheets = document.styleSheets.length > 0 || 
                          document.querySelector('style,link[rel="stylesheet"]');
    
    if (!hasStylesheets) {
      // Inject base styles for pages without CSS
      const [varsCss, baseCss] = await Promise.all([
        ipcRenderer.invoke('peersky-read-css', 'vars'),
        ipcRenderer.invoke('peersky-read-css', 'base')
      ]);

      const style = document.createElement('style');
      style.textContent = varsCss + '\n' + baseCss;
      document.head.appendChild(style);
    }
  } catch (error) {
    console.error('Settings-preload: Error injecting default styles:', error);
  }
});