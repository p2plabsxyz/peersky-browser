// Extension Registry - Manages extension metadata and persistence
// Enhanced schema with publisher, type classification, P2P mappings, and verification
// Pattern: Similar to settings-manager.js persistence approach

import { app } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';

const EXTENSIONS_DIR = path.join(app.getPath("userData"), "extensions");
const REGISTRY_FILE = path.join(EXTENSIONS_DIR, "index.json");
const P2P_CACHE_FILE = path.join(EXTENSIONS_DIR, ".p2p-cache.json");
const OLD_REGISTRY_FILE = path.join(EXTENSIONS_DIR, "extension.json"); // Migration support

class ExtensionRegistry {
  constructor() {
    this.registry = {
      version: "1.0",
      extensions: {}
    };
    this.p2pMappings = {
      ipfsToExtension: {},
      hyperToExtension: {},
      extensionToP2P: {}
    };
    this.isLoading = false;
    this.isSaving = false;
  }

  async init() {
    // TODO: Initialize extension registry
    // - Ensure extensions directory exists
    // - Load existing registry or create new one
    // - Migrate from old extension.json format if exists
    // - Load P2P mappings cache
    // - Validate registry integrity
    console.log('ExtensionRegistry: Initializing...');
    
    try {
      await fs.mkdir(EXTENSIONS_DIR, { recursive: true });
      await this.migrateOldRegistryIfExists();
      await this.loadRegistry();
      await this.loadP2PMappings();
      await this.validateRegistryIntegrity();
    } catch (error) {
      console.error('ExtensionRegistry: Initialization failed:', error);
    }
  }

