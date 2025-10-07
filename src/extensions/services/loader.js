// Loading extensions into Electron session

import * as RegistryService from './registry.js';

/**
 * Load all enabled extensions into Electron's session
 * @param {any} manager
 */
export async function loadExtensionsIntoElectron(manager) {
  if (!manager.session) {
    console.warn('ExtensionManager: No session available for extension loading');
    return;
  }
  try {
    for (const extension of manager.loadedExtensions.values()) {
      if (extension.enabled && extension.installedPath) {
        try {
          console.log(`ExtensionManager: Loading extension into Electron: ${extension.displayName || extension.name}`);
          const electronExtension = await manager.session.loadExtension(extension.installedPath, { allowFileAccess: false });
          extension.electronId = electronExtension.id;
          console.log(`ExtensionManager: Extension loaded successfully: ${extension.displayName || extension.name} (${electronExtension.id})`);
        } catch (error) {
          console.error(`ExtensionManager: Failed to load extension ${extension.displayName || extension.name}:`, error);
        }
      }
    }
    await RegistryService.writeRegistry(manager);
  } catch (error) {
    console.error('ExtensionManager: Error loading extensions into Electron:', error);
  }
}

