// Extension System - Central Export Hub
// Provides singleton instances for all extension modules
// Pattern: Dependency injection for testability, shared access across main/preload/renderer

import ExtensionRegistry from './extension-registry.js';
import ExtensionSecurity from './extension-security.js';
import ExtensionP2P from './extension-p2p.js';
import ExtensionFileHandler from './extension-file-handler.js';
import ExtensionLoader from './extension-loader.js';

// Create singleton instances
export const registry = new ExtensionRegistry();
export const security = new ExtensionSecurity();
export const p2p = new ExtensionP2P();
export const fileHandler = new ExtensionFileHandler();

// Create loader with dependency injection
export const loader = new ExtensionLoader({
  registry,
  security,
  p2p,
  fileHandler
});

// Initialize extension system
export async function initializeExtensionSystem() {
  // TODO: Initialize all extension system components in correct order
  // 1. Initialize registry (load index.json, migrate if needed)
  // 2. Initialize security policies
  // 3. Initialize P2P mappings cache
  // 4. Initialize file handler temp directories
  // 5. Initialize loader and restore enabled extensions
  console.log('TODO: Initialize extension system components');
}

// Cleanup extension system
export async function cleanupExtensionSystem() {
  // TODO: Clean shutdown of all extension components
  // - Save registry state
  // - Unload all extensions from Electron
  // - Clean up temporary files
  // - Close P2P connections
  console.log('TODO: Cleanup extension system');
}

export default {
  registry,
  security,
  p2p,
  fileHandler,
  loader,
  initializeExtensionSystem,
  cleanupExtensionSystem
};