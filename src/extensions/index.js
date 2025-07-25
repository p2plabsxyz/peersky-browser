/**
 * Extension System - Central Export Hub with Dependency Injection
 * 
 * This module serves as the central export hub for the extension system,
 * implementing a dependency injection pattern that allows for easy testing,
 * modularity, and configuration of the extension subsystems.
 * 
 * Key Features:
 * - Central import/export for all extension components
 * - Dependency injection pattern for modular architecture
 * - Configuration management for extension system
 * - Initialization orchestration for all subsystems
 * - Error handling and logging coordination
 * 
 * Architecture:
 * - ExtensionLoader: Main orchestrator
 * - ExtensionRegistry: Metadata and persistence
 * - ExtensionSecurity: Security validation and enforcement
 * - ExtensionP2P: Decentralized distribution
 * - ExtensionFileHandler: File operations and conversion
 * - ManifestValidator: Schema validation for Manifest V3
 * 
 * Usage:
 * ```javascript
 * import { extensionSystem } from './extensions/index.js';
 * await extensionSystem.initialize();
 * ```
 * 
 * Related Issues:
 * - Issue #19: Extension loading, signature validation, UI integration
 * - Issue #42: P2P trust model, decentralized fetch
 */

// Import all extension system components
import ExtensionLoader from './extension-loader.js';
import ExtensionRegistry from './extension-registry.js';
import ExtensionSecurity from './extension-security.js';
import ExtensionP2P from './extension-p2p.js';
import ExtensionFileHandler from './extension-file-handler.js';
import ManifestValidator from './manifest-validator.js';

// Import IPC handlers
import { setupExtensionIpcHandlers } from '../ipc-handlers/extensions.js';

/**
 * ExtensionSystem - Central coordinator with dependency injection
 * 
 * Provides a unified interface to the extension system with proper
 * dependency injection and initialization orchestration.
 */
class ExtensionSystem {
  constructor(config = {}) {
    this.config = {
      dataPath: null, // Will be set during initialization
      enableP2P: false,
      enableAutoUpdate: true,
      strictSecurity: true,
      ...config
    };
    
    this.isInitialized = false;
    this.components = {};
    this.initializationPromise = null;
  }

  /**
   * Initialize the complete extension system
   * 
   * TODO:
   * - Initialize all extension components in correct order
   * - Set up dependency injection between components
   * - Configure component settings from config
   * - Set up IPC handlers for communication
   * - Validate system integrity
   * - Handle initialization errors gracefully
   */
  async initialize() {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this._doInitialize();
    return this.initializationPromise;
  }

