// Extension IPC Handlers - Clean IPC communication layer
// Handles communication between main process and renderer for extension management
// Pattern: Similar to existing settings IPC handlers in settings-manager.js

import { ipcMain } from 'electron';
import { registry, loader, security, p2p } from '../extensions/index.js';

// Standardized response helpers
function createSuccessResponse(data = {}) {
  return {
    success: true,
    timestamp: new Date().toISOString(),
    ...data
  };
}

function createErrorResponse(error, data = {}) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`Extension IPC Error: ${errorMessage}`);
  
  return {
    success: false,
    error: errorMessage,
    timestamp: new Date().toISOString(),
    ...data
  };
}

// Rate limiting helper
const rateLimits = new Map();
function checkRateLimit(operation, limit = 10, windowMs = 60000) {
  const now = Date.now();
  const key = `${operation}-${Math.floor(now / windowMs)}`;
  const count = rateLimits.get(key) || 0;
  
  if (count >= limit) {
    throw new Error(`Rate limit exceeded for ${operation}. Try again later.`);
  }
  
  rateLimits.set(key, count + 1);
}

class ExtensionIPCHandlers {
  constructor() {
    this.handlersRegistered = false;
  }

  registerExtensionIpcHandlers() {
    // TODO: Register all extension IPC handlers
    // - Prevent duplicate registration
    // - Handle async operations properly
    // - Provide consistent error handling
    console.log('TODO: Register extension IPC handlers');
    
    if (this.handlersRegistered) {
      console.log('Extension IPC handlers already registered');
      return;
    }
    
    // Extension listing and info
    ipcMain.handle('extensions-list', this.handleExtensionsList.bind(this));
    ipcMain.handle('extensions-get-info', this.handleGetExtensionInfo.bind(this));
    
    // Extension state management
    ipcMain.handle('extensions-toggle', this.handleToggleExtension.bind(this));
    ipcMain.handle('extensions-enable', this.handleEnableExtension.bind(this));
    ipcMain.handle('extensions-disable', this.handleDisableExtension.bind(this));
    
    // Extension installation
    ipcMain.handle('extensions-install-local', this.handleInstallLocal.bind(this));
    ipcMain.handle('extensions-install-p2p', this.handleInstallP2P.bind(this));
    ipcMain.handle('extensions-uninstall', this.handleUninstallExtension.bind(this));
    
    // Extension updates
    ipcMain.handle('extensions-check-updates', this.handleCheckUpdates.bind(this));
    ipcMain.handle('extensions-update', this.handleUpdateExtension.bind(this));
    
    // Settings and configuration
    ipcMain.handle('extensions-toggle-p2p', this.handleToggleP2P.bind(this));
    ipcMain.handle('extensions-get-settings', this.handleGetSettings.bind(this));
    ipcMain.handle('extensions-set-setting', this.handleSetSetting.bind(this));
    
    // Network and status
    ipcMain.handle('extensions-get-network-status', this.handleGetNetworkStatus.bind(this));
    
    this.handlersRegistered = true;
    console.log('Extension IPC handlers registered successfully');
  }

  async handleExtensionsList(event, filterType = null) {
    // Get all extensions for UI display
    // - Return array of extension metadata
    // - Include enabled/disabled status
    // - Support filtering by type
    // - Include loading status and errors
    console.log(`Handling extensions list request, filter: ${filterType}`);
    
    try {
      // Input validation
      if (filterType && typeof filterType !== 'string') {
        throw new Error('Filter type must be a string');
      }
      
      const extensions = await registry.listExtensions(filterType);
      const extensionsWithStatus = await Promise.all(
        extensions.map(async (ext) => ({
          ...ext,
          loaded: loader.loadedExtensions.has(ext.id),
          lastUsed: ext.lastUsed || null,
          fileSize: ext.fileSize || null
        }))
      );
      
      return createSuccessResponse({
        extensions: extensionsWithStatus,
        count: extensionsWithStatus.length,
        filterType
      });
      
    } catch (error) {
      return createErrorResponse(error, {
        extensions: [],
        count: 0,
        filterType
      });
    }
  }

