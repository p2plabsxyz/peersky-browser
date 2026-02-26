// Settings Manager - Main Process
// Handles settings storage, defaults, validation, and IPC communication
// Pattern: Similar to window-manager.js

import { app, ipcMain, BrowserWindow, session, safeStorage } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { getBrowserSession } from './session.js';

const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");
const DEBUG_LOG = path.join(os.homedir(), '.peersky', 'debug.log');

// Debug logging helper
function logDebug(message) {
  const entry = `[${new Date().toISOString()}] Settings: ${message}\n`;
  fs.appendFile(DEBUG_LOG, entry).catch(() => {}); // Don't crash on failure
}

// Default settings configuration
const DEFAULT_SETTINGS = {
  searchEngine: 'duckduckgo',
  customSearchTemplate: "https://duckduckgo.com/?q=%s",
  theme: 'dark',
  showClock: true,
  verticalTabs: false,
  keepTabsExpanded: false,
  wallpaper: 'redwoods',
  wallpaperCustomPath: null,
  extensionP2PEnabled: false,
  extensionAutoUpdate: true,
  llm: {
    enabled: false,
    baseURL: 'http://127.0.0.1:11434/',
    apiKey: 'ollama',
    model: 'qwen2.5-coder:3b'
  }
};

let isClearingBrowserCache = false;

async function clearBrowserCache() {
  if (isClearingBrowserCache)
    throw new Error('Cache clearing already in progress');

  isClearingBrowserCache = true;

  try {
    logDebug('Starting safe browser cache clearing...');

    // Step 1 → Ask all renderer windows to detach webviews
    const windows = BrowserWindow.getAllWindows();
    logDebug('Requesting all renderers to detach webviews...');
    await Promise.allSettled(
      windows.map(win =>
        win.webContents.executeJavaScript('window.detachWebviews?.()', true)
      )
    );

    await new Promise(r => setTimeout(r, 100)); // small delay

    // Step 2 → Clear cache and storage (in smaller groups)
    const clear = storages =>
      session.defaultSession.clearStorageData({ storages });

    await session.defaultSession.clearCache();
    await clear(['cookies', 'localstorage', 'sessionstorage']);
    await clear(['indexdb']); // (Electron's internal key for IndexedDB)
    await clear(['cachestorage', 'serviceworkers']);

    logDebug('Cache and storage cleared safely');

    // Step 3 → Notify all renderer processes to reinitialize
    windows.forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('reload-ui-after-cache');
      }
    });

    logDebug('UI reload triggered in all renderers');
  } catch (error) {
    logDebug(`Error during cache clearing: ${error.message}`);
    throw error;
  } finally {
    isClearingBrowserCache = false;
  }
}

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function removeChildrenExcept(dir, keepNames = []) {
  if (!(await pathExists(dir))) return;
  const keep = new Set(keepNames);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map(async (ent) => {
    if (keep.has(ent.name)) return;
    const target = path.join(dir, ent.name);
    await fs.rm(target, { recursive: true, force: true });
  }));
}

async function resetP2PData({ resetIdentities = false } = {}) {
  const USER_DATA = app.getPath('userData');
  const ipfsDir  = path.join(USER_DATA, 'ipfs');
  const hyperDir = path.join(USER_DATA, 'hyper');
  const ensCache = path.join(USER_DATA, 'ensCache.json');
  const btState = path.join(USER_DATA, 'bt-state.json');

  // ENS cache and BitTorrent state cache can always be removed
  await fs.rm(ensCache, { recursive: true, force: true }).catch(() => {});
  await fs.rm(btState, { recursive: true, force: true }).catch(() => {});

  if (resetIdentities) {
    // full wipe
    await fs.rm(ipfsDir,  { recursive: true, force: true }).catch(() => {});
    await fs.rm(hyperDir, { recursive: true, force: true }).catch(() => {});
    logDebug('P2P reset: full wipe including identities');
  } else {
    // preserve identity files by default
    await removeChildrenExcept(ipfsDir,  ['libp2p-key']);          // IPFS Peer ID
    await removeChildrenExcept(hyperDir, ['swarm-keypair.json']);  // Hyper identity
    logDebug('P2P reset: data cleared, identities preserved');
  }
}

