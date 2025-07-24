// Extension Loader - Core loading and validation logic for WebExtensions
// Refactored with dependency injection for better testability and separation of concerns
// Handles orchestration between registry, security, P2P, and file operations

import { session } from 'electron';
import path from 'path';

class ExtensionLoader {
  constructor({ registry, security, p2p, fileHandler }) {
    this.registry = registry;
    this.security = security;
    this.p2p = p2p;
    this.fileHandler = fileHandler;
    
    this.loadedExtensions = new Map(); // extensionId -> electron extension object
    this.loadingQueue = new Set(); // Track extensions currently being loaded
  }

  async init() {
    // TODO: Initialize extension loader
    // - Load enabled extensions from registry
    // - Restore extension states in Electron session
    // - Handle failed extensions and error recovery
    console.log('ExtensionLoader: Initializing...');
    
    try {
      const enabledExtensions = await this.registry.listExtensions();
      const enabled = enabledExtensions.filter(ext => ext.enabled);
      
      for (const ext of enabled) {
        await this.loadExtensionById(ext.id);
      }
      
      console.log(`ExtensionLoader: Loaded ${enabled.length} enabled extensions`);
    } catch (error) {
      console.error('ExtensionLoader: Initialization failed:', error);
    }
  }

  async loadExtensionFromCrx(crxPath, extensionId = null) {
    // TODO: Convert .crx file to standard ZIP format and load
    // - Delegate CRX conversion to fileHandler
    // - Generate extensionId if not provided
    // - Validate manifest after extraction
    // - Register in registry with metadata
    console.log(`TODO: Load extension from CRX: ${crxPath}`);
    
    if (this.loadingQueue.has(crxPath)) {
      throw new Error('Extension is already being loaded');
    }
    
    this.loadingQueue.add(crxPath);
    
    try {
      // Convert CRX to ZIP and extract
      const extractedPath = await this.fileHandler.convertCrxToZip(crxPath);
      
      // Load from extracted directory
      return await this.loadExtensionFromDirectory(extractedPath, extensionId);
    } finally {
      this.loadingQueue.delete(crxPath);
    }
  }

  async loadExtensionFromZip(zipPath, extensionId = null) {
    // TODO: Extract and validate ZIP-based extension
    // - Delegate ZIP extraction to fileHandler
    // - Validate manifest structure with security module
    // - Install to extensions directory
    // - Register in registry
    console.log(`TODO: Load extension from ZIP: ${zipPath}`);
    
    if (this.loadingQueue.has(zipPath)) {
      throw new Error('Extension is already being loaded');
    }
    
    this.loadingQueue.add(zipPath);
    
    try {
      // Extract ZIP to temporary directory
      const extractedPath = await this.fileHandler.extractZipExtension(zipPath);
      
      // Load from extracted directory
      return await this.loadExtensionFromDirectory(extractedPath, extensionId);
    } finally {
      this.loadingQueue.delete(zipPath);
    }
  }

  async loadExtensionFromDirectory(extensionPath, extensionId = null) {
    // Load extension from extracted directory
    // - Read and validate manifest.json
    // - Generate extension ID if not provided  
    // - Check for duplicate installations
    // - Validate security policies
    // - Copy to permanent location
    // - Load into Electron session
    // - Register in registry
    console.log(`Loading extension from directory: ${extensionPath}`);
    
    try {
      // Validate manifest
      const manifestPath = path.join(extensionPath, 'manifest.json');
      const validation = await this.security.validateManifestV3(manifestPath);
      
      if (!validation.valid) {
        throw new Error(`Invalid manifest: ${validation.errors.join(', ')}`);
      }
      
      // Read manifest for metadata
      const manifest = validation.manifest;
      const finalExtensionId = extensionId || this.generateExtensionId(manifest);
      
      // Check if extension is already installed
      const existingExtension = await this.registry.getExtension(finalExtensionId);
      if (existingExtension) {
        throw new Error(`Extension "${manifest.name}" is already installed. Uninstall first to reinstall.`);
      }
      
      // Check if extension is already loaded
      if (this.loadedExtensions.has(finalExtensionId)) {
        throw new Error(`Extension "${manifest.name}" is already loaded in memory.`);
      }
      
      // Copy to permanent extensions directory
      const permanentPath = await this.fileHandler.copyExtensionFiles(
        extensionPath, 
        finalExtensionId
      );
      
      // Load into Electron session
      const electronExtension = await this.loadIntoElectron(permanentPath);
      
      // Register in registry
      await this.registry.addExtension(finalExtensionId, {
        name: manifest.name,
        version: manifest.version,
        publisher: manifest.author || 'Unknown',
        type: this.determineExtensionType(manifest),
        enabled: true,
        verified: false, // Local installs are unverified by default
        source: 'local',
        description: manifest.description || '',
        permissions: manifest.permissions || []
      });
      
      // Track loaded extension
      this.loadedExtensions.set(finalExtensionId, electronExtension);
      
      console.log(`Extension loaded successfully: ${manifest.name} (${finalExtensionId})`);
      return { id: finalExtensionId, extension: electronExtension };
    } catch (error) {
      // Clean up on failure
      await this.fileHandler.cleanupTempFiles(extensionPath);
      throw error;
    }
  }