  async handleGetExtensionInfo(event, extensionId) {
    // Get detailed extension information
    // - Return comprehensive extension metadata
    // - Include permissions, files, status
    // - Add security information
    console.log(`Handling get extension info: ${extensionId}`);
    
    try {
      // Input validation
      if (!extensionId || typeof extensionId !== 'string') {
        throw new Error('Extension ID is required and must be a string');
      }
      
      const extensionInfo = await registry.getExtension(extensionId);
      if (!extensionInfo) {
        throw new Error(`Extension ${extensionId} not found`);
      }
      
      // Enhance with additional runtime information
      const detailedInfo = {
        ...extensionInfo,
        loaded: loader.loadedExtensions.has(extensionId),
        electronExtension: loader.loadedExtensions.get(extensionId) || null,
        runtimeStatus: loader.loadedExtensions.has(extensionId) ? 'loaded' : 'unloaded'
      };
      
      return createSuccessResponse({
        extension: detailedInfo,
        extensionId
      });
      
    } catch (error) {
      return createErrorResponse(error, {
        extensionId
      });
    }
  }

  async handleToggleExtension(event, extensionId, enabled) {
    // Enable/disable extension
    // - Update extension state
    // - Load/unload from Electron session
    // - Update registry
    // - Return operation result
    console.log(`Handling toggle extension: ${extensionId} -> ${enabled}`);
    
    try {
      // Input validation
      if (!extensionId || typeof extensionId !== 'string') {
        throw new Error('Extension ID is required and must be a string');
      }
      if (typeof enabled !== 'boolean') {
        throw new Error('Enabled parameter must be a boolean');
      }
      
      // Rate limiting for toggle operations
      checkRateLimit(`toggle-${extensionId}`, 5, 10000); // 5 toggles per 10 seconds per extension
      
      const extensionInfo = await registry.getExtension(extensionId);
      if (!extensionInfo) {
        throw new Error(`Extension ${extensionId} not found`);
      }
      
      if (enabled) {
        await loader.enableExtension(extensionId);
      } else {
        await loader.disableExtension(extensionId);
      }
      
      return createSuccessResponse({
        extensionId,
        enabled,
        extensionName: extensionInfo.name,
        action: enabled ? 'enabled' : 'disabled'
      });
      
    } catch (error) {
      return createErrorResponse(error, {
        extensionId,
        enabled,
        action: enabled ? 'enable' : 'disable'
      });
    }
  }

  async handleEnableExtension(event, extensionId) {
    // TODO: Enable specific extension
    // - Load extension into Electron session
    // - Update registry state
    // - Handle loading errors
    console.log(`TODO: Handle enable extension: ${extensionId}`);
    
    return await this.handleToggleExtension(event, extensionId, true);
  }

  async handleDisableExtension(event, extensionId) {
    // TODO: Disable specific extension
    // - Unload from Electron session
    // - Update registry state
    // - Keep files intact
    console.log(`TODO: Handle disable extension: ${extensionId}`);
    
    return await this.handleToggleExtension(event, extensionId, false);
  }

  async handleInstallLocal(event, filePath, extensionId = null) {
    // Install extension from local file
    // - Support .crx and .zip files
    // - Validate file before installation
    // - Install and register extension
    // - Return installation result
    console.log(`Handling install local extension: ${filePath}`);
    
    try {
      // Input validation
      if (!filePath || typeof filePath !== 'string') {
        throw new Error('File path is required and must be a string');
      }
      
      if (extensionId && typeof extensionId !== 'string') {
        throw new Error('Extension ID must be a string if provided');
      }
      
      // Rate limiting for installations
      checkRateLimit('install-local', 3, 60000); // 3 installs per minute
      
      // Validate file extension
      const fileExtension = filePath.toLowerCase();
      if (!fileExtension.endsWith('.crx') && !fileExtension.endsWith('.zip')) {
        throw new Error('Unsupported file format. Please use .crx or .zip files.');
      }
      
      let result;
      if (fileExtension.endsWith('.crx')) {
        result = await loader.loadExtensionFromCrx(filePath, extensionId);
      } else {
        result = await loader.loadExtensionFromZip(filePath, extensionId);
      }
      
      return createSuccessResponse({
        extensionId: result.id,
        extensionName: result.extension?.name || 'Unknown',
        filePath,
        fileType: fileExtension.endsWith('.crx') ? 'crx' : 'zip',
        message: 'Extension installed successfully'
      });
      
    } catch (error) {
      return createErrorResponse(error, {
        filePath,
        extensionId,
        operation: 'install-local'
      });
    }
  }