class SettingsManager {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.isLoading = false;
    this.isSaving = false;
    
    this.init();
    this.registerIpcHandlers();
  }
  
  // Encrypt sensitive data (API keys)
  encryptApiKey(apiKey) {
    // Don't encrypt 'ollama' - it's not sensitive
    if (!apiKey || apiKey === 'ollama') {
      return apiKey;
    }
    
    // Only encrypt if safeStorage is available
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const buffer = safeStorage.encryptString(apiKey);
        return `encrypted:${buffer.toString('base64')}`;
      } catch (error) {
        logDebug(`Failed to encrypt API key: ${error.message}`);
        return apiKey; // Fallback to plain text
      }
    }
    
    return apiKey;
  }
  
  // Decrypt sensitive data (API keys)
  decryptApiKey(encryptedKey) {
    // Not encrypted
    if (!encryptedKey || !encryptedKey.startsWith('encrypted:')) {
      return encryptedKey;
    }
    
    // Only decrypt if safeStorage is available
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const base64 = encryptedKey.replace('encrypted:', '');
        const buffer = Buffer.from(base64, 'base64');
        return safeStorage.decryptString(buffer);
      } catch (error) {
        logDebug(`Failed to decrypt API key: ${error.message}`);
        return encryptedKey; // Return as-is if decryption fails
      }
    }
    
    return encryptedKey;
  }

  async init() {
    try {
      // Ensure debug log directory exists
      await fs.mkdir(path.dirname(DEBUG_LOG), { recursive: true });
      logDebug('Settings manager initializing');
      
      await this.loadSettings();
      logDebug('Settings manager initialized successfully');
    } catch (error) {
      logDebug(`Initialization failed: ${error.message}`);
    }
  }

  registerIpcHandlers() {
    // Get all settings
    ipcMain.handle('settings-get-all', async () => {
      try {
        logDebug('Request: get all settings');
        return this.settings;
      } catch (error) {
        logDebug(`Error getting all settings: ${error.message}`);
        throw error;
      }
    });

    // Get single setting
    ipcMain.handle('settings-get', async (event, key) => {
      try {
        logDebug(`Request: get setting ${key}`);
        if (!(key in this.settings)) {
          throw new Error(`Setting '${key}' does not exist`);
        }
        return this.settings[key];
      } catch (error) {
        logDebug(`Error getting setting ${key}: ${error.message}`);
        throw error;
      }
    });

    // Set setting
    ipcMain.handle('settings-set', async (event, key, value) => {
      try {
        logDebug(`Request: set ${key} = ${value}`);
        
        // Validate setting
        if (!this.validateSetting(key, value)) {
          const error = `Invalid value for ${key}: ${value}`;
          logDebug(error);
          throw new Error(error);
        }
        
        // Update setting
        const oldValue = this.settings[key];
        this.settings[key] = value;
        
        // Save to file
        await this.saveSettings();
        
        // Apply setting changes immediately
        this.applySettingChange(key, value);
        
        logDebug(`Setting updated: ${key} changed from ${oldValue} to ${value}`);
        return { success: true, key, value, oldValue };
      } catch (error) {
        logDebug(`Error setting ${key}: ${error.message}`);
        throw error;
      }
    });

    // Reset settings to defaults
    ipcMain.handle('settings-reset', async () => {
      try {
        logDebug('Request: reset settings to defaults');
        
        const oldSettings = { ...this.settings };
        this.settings = { ...DEFAULT_SETTINGS };
        
        await this.saveSettings();
        
        logDebug('Settings reset to defaults successfully');
        return { success: true, settings: this.settings, oldSettings };
      } catch (error) {
        logDebug(`Error resetting settings: ${error.message}`);
        throw error;
      }
    });

    // Get wallpaper URL (async)
    ipcMain.handle('settings-get-wallpaper-url', async () => {
      try {
        logDebug('Request: get wallpaper URL (async)');
        return this.getWallpaperUrl();
      } catch (error) {
        logDebug(`Error getting wallpaper URL (async): ${error.message}`);
        throw error;
      }
    });

    // Get wallpaper URL (sync) - for zero-flicker wallpaper injection
    ipcMain.on('settings-get-wallpaper-url-sync', (event) => {
      try {
        logDebug('Request: get wallpaper URL (sync)');
        const wallpaperUrl = this.getWallpaperUrl();
        event.returnValue = wallpaperUrl;
      } catch (error) {
        logDebug(`Error getting wallpaper URL (sync): ${error.message}`);
        event.returnValue = null;
      }
    });

    // Handle clear cache
    ipcMain.handle('settings-clear-cache', async () => {
      try {
        await clearBrowserCache();
        return { success: true, message: 'Browser cache cleared' };
      } catch (error) {
        const errorMsg = `Failed to clear browser cache: ${error.message}`;
        logDebug(errorMsg);
        throw new Error(errorMsg);
      }
    });

    ipcMain.handle('settings-reset-p2p', async (_event, opts = {}) => {
      try {
        await resetP2PData({ resetIdentities: !!opts.resetIdentities });
        return {
          success: true,
          message: opts.resetIdentities
            ? 'P2P data cleared (identities removed)'
            : 'P2P data cleared (identities preserved)'
        };
      } catch (error) {
        const errorMsg = `Failed to reset P2P data: ${error.message}`;
        logDebug(errorMsg);
        throw new Error(errorMsg);
      }
    });

    // Handle wallpaper upload
    ipcMain.handle('settings-upload-wallpaper', async (event, fileData) => {
      try {
        logDebug(`Wallpaper upload requested: ${fileData.name}`);
        
        // Validate file data
        if (!fileData || !fileData.name || !fileData.content) {
          throw new Error('Invalid file data provided');
        }
        
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        const fileExtension = path.extname(fileData.name).toLowerCase();
        if (!allowedExtensions.includes(fileExtension)) {
          throw new Error('Invalid file type. Please select a valid image file (jpg, png, gif, webp)');
        }
        
        // Create wallpapers directory in userData
        const USER_DATA = app.getPath("userData");
        const wallpapersDir = path.join(USER_DATA, "wallpapers");
        await fs.mkdir(wallpapersDir, { recursive: true });
        
        // Generate unique filename to avoid conflicts
        const fileName = `wallpaper_${Date.now()}${fileExtension}`;
        const destinationPath = path.join(wallpapersDir, fileName);
        
        // Convert base64 content to buffer and save
        const buffer = Buffer.from(fileData.content, 'base64');
        await fs.writeFile(destinationPath, buffer);
        
        // Update settings
        this.settings.wallpaper = 'custom';
        this.settings.wallpaperCustomPath = destinationPath;
        
        // Save settings
        await this.saveSettings();
        
        // Apply wallpaper change immediately
        this.applySettingChange('wallpaper', 'custom');
        
        logDebug(`Wallpaper uploaded successfully: ${destinationPath}`);
        return { 
          success: true, 
          message: 'Wallpaper uploaded successfully',
          path: destinationPath 
        };
        
      } catch (error) {
        const errorMsg = `Failed to upload wallpaper: ${error.message}`;
        logDebug(errorMsg);
        throw new Error(errorMsg);
      }
    });
  }

  async loadSettings() {
    try {
      const data = await fs.readFile(SETTINGS_FILE, 'utf8');
      const loaded = JSON.parse(data);
      
      // Start with defaults
      this.settings = { ...DEFAULT_SETTINGS };
      
      // Merge loaded settings, handling nested objects properly
      for (const key in loaded) {
        if (key === 'llm' && typeof loaded[key] === 'object' && loaded[key] !== null) {
          // Simple LLM settings structure
          const llmSettings = loaded.llm;
          
          // Ensure apiKey is 'ollama' for local setup
          if (!llmSettings.apiKey || llmSettings.apiKey === '') {
            llmSettings.apiKey = 'ollama';
          }
          
          // Keep the user's selected model (don't reset it)
          // Only use default if no model is set
          if (!llmSettings.model) {
            llmSettings.model = DEFAULT_SETTINGS.llm.model;
          }
          
          // Only keep the fields we need
          this.settings.llm = {
            enabled: llmSettings.enabled || false,
            baseURL: llmSettings.baseURL || DEFAULT_SETTINGS.llm.baseURL,
            apiKey: this.decryptApiKey(llmSettings.apiKey || DEFAULT_SETTINGS.llm.apiKey),
            model: llmSettings.model || DEFAULT_SETTINGS.llm.model
          };
        } else {
          this.settings[key] = loaded[key];
        }
      }
      
      logDebug(`Settings loaded successfully: ${Object.keys(loaded).length} keys`);
      return this.settings;
    } catch (error) {
      if (error.code === 'ENOENT') {
        logDebug('Settings file not found, creating with defaults');
      } else {
        logDebug(`loadSettings failed: ${error.message}`);
      }
      
      // Use defaults and create initial file
      this.settings = { ...DEFAULT_SETTINGS };
      await this.saveSettings();
      return this.settings;
    }
  }

  async saveSettings() {
    if (this.isSaving) {
      logDebug('Save already in progress, skipping');
      return;
    }
    
    this.isSaving = true;
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
      
      // Create a copy of settings with encrypted API key
      const settingsToSave = { ...this.settings };
      if (settingsToSave.llm && settingsToSave.llm.apiKey) {
        settingsToSave.llm = {
          ...settingsToSave.llm,
          apiKey: this.encryptApiKey(settingsToSave.llm.apiKey)
        };
      }
      
      // Atomic write: write to temp file then rename
      const tempFile = SETTINGS_FILE + '.tmp';
      await fs.writeFile(tempFile, JSON.stringify(settingsToSave, null, 2), 'utf8');
      await fs.rename(tempFile, SETTINGS_FILE);
      
      logDebug('Settings saved successfully');
    } catch (error) {
      logDebug(`saveSettings failed: ${error.message}`);
      throw error;
    } finally {
      this.isSaving = false;
    }
  }

  validateSetting(key, value) {
    const validators = {
      searchEngine: (v) => ['duckduckgo_noai', 'duckduckgo', 'brave', 'ecosia', 'kagi', 'startpage', "custom"].includes(v),
      customSearchTemplate: (v) => {
        if (typeof v !== "string" || v.length >= 2048) return false;
        try {
          // Just check if it’s parseable as a URL with any protocol
          new URL(v);
          return true;
        } catch {
          return false;
        }
      },
      theme: (v) =>
        [
          "transparent",
          "light",
          "dark",
          "green",
          "cyan",
          "yellow",
          "violet",
        ].includes(v),
      showClock: (v) => typeof v === "boolean",
      verticalTabs: (v) => typeof v === "boolean",
      keepTabsExpanded: (v) => typeof v === "boolean",
      wallpaper: (v) => ["redwoods", "mountains", "custom"].includes(v),
      wallpaperCustomPath: (v) => v === null || typeof v === "string",
      llm: (v) => {
        // Validate LLM settings object (simplified for Ollama-only)
        if (typeof v !== 'object' || v === null) return false;
        
        // Check required fields
        if (typeof v.enabled !== 'boolean') return false;
        if (typeof v.baseURL !== 'string') return false;
        if (typeof v.apiKey !== 'string') return false;
        if (typeof v.model !== 'string') return false;
        
        return true;
      }
    };
    
    const validator = validators[key];
    if (!validator) {
      logDebug(`No validator for setting: ${key}`);
      return false;
    }
    
    const isValid = validator(value);
    if (!isValid) {
      logDebug(`Validation failed for ${key}: ${value}`);
    }
    
    return isValid;
  }

  applySettings() {
    // Apply all settings to all windows
    this.applySettingChange('theme', this.settings.theme);
    this.applySettingChange('searchEngine', this.settings.searchEngine);
    this.applySettingChange('showClock', this.settings.showClock);
    this.applySettingChange('verticalTabs', this.settings.verticalTabs);
    this.applySettingChange('keepTabsExpanded', this.settings.keepTabsExpanded);
    this.applySettingChange('wallpaper', this.settings.wallpaper);
  }

  applySettingChange(key, value) {
    try {
      logDebug(`Applying setting change: ${key} = ${value}`);
      
      // Get all open windows
      const windows = BrowserWindow.getAllWindows();
      
      if (key === 'theme') {
        // Notify all windows of theme change
        windows.forEach(window => {
          if (window && !window.isDestroyed()) {
            window.webContents.send('theme-changed', value);
          }
        });
        logDebug(`Theme changed to ${value}, notified ${windows.length} windows`);
      } else if (key === 'searchEngine') {
        // Notify windows of search engine change
        windows.forEach(window => {
          if (window && !window.isDestroyed()) {
            window.webContents.send('search-engine-changed', value);
          }
        });
      } else if (key === 'showClock') {
        // Notify windows of clock setting change
        windows.forEach(window => {
          if (window && !window.isDestroyed()) {
            window.webContents.send('show-clock-changed', value);
          }
        });
      } else if (key === 'wallpaper') {
        // Notify windows of wallpaper change
        windows.forEach(window => {
          if (window && !window.isDestroyed()) {
            window.webContents.send('wallpaper-changed', value);
          }
        });
      } else if (key === 'verticalTabs') {
        windows.forEach(window => {
          if (window && !window.isDestroyed()) {
            window.webContents.send('vertical-tabs-changed', value);
          }
        });
      } else if (key === 'keepTabsExpanded') {
        windows.forEach(window => {
          if (window && !window.isDestroyed()) {
            window.webContents.send('keep-tabs-expanded-changed', value);
          }
        });
      } else if (key === 'wallpaperCustomPath') {
        // When custom path changes, also notify about wallpaper change
        windows.forEach(window => {
          if (window && !window.isDestroyed()) {
            window.webContents.send('wallpaper-changed', this.settings.wallpaper);
          }
        });
      } else if (key === "customSearchTemplate") {
        windows.forEach((window) => {
          if (window && !window.isDestroyed()) {
            window.webContents.send(
              "search-engine-changed",
              this.settings.searchEngine
            );
          }
        });
      }
      
      logDebug(`Applied setting change: ${key} to ${windows.length} windows`);
    } catch (error) {
      logDebug(`Failed to apply setting change ${key}: ${error.message}`);
    }
  }

  // Helper methods
  getSearchEngineUrl(query) {
    const { makeSearch } = require('./utils.js');
    return makeSearch(query, this.settings.searchEngine);
  }

  getSearchEngineName() {
    const engineNames = {
      'duckduckgo_noai': 'DuckDuckGo (No AI)',
      'duckduckgo': 'DuckDuckGo (AI)',
      'brave': 'Brave Search',
      'ecosia': 'Ecosia',
      'kagi': 'Kagi',
      'startpage': 'Startpage',
      'custom' : 'Custom'
    };
    return engineNames[this.settings.searchEngine] || 'DuckDuckGo (No AI)';
  }

  // Get wallpaper path for current setting
  getWallpaperPath() {
    if (this.settings.wallpaper === 'custom' && this.settings.wallpaperCustomPath) {
      return this.settings.wallpaperCustomPath;
    }
    // Return path to built-in wallpaper
    const wallpaperFile = this.settings.wallpaper === 'mountains' ? 'mountains.jpg' : 'redwoods.jpg';
    return path.join(__dirname, 'pages', 'static', 'assets', wallpaperFile);
  }

  // Get wallpaper URL for browser usage
  getWallpaperUrl() {
    if (this.settings.wallpaper === 'custom' && this.settings.wallpaperCustomPath) {
      // Extract filename from full path and serve via peersky protocol
      const filename = path.basename(this.settings.wallpaperCustomPath);
      return `peersky://wallpaper/${filename}`;
    }
    // Return URL to built-in wallpaper
    const wallpaperFile = this.settings.wallpaper === 'mountains' ? 'mountains.jpg' : 'redwoods.jpg';
    return `peersky://static/assets/${wallpaperFile}`;
  }
}

app.on('before-quit', e => {
  if (isClearingBrowserCache) {
    e.preventDefault();
    setTimeout(() => app.quit(), 200);
  }
});

// Create singleton instance
const settingsManager = new SettingsManager();

export default settingsManager;
