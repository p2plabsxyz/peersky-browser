/**
 * Extension Registry - JSON file operations for extension metadata
 * 
 * Provides utilities for reading and writing extension registry data
 * to persistent storage in userData/extensions/extensions.json
 */

import path from 'path';
import fs from 'fs-extra';
import electron from 'electron';
const { app } = electron;

// Registry file path
const REGISTRY_FILE = 'extensions.json';

/**
 * Get the extensions data directory path
 * 
 * @returns {string} - Path to extensions directory
 */
function getExtensionsDataPath() {
  return path.join(app.getPath('userData'), 'extensions');
}

/**
 * Get the registry file path
 * 
 * @returns {string} - Path to extensions.json file
 */
function getRegistryPath() {
  return path.join(getExtensionsDataPath(), REGISTRY_FILE);
}

/**
 * Ensure extensions directory exists
 * 
 * @returns {Promise<void>}
 */
async function ensureExtensionsDir() {
  const extensionsDir = getExtensionsDataPath();
  await fs.ensureDir(extensionsDir);
}

/**
 * Read the extension registry from disk
 * 
 * @returns {Promise<{extensions: Array}>} - Registry data with extensions array
 */
export async function readRegistry() {
  try {
    await ensureExtensionsDir();
    const registryPath = getRegistryPath();
    
    if (await fs.pathExists(registryPath)) {
      const data = await fs.readJson(registryPath);
      
      // Ensure we have the expected structure
      if (!data.extensions || !Array.isArray(data.extensions)) {
        console.warn('[Registry] Invalid registry structure, initializing with empty array');
        return { extensions: [] };
      }
      
      return data;
    } else {
      // First run - create empty registry
      console.log('[Registry] Creating new registry file');
      const emptyRegistry = { extensions: [] };
      await writeRegistry(emptyRegistry);
      return emptyRegistry;
    }
  } catch (error) {
    console.error('[Registry] Failed to read registry:', error);
    // Return empty registry on error to prevent crashes
    return { extensions: [] };
  }
}

/**
 * Write the extension registry to disk
 * 
 * @param {Object} registryData - Registry data to write
 * @returns {Promise<void>}
 */
export async function writeRegistry(registryData) {
  try {
    await ensureExtensionsDir();
    const registryPath = getRegistryPath();
    
    // Validate structure
    if (!registryData.extensions || !Array.isArray(registryData.extensions)) {
      throw new Error('Invalid registry data: extensions array required');
    }
    
    // Write atomically with temp file
    const tempPath = `${registryPath}.tmp`;
    await fs.writeJson(tempPath, registryData, { spaces: 2 });
    await fs.move(tempPath, registryPath);
    
    console.log(`[Registry] Successfully saved ${registryData.extensions.length} extensions`);
  } catch (error) {
    console.error('[Registry] Failed to write registry:', error);
    throw error;
  }
}

/**
 * Add or update extension in registry
 * 
 * @param {Object} extensionData - Extension metadata to add/update
 * @returns {Promise<void>}
 */
export async function addOrUpdateExtension(extensionData) {
  if (!extensionData.id) {
    throw new Error('Extension ID required');
  }
  
  const registry = await readRegistry();
  const existingIndex = registry.extensions.findIndex(ext => ext.id === extensionData.id);
  
  if (existingIndex >= 0) {
    // Update existing
    registry.extensions[existingIndex] = { ...registry.extensions[existingIndex], ...extensionData };
    console.log(`[Registry] Updated extension: ${extensionData.id}`);
  } else {
    // Add new
    registry.extensions.push(extensionData);
    console.log(`[Registry] Added extension: ${extensionData.id}`);
  }
  
  await writeRegistry(registry);
}

/**
 * Remove extension from registry
 * 
 * @param {string} extensionId - ID of extension to remove
 * @returns {Promise<boolean>} - True if extension was found and removed
 */
export async function removeExtension(extensionId) {
  const registry = await readRegistry();
  const initialLength = registry.extensions.length;
  
  registry.extensions = registry.extensions.filter(ext => ext.id !== extensionId);
  
  if (registry.extensions.length < initialLength) {
    await writeRegistry(registry);
    console.log(`[Registry] Removed extension: ${extensionId}`);
    return true;
  } else {
    console.warn(`[Registry] Extension not found for removal: ${extensionId}`);
    return false;
  }
}

/**
 * Get extension by ID from registry
 * 
 * @param {string} extensionId - Extension ID to find
 * @returns {Promise<Object|null>} - Extension data or null if not found
 */
export async function getExtension(extensionId) {
  const registry = await readRegistry();
  return registry.extensions.find(ext => ext.id === extensionId) || null;
}

/**
 * List all extensions from registry
 * 
 * @returns {Promise<Array>} - Array of extension objects
 */
export async function listExtensions() {
  const registry = await readRegistry();
  return registry.extensions;
}

/**
 * Update extension enabled state
 * 
 * @param {string} extensionId - Extension ID
 * @param {boolean} enabled - New enabled state
 * @returns {Promise<boolean>} - True if extension was found and updated
 */
export async function updateExtensionEnabled(extensionId, enabled) {
  const registry = await readRegistry();
  const extension = registry.extensions.find(ext => ext.id === extensionId);
  
  if (extension) {
    extension.enabled = enabled;
    await writeRegistry(registry);
    console.log(`[Registry] Updated ${extensionId} enabled: ${enabled}`);
    return true;
  } else {
    console.warn(`[Registry] Extension not found for enabled update: ${extensionId}`);
    return false;
  }
}

/**
 * Get extensions data directory path (for external use)
 * 
 * @returns {string} - Extensions directory path
 */
export { getExtensionsDataPath };