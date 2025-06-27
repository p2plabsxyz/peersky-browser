// Settings Manager - Main Process
// Handles settings storage, defaults, validation, and IPC communication
// Pattern: Similar to window-manager.js

import { app, ipcMain } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

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
  theme: 'dark',
  showClock: true,
  wallpaper: 'default',
  wallpaperCustomPath: null
};

class SettingsManager {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.isLoading = false;
    this.isSaving = false;
    
    this.init();
    this.registerIpcHandlers();
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

    // TODO: Handle clear cache
    ipcMain.handle('settings-clear-cache', async () => {
      // TODO: Clear browser cache
      // TODO: Clear stored data
      console.log('TODO: Clear cache');
      return true;
    });

    // TODO: Handle wallpaper upload
    ipcMain.handle('settings-upload-wallpaper', async (event, filePath) => {
      // TODO: Validate file
      // TODO: Copy to userData directory
      // TODO: Update settings
      console.log('TODO: Upload wallpaper:', filePath);
      return true;
    });
  }

  async loadSettings() {
    try {
      const data = await fs.readFile(SETTINGS_FILE, 'utf8');
      const loaded = JSON.parse(data);
      
      // Merge with defaults for missing keys
      this.settings = { ...DEFAULT_SETTINGS, ...loaded };
      
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
      
      // Atomic write: write to temp file then rename
      const tempFile = SETTINGS_FILE + '.tmp';
      await fs.writeFile(tempFile, JSON.stringify(this.settings, null, 2), 'utf8');
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
      searchEngine: (v) => ['duckduckgo', 'ecosia', 'google', 'bing', 'brave', 'startpage'].includes(v),
      theme: (v) => ['light', 'dark', 'green', 'cyan', 'yellow'].includes(v),
      showClock: (v) => typeof v === 'boolean',
      wallpaper: (v) => ['default', 'custom'].includes(v),
      wallpaperCustomPath: (v) => v === null || typeof v === 'string'
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
    // TODO: Apply theme changes
    // TODO: Update search engine
    // TODO: Apply wallpaper changes
    // TODO: Notify all windows of changes
    console.log('TODO: Apply settings to browser');
  }

  // TODO: Add helper methods
  // getSearchEngineUrl(query) - convert search to URL
  // getThemeData() - get current theme configuration
  // getWallpaperPath() - get current wallpaper file path
}

// Create singleton instance
const settingsManager = new SettingsManager();

export default settingsManager;