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

import { app, session } from 'electron';
import path from 'path';
import fs from 'fs-extra';
import ManifestValidator from './manifest-validator.js';

// Import IPC handlers
import { setupExtensionIpcHandlers } from '../ipc-handlers/extensions.js';

const EXTENSIONS_DATA_PATH = path.join(app.getPath('userData'), 'extensions');
const EXTENSIONS_METADATA_FILE = path.join(EXTENSIONS_DATA_PATH, 'extensions.json');

/**
 * ExtensionManager - Main extension management class
 * 
 * Handles all extension operations including installation, validation,
 * lifecycle management, and integration with Electron's extension system.
 */
class ExtensionManager {
  constructor(config = {}) {
    this.config = {
      extensionsEnabled: true,
      extensionMaxSize: 10 * 1024 * 1024, // 10MB
      extensionDevMode: false,
      ...config
    };
    
    this.isInitialized = false;
    this.loadedExtensions = new Map(); // extensionId -> extension metadata
    this.manifestValidator = null;
    this.initializationPromise = null;
    
    // TODO: Add Electron session reference for extension loading
    this.session = null;
    
    // TODO: Add browser action management
    this.browserActions = new Map();
  }

  /**
   * Initialize the extension system
   * 
   * Sets up extension directories, manifest validator, loads existing extensions,
   * and integrates with Electron's extension system.
   * 
   * @param {Electron.Session} electronSession - Electron session for extension loading
   */
  async initialize(electronSession) {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this._doInitialize(electronSession);
    return this.initializationPromise;
  }

  async _doInitialize(electronSession) {
    try {
      console.log('ExtensionManager: Initializing extension system...');

      // Create extension directories
      await fs.ensureDir(EXTENSIONS_DATA_PATH);

      // Initialize manifest validator
      this.manifestValidator = new ManifestValidator();

      // Get Electron session reference
      this.session = electronSession || session.defaultSession;

      // Load existing extensions from metadata
      await this._loadExtensionsFromMetadata();

      // Load extensions into Electron's extension system
      await this._loadExtensionsIntoElectron();

      // Set up IPC handlers for UI communication
      setupExtensionIpcHandlers(this);

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
          const electronExtension = await this.session.loadExtension(extensionData.path);
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
  }

  /**
   * Enable or disable an extension
   * 
   * @param {string} extensionId - Extension identifier
   * @param {boolean} enabled - Whether to enable or disable
   * @returns {Promise<boolean>} Success status
   */
  async toggleExtension(extensionId, enabled) {
    await this.initialize();
    
    try {
      const extension = this.loadedExtensions.get(extensionId);
      if (!extension) {
        throw new Error(`Extension not found: ${extensionId}`);
      }

      extension.enabled = enabled;
      await this._saveExtensionMetadata(extension);

      // Enable/disable extension in Electron's system
      if (this.session) {
        try {
          if (enabled) {
            console.log(`ExtensionManager: Loading extension into Electron: ${extension.name}`);
            await this.session.loadExtension(extension.path);
            console.log(`ExtensionManager: Extension loaded in Electron: ${extension.name}`);
          } else {
            console.log(`ExtensionManager: Removing extension from Electron: ${extension.name}`);
            // Note: Electron doesn't provide removeExtension by extension ID directly
            // We'll need to track Electron extension IDs separately in a future enhancement
            console.log(`ExtensionManager: Extension disable requested: ${extension.name}`);
          }
        } catch (error) {
          console.error(`ExtensionManager: Failed to toggle extension in Electron:`, error);
        }
      }

      console.log(`ExtensionManager: Extension ${enabled ? 'enabled' : 'disabled'}:`, extensionId);
      return true;
      
    } catch (error) {
      console.error('ExtensionManager: Toggle failed:', error);
      throw error;
    }
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
          // Note: Electron's removeExtension method needs the Electron extension ID
          // For now, we'll log the action. Future enhancement will track Electron IDs.
          console.log(`ExtensionManager: Extension unload requested: ${extension.name}`);
        } catch (error) {
          console.error(`ExtensionManager: Failed to unload extension from Electron:`, error);
        }
      }

