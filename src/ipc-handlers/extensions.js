/**
 * Extension IPC Handlers - Extension System Communication
 * 
 * This module provides IPC handlers for extension operations,
 * enabling communication between the main process and renderer
 * for extension management functionality.
 * 
 * Key Features:
 * - Extension listing and information retrieval
 * - Extension installation from local sources
 * - Extension enable/disable operations
 * - Extension uninstallation
 * - Error handling and validation
 * 
 * Implementation Approach:
 * - Direct integration with ExtensionManager
 * - Comprehensive input validation
 * - Detailed error reporting
 * - Secure IPC communication
 * - Performance-optimized handlers
 */

import electron from 'electron';
const { ipcMain, BrowserWindow } = electron;
import { ERR } from '../extensions/util.js';

/**
 * Setup extension IPC handlers
 * 
 * Registers all IPC handlers for extension management operations,
 * providing secure communication between main and renderer processes.
 * 
 * @param {ExtensionManager} extensionManager - Extension manager instance
 */
export function setupExtensionIpcHandlers(extensionManager) {
  console.log('ExtensionIPC: Setting up extension IPC handlers...');

  try {
    // List all installed extensions
    ipcMain.handle('extensions-list', async () => {
      try {
        const extensions = await extensionManager.listExtensions();
        return { success: true, extensions };
      } catch (error) {
        return {
          success: false,
          code: error.code || 'E_UNKNOWN',
          error: error.message
        };
      }
    });

    // Install extension from local path
    ipcMain.handle('extensions-install', async (event, sourcePath) => {
      try {
        if (!sourcePath || typeof sourcePath !== 'string') {
          throw Object.assign(new Error('Invalid source path'), { code: ERR.E_INVALID_ID });
        }

        const result = await extensionManager.installExtension(sourcePath);
        return { success: true, ...result };
      } catch (error) {
        return {
          success: false,
          code: error.code || 'E_UNKNOWN',
          error: error.message
        };
      }
    });

    // Toggle extension enabled/disabled state
    ipcMain.handle('extensions-toggle', async (event, extensionId, enabled) => {
      try {
        if (!extensionId || typeof extensionId !== 'string') {
          throw Object.assign(new Error('Invalid extension ID'), { code: ERR.E_INVALID_ID });
        }
        if (typeof enabled !== 'boolean') {
          throw Object.assign(new Error('Enabled status must be boolean'), { code: ERR.E_INVALID_ID });
        }

        const result = await extensionManager.toggleExtension(extensionId, enabled);
        return { success: true, result };
      } catch (error) {
        return {
          success: false,
          code: error.code || 'E_UNKNOWN',
          error: error.message
        };
      }
    });

    // Uninstall extension
    ipcMain.handle('extensions-uninstall', async (event, extensionId) => {
      try {
        if (!extensionId || typeof extensionId !== 'string') {
          throw Object.assign(new Error('Invalid extension ID'), { code: ERR.E_INVALID_ID });
        }

        const result = await extensionManager.uninstallExtension(extensionId);
        return { success: true, result };
      } catch (error) {
        return {
          success: false,
          code: error.code || 'E_UNKNOWN',
          error: error.message
        };
      }
    });

    // Get extension system status
    ipcMain.handle('extensions-status', async () => {
      try {
        const status = extensionManager.getStatus();
        return { success: true, status };
      } catch (error) {
        return {
          success: false,
          code: error.code || 'E_UNKNOWN',
          error: error.message
        };
      }
    });

    // TODO: Add missing extension IPC handlers
    // Get extension info
    ipcMain.handle('extensions-get-info', async (event, extensionId) => {
      try {
        if (!extensionId || typeof extensionId !== 'string') {
          throw Object.assign(new Error('Invalid extension ID'), { code: ERR.E_INVALID_ID });
        }

        const extensions = await extensionManager.listExtensions();
        const extension = extensions.find(ext => ext.id === extensionId);
        
        if (!extension) {
          throw Object.assign(new Error('Extension not found'), { code: ERR.E_INVALID_ID });
        }

        return { success: true, extension };
      } catch (error) {
        return {
          success: false,
          code: error.code || 'E_UNKNOWN',
          error: error.message
        };
      }
    });

    // Install extension from Chrome Web Store URL or ID
    ipcMain.handle('extensions-install-webstore', async (event, urlOrId) => {
      try {
        if (!urlOrId || typeof urlOrId !== 'string') {
          throw Object.assign(new Error('Invalid Chrome Web Store URL or ID'), { code: ERR.E_INVALID_URL });
        }

        const result = await extensionManager.installFromWebStore(urlOrId);
        return { success: true, id: result.extension.id, extension: result.extension };
      } catch (error) {
        return {
          success: false,
          code: error.code || 'E_UNKNOWN',
          error: error.message
        };
      }
    });

    // Update all extensions
    ipcMain.handle('extensions-update-all', async () => {
      try {
        const result = await extensionManager.updateAllExtensions();
        return { success: true, ...result };
      } catch (error) {
        return {
          success: false,
          code: error.code || 'E_UNKNOWN',
          error: error.message,
          updated: [],
          skipped: [],
          errors: []
        };
      }
    });

    // Get extension icon URL via peersky protocol
    ipcMain.handle('extensions-get-icon-url', async (event, extensionId, size = '64') => {
      try {
        if (!extensionId || typeof extensionId !== 'string') {
          throw Object.assign(new Error('Invalid extension ID'), { code: ERR.E_INVALID_ID });
        }

        const extensions = await extensionManager.listExtensions();
        const extension = extensions.find(ext => ext.id === extensionId);
        
        if (!extension) {
          throw Object.assign(new Error('Extension not found'), { code: ERR.E_INVALID_ID });
        }

        // Validate size parameter
        const validSizes = ['16', '32', '48', '64', '128'];
        const iconSize = validSizes.includes(size) ? size : '64';

        // Return peersky protocol URL for extension icon
        const iconUrl = `peersky://extension-icon/${extensionId}/${iconSize}`;
        
        return { success: true, iconUrl };
      } catch (error) {
        return {
          success: false,
          code: error.code || 'E_UNKNOWN',
          error: error.message,
          iconUrl: null
        };
      }
    });

    // Clean up registry by removing entries with missing directories
    ipcMain.handle('extensions-cleanup-registry', async () => {
      try {
        const result = await extensionManager.validateAndCleanRegistry();
        return { success: true, ...result };
      } catch (error) {
        return {
          success: false,
          code: error.code || 'E_UNKNOWN',
          error: error.message,
          initialCount: 0,
          finalCount: 0,
          removedCount: 0,
          removedExtensions: []
        };
      }
    });

    // TODO: Add extension update checking
    // ipcMain.handle('extensions-check-updates', async () => {
    //   try {
    //     // TODO: Implement extension update checking
    //     return { success: true, updates: [] };
    //   } catch (error) {
    //     console.error('ExtensionIPC: extensions-check-updates failed:', error);
    //     return { success: false, error: error.message };
    //   }
    // });

    // TODO: Add P2P extension toggle
    // ipcMain.handle('extensions-toggle-p2p', async (event, enabled) => {
    //   try {
    //     // TODO: Implement P2P extension toggle
    //     return { success: true };
    //   } catch (error) {
    //     console.error('ExtensionIPC: extensions-toggle-p2p failed:', error);
    //     return { success: false, error: error.message };
    //   }
    // });

    // List browser actions for current window
    ipcMain.handle('extensions-list-browser-actions', async (event) => {
      try {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const actions = await extensionManager.listBrowserActions(senderWindow);
        return { success: true, actions };
      } catch (error) {
        console.error('ExtensionIPC: extensions-list-browser-actions failed:', error);
        return { 
          success: false, 
          code: error.code || 'E_UNKNOWN',
          error: error.message,
          actions: []
        };
      }
    });

    // Handle browser action click
    ipcMain.handle('extensions-click-browser-action', async (event, actionId) => {
      try {
        if (!actionId || typeof actionId !== 'string') {
          throw Object.assign(new Error('Invalid action ID'), { code: ERR.E_INVALID_ID });
        }

        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        await extensionManager.clickBrowserAction(actionId, senderWindow);
        return { success: true };
      } catch (error) {
        console.error('ExtensionIPC: extensions-click-browser-action failed:', error);
        return {
          success: false,
          code: error.code || 'E_UNKNOWN', 
          error: error.message
        };
      }
    });

    // Handle browser action popup (NEW - matches existing patterns)
    ipcMain.handle('extensions-open-browser-action-popup', async (event, { actionId, anchorRect }) => {
      try {
        if (!actionId || typeof actionId !== 'string') {
          throw Object.assign(new Error('Invalid action ID'), { code: ERR.E_INVALID_ID });
        }

        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        
        // Validate anchorRect has required fields
        const safeRect = anchorRect && typeof anchorRect === 'object' ? {
          x: Number(anchorRect.x) || 100,
          y: Number(anchorRect.y) || 40,
          width: Number(anchorRect.width) || 20,
          height: Number(anchorRect.height) || 20,
          left: Number(anchorRect.left) || 100,
          top: Number(anchorRect.top) || 40,
          right: Number(anchorRect.right) || 120,
          bottom: Number(anchorRect.bottom) || 60
        } : { x: 100, y: 40, width: 20, height: 20, left: 100, top: 40, right: 120, bottom: 60 };
        
        const result = await extensionManager.openBrowserActionPopup(actionId, senderWindow, safeRect);
        return result || { success: true };
      } catch (error) {
        console.error('ExtensionIPC: extensions-open-browser-action-popup failed:', error);
        return { success: false, error: error.message };
      }
    });

    console.log('ExtensionIPC: Extension IPC handlers registered successfully');
    
  } catch (error) {
    console.error('ExtensionIPC: Failed to register IPC handlers:', error);
    throw error;
  }
}

