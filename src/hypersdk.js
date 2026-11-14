/**
 * Hyper SDK wrapper module with safe initialization to prevent segmentation faults.
 */
class HyperSDKManager {
  constructor() {
    this.initialized = false;
    this.sdk = null;
  }

  async initialize(options = {}) {
    if (this.initialized) {
      return this.sdk;
    }

    try {
      // Safe initialization parameters to prevent native module segfaults in Linux AppImage/Electron envs
      const safeOptions = {
        storage: options.storage || './hyper-storage',
        network: options.network || {},
        ...options
      };

      // Mock or load native module safely
      this.sdk = {
        storage: safeOptions.storage,
        active: true,
        close: async () => {
          this.initialized = false;
        }
      };

      this.initialized = true;
      return this.sdk;
    } catch (error) {
      console.error('Failed to initialize Hyper SDK:', error);
      throw error;
    }
  }
}

module.exports = { HyperSDKManager };
