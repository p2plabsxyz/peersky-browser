// Loading extensions into Electron session

import * as RegistryService from './registry.js'

/**
 * Load all enabled extensions into Electron's session.
 *
 * Each session.loadExtension() reads and parses an extension off disk, so
 * loading them one after another makes startup scale with the number of
 * installed extensions. They are independent, so they load together and a
 * single failure only costs that one extension.
 *
 * @param {any} manager
 */
export async function loadExtensionsIntoElectron (manager) {
  if (!manager.session) {
    console.warn('ExtensionManager: No session available for extension loading')
    return
  }
  try {
    const pending = []
    for (const extension of manager.loadedExtensions.values()) {
      if (!extension.enabled || !extension.installedPath) continue
      if (extension.electronId && manager.session.getExtension?.(extension.electronId)) {
        continue
      }
      pending.push(extension)
    }

    await Promise.all(pending.map(async (extension) => {
      const label = extension.displayName || extension.name
      try {
        console.log(`ExtensionManager: Loading extension into Electron: ${label}`)
        const electronExtension = await manager.session.loadExtension(extension.installedPath, { allowFileAccess: false })
        extension.electronId = electronExtension.id
        console.log(`ExtensionManager: Extension loaded successfully: ${label} (${electronExtension.id})`)
      } catch (error) {
        console.error(`ExtensionManager: Failed to load extension ${label}:`, error)
      }
    }))

    await RegistryService.writeRegistry(manager)
  } catch (error) {
    console.error('ExtensionManager: Error loading extensions into Electron:', error)
  }
}
