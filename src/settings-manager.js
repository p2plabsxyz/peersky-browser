// Settings Manager - Main Process
// Handles settings storage, defaults, validation, and IPC communication
// Pattern: Similar to window-manager.js

import { app, ipcMain, BrowserWindow, session } from 'electron';
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
  verticalTabs: false,
  keepTabsExpanded: false,
  wallpaper: 'redwoods',
  wallpaperCustomPath: null
};

class SettingsManager {
  // Backup relevant data files into a zip
  async createBackup({ generateCid = false } = {}) {
    const archiver = require('archiver');
    const { createWriteStream, readFile } = require('fs');
    const { pipeline } = require('stream');
    const util = require('util');
    const pipe = util.promisify(pipeline);
    const USER_DATA = app.getPath('userData');
    const files = [
      'settings.json',
      'ensCache.json',
      'ipfsCache.json',
      'lastOpened.json',
      // Add more as needed (e.g., Hyperdrive index)
    ];
    const backupPath = path.join(USER_DATA, `peersky-backup-${Date.now()}.zip`);
    const output = createWriteStream(backupPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('warning', err => logDebug(`Backup warning: ${err.message}`));
    archive.on('error', err => { throw err; });
    archive.pipe(output);
    for (const file of files) {
      const filePath = path.join(USER_DATA, file);
      try {
        await fs.access(filePath);
        archive.file(filePath, { name: file });
      } catch (e) {
        logDebug(`Backup: File not found, skipping: ${file}`);
      }
    }
    await archive.finalize();
    await new Promise(resolve => output.on('close', resolve));
    let cid = null;
    if (generateCid) {
      // Stub: Integrate with IPFS to add file and get CID
      // cid = await addToIpfs(backupPath);
      logDebug('IPFS CID generation requested (not implemented)');
    }
    return { backupPath, cid };
  }

  // Restore from backup zip file
  async restoreBackup({ zipPath, zipBuffer, fromCid, pastedContent }) {
    const unzipper = require('unzipper');
    const USER_DATA = app.getPath('userData');
    let zipStream;
    if (zipPath) {
      zipStream = require('fs').createReadStream(zipPath);
    } else if (zipBuffer) {
      const { Readable } = require('stream');
      zipStream = Readable.from(zipBuffer);
    } else if (pastedContent) {
      const { Readable } = require('stream');
      zipStream = Readable.from(Buffer.from(pastedContent, 'base64'));
    } else if (fromCid) {
      // Stub: Download from IPFS using CID
      // zipStream = await getFromIpfs(fromCid);
      throw new Error('IPFS restore not implemented');
    } else {
      throw new Error('No backup source provided');
    }
    await zipStream.pipe(unzipper.Extract({ path: USER_DATA })).promise();
    logDebug('Backup restored successfully');
    await this.loadSettings();
    this.applySettings();
    return { success: true };
  }
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
    // Backup handler
    ipcMain.handle('settings-backup', async (event, { generateCid } = {}) => {
      try {
        logDebug('Request: create backup');
        const result = await this.createBackup({ generateCid });
        return result;
      } catch (error) {
        logDebug(`Backup error: ${error.message}`);
        throw error;
      }
    });

    // Restore handler
    ipcMain.handle('settings-restore', async (event, { zipPath, zipBuffer, fromCid, pastedContent }) => {
      try {
        logDebug('Request: restore backup');
        const result = await this.restoreBackup({ zipPath, zipBuffer, fromCid, pastedContent });
        return result;
      } catch (error) {
        logDebug(`Restore error: ${error.message}`);
        throw error;
      }
    });
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
        logDebug('Starting cache clearing operation');
        
        // 1. Clear Electron session data (browser cache, cookies, storage)
        await session.defaultSession.clearStorageData({
          storages: [
            'cookies',
            'localStorage', 
            'sessionStorage',
            'indexedDB',
            'serviceworkers',
            'cachestorage'
          ]
        });
        
        // Clear HTTP cache separately
        await session.defaultSession.clearCache();
        
        logDebug('Electron session data cleared successfully');
        
        // 2. Clear P2P protocol cache files
        const USER_DATA = app.getPath("userData");
        const filesToClear = [
          { path: path.join(USER_DATA, "ensCache.json"), type: "ENS cache" },
          { path: path.join(USER_DATA, "ipfs"), type: "IPFS data" },
          { path: path.join(USER_DATA, "hyper"), type: "Hyper data" }
        ];
        
        // Clear P2P cache files/directories
        for (const { path: filePath, type } of filesToClear) {
          try {
            await fs.rm(filePath, { recursive: true, force: true });
            logDebug(`Cleared ${type}: ${filePath}`);
          } catch (error) {
            if (error.code === 'ENOENT') {
              logDebug(`${type} not found (skipping): ${filePath}`);
            } else {
              logDebug(`Failed to clear ${type}: ${error.message}`);
            }
          }
        }
        
        logDebug('Cache clearing operation completed successfully');
        return { success: true, message: 'Cache cleared successfully' };
        
      } catch (error) {
        const errorMsg = `Failed to clear cache: ${error.message}`;
        logDebug(errorMsg);
        console.error(errorMsg);
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
      searchEngine: (v) => ['duckduckgo', 'ecosia', 'kagi', 'startpage'].includes(v),
      theme: (v) => ['transparent', 'light', 'dark', 'green', 'cyan', 'yellow', 'violet'].includes(v),
      showClock: (v) => typeof v === 'boolean',
      verticalTabs: (v) => typeof v === 'boolean',
      keepTabsExpanded: (v) => typeof v === 'boolean',
      wallpaper: (v) => ['redwoods', 'mountains', 'custom'].includes(v),
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
      'duckduckgo': 'DuckDuckGo',
      'ecosia': 'Ecosia',
      'kagi': 'Kagi',
      'startpage': 'Startpage'
    };
    return engineNames[this.settings.searchEngine] || 'DuckDuckGo';
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

// Create singleton instance
const settingsManager = new SettingsManager();

export default settingsManager;