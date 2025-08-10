// Extensions page - UI-only implementation with mock data
// No IPC calls, no persistence - toggles are local state only

const EXTENSIONS = [
  {
    id: 'grammarly',
    name: 'Grammarly',
    version: '2.1.4',
    desc: 'AI writing assistant',
    permissions: ['activeTab', 'storage'],
    enabled: true,
    icon: null
  },
  {
    id: 'color-picker',
    name: 'Color Picker',
    version: '1.0.3',
    desc: 'Eyedropper & palette',
    permissions: ['tabs'],
    enabled: false,
    icon: null
  },
  {
    id: 'pie-adblock',
    name: 'Pie Adblock',
    version: '5.2.0',
    desc: 'Content blocker',
    permissions: ['declarativeNetRequest'],
    enabled: true,
    icon: null
  },
  {
    id: 'simplify',
    name: 'Simplify Copilot',
    version: '0.9.1',
    desc: 'Autofill & assistant',
    permissions: ['storage'],
    enabled: false,
    icon: null
  },
  {
    id: 'dark-reader',
    name: 'Dark Reader',
    version: '4.9.58',
    desc: 'Dark theme for every website',
    permissions: ['activeTab', 'storage', 'scripting'],
    enabled: true,
    icon: null
  },
  {
    id: 'ublock-origin',
    name: 'uBlock Origin',
    version: '1.52.0',
    desc: 'Efficient wide-spectrum blocker',
    permissions: ['declarativeNetRequest', 'storage', 'tabs'],
    enabled: false,
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

// Format permissions for display
function formatPermissions(permissions) {
  if (!permissions || permissions.length === 0) {
    return '';
  }
  
  const permissionLabels = {
    'activeTab': 'active tab',
    'storage': 'storage',
    'tabs': 'browser tabs',
    'declarativeNetRequest': 'web requests',
    'scripting': 'page scripts',
    'webNavigation': 'navigation'
  };
  
  const formatted = permissions
    .map(perm => permissionLabels[perm] || perm)
    .join(', ');
  
  return `Permissions: ${formatted}`;
}

// Create extension card HTML
function createExtensionCard(extension) {
  const isEnabled = extensionStates[extension.id];
  const permissionsText = formatPermissions(extension.permissions);
  
  const card = document.createElement('div');
  card.className = 'extension-card settings-section';
  card.setAttribute('role', 'region');
  card.setAttribute('aria-labelledby', `ext-${extension.id}-name`);
  
  card.innerHTML = `
    <div class="extension-icon">
      ${extension.icon || DEFAULT_ICON_SVG}
    </div>
    <div class="extension-info">
      <h3 id="ext-${extension.id}-name" class="extension-name">${extension.name}</h3>
      <p class="extension-meta">v${extension.version} • ${extension.desc}</p>
      ${permissionsText ? `<p class="extension-permissions">${permissionsText}</p>` : ''}
    </div>
    <div class="extension-toggle">
      <label class="toggle-label" aria-label="Enable ${extension.name}">
        <input type="checkbox" class="toggle-input" ${isEnabled ? 'checked' : ''} data-extension-id="${extension.id}">
        <span class="toggle-slider"></span>
      </label>
    </div>
  `;
  
  return card;
}

// Handle toggle changes
function handleToggleChange(event) {
  const extensionId = event.target.dataset.extensionId;
  const isEnabled = event.target.checked;
  
  // Update local state (UI only)
  extensionStates[extensionId] = isEnabled;
  
  // Find the extension for logging
  const extension = EXTENSIONS.find(ext => ext.id === extensionId);
  console.log(`Extension "${extension?.name}" ${isEnabled ? 'enabled' : 'disabled'} (UI only)`);
}

// Render extensions list
function renderExtensions() {
  const container = document.getElementById('extensions-list');
  if (!container) {
    console.error('Extensions list container not found');
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
  
  // Add event listeners to toggles
  const toggles = container.querySelectorAll('.toggle-input');
  toggles.forEach(toggle => {
    toggle.addEventListener('change', handleToggleChange);
  });
}

// Initialize the page
function init() {
  initializeStates();
  renderExtensions();
  
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