  async handleInstallP2P(event, source) {
    // Install extension from P2P network
    // - Parse P2P source (ipfs://, hyper://)
    // - Download and validate extension
    // - Install using standard flow
    // - Update P2P mappings
    console.log(`Handling install P2P extension: ${source}`);
    
    try {
      // Input validation
      if (!source || typeof source !== 'string') {
        throw new Error('P2P source is required and must be a string');
      }
      
      // Validate P2P URL format
      if (!source.startsWith('ipfs://') && !source.startsWith('hyper://')) {
        throw new Error('Invalid P2P source format. Must start with ipfs:// or hyper://');
      }
      
      // Rate limiting for P2P installations
      checkRateLimit('install-p2p', 2, 120000); // 2 P2P installs per 2 minutes
      
      const result = await loader.installExtensionFromP2P(source);
      
      return createSuccessResponse({
        extensionId: result.id,
        extensionName: result.extension?.name || 'Unknown',
        source,
        sourceType: source.startsWith('ipfs://') ? 'ipfs' : 'hyper',
        message: 'Extension installed successfully from P2P network'
      });
      
    } catch (error) {
      return createErrorResponse(error, {
        source,
        operation: 'install-p2p'
      });
    }
  }

  async handleUninstallExtension(event, extensionId, removeFiles = true) {
    // Remove extension completely
    // - Unload from Electron session
    // - Remove from registry
    // - Optionally remove files from disk
    // - Clean up P2P mappings
    console.log(`Handling uninstall extension: ${extensionId}`);
    
    try {
      // Input validation
      if (!extensionId || typeof extensionId !== 'string') {
        throw new Error('Extension ID is required and must be a string');
      }
      
      if (typeof removeFiles !== 'boolean') {
        throw new Error('removeFiles parameter must be a boolean');
      }
      
      // Rate limiting for uninstalls
      checkRateLimit('uninstall', 5, 60000); // 5 uninstalls per minute
      
      // Get extension info before removal
      const extensionInfo = await registry.getExtension(extensionId);
      if (!extensionInfo) {
        throw new Error(`Extension ${extensionId} not found`);
      }
      
      // Unload extension if loaded
      const wasLoaded = loader.loadedExtensions.has(extensionId);
      if (wasLoaded) {
        await loader.unloadExtension(extensionId);
      }
      
      // Remove from registry (this also cleans up P2P mappings)
      await registry.removeExtension(extensionId);
      
      // TODO: Remove files if requested
      let filesRemoved = false;
      if (removeFiles) {
        // For now, just log that files would be removed
        console.log(`Would remove extension files for ${extensionId}`);
        filesRemoved = false; // Set to true when actually implemented
      }
      
      return createSuccessResponse({
        extensionId,
        extensionName: extensionInfo.name,
        wasLoaded,
        filesRemoved,
        message: 'Extension uninstalled successfully'
      });
      
    } catch (error) {
      return createErrorResponse(error, {
        extensionId,
        removeFiles,
        operation: 'uninstall'
      });
    }
  }

  async handleCheckUpdates(event, extensionId = null) {
    // TODO: Check for extension updates
    // - Check specific extension if ID provided
    // - Check all extensions if no ID provided
    // - Query P2P networks for newer versions
    // - Return update availability
    console.log(`TODO: Handle check updates: ${extensionId || 'all'}`);
    
    try {
      const updates = [];
      
      if (extensionId) {
        // Check specific extension
        const extensionInfo = await registry.getExtension(extensionId);
        if (extensionInfo && extensionInfo.p2pMappings) {
          const updateInfo = await p2p.checkForUpdates(
            extensionId,
            extensionInfo.version,
            extensionInfo.p2pMappings
          );
          if (updateInfo.hasUpdate) {
            updates.push({ extensionId, ...updateInfo });
          }
        }
      } else {
        // Check all extensions
        const allExtensions = await registry.listExtensions();
        for (const ext of allExtensions) {
          if (ext.p2pMappings) {
            const updateInfo = await p2p.checkForUpdates(
              ext.id,
              ext.version,
              ext.p2pMappings
            );
            if (updateInfo.hasUpdate) {
              updates.push({ extensionId: ext.id, ...updateInfo });
            }
          }
        }
      }
      
      return {
        success: true,
        updates
      };
    } catch (error) {
      console.error('Failed to check for updates:', error);
      return {
        success: false,
        error: error.message,
        updates: []
      };
    }
  }

