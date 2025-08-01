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

import { ipcMain } from 'electron';

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
        console.error('ExtensionIPC: extensions-list failed:', error);
        return { success: false, error: error.message };
      }
    });

    // Install extension from local path
    ipcMain.handle('extensions-install', async (event, sourcePath) => {
      try {
        if (!sourcePath || typeof sourcePath !== 'string') {
          throw new Error('Invalid source path');
        }

        const result = await extensionManager.installExtension(sourcePath);
        return { success: true, ...result };
      } catch (error) {
        console.error('ExtensionIPC: extensions-install failed:', error);
        return { success: false, error: error.message };
      }
    });

    // Toggle extension enabled/disabled state
    ipcMain.handle('extensions-toggle', async (event, extensionId, enabled) => {
      try {
        if (!extensionId || typeof extensionId !== 'string') {
          throw new Error('Invalid extension ID');
        }
        if (typeof enabled !== 'boolean') {
          throw new Error('Enabled status must be boolean');
        }

        const result = await extensionManager.toggleExtension(extensionId, enabled);
        return { success: true, result };
      } catch (error) {
        console.error('ExtensionIPC: extensions-toggle failed:', error);
        return { success: false, error: error.message };
      }
    });

    // Uninstall extension
    ipcMain.handle('extensions-uninstall', async (event, extensionId) => {
      try {
        if (!extensionId || typeof extensionId !== 'string') {
          throw new Error('Invalid extension ID');
        }

        const result = await extensionManager.uninstallExtension(extensionId);
        return { success: true, result };
      } catch (error) {
        console.error('ExtensionIPC: extensions-uninstall failed:', error);
        return { success: false, error: error.message };
      }
    });

    // Get extension system status
    ipcMain.handle('extensions-status', async () => {
      try {
        const status = extensionManager.getStatus();
        return { success: true, status };
      } catch (error) {
        console.error('ExtensionIPC: extensions-status failed:', error);
        return { success: false, error: error.message };
      }
    });

    // TODO: Add missing extension IPC handlers
    // Get extension info
    ipcMain.handle('extensions-get-info', async (event, extensionId) => {
      try {
        if (!extensionId || typeof extensionId !== 'string') {
          throw new Error('Invalid extension ID');
        }

        const extensions = await extensionManager.listExtensions();
        const extension = extensions.find(ext => ext.id === extensionId);
        
        if (!extension) {
          throw new Error('Extension not found');
        }

        return { success: true, extension };
      } catch (error) {
        console.error('ExtensionIPC: extensions-get-info failed:', error);
        return { success: false, error: error.message };
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

    // TODO: Add browser action IPC handlers
    // ipcMain.handle('extensions-browser-actions', async (event, windowId) => {
    //   try {
    //     const actions = await extensionManager.listBrowserActions(windowId);
    //     return { success: true, actions };
    //   } catch (error) {
    //     console.error('ExtensionIPC: extensions-browser-actions failed:', error);
    //     return { success: false, error: error.message };
    //   }
    // });

    // TODO: Add browser action click handler
    // ipcMain.handle('extensions-click-action', async (event, actionId, windowId) => {
    //   try {
    //     await extensionManager.clickBrowserAction(actionId, windowId);
    //     return { success: true };
    //   } catch (error) {
    //     console.error('ExtensionIPC: extensions-click-action failed:', error);
    //     return { success: false, error: error.message };
    //   }
    // });

    console.log('ExtensionIPC: Extension IPC handlers registered successfully');
    
  } catch (error) {
    console.error('ExtensionIPC: Failed to register IPC handlers:', error);
    throw error;
  }
}

export default {
  setupExtensionIpcHandlers
};