  async _doInitialize() {
    try {
      console.log('ExtensionSystem: Initializing extension system...');

      // TODO: Initialize components with dependency injection
      await this._initializeComponents();

      // TODO: Set up IPC handlers
      setupExtensionIpcHandlers();

      this.isInitialized = true;
      console.log('ExtensionSystem: Extension system initialized successfully');
      
    } catch (error) {
      console.error('ExtensionSystem: Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Get extension loader instance
   * 
   * @returns {ExtensionLoader} Extension loader instance
   */
  getLoader() {
    if (!this.isInitialized) {
      throw new Error('Extension system not initialized');
    }
    return this.components.loader;
  }

  /**
   * Get extension registry instance
   * 
   * @returns {ExtensionRegistry} Extension registry instance
   */
  getRegistry() {
    if (!this.isInitialized) {
      throw new Error('Extension system not initialized');
    }
    return this.components.registry;
  }

  /**
   * Get extension security instance
   * 
   * @returns {ExtensionSecurity} Extension security instance
   */
  getSecurity() {
    if (!this.isInitialized) {
      throw new Error('Extension system not initialized');
    }
    return this.components.security;
  }

  /**
   * Get extension P2P instance
   * 
   * @returns {ExtensionP2P} Extension P2P instance
   */
  getP2P() {
    if (!this.isInitialized) {
      throw new Error('Extension system not initialized');
    }
    return this.components.p2p;
  }

  /**
   * Get extension file handler instance
   * 
   * @returns {ExtensionFileHandler} Extension file handler instance
   */
  getFileHandler() {
    if (!this.isInitialized) {
      throw new Error('Extension system not initialized');
    }
    return this.components.fileHandler;
  }

  /**
   * Get manifest validator instance
   * 
   * @returns {ManifestValidator} Manifest validator instance
   */
  getManifestValidator() {
    if (!this.isInitialized) {
      throw new Error('Extension system not initialized');
    }
    return this.components.manifestValidator;
  }

  /**
   * Update extension system configuration
   * 
   * @param {Object} newConfig - Configuration updates
   * 
   * TODO:
   * - Validate configuration changes
   * - Apply configuration to components
   * - Handle configuration conflicts
   * - Persist configuration changes
   */
  updateConfig(newConfig) {
    try {
      console.log('ExtensionSystem: Updating configuration:', newConfig);

      // TODO: Implement configuration update
      this.config = { ...this.config, ...newConfig };
      
      // TODO: Apply configuration to components
      if (this.isInitialized) {
        this._applyConfigToComponents();
      }
      
    } catch (error) {
      console.error('ExtensionSystem: Configuration update failed:', error);
      throw error;
    }
  }

  /**
   * Get system status and health information
   * 
   * @returns {Object} System status
   * 
   * TODO:
   * - Check component health status
   * - Validate system integrity
   * - Check resource usage
   * - Return comprehensive status
   */
  getStatus() {
    try {
      const status = {
        initialized: this.isInitialized,
        config: this.config,
        components: {
          loader: !!this.components.loader,
          registry: !!this.components.registry,
          security: !!this.components.security,
          p2p: !!this.components.p2p,
          fileHandler: !!this.components.fileHandler,
          manifestValidator: !!this.components.manifestValidator
        },
        health: 'unknown' // TODO: Implement health checking
      };

      return status;
      
    } catch (error) {
      console.error('ExtensionSystem: Status check failed:', error);
      throw error;
    }
  }

  /**
   * Shutdown the extension system
   * 
   * TODO:
   * - Gracefully shutdown all components
   * - Clean up resources and temporary files
   * - Close P2P connections
   * - Save final state
   */
  async shutdown() {
    try {
      console.log('ExtensionSystem: Shutting down extension system...');

      // TODO: Implement graceful shutdown
      if (this.isInitialized) {
        // Shutdown components in reverse order
        // await this._shutdownComponents();
      }

      this.isInitialized = false;
      console.log('ExtensionSystem: Extension system shutdown complete');
      
    } catch (error) {
      console.error('ExtensionSystem: Shutdown failed:', error);
      throw error;
    }
  }

  /**
   * Private helper to initialize all components with dependency injection
   * 
   * TODO:
   * - Create component instances with proper configuration
   * - Set up dependency injection between components
   * - Initialize components in correct order
   * - Handle component initialization failures
   */
  async _initializeComponents() {
    try {
      console.log('ExtensionSystem: Initializing components...');

      // TODO: Initialize components with dependency injection
      // Order matters: Registry -> Security -> FileHandler -> P2P -> Loader
      
      // this.components.registry = new ExtensionRegistry(this.config.dataPath);
      // this.components.security = new ExtensionSecurity();
      // this.components.fileHandler = new ExtensionFileHandler(this.config.dataPath);
      // this.components.p2p = new ExtensionP2P();
      // this.components.manifestValidator = new ManifestValidator();
      // this.components.loader = ExtensionLoader; // Singleton

      // TODO: Inject dependencies between components
      // this.components.loader.registry = this.components.registry;
      // this.components.loader.security = this.components.security;
      // this.components.loader.fileHandler = this.components.fileHandler;
      // this.components.loader.p2p = this.components.p2p;

      console.log('ExtensionSystem: Components initialized');
      
    } catch (error) {
      console.error('ExtensionSystem: Component initialization failed:', error);
      throw error;
    }
  }

  /**
   * Private helper to apply configuration to components
   * 
   * TODO:
   * - Update component configurations
   * - Handle configuration validation
   * - Apply changes without restart if possible
   */
  _applyConfigToComponents() {
    try {
      console.log('ExtensionSystem: Applying configuration to components...');

      // TODO: Apply configuration to each component
      
    } catch (error) {
      console.error('ExtensionSystem: Configuration application failed:', error);
      throw error;
    }
  }
}

// Create singleton instance
const extensionSystem = new ExtensionSystem();

// Export individual components for direct use if needed
export {
  ExtensionLoader,
  ExtensionRegistry,
  ExtensionSecurity,
  ExtensionP2P,
  ExtensionFileHandler,
  ManifestValidator,
  setupExtensionIpcHandlers
};

// Export singleton system instance as default
export default extensionSystem;

// Export system instance with explicit name for clarity
export { extensionSystem };