  async loadRegistry() {
    // TODO: Load index.json from userData/extensions/
    // - Handle missing file (create default structure)
    // - Validate registry format version
    // - Merge with defaults for missing fields
    // - Handle corrupted registry files
    console.log('TODO: Load registry from disk');
    
    try {
      const data = await fs.readFile(REGISTRY_FILE, 'utf8');
      this.registry = JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('Registry file not found, creating default');
        await this.saveRegistry();
      } else {
        throw error;
      }
    }
  }

  async saveRegistry() {
    // TODO: Persist registry with atomic writes
    // - Use temporary file + rename for atomicity
    // - Ensure directory exists
    // - Handle concurrent save operations
    console.log('TODO: Save registry to disk');
    
    if (this.isSaving) return;
    this.isSaving = true;
    
    try {
      const tempFile = REGISTRY_FILE + '.tmp';
      await fs.writeFile(tempFile, JSON.stringify(this.registry, null, 2), 'utf8');
      await fs.rename(tempFile, REGISTRY_FILE);
    } finally {
      this.isSaving = false;
    }
  }

  async addExtension(id, metadata) {
    // Add extension entry with enhanced schema
    // Required fields: name, version, publisher, type, enabled, verified
    // Optional fields: description, permissions, installTime, source, p2pMappings
    // Validate metadata structure before adding
    console.log(`Adding extension to registry: ${id}`);
    
    // Validate that extension ID isn't already taken
    if (this.registry.extensions[id]) {
      throw new Error(`Extension with ID "${id}" already exists in registry`);
    }
    
    // Validate required metadata fields
    if (!metadata.name || !metadata.version) {
      throw new Error('Extension metadata must include name and version');
    }
    
    const extensionEntry = {
      name: metadata.name,
      version: metadata.version,
      publisher: metadata.publisher || 'Unknown',
      type: metadata.type || 'content_script', // content_script|background|newtab|devtool|p2p-remote
      enabled: metadata.enabled !== false,
      verified: metadata.verified || false,
      sha256: metadata.sha256 || null,
      installTime: metadata.installTime || new Date().toISOString(),
      source: metadata.source || 'local', // local|ipfs|hyper|store
      description: metadata.description || '',
      permissions: metadata.permissions || [],
      p2pMappings: metadata.p2pMappings || {}
    };
    
    // Prepare P2P mapping updates
    const p2pUpdates = {};
    if (extensionEntry.p2pMappings.ipfs) {
      // Check if IPFS hash is already mapped to another extension
      const existingExtension = this.p2pMappings.ipfsToExtension[extensionEntry.p2pMappings.ipfs];
      if (existingExtension && existingExtension !== id) {
        throw new Error(`IPFS hash ${extensionEntry.p2pMappings.ipfs} is already mapped to extension ${existingExtension}`);
      }
      p2pUpdates.ipfs = extensionEntry.p2pMappings.ipfs;
    }
    if (extensionEntry.p2pMappings.hyper) {
      // Check if Hyper key is already mapped to another extension
      const existingExtension = this.p2pMappings.hyperToExtension[extensionEntry.p2pMappings.hyper];
      if (existingExtension && existingExtension !== id) {
        throw new Error(`Hyper key ${extensionEntry.p2pMappings.hyper} is already mapped to extension ${existingExtension}`);
      }
      p2pUpdates.hyper = extensionEntry.p2pMappings.hyper;
    }
    
    // Atomic update: add extension and update P2P mappings together
    this.registry.extensions[id] = extensionEntry;
    
    // Update P2P mappings
    if (p2pUpdates.ipfs) {
      this.p2pMappings.ipfsToExtension[p2pUpdates.ipfs] = id;
      this.p2pMappings.extensionToP2P[id] = { ...this.p2pMappings.extensionToP2P[id], ipfs: p2pUpdates.ipfs };
    }
    if (p2pUpdates.hyper) {
      this.p2pMappings.hyperToExtension[p2pUpdates.hyper] = id;
      this.p2pMappings.extensionToP2P[id] = { ...this.p2pMappings.extensionToP2P[id], hyper: p2pUpdates.hyper };
    }
    
    // Save both registry and P2P mappings atomically
    await Promise.all([
      this.saveRegistry(),
      this.saveP2PMappings()
    ]);
    
    console.log(`Extension added successfully: ${extensionEntry.name} (${id})`);
  }

  async removeExtension(id) {
    // Remove extension entry and cleanup
    // - Remove from registry
    // - Clean up P2P mappings
    // - Update registry file atomically
    console.log(`Removing extension from registry: ${id}`);
    
    if (!this.registry.extensions[id]) {
      throw new Error(`Extension with ID "${id}" not found in registry`);
    }
    
    // Get P2P mappings before deletion
    const p2pEntry = this.p2pMappings.extensionToP2P[id];
    
    // Atomic removal: remove extension and update P2P mappings together
    delete this.registry.extensions[id];
    
    // Clean up P2P mappings
    if (p2pEntry) {
      if (p2pEntry.ipfs) delete this.p2pMappings.ipfsToExtension[p2pEntry.ipfs];
      if (p2pEntry.hyper) delete this.p2pMappings.hyperToExtension[p2pEntry.hyper];
      delete this.p2pMappings.extensionToP2P[id];
    }
    
    // Save both registry and P2P mappings atomically
    await Promise.all([
      this.saveRegistry(),
      this.saveP2PMappings()
    ]);
    
    console.log(`Extension removed successfully: ${id}`);
  }

  async updateExtension(id, metadata) {
    // Update existing extension entry
    // - Merge new metadata with existing
    // - Update version and lastModified time
    // - Preserve enabled state unless explicitly changed
    // - Update P2P mappings if changed
    console.log(`Updating extension in registry: ${id}`);
    
    if (!this.registry.extensions[id]) {
      throw new Error(`Extension with ID "${id}" not found in registry`);
    }
    
    const existing = this.registry.extensions[id];
    const updated = {
      ...existing,
      ...metadata,
      installTime: existing.installTime, // Preserve original install time
      lastModified: new Date().toISOString()
    };
    
    // Handle P2P mapping changes
    const oldP2PMappings = existing.p2pMappings || {};
    const newP2PMappings = metadata.p2pMappings || oldP2PMappings;
    
    // Clean up old P2P mappings if they changed
    if (oldP2PMappings.ipfs && oldP2PMappings.ipfs !== newP2PMappings.ipfs) {
      delete this.p2pMappings.ipfsToExtension[oldP2PMappings.ipfs];
    }
    if (oldP2PMappings.hyper && oldP2PMappings.hyper !== newP2PMappings.hyper) {
      delete this.p2pMappings.hyperToExtension[oldP2PMappings.hyper];
    }
    
    // Add new P2P mappings
    if (newP2PMappings.ipfs) {
      this.p2pMappings.ipfsToExtension[newP2PMappings.ipfs] = id;
      this.p2pMappings.extensionToP2P[id] = { ...this.p2pMappings.extensionToP2P[id], ipfs: newP2PMappings.ipfs };
    }
    if (newP2PMappings.hyper) {
      this.p2pMappings.hyperToExtension[newP2PMappings.hyper] = id;
      this.p2pMappings.extensionToP2P[id] = { ...this.p2pMappings.extensionToP2P[id], hyper: newP2PMappings.hyper };
    }
    
    // Update registry entry
    this.registry.extensions[id] = updated;
    
    // Save both registry and P2P mappings atomically
    await Promise.all([
      this.saveRegistry(),
      this.saveP2PMappings()
    ]);
    
    console.log(`Extension updated successfully: ${updated.name} (${id})`);
  }

  async getExtension(id) {
    // TODO: Get single extension metadata
    // - Return extension entry with computed fields
    // - Include P2P mapping information
    // - Add runtime status (loaded, enabled, etc.)
    console.log(`TODO: Get extension info: ${id}`);
    
    return this.registry.extensions[id] || null;
  }

  async listExtensions(filterType = null) {
    // TODO: Get all extensions with optional type filter
    // - Return array of extension metadata
    // - Include enabled/disabled status
    // - Support filtering by type (content_script, background, etc.)
    // - Include P2P mapping information
    console.log(`TODO: List extensions, filter: ${filterType}`);
    
    const extensions = Object.entries(this.registry.extensions).map(([id, ext]) => ({
      id,
      ...ext
    }));
    
    if (filterType) {
      return extensions.filter(ext => ext.type === filterType);
    }
    
    return extensions;
  }

  async setEnabled(id, enabled) {
    // TODO: Toggle enabled state for extension
    // - Update registry entry
    // - Persist to disk
    // - Return success/failure
    console.log(`TODO: Set extension ${id} enabled: ${enabled}`);
    
    if (this.registry.extensions[id]) {
      this.registry.extensions[id].enabled = enabled;
      await this.saveRegistry();
      return true;
    }
    return false;
  }

  async validateRegistryIntegrity() {
    // TODO: Check for orphaned files and invalid entries
    // - Scan extensions directory for folders without registry entries
    // - Check registry entries for missing extension folders
    // - Validate extension manifest files exist
    // - Clean up orphaned P2P mappings
    console.log('TODO: Validate registry integrity');
  }

  async migrateOldRegistryIfExists() {
    // TODO: Migrate from extension.json to index.json format
    // - Check if old format exists
    // - Convert old schema to new enhanced schema
    // - Add default values for new fields (publisher, type, verified)
    // - Backup old file before deletion
    console.log('TODO: Migrate old registry format if exists');
    
    try {
      const oldData = await fs.readFile(OLD_REGISTRY_FILE, 'utf8');
      const oldRegistry = JSON.parse(oldData);
      
      // Convert old format to new format
      for (const [id, oldEntry] of Object.entries(oldRegistry)) {
        await this.addExtension(id, {
          name: oldEntry.name || id,
          version: oldEntry.version || '1.0.0',
          publisher: 'Unknown', // Old format didn't have publisher
          type: 'content_script', // Default type for migrated extensions
          enabled: oldEntry.enabled !== false,
          verified: false, // Old extensions are unverified
          source: 'local',
          description: oldEntry.description || '',
          permissions: oldEntry.permissions || []
        });
      }
      
      // Backup and remove old file
      await fs.rename(OLD_REGISTRY_FILE, OLD_REGISTRY_FILE + '.backup');
      console.log('ExtensionRegistry: Successfully migrated old registry format');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('ExtensionRegistry: Migration failed:', error);
      }
    }
  }

  async loadP2PMappings() {
    // TODO: Load P2P mappings cache
    // - Load .p2p-cache.json
    // - Validate mapping consistency
    // - Handle missing cache file
    console.log('TODO: Load P2P mappings cache');
    
    try {
      const data = await fs.readFile(P2P_CACHE_FILE, 'utf8');
      this.p2pMappings = JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('P2P cache not found, creating default');
        await this.saveP2PMappings();
      }
    }
  }

  async saveP2PMappings() {
    // TODO: Save P2P mappings to cache file
    // - Use atomic write
    // - Handle concurrent operations
    console.log('TODO: Save P2P mappings cache');
    
    const tempFile = P2P_CACHE_FILE + '.tmp';
    await fs.writeFile(tempFile, JSON.stringify(this.p2pMappings, null, 2), 'utf8');
    await fs.rename(tempFile, P2P_CACHE_FILE);
  }

  getExtensionByP2PHash(type, hash) {
    // TODO: Get extension ID from P2P hash
    // - Support both IPFS and Hyper lookups
    // - Return extension ID or null
    console.log(`TODO: Get extension by ${type} hash: ${hash}`);
    
    if (type === 'ipfs') {
      return this.p2pMappings.ipfsToExtension[hash] || null;
    } else if (type === 'hyper') {
      return this.p2pMappings.hyperToExtension[hash] || null;
    }
    return null;
  }

  getP2PMappingForExtension(extensionId) {
    // TODO: Get P2P mappings for extension
    // - Return both IPFS and Hyper mappings if available
    console.log(`TODO: Get P2P mappings for extension: ${extensionId}`);
    
    return this.p2pMappings.extensionToP2P[extensionId] || {};
  }
}

export default ExtensionRegistry;