      // Remove extension files
      const extensionPath = path.join(EXTENSIONS_DATA_PATH, extensionId);
      await fs.remove(extensionPath);

      // Remove from loaded extensions
      this.loadedExtensions.delete(extensionId);

      // Update metadata file
      await this._saveAllExtensionMetadata();

      console.log('ExtensionManager: Extension uninstalled:', extensionId);
      return true;
      
    } catch (error) {
      console.error('ExtensionManager: Uninstall failed:', error);
      throw error;
    }
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
        // Save final extension metadata
        await this._saveAllExtensionMetadata();
        
        // Unload all extensions from Electron's system
        if (this.session) {
          try {
            console.log('ExtensionManager: Unloading all extensions from Electron...');
            // Note: Future enhancement will track and properly remove Electron extensions
            for (const extension of this.loadedExtensions.values()) {
              console.log(`ExtensionManager: Extension shutdown requested: ${extension.name}`);
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
   * Load extensions from metadata file
   */
  async _loadExtensionsFromMetadata() {
    try {
      if (await fs.pathExists(EXTENSIONS_METADATA_FILE)) {
        const metadata = await fs.readJson(EXTENSIONS_METADATA_FILE);
        for (const extensionData of metadata.extensions || []) {
          this.loadedExtensions.set(extensionData.id, extensionData);
        }
        console.log(`ExtensionManager: Loaded ${this.loadedExtensions.size} extensions from metadata`);
      }
    } catch (error) {
      console.error('ExtensionManager: Failed to load extension metadata:', error);
    }
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
        if (extension.enabled && extension.path) {
          try {
            console.log(`ExtensionManager: Loading extension into Electron: ${extension.name}`);
            const electronExtension = await this.session.loadExtension(extension.path);
            console.log(`ExtensionManager: Extension loaded successfully: ${extension.name} (${electronExtension.id})`);
          } catch (error) {
            console.error(`ExtensionManager: Failed to load extension ${extension.name}:`, error);
          }
        }
      }
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
   * Prepare extension from directory
   */
  async _prepareFromDirectory(dirPath) {
    const manifestPath = path.join(dirPath, 'manifest.json');
    if (!await fs.pathExists(manifestPath)) {
      throw new Error('No manifest.json found in extension directory');
    }

    const manifest = await fs.readJson(manifestPath);
    const extensionId = manifest.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    
    // Copy extension to extensions directory
    const targetPath = path.join(EXTENSIONS_DATA_PATH, extensionId);
    await fs.copy(dirPath, targetPath);

    return {
      id: extensionId,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      manifest,
      path: targetPath,
      enabled: true,
      installDate: new Date().toISOString()
    };
  }

  /**
   * Prepare extension from ZIP/CRX archive
   */
  async _prepareFromArchive(archivePath) {
    // TODO: Implement ZIP/CRX extraction
    // For now, throw error indicating this needs implementation
    throw new Error('ZIP/CRX installation not yet implemented - use directory installation');
  }

  /**
   * Save extension metadata
   */
  async _saveExtensionMetadata(extensionData) {
    this.loadedExtensions.set(extensionData.id, extensionData);
    await this._saveAllExtensionMetadata();
  }

  /**
   * Save all extension metadata to file
   */
  async _saveAllExtensionMetadata() {
    const metadata = {
      version: '1.0.0',
      extensions: Array.from(this.loadedExtensions.values())
    };
    await fs.writeJson(EXTENSIONS_METADATA_FILE, metadata, { spaces: 2 });
  }
}

// Create singleton instance
const extensionManager = new ExtensionManager();

// Export individual components for direct use if needed
export {
  ManifestValidator,
  setupExtensionIpcHandlers
};

// Export singleton manager instance as default
export default extensionManager;

// Export manager instance with explicit name for clarity
export { extensionManager };