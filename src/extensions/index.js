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
const { app } = electron;
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { installChromeWebStore } from '@iamevan/electron-chrome-web-store';
import ManifestValidator from './manifest-validator.js';
import { ensureDir, readJsonSafe, writeJsonAtomic, KeyedMutex, ERR } from './util.js';
import ChromeWebStoreManager from './chrome-web-store.js';
import { parseUrlOrId, buildWebStoreUrl } from './url-utils.js';
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
      console.log('ExtensionManager: Initializing extension system...');

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

      // Initialize validator
      this.manifestValidator = new ManifestValidator();

      // Load registry
      await this._readRegistry();

      // Install default extensions if needed
      await this._installDefaultExtensions();

      // Load enabled extensions
      await this._loadExtensionsIntoElectron();

      this.isInitialized = true;
      console.log('ExtensionManager: Extension system initialized successfully');

    } catch (error) {
      console.error('ExtensionManager: Failed to initialize:', error);
      throw error;
    }
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
        
        // Validate manifest
        const validationResult = await this.manifestValidator.validate(extensionData.manifest);
        if (!validationResult.isValid) {
          throw new Error(`Invalid manifest: ${validationResult.errors.join(', ')}`);
        }

        // Save extension metadata
        await this._saveExtensionMetadata(extensionData);

        // Load extension into Electron's extension system
        if (this.session && extensionData.enabled) {
          try {
            console.log(`ExtensionManager: Loading installed extension into Electron: ${extensionData.name}`);
            const electronExtension = await this.session.extensions.loadExtension(extensionData.installedPath, { allowFileAccess: true });
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
              const electronExtension = await this.session.extensions.loadExtension(extension.installedPath, { allowFileAccess: true });
              extension.electronId = electronExtension.id;
            } else {
              if (extension.electronId) {
                await this.session.extensions.removeExtension(extension.electronId);
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
    // TODO: Implement browser action listing
    // This should return extension browser actions for the current window
    return [];
  }

  /**
   * Handle browser action click
   * 
   * @param {string} actionId - Browser action identifier
   * @param {Object} window - Window instance
   */
  async clickBrowserAction(actionId, window) {
    // TODO: Implement browser action click handling
    // This should trigger the extension's browser action click handler
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
        if (this.session) {
          try {
            console.log(`ExtensionManager: Attempting to unload extension from Electron: ${extension.name}`);
            // Note: Electron's session.extensions.removeExtension method needs the Electron extension ID
            // For now, we'll log the action. Future enhancement will track Electron IDs.
            console.log(`ExtensionManager: Extension unload requested: ${extension.name}`);
          } catch (error) {
            console.error(`ExtensionManager: Failed to unload extension from Electron:`, error);
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

        // Parse URL or ID
        const extensionId = parseUrlOrId(urlOrId);
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
              // Use peersky protocol which works reliably in renderer
              iconPath = `peersky://extension-icon/${extensionId}/${size}`;
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
          webStoreUrl: buildWebStoreUrl(extensionId),
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

        // For MVP, we'll use the Chrome Web Store's bulk update
        await this.chromeWebStore.updateAll();
        
        // Re-read registry to get updated versions
        // Note: This is a simplified implementation for MVP
        await this._readRegistry();
        
        console.log('ExtensionManager: Extension update check completed');
        return {
          updated: [], // Chrome Web Store doesn't provide detailed results
          skipped: [],
          errors: []
        };
        
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
                  await this.session.extensions.removeExtension(extension.electronId);
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
          
          // Fix legacy icon paths to use peersky:// protocol
          if (extensionData.iconPath && (extensionData.iconPath.startsWith('file://') || extensionData.iconPath.startsWith('chrome-extension://'))) {
            const icons = extensionData.manifest?.icons;
            if (icons) {
              const iconSizes = ['64', '48', '32', '16'];
              for (const size of iconSizes) {
                if (icons[size]) {
                  extensionData.iconPath = `peersky://extension-icon/${extensionData.id}/${size}`;
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
            const electronExtension = await this.session.extensions.loadExtension(extension.installedPath, { allowFileAccess: true });
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
   * Install default extensions if they haven't been installed yet
   */
  async _installDefaultExtensions() {
    const defaultExtensions = [
      {
        id: 'eimadpbcbfnmbkopoojfekhnkhdbieeh', // Dark Reader
        name: 'Dark Reader',
        reason: 'Popular dark mode extension for better reading experience'
      }
    ];

    console.log('ExtensionManager: Checking for default extensions to install...');
    
    for (const defaultExt of defaultExtensions) {
      // Check if extension is already installed
      if (this.loadedExtensions.has(defaultExt.id)) {
        console.log(`ExtensionManager: Default extension '${defaultExt.name}' already installed`);
        continue;
      }

      try {
        console.log(`ExtensionManager: Installing default extension: ${defaultExt.name} (${defaultExt.reason})`);
        const result = await this.installFromWebStore(defaultExt.id);
        
        if (result.success) {
          console.log(`ExtensionManager: Successfully installed default extension: ${defaultExt.name}`);
        } else {
          console.warn(`ExtensionManager: Failed to install default extension ${defaultExt.name}: ${result.error}`);
        }
      } catch (error) {
        console.warn(`ExtensionManager: Error installing default extension ${defaultExt.name}:`, error);
        // Don't throw - continue with other extensions and startup
      }
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
   * Prepare extension from directory
   */
  async _prepareFromDirectory(dirPath) {
    const manifestPath = path.join(dirPath, 'manifest.json');
    const stats = await fs.stat(manifestPath).catch(() => null);
    if (!stats) {
      throw new Error('No manifest.json found in extension directory');
    }

    const manifestContent = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestContent);
    const extensionId = manifest.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    
    // Copy extension to extensions directory
    const targetPath = path.join(this.extensionsBaseDir, extensionId);
    await fs.cp(dirPath, targetPath, { recursive: true });

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