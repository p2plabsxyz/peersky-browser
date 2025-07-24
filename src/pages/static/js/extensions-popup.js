// TODO: Extensions Popup UI Interaction Logic
// Handles extension popup functionality - toggle, install, P2P management
// Pattern: Similar to other UI scripts in Peersky

class ExtensionPopupManager {
  constructor() {
    this.extensions = [];
    this.networkStatus = { ipfs: false, hyper: false };
    this.p2pEnabled = false;
    
    // TODO: Initialize popup manager
    console.log('TODO: ExtensionPopupManager initialized');
  }

  async loadExtensions() {
    // TODO: Load extension data from electronAPI
    console.log('TODO: Load extensions from electronAPI.extensions.list()');
    
    try {
      // TODO: Call actual API when implemented
      // const result = await window.electronAPI?.extensions?.list();
      // if (result?.success) {
      //   this.extensions = result.extensions;
      //   this.renderExtensionList();
      // }
      
      // Placeholder data for now
      this.extensions = [
        { id: 'ad-blocker', name: 'Ad Blocker', enabled: false, type: 'content_script' },
        { id: 'dscan', name: 'DScan', enabled: false, type: 'background' }
      ];
      
      this.renderExtensionList();
    } catch (error) {
      console.error('TODO: Handle extension loading error:', error);
      this.showError('Failed to load extensions');
    }
  }

  async loadNetworkStatus() {
    // TODO: Get P2P network status
    console.log('TODO: Load network status from electronAPI.extensions.getNetworkStatus()');
    
    try {
      // TODO: Call actual API when implemented
      // const result = await window.electronAPI?.extensions?.getNetworkStatus();
      // if (result?.success) {
      //   this.networkStatus = result.networks;
      //   this.updateNetworkStatusDisplay();
      // }
      
      // Placeholder status for now
      this.networkStatus = { ipfs: false, hyper: false };
      this.updateNetworkStatusDisplay();
    } catch (error) {
      console.error('TODO: Handle network status error:', error);
    }
  }

  renderExtensionList() {
    // TODO: Render extension list in popup
    console.log('TODO: Render extension list with toggle switches');
    
    const extensionsList = document.querySelector('.extensions-list');
    if (!extensionsList) return;
    
    if (this.extensions.length === 0) {
      extensionsList.innerHTML = `
        <div class="extensions-empty">
          <svg viewBox="0 0 24 24">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
          </svg>
          <p>No extensions installed</p>
        </div>
      `;
      return;
    }
    
    // TODO: Generate extension items dynamically
    extensionsList.innerHTML = this.extensions.map(ext => `
      <div class="extension-item" data-extension-id="${ext.id}">
        <span class="extension-name">${ext.name}</span>
        <label class="toggle-label">
          <input type="checkbox" class="toggle-input" ${ext.enabled ? 'checked' : ''} 
                 data-extension-id="${ext.id}">
          <span class="toggle-slider"></span>
        </label>
      </div>
    `).join('');
    
    // TODO: Add event listeners for toggle switches
    this.setupToggleListeners();
  }

  setupToggleListeners() {
    // TODO: Setup event listeners for extension toggles
    console.log('TODO: Setup toggle switch event listeners');
    
    const toggles = document.querySelectorAll('.toggle-input[data-extension-id]');
    toggles.forEach(toggle => {
      toggle.addEventListener('change', async (e) => {
        const extensionId = e.target.dataset.extensionId;
        const enabled = e.target.checked;
        
        await this.toggleExtension(extensionId, enabled);
      });
    });
  }

  async toggleExtension(extensionId, enabled) {
    // TODO: Toggle extension via electronAPI
    console.log(`TODO: Toggle extension ${extensionId} to ${enabled}`);
    
    try {
      // TODO: Call actual API when implemented
      // const result = await window.electronAPI?.extensions?.toggle(extensionId, enabled);
      // if (result?.success) {
      //   this.updateExtensionStatus(extensionId, enabled);
      //   this.showSuccess(`Extension ${enabled ? 'enabled' : 'disabled'}`);
      // } else {
      //   this.showError(result?.error || 'Failed to toggle extension');
      //   this.revertToggle(extensionId);
      // }
      
      // Placeholder behavior
      this.updateExtensionStatus(extensionId, enabled);
      this.showToast(`Extension ${enabled ? 'enabled' : 'disabled'} (placeholder)`);
    } catch (error) {
      console.error('TODO: Handle toggle error:', error);
      this.showError('Failed to toggle extension');
      this.revertToggle(extensionId);
    }
  }

  updateExtensionStatus(extensionId, enabled) {
    // TODO: Update local extension status
    const extension = this.extensions.find(ext => ext.id === extensionId);
    if (extension) {
      extension.enabled = enabled;
    }
  }

  revertToggle(extensionId) {
    // TODO: Revert toggle switch on error
    const toggle = document.querySelector(`[data-extension-id="${extensionId}"]`);
    if (toggle) {
      const extension = this.extensions.find(ext => ext.id === extensionId);
      toggle.checked = extension?.enabled || false;
    }
  }

  async handleInstallClick() {
    // TODO: Handle install button click
    console.log('TODO: Handle extension installation');
    
    // TODO: Show file picker for local files
    // TODO: Handle P2P URL input
    // TODO: Validate and install extension
    
    this.showToast('Install functionality not yet implemented');
  }

  async handleP2PInstall(url) {
    // TODO: Handle P2P extension installation
    console.log(`TODO: Install extension from P2P URL: ${url}`);
    
    try {
      if (!this.p2pEnabled) {
        this.showError('P2P installation is disabled. Enable in settings.');
        return;
      }
      
      // TODO: Validate P2P URL format
      if (!this.isValidP2PUrl(url)) {
        this.showError('Invalid P2P URL format');
        return;
      }
      
      // TODO: Call actual API when implemented
      // const result = await window.electronAPI?.extensions?.install(url);
      // if (result?.success) {
      //   this.loadExtensions(); // Refresh list
      //   this.showSuccess('Extension installed successfully');
      // } else {
      //   this.showError(result?.error || 'Installation failed');
      // }
      
      this.showToast('P2P installation not yet implemented');
    } catch (error) {
      console.error('TODO: Handle P2P install error:', error);
      this.showError('P2P installation failed');
    }
  }

  isValidP2PUrl(url) {
    // TODO: Validate P2P URL format
    return url.startsWith('ipfs://') || url.startsWith('hyper://');
  }

  updateNetworkStatusDisplay() {
    // TODO: Update network status indicator
    console.log('TODO: Update network status display');
    
    const statusIndicator = document.querySelector('.status-indicator');
    if (!statusIndicator) return;
    
    const isOnline = this.networkStatus.ipfs || this.networkStatus.hyper;
    
    statusIndicator.className = `status-indicator ${isOnline ? 'online' : 'offline'}`;
    statusIndicator.textContent = isOnline ? 'P2P: Online' : 'P2P: Offline';
    
    // TODO: Update button states based on network status
    const installBtn = document.querySelector('.install-btn');
    const p2pInput = document.querySelector('.p2p-input');
    
    if (installBtn && p2pInput) {
      const shouldEnable = isOnline && this.p2pEnabled;
      installBtn.disabled = !shouldEnable;
      p2pInput.disabled = !shouldEnable;
    }
  }

  showToast(message, type = 'info') {
    // TODO: Show toast notification
    console.log(`TODO: Show toast - ${type}: ${message}`);
    
    // Create simple toast notification
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: var(--base02);
      color: var(--browser-theme-text-color);
      padding: 12px 16px;
      border-radius: 6px;
      font-size: 14px;
      z-index: 10000;
      opacity: 0;
      transition: opacity 0.3s ease;
    `;
    
    document.body.appendChild(toast);
    
    // Animate in
    setTimeout(() => toast.style.opacity = '1', 10);
    
    // Remove after delay
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  showError(message) {
    this.showToast(message, 'error');
  }

  showSuccess(message) {
    this.showToast(message, 'success');
  }

  // TODO: Public methods for external access
  
  async refresh() {
    // TODO: Refresh extension data
    console.log('TODO: Refresh extension popup data');
    await Promise.all([
      this.loadExtensions(),
      this.loadNetworkStatus()
    ]);
  }

  async loadSettings() {
    // TODO: Load extension-related settings
    console.log('TODO: Load extension settings');
    
    try {
      // TODO: Call actual API when implemented
      // const result = await window.electronAPI?.extensions?.getSettings();
      // if (result?.success) {
      //   this.p2pEnabled = result.settings.p2pEnabled;
      //   this.updateNetworkStatusDisplay();
      // }
      
      // Placeholder settings
      this.p2pEnabled = false;
      this.updateNetworkStatusDisplay();
    } catch (error) {
      console.error('TODO: Handle settings load error:', error);
    }
  }
}

// TODO: Export for use in nav-box.js
window.ExtensionPopupManager = ExtensionPopupManager;

// TODO: Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  console.log('TODO: Extensions popup script loaded');
});