  async loadExtensionById(extensionId) {
    // TODO: Load extension by ID from registry
    // - Get extension info from registry
    // - Check if already loaded
    // - Load from extensions directory
    // - Handle missing or corrupted extensions
    console.log(`TODO: Load extension by ID: ${extensionId}`);
    
    if (this.loadedExtensions.has(extensionId)) {
      console.log(`Extension ${extensionId} already loaded`);
      return this.loadedExtensions.get(extensionId);
    }
    
    const extensionInfo = await this.registry.getExtension(extensionId);
    if (!extensionInfo) {
      throw new Error(`Extension ${extensionId} not found in registry`);
    }
    
    const extensionPath = path.join(
      this.registry.EXTENSIONS_DIR, 
      extensionId
    );
    
    const electronExtension = await this.loadIntoElectron(extensionPath);
    this.loadedExtensions.set(extensionId, electronExtension);
    
    return electronExtension;
  }

  async loadIntoElectron(extensionPath) {
    // TODO: Load extension into Electron session
    // - Use session.defaultSession.loadExtension()
    // - Handle loading errors and provide meaningful feedback
    // - Apply security sandbox settings
    // - Return extension reference for management
    console.log(`TODO: Load into Electron: ${extensionPath}`);
    
    try {
      const extension = await session.defaultSession.loadExtension(extensionPath, {
        allowFileAccess: false // Restrict file access by default
      });
      
      console.log(`Loaded extension: ${extension.name} (${extension.id})`);
      return extension;
    } catch (error) {
      console.error(`Failed to load extension from ${extensionPath}:`, error);
      throw new Error(`Electron extension loading failed: ${error.message}`);
    }
  }

  async unloadExtension(extensionId) {
    // TODO: Unload extension from Electron session
    // - Use session.defaultSession.removeExtension()
    // - Clean up extension data and references
    // - Remove from loaded extensions map
    // - Optionally remove files from disk
    console.log(`TODO: Unload extension: ${extensionId}`);
    
    const electronExtension = this.loadedExtensions.get(extensionId);
    if (electronExtension) {
      try {
        await session.defaultSession.removeExtension(electronExtension.id);
        this.loadedExtensions.delete(extensionId);
        console.log(`Unloaded extension: ${extensionId}`);
      } catch (error) {
        console.error(`Failed to unload extension ${extensionId}:`, error);
        throw error;
      }
    }
  }

  async enableExtension(extensionId) {
    // TODO: Enable previously disabled extension
    // - Update registry enabled state
    // - Load extension if not already loaded
    // - Apply extension to all relevant windows
    console.log(`TODO: Enable extension: ${extensionId}`);
    
    await this.registry.setEnabled(extensionId, true);
    
    if (!this.loadedExtensions.has(extensionId)) {
      await this.loadExtensionById(extensionId);
    }
    
    return true;
  }

  async disableExtension(extensionId) {
    // TODO: Disable extension without unloading
    // - Update registry enabled state
    // - Optionally unload from Electron (configurable)
    // - Keep extension files intact
    console.log(`TODO: Disable extension: ${extensionId}`);
    
    await this.registry.setEnabled(extensionId, false);
    
    // For now, we unload disabled extensions
    // In the future, this could be configurable
    if (this.loadedExtensions.has(extensionId)) {
      await this.unloadExtension(extensionId);
    }
    
    return true;
  }

  async installExtensionFromP2P(source) {
    // TODO: Install extension from P2P networks
    // - Parse source (ipfs://hash, hyper://key)
    // - Delegate to P2P module for download
    // - Validate downloaded extension
    // - Check for existing extensions with same P2P mapping
    // - Install using standard installation flow
    console.log(`TODO: Install from P2P: ${source}`);
    
    try {
      // Parse P2P source
      const { type, hash } = this.parseP2PSource(source);
      
      // Check if already installed via P2P mapping
      const existingId = this.registry.getExtensionByP2PHash(type, hash);
      if (existingId) {
        throw new Error(`Extension already installed from ${source} as ${existingId}`);
      }
      
      // Download from P2P network
      const downloadedPath = await this.p2p.fetchExtension(type, hash);
      
      // Validate and install
      const result = await this.loadExtensionFromDirectory(downloadedPath);
      
      // Update registry with P2P mapping
      await this.registry.updateExtension(result.id, {
        source: type,
        p2pMappings: { [type]: hash }
      });
      
      return result;
    } catch (error) {
      console.error(`P2P installation failed for ${source}:`, error);
      throw error;
    }
  }

  async updateExtension(extensionId, source = null) {
    // TODO: Update existing extension
    // - Get current extension info
    // - Compare version numbers
    // - Download new version from source
    // - Backup current version
    // - Install new version
    // - Migrate extension data if needed
    console.log(`TODO: Update extension: ${extensionId} from ${source}`);
    
    const currentInfo = await this.registry.getExtension(extensionId);
    if (!currentInfo) {
      throw new Error(`Extension ${extensionId} not found`);
    }
    
    // If no source provided, try to update from original source
    const updateSource = source || this.getUpdateSource(currentInfo);
    
    if (!updateSource) {
      throw new Error(`No update source available for ${extensionId}`);
    }
    
    // TODO: Implement version comparison and update logic
    console.log(`Would update ${extensionId} from ${updateSource}`);
  }

  async listLoadedExtensions() {
    // TODO: List all loaded extensions with status
    // - Combine registry data with runtime status
    // - Include loading errors if any
    // - Return comprehensive extension info
    console.log('TODO: List loaded extensions');
    
    const registryExtensions = await this.registry.listExtensions();
    
    return registryExtensions.map(ext => ({
      ...ext,
      loaded: this.loadedExtensions.has(ext.id),
      electronExtension: this.loadedExtensions.get(ext.id) || null
    }));
  }

  // Helper methods

  generateExtensionId(manifest) {
    // Generate deterministic extension ID from manifest content
    // - Use manifest name, version, and author for consistency
    // - Create hash for uniqueness while being deterministic
    // - Handle special characters and ensure valid ID format
    const baseName = manifest.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const version = manifest.version.replace(/[^a-z0-9.]/g, '');
    const author = (manifest.author || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '-');
    
    // Create deterministic hash from manifest content
    const manifestString = JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      author: manifest.author || 'unknown',
      description: manifest.description || ''
    });
    
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(manifestString).digest('hex').substring(0, 8);
    
    return `${baseName}-${version}-${hash}`;
  }

  determineExtensionType(manifest) {
    // TODO: Determine extension type from manifest
    // - Check for service_worker (background)
    // - Check for content_scripts
    // - Check for newtab override
    // - Check for devtools_page
    if (manifest.background?.service_worker) return 'background';
    if (manifest.content_scripts?.length > 0) return 'content_script';
    if (manifest.chrome_url_overrides?.newtab) return 'newtab';
    if (manifest.devtools_page) return 'devtool';
    return 'content_script'; // Default
  }

  parseP2PSource(source) {
    // TODO: Parse P2P source URL
    // - Support ipfs://hash and hyper://key formats
    // - Validate hash/key format
    // - Return type and identifier
    if (source.startsWith('ipfs://')) {
      return { type: 'ipfs', hash: source.slice(7) };
    } else if (source.startsWith('hyper://')) {
      return { type: 'hyper', hash: source.slice(8) };
    } else {
      throw new Error(`Unsupported P2P source format: ${source}`);
    }
  }

  getUpdateSource(extensionInfo) {
    // TODO: Determine update source for extension
    // - Check P2P mappings
    // - Return appropriate source URL
    if (extensionInfo.source === 'ipfs' && extensionInfo.p2pMappings?.ipfs) {
      return `ipfs://${extensionInfo.p2pMappings.ipfs}`;
    } else if (extensionInfo.source === 'hyper' && extensionInfo.p2pMappings?.hyper) {
      return `hyper://${extensionInfo.p2pMappings.hyper}`;
    }
    return null;
  }
}

export default ExtensionLoader;