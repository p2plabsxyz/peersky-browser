// Extensions page - Real backend implementation with Chrome Web Store support
// Uses IPC calls for all operations, full persistence

let EXTENSIONS = [];
let extensionStates = {};

// Default extension icon (loaded from asset, not inlined)
const DEFAULT_ICON_SVG_PATH = 'peersky://static/assets/svg/default-extension-icon.svg';

function loadSVG(container, svgPath) {
  fetch(svgPath)
    .then(response => response.text())
    .then(svgContent => {
      // Strip any XML headers/comments; keep only the SVG element
      const start = svgContent.indexOf('<svg');
      const content = start >= 0 ? svgContent.slice(start) : svgContent;
      container.innerHTML = content;
      const svgElement = container.querySelector('svg');
      if (svgElement) {
        const isEmptyIcon = container.classList.contains('extensions-empty-icon');
        svgElement.setAttribute('width', isEmptyIcon ? '48' : '36');
        svgElement.setAttribute('height', isEmptyIcon ? '48' : '36');
        svgElement.classList.add('extension-icon-placeholder');
        // Ensure color follows theme
        svgElement.setAttribute('fill', 'currentColor');
        // Force stroke-based icons to adopt theme color
        const stroked = svgElement.querySelectorAll('[stroke]');
        stroked.forEach(el => el.setAttribute('stroke', 'currentColor'));
      }
    })
    .catch(error => {
      console.error(`Error loading SVG from ${svgPath}:`, error);
    });
}

// Load real extension data from backend
async function loadExtensions() {
  try {
    console.log('[Extensions] Loading extensions from backend...');
    const result = await window.electronAPI.extensions.listExtensions();
    
    if (result.success) {
      EXTENSIONS = result.extensions || [];
      initializeStates();
      renderExtensions();
      console.log(`[Extensions] Loaded ${EXTENSIONS.length} extensions`);
    } else {
      console.error('[Extensions] Failed to load extensions:', result.error);
      showStatusMessage('Failed to load extensions: ' + result.error, 'error');
    }
  } catch (error) {
    console.error('[Extensions] Error loading extensions:', error);
    showStatusMessage('Failed to load extensions', 'error');
  }
}

// Initialize extension states from loaded data
function initializeStates() {
  extensionStates = {};
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
  
  // Create icon HTML - use iconPath if available, otherwise default SVG
  const iconHTML = extension.iconPath 
    ? `<img src="${extension.iconPath}" alt="${extension.name} icon" class="extension-icon-img" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">`
    : '';
  
  card.innerHTML = `
    <div class="extension-header">
      <div class="extension-icon">
        ${iconHTML}
        <div class="extension-icon-fallback" style="${extension.iconPath ? 'display:none' : 'display:block'}"></div>
      </div>
      <h3 id="ext-${extension.id}-name" class="extension-name">${extension.name}</h3>
      <p class="extension-description">${extension.description}</p>
    </div>
    <div class="extension-actions">
      <div class="extension-buttons">
        <button type="button" class="btn btn-danger" data-action="remove" data-extension-id="${extension.id}" title="Remove extension">
          Remove
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
  
  // Load fallback SVG into the placeholder container
  const fallback = card.querySelector('.extension-icon-fallback');
  if (fallback && !extension.iconPath) {
    loadSVG(fallback, DEFAULT_ICON_SVG_PATH);
  }

  return card;
}

// Handle install from URL
async function handleInstallFromURL() {
  const urlInput = document.getElementById('install-url');
  const url = urlInput.value.trim();
  
  if (!url) {
    console.log('[Extensions] No URL entered');
    return;
  }
  
  // Show installing status
  showStatusMessage('Installing extension...', 'info');
  
  try {
    console.log(`[Extensions] Installing extension from Chrome Web Store: ${url}`);
    const result = await window.electronAPI.extensions.installFromWebStore(url);
    
    if (result.success) {
      showStatusMessage(`Extension "${result.extension.name}" installed successfully!`, 'success');
      await loadExtensions(); // Refresh list
      urlInput.value = ''; // Clear input
    } else {
      console.error('[Extensions] Installation failed:', result.error);
      showStatusMessage('Installation failed: ' + result.error, 'error');
    }
  } catch (error) {
    console.error('[Extensions] Installation error:', error);
    showStatusMessage('Installation failed', 'error');
  }
}

// Handle extension removal
async function handleRemoveExtension(extensionId) {
  const extension = EXTENSIONS.find(ext => ext.id === extensionId);
  if (!extension) return;
  
  const confirmed = confirm(`Remove "${extension.name}" extension?\n\nThis action cannot be undone.`);
  if (confirmed) {
    try {
      console.log(`[Extensions] Removing extension: ${extension.name}`);
      const result = await window.electronAPI.extensions.uninstallExtension(extensionId);
      
      if (result.success) {
        showStatusMessage(`Extension "${extension.name}" removed successfully`, 'success');
        await loadExtensions(); // Refresh list
      } else {
        console.error('[Extensions] Removal failed:', result.error);
        showStatusMessage('Failed to remove extension: ' + result.error, 'error');
      }
    } catch (error) {
      console.error('[Extensions] Removal error:', error);
      showStatusMessage('Failed to remove extension', 'error');
    }
  }
}

// Handle update all extensions
async function handleUpdateAll() {
  const updateAllBtn = document.getElementById('update-all-btn');
  if (updateAllBtn) {
    updateAllBtn.disabled = true;
  }
  showStatusMessage('Checking for extension updates…', 'info');

  try {
    const result = await window.electronAPI.extensions.updateAll();
    if (result && result.success !== false) {
      const updated = Array.isArray(result.updated) ? result.updated.length : 0;
      const skipped = Array.isArray(result.skipped) ? result.skipped.length : 0;
      const failed = Array.isArray(result.errors) ? result.errors.length : 0;
      showStatusMessage(`${updated} updated, ${skipped} skipped, ${failed} failed`, failed > 0 ? 'warning' : 'success');
      await loadExtensions();
    } else {
      const msg = result && result.error ? result.error : 'Unknown error';
      showStatusMessage(`Update failed: ${msg}`, 'error');
    }
  } catch (e) {
    console.error('[Extensions] Update All error:', e);
    showStatusMessage('Update failed', 'error');
  } finally {
    if (updateAllBtn) {
      updateAllBtn.disabled = false;
    }
  }
}

// Handle toggle changes
async function handleToggleChange(event) {
  const extensionId = event.target.dataset.extensionId;
  const isEnabled = event.target.checked;
  
  try {
    console.log(`[Extensions] Toggling extension ${extensionId}: ${isEnabled}`);
    const result = await window.electronAPI.extensions.toggleExtension(extensionId, isEnabled);
    
    if (result.success) {
      // Update local state
      extensionStates[extensionId] = isEnabled;
      const extension = EXTENSIONS.find(ext => ext.id === extensionId);
      if (extension) {
        extension.enabled = isEnabled;
        console.log(`[Extensions] Extension "${extension.name}" ${isEnabled ? 'enabled' : 'disabled'}`);
      }
    } else {
      // Revert toggle on failure
      event.target.checked = !isEnabled;
      console.error('[Extensions] Toggle failed:', result.error);
      showStatusMessage('Failed to toggle extension: ' + result.error, 'error');
    }
  } catch (error) {
    // Revert toggle on error
    event.target.checked = !isEnabled;
    console.error('[Extensions] Toggle error:', error);
    showStatusMessage('Failed to toggle extension', 'error');
  }
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
        <div class="extensions-empty-icon"></div>
        <p>No extensions installed</p>
      </div>
    `;
    // Inject SVG into the empty state icon
    const emptyIcon = container.querySelector('.extensions-empty-icon');
    if (emptyIcon) {
      loadSVG(emptyIcon, DEFAULT_ICON_SVG_PATH);
    }
    return;
  }
  
  // Create and append extension cards
  EXTENSIONS.forEach(extension => {
    const card = createExtensionCard(extension);
    container.appendChild(card);
  });
}

// Status messaging system - Same as settings.js showSettingsSavedMessage
function showStatusMessage(message, type = 'success') {
  console.log(`[Extensions] ${type.toUpperCase()}: ${message}`);
  
  // Remove any existing message
  const existingMessage = document.querySelector('.settings-saved-message');
  if (existingMessage) {
    existingMessage.remove();
  }
  
  // Create new message element with appropriate styling
  const messageEl = document.createElement('div');
  messageEl.className = `settings-saved-message ${type}`;
  messageEl.textContent = message;
  
  // Minimal styling
  messageEl.style.position = 'fixed';
  messageEl.style.top = '20px';
  messageEl.style.right = '20px';
  messageEl.style.padding = '12px 20px';
  messageEl.style.borderRadius = '6px';
  messageEl.style.fontFamily = 'Arial, sans-serif';
  messageEl.style.zIndex = '10000';
  messageEl.style.opacity = '0';
  messageEl.style.transition = 'opacity 0.2s ease-in-out';
  
  // Add type-specific styling
  if (type === 'error') {
    messageEl.style.backgroundColor = '#f44336';
    messageEl.style.color = 'white';
  } else if (type === 'warning') {
    messageEl.style.backgroundColor = '#ff9800';
    messageEl.style.color = 'white';
  } else if (type === 'info') {
    messageEl.style.backgroundColor = '#2196f3';
    messageEl.style.color = 'white';
  } else {
    messageEl.style.backgroundColor = '#0fba84';
    messageEl.style.color = 'white';
  }
  
  document.body.appendChild(messageEl);
  
  // Fade in
  setTimeout(() => {
    messageEl.style.opacity = '1';
  }, 10);
  
  const duration = type === 'error' ? 3000 : 2000;
  setTimeout(() => {
    messageEl.style.opacity = '0';
    setTimeout(() => {
      if (messageEl.parentNode) {
        messageEl.parentNode.removeChild(messageEl);
      }
    }, 300);
  }, duration);
}

// Initialize the page
async function init() {
  await loadExtensions();
  
  // Add event listener for install button
  const installBtn = document.getElementById('install-btn');
  if (installBtn) {
    installBtn.addEventListener('click', handleInstallFromURL);
  }
  
  // Add event listener for update all button
  const updateAllBtn = document.getElementById('update-all-btn');
  if (updateAllBtn) {
    updateAllBtn.addEventListener('click', handleUpdateAll);
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