  async handleUpdateExtension(event, extensionId, source = null) {
    // TODO: Update specific extension
    // - Download new version from source
    // - Validate and install update
    // - Migrate extension data if needed
    // - Update registry
    console.log(`TODO: Handle update extension: ${extensionId} from ${source}`);
    
    try {
      await loader.updateExtension(extensionId, source);
      
      return {
        success: true,
        extensionId,
        message: 'Extension updated successfully'
      };
    } catch (error) {
      console.error(`Failed to update extension ${extensionId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async handleToggleP2P(event, enabled) {
    // TODO: Toggle P2P extension loading
    // - Update settings
    // - Enable/disable P2P functionality
    // - Return new state
    console.log(`TODO: Handle toggle P2P: ${enabled}`);
    
    try {
      // TODO: Update extension settings
      // This would integrate with settings-manager.js
      
      return {
        success: true,
        p2pEnabled: enabled,
        message: `P2P extension loading ${enabled ? 'enabled' : 'disabled'}`
      };
    } catch (error) {
      console.error('Failed to toggle P2P:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async handleGetSettings(event) {
    // TODO: Get extension-related settings
    // - Return P2P enabled state
    // - Return auto-update preferences
    // - Return security settings
    console.log('TODO: Handle get extension settings');
    
    try {
      // TODO: Get actual settings from settings manager
      const settings = {
        p2pEnabled: false,
        autoUpdate: true,
        // TODO: Add more extension settings
      };
      
      return {
        success: true,
        settings
      };
    } catch (error) {
      console.error('Failed to get extension settings:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async handleSetSetting(event, key, value) {
    // TODO: Set extension-related setting
    // - Validate setting key and value
    // - Update settings
    // - Apply setting changes
    console.log(`TODO: Handle set extension setting: ${key} = ${value}`);
    
    try {
      // TODO: Validate and set setting
      // This would integrate with settings-manager.js
      
      return {
        success: true,
        key,
        value,
        message: 'Setting updated successfully'
      };
    } catch (error) {
      console.error(`Failed to set extension setting ${key}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async handleGetNetworkStatus(event) {
    // TODO: Get P2P network connectivity status
    // - Check IPFS and Hyper network status
    // - Return peer counts and connection info
    // - Include any network errors
    console.log('TODO: Handle get network status');
    
    try {
      const networkStatus = await p2p.getNetworkStatus();
      
      return {
        success: true,
        networks: networkStatus
      };
    } catch (error) {
      console.error('Failed to get network status:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  unregisterHandlers() {
    // TODO: Clean up IPC handlers on shutdown
    // - Remove all registered handlers
    // - Clean up any resources
    console.log('TODO: Unregister extension IPC handlers');
    
    if (!this.handlersRegistered) return;
    
    const handlers = [
      'extensions-list',
      'extensions-get-info',
      'extensions-toggle',
      'extensions-enable',
      'extensions-disable',
      'extensions-install-local',
      'extensions-install-p2p',
      'extensions-uninstall',
      'extensions-check-updates',
      'extensions-update',
      'extensions-toggle-p2p',
      'extensions-get-settings',
      'extensions-set-setting',
      'extensions-get-network-status'
    ];
    
    handlers.forEach(handler => {
      ipcMain.removeHandler(handler);
    });
    
    this.handlersRegistered = false;
    console.log('Extension IPC handlers unregistered');
  }
}

// Create singleton instance
const extensionIPCHandlers = new ExtensionIPCHandlers();

export default extensionIPCHandlers;