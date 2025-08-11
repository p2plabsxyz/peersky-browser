// Extensions page - UI-only implementation with mock data
// No IPC calls, no persistence - toggles are local state only

let EXTENSIONS = [
  {
    id: 'adblocker-plus',
    name: 'AdBlocker Plus',
    version: '3.15.1',
    description: 'Block ads and trackers across the web for a cleaner browsing experience',
    enabled: true,
    icon: null
  },
  {
    id: 'grammarly',
    name: 'Grammarly',
    version: '2.1.4', 
    description: 'AI writing assistant for better communication and grammar checking',
    enabled: true,
    icon: null
  },
  {
    id: 'p2p-messenger',
    name: 'P2P Messenger',
    version: '1.0.0',
    description: 'Decentralized messaging extension for peer-to-peer communication',
    enabled: false,
    icon: null
  },
  {
    id: 'dev-tools-custom',
    name: 'Custom Dev Tools',
    version: '0.8.2',
    description: 'Developer utilities for debugging and web development',
    enabled: false,
    icon: null
  },
  {
    id: 'color-picker',
    name: 'Color Picker',
    version: '1.0.3',
    description: 'Eyedropper tool and color palette for designers and developers',
    enabled: true,
    icon: null
  }
];

// Default extension icon SVG
const DEFAULT_ICON_SVG = `
  <svg class="extension-icon-placeholder" viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-5.5c0-.83-.67-1.5-1.5-1.5zM10.5 3c.28 0 .5.22.5.5V5H9V3.5c0-.28.22-.5.5-.5zM20 17H4V7h16v10z"/>
  </svg>
`;

// Extension state management (UI only)
let extensionStates = {};

// Initialize extension states from mock data
function initializeStates() {
  EXTENSIONS.forEach(ext => {
    extensionStates[ext.id] = ext.enabled;
  });
}


// Create extension card HTML with new vertical layout
function createExtensionCard(extension) {
  const isEnabled = extensionStates[extension.id];
  
  const card = document.createElement('div');
  card.className = 'extension-card settings-section';
  card.setAttribute('role', 'region');
  card.setAttribute('aria-labelledby', `ext-${extension.id}-name`);
  
  card.innerHTML = `
    <div class="extension-header">
      <div class="extension-icon">
        ${extension.icon || DEFAULT_ICON_SVG}
      </div>
      <h3 id="ext-${extension.id}-name" class="extension-name">${extension.name}</h3>
      <p class="extension-description">${extension.description}</p>
    </div>
    <div class="extension-actions">
      <div class="extension-buttons">
        <button type="button" class="btn btn-danger" data-action="remove" data-extension-id="${extension.id}" title="Remove extension">
          Remove
        </button>
        <button type="button" class="btn btn-secondary" data-action="update" data-extension-id="${extension.id}" title="Update extension">
          Update
        </button>
      </div>
      <div class="extension-toggle">
        <label class="toggle-label" aria-label="Enable ${extension.name}">
          <input type="checkbox" class="toggle-input" ${isEnabled ? 'checked' : ''} data-extension-id="${extension.id}">
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
  `;
  
  return card;
}

// Handle install from URL
function handleInstallFromURL() {
  const urlInput = document.getElementById('install-url');
  const url = urlInput.value.trim();
  
  if (!url) {
    console.log('No URL entered');
    return;
  }
  
  console.log(`Install extension from URL: ${url}`);
  // TODO: Implement actual installation logic
  
  // Clear input after logging
  urlInput.value = '';
}

// Handle extension removal
function handleRemoveExtension(extensionId) {
  const extension = EXTENSIONS.find(ext => ext.id === extensionId);
  if (!extension) return;
  
  const confirmed = confirm(`Remove "${extension.name}" extension?\n\nThis action cannot be undone.`);
  if (confirmed) {
    // Remove from array
    const index = EXTENSIONS.findIndex(ext => ext.id === extensionId);
    if (index !== -1) {
      EXTENSIONS.splice(index, 1);
      delete extensionStates[extensionId];
      
      console.log(`Extension "${extension.name}" removed`);
      
      // Re-render the grid
      renderExtensions();
    }
  }
}

// Handle extension update
function handleUpdateExtension(extensionId) {
  const extension = EXTENSIONS.find(ext => ext.id === extensionId);
  if (!extension) return;
  
  console.log(`Update extension: ${extension.name}`);
  // TODO: Implement actual update logic
}

// Handle toggle changes
function handleToggleChange(event) {
  const extensionId = event.target.dataset.extensionId;
  const isEnabled = event.target.checked;
  
  // Update local state (UI only)
  extensionStates[extensionId] = isEnabled;
  
  // Update the extension object
  const extension = EXTENSIONS.find(ext => ext.id === extensionId);
  if (extension) {
    extension.enabled = isEnabled;
  }
  
  console.log(`Extension "${extension?.name}" ${isEnabled ? 'enabled' : 'disabled'} (UI only)`);
}

// Render extensions grid
function renderExtensions() {
  const container = document.getElementById('extensions-grid');
  if (!container) {
    console.error('Extensions grid container not found');
    return;
  }
  
  // Clear existing content
  container.innerHTML = '';
  
  if (EXTENSIONS.length === 0) {
    container.innerHTML = `
      <div class="extensions-empty">
        <div class="extensions-empty-icon">${DEFAULT_ICON_SVG}</div>
        <p>No extensions installed</p>
      </div>
    `;
    return;
  }
  
  // Create and append extension cards
  EXTENSIONS.forEach(extension => {
    const card = createExtensionCard(extension);
    container.appendChild(card);
  });
}

// Initialize the page
function init() {
  initializeStates();
  renderExtensions();
  
  // Add event listener for install button
  const installBtn = document.getElementById('install-btn');
  if (installBtn) {
    installBtn.addEventListener('click', handleInstallFromURL);
  }
  
  // Add enter key support for install input
  const installInput = document.getElementById('install-url');
  if (installInput) {
    installInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        handleInstallFromURL();
      }
    });
  }
  
  // Add event delegation for extension cards
  const container = document.getElementById('extensions-grid');
  if (container) {
    container.addEventListener('change', (event) => {
      if (event.target.classList.contains('toggle-input')) {
        handleToggleChange(event);
      }
    });
    
    container.addEventListener('click', (event) => {
      if (event.target.dataset.action === 'remove') {
        handleRemoveExtension(event.target.dataset.extensionId);
      } else if (event.target.dataset.action === 'update') {
        handleUpdateExtension(event.target.dataset.extensionId);
      }
    });
  }
  
  // Focus management
  const firstToggle = document.querySelector('.toggle-input');
  if (firstToggle) {
    // Make first extension toggle focusable for keyboard navigation
    firstToggle.setAttribute('tabindex', '0');
  }
}

// Initialize when DOM is loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}