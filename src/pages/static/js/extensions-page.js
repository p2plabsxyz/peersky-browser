// Extensions page - Real backend implementation with Chrome Web Store support
// Uses IPC calls for all operations, full persistence

let EXTENSIONS = [];
let extensionStates = {};
// Track expanded description state per extension card
const extensionExpanded = {}; // { [extensionId]: boolean }

// Default extension icon (loaded from asset, not inlined)
const DEFAULT_ICON_SVG_PATH = 'peersky://static/assets/svg/default-extension-icon.svg';

function loadSVG(container, svgPath) {
  fetch(svgPath)
    .then(response => response.text())
    .then(svgContent => {
      // Strip any XML headers/comments; keep only the SVG element
      const start = svgContent.indexOf('<svg');
      const content = start >= 0 ? svgContent.slice(start) : svgContent;
      // Parse and append without using innerHTML
      const parser = new DOMParser();
      const doc = parser.parseFromString(content, 'image/svg+xml');
      const svgElement = doc && doc.querySelector('svg');
      while (container.firstChild) container.removeChild(container.firstChild);
      if (svgElement) {
        const node = svgElement.cloneNode(true);
        const isEmptyIcon = container.classList.contains('extensions-empty-icon');
        const dimension = isEmptyIcon ? '48' : '48';
        node.setAttribute('width', dimension);
        node.setAttribute('height', dimension);
        node.classList.add('extension-icon-placeholder');
        node.setAttribute('fill', 'currentColor');
        const stroked = node.querySelectorAll('[stroke]');
        stroked.forEach(el => el.setAttribute('stroke', 'currentColor'));
        container.appendChild(node);
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


// Create extension card HTML with new vertical layout (safe, no innerHTML with untrusted data)
function createExtensionCard(extension) {
  const isEnabled = extensionStates[extension.id];
  const displayName = extension.displayName || extension.name || '';
  const displayDesc = extension.displayDescription || extension.description || '';
  const isSystem = !!(extension && (extension.isSystem || extension.source === 'preinstalled' || extension.removable === false));

  const card = document.createElement('div');
  card.className = 'extension-card settings-section';
  card.setAttribute('role', 'region');
  card.setAttribute('aria-labelledby', `ext-${extension.id}-name`);
  // Default collapsed unless remembered expanded
  if (extensionExpanded[extension.id]) {
    card.classList.add('expanded');
  } else {
    card.classList.add('collapsed');
  }

  // Header
  const header = document.createElement('div');
  header.className = 'extension-header';

  const iconWrap = document.createElement('div');
  iconWrap.className = 'extension-icon';

  const iconFallback = document.createElement('div');
  iconFallback.className = 'extension-icon-fallback';

  if (extension.iconPath) {
    const img = document.createElement('img');
    img.className = 'extension-icon-img';
    img.src = extension.iconPath;
    img.alt = `${displayName} icon`;
    // On error, hide image and show fallback
    img.onerror = () => {
      img.style.display = 'none';
      iconFallback.style.display = 'block';
    };
    iconWrap.appendChild(img);
    iconFallback.style.display = 'none';
  } else {
    iconFallback.style.display = 'block';
  }
  iconWrap.appendChild(iconFallback);

  const nameEl = document.createElement('h3');
  nameEl.id = `ext-${extension.id}-name`;
  nameEl.className = 'extension-name';
  nameEl.textContent = displayName;

  // Description + Show more/less UI
  const descWrap = document.createElement('div');
  descWrap.className = 'extension-description-wrap';
  const descEl = document.createElement('p');
  descEl.className = 'extension-description';
  const descId = `ext-${extension.id}-desc`;
  descEl.id = descId;
  descEl.textContent = displayDesc;
  descWrap.appendChild(descEl);

  const showMoreBtn = document.createElement('button');
  showMoreBtn.type = 'button';
  showMoreBtn.className = 'show-more-btn';
  showMoreBtn.dataset.action = 'toggle-description';
  showMoreBtn.dataset.extensionId = extension.id;
  showMoreBtn.setAttribute('aria-controls', descId);
  // Defer text/visibility until measurement
  showMoreBtn.style.display = 'none';

  header.appendChild(iconWrap);
  header.appendChild(nameEl);
  header.appendChild(descWrap);
  header.appendChild(showMoreBtn);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'extension-actions';

  const btns = document.createElement('div');
  btns.className = 'extension-buttons';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn btn-danger';
  removeBtn.dataset.action = 'remove';
  removeBtn.dataset.extensionId = extension.id;
  removeBtn.title = isSystem ? 'Required by browser' : 'Remove extension';
  removeBtn.textContent = 'Remove';
  if (isSystem) {
    removeBtn.setAttribute('aria-disabled', 'true');
    removeBtn.classList.add('btn-disabled');
  }
  btns.appendChild(removeBtn);

  const toggleWrap = document.createElement('div');
  toggleWrap.className = 'extension-toggle';

  const label = document.createElement('label');
  label.className = 'toggle-label';
  label.setAttribute('aria-label', `Enable ${displayName}`);

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'toggle-input';
  if (isEnabled) input.checked = true;
  input.dataset.extensionId = extension.id;

  const slider = document.createElement('span');
  slider.className = 'toggle-slider';

  label.appendChild(input);
  label.appendChild(slider);
  toggleWrap.appendChild(label);

  actions.appendChild(btns);
  actions.appendChild(toggleWrap);

  // Assemble card
  card.appendChild(header);
  card.appendChild(actions);

  // Load fallback SVG into the placeholder container
  if (iconFallback && !extension.iconPath) {
    loadSVG(iconFallback, DEFAULT_ICON_SVG_PATH);
  }

  return card;
}

// Measure overflow and set up description UI for a card
function setupCardDescription(card, extension) {
  const id = extension.id;
  const wrap = card.querySelector('.extension-description-wrap');
  const desc = card.querySelector('.extension-description');
  const btn = card.querySelector('.show-more-btn');
  if (!wrap || !desc || !btn) return;

  const expanded = !!extensionExpanded[id];
  if (expanded) {
    wrap.classList.add('expanded');
    wrap.classList.remove('clamped');
    card.classList.add('expanded');
    card.classList.remove('collapsed');
    btn.textContent = 'Show less';
    btn.setAttribute('aria-expanded', 'true');
    btn.style.display = 'inline';
    return; // no need to measure when expanded
  }

  // Ensure clamped state before measuring
  wrap.classList.remove('expanded');
  wrap.classList.add('clamped');
  card.classList.add('collapsed');
  card.classList.remove('expanded');
  desc.style.display = ''; // allow CSS clamp

  // If content overflows when clamped, show button and fade
  const isOverflowing = desc.scrollHeight > desc.clientHeight + 1; // +1 to ignore rounding
  if (isOverflowing) {
    btn.textContent = 'Show more';
    btn.setAttribute('aria-expanded', 'false');
    btn.style.display = 'inline';
  } else {
    // No overflow: hide button and fade
    btn.style.display = 'none';
    wrap.classList.remove('clamped');
  }
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
      const disp = result.extension.displayName || result.extension.name || 'Extension';
      showStatusMessage(`Extension "${disp}" installed successfully!`, 'success');
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

// Handle install from local file (drop zone or file picker)
async function handleInstallFromFilePath(filePath) {
  if (!filePath) return;
  showStatusMessage('Installing from file…', 'info');
  try {
    const result = await window.electronAPI.extensions.installExtension(filePath);
    if (result && result.success !== false) {
      const warnCount = result.extension?.warnings?.length || 0;
      const msg = warnCount > 0 ? `Extension installed with ${warnCount} warning${warnCount>1?'s':''}` : 'Extension installed successfully';
      showStatusMessage(msg, warnCount > 0 ? 'warning' : 'success');
      await loadExtensions();
    } else {
      const msg = result && result.error ? result.error : 'Unknown error';
      showStatusMessage(`Install failed: ${msg}`, 'error');
    }
  } catch (e) {
    console.error('[Extensions] File install error:', e);
    showStatusMessage('Install failed', 'error');
  }
}

// Handle extension removal
async function handleRemoveExtension(extensionId) {
  const extension = EXTENSIONS.find(ext => ext.id === extensionId);
  if (!extension) return;
  
  const disp = extension.displayName || extension.name || 'Extension';
  const confirmed = confirm(`Remove "${disp}" extension?\n\nThis action cannot be undone.`);
  if (confirmed) {
    try {
      console.log(`[Extensions] Removing extension: ${disp}`);
      const result = await window.electronAPI.extensions.uninstallExtension(extensionId);
      
      if (result.success) {
        showStatusMessage(`Extension "${disp}" removed successfully`, 'success');
        try {
          await window.electronAPI.extensions.unpinExtension(extensionId);
        } catch (unpinError) {
          console.warn('Failed to unpin extension during removal:', unpinError);
        }
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
        const disp = extension.displayName || extension.name || 'Extension';
        console.log(`[Extensions] Extension "${disp}" ${isEnabled ? 'enabled' : 'disabled'}`);
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
  const userContainer = document.getElementById('user-extensions-grid');
  const systemContainer = document.getElementById('system-extensions-grid');
  if (!userContainer || !systemContainer) {
    console.error('Extension grids not found');
    return;
  }

  // Clear both containers
  while (userContainer.firstChild) userContainer.removeChild(userContainer.firstChild);
  while (systemContainer.firstChild) systemContainer.removeChild(systemContainer.firstChild);

  if (EXTENSIONS.length === 0) {
    // Empty state only in user section
    const empty = document.createElement('div');
    empty.className = 'extensions-empty';
    const icon = document.createElement('div');
    icon.className = 'extensions-empty-icon';
    const msg = document.createElement('p');
    msg.textContent = 'No extensions installed';
    empty.appendChild(icon);
    empty.appendChild(msg);
    userContainer.appendChild(empty);
    loadSVG(icon, DEFAULT_ICON_SVG_PATH);
    return;
  }

  const userExts = [];
  const systemExts = [];
  for (const ext of EXTENSIONS) {
    const sys = !!(ext && (ext.isSystem || ext.source === 'preinstalled' || ext.removable === false));
    (sys ? systemExts : userExts).push(ext);
  }

  const appendTo = (list, container) => {
    if (!Array.isArray(list) || !container) return;
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'extensions-empty';
      const icon = document.createElement('div');
      icon.className = 'extensions-empty-icon';
      const msg = document.createElement('p');
      msg.textContent = 'None';
      empty.appendChild(icon);
      empty.appendChild(msg);
      container.appendChild(empty);
      loadSVG(icon, DEFAULT_ICON_SVG_PATH);
      return;
    }
    list.forEach((extension) => {
      const card = createExtensionCard(extension);
      container.appendChild(card);
      requestAnimationFrame(() => {
        try { setupCardDescription(card, extension); } catch (_) {}
      });
    });
  };

  appendTo(userExts, userContainer);
  appendTo(systemExts, systemContainer);
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
  
  // Add event delegation for both extension grids
  const containers = [
    document.getElementById('user-extensions-grid'),
    document.getElementById('system-extensions-grid')
  ].filter(Boolean);
  containers.forEach((container) => {
    container.addEventListener('change', (event) => {
      if (event.target.classList.contains('toggle-input')) {
        handleToggleChange(event);
      }
    });
    container.addEventListener('click', (event) => {
      if (event.target.dataset.action === 'remove') {
        handleRemoveExtension(event.target.dataset.extensionId);
      } else if (event.target.dataset && event.target.dataset.action === 'toggle-description') {
        const id = event.target.dataset.extensionId;
        const card = event.target.closest('.extension-card');
        if (!id || !card) return;
        // Flip state
        extensionExpanded[id] = !extensionExpanded[id];
        // Try to keep focus on the button after reconfiguring
        try { setupCardDescription(card, { id }); } catch (e) { /* ignore */ }
      }
    });
  });
  
  // Focus management
  const firstToggle = document.querySelector('.toggle-input');
  if (firstToggle) {
    // Make first extension toggle focusable for keyboard navigation
    firstToggle.setAttribute('tabindex', '0');
  }

  // Drag-and-drop and file picker for local installs
  const dropZone = document.getElementById('extensions-drop-zone');
  if (dropZone) {
    const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
    ['dragenter','dragover','dragleave','drop'].forEach(evt => dropZone.addEventListener(evt, prevent));
    dropZone.addEventListener('dragover', () => {
      dropZone.style.borderColor = 'var(--settings-border-hover)';
      dropZone.style.color = 'var(--settings-text-primary)';
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.style.borderColor = 'var(--settings-border)';
      dropZone.style.color = 'var(--settings-text-secondary)';
    });
    dropZone.addEventListener('drop', async (e) => {
      const file = e.dataTransfer?.files?.[0];
      dropZone.style.borderColor = 'var(--settings-border)';
      dropZone.style.color = 'var(--settings-text-secondary)';
      if (!file) return;
      const lower = String(file.name || '').toLowerCase();
      if (!(lower.endsWith('.zip') || lower.endsWith('.crx') || lower.endsWith('.crx3'))) {
        showStatusMessage('Unsupported file type. Select a .zip or .crx', 'warning');
        return;
      }
      try {
        // Prefer blob upload path for reliability regardless of file.path availability
        const buf = await file.arrayBuffer();
        const resp = await window.electronAPI.extensions.installFromBlob(file.name, buf);
        if (resp && resp.success !== false) {
          const warnCount = resp.extension?.warnings?.length || 0;
          const msg = warnCount > 0 ? `Extension installed with ${warnCount} warning${warnCount>1?'s':''}` : 'Extension installed successfully';
          showStatusMessage(msg, warnCount > 0 ? 'warning' : 'success');
          await loadExtensions();
        } else {
          const msg = resp && resp.error ? resp.error : 'Unknown error';
          showStatusMessage(`Install failed: ${msg}`, 'error');
        }
      } catch (err) {
        console.error('[Extensions] DnD upload install error:', err);
        showStatusMessage('Install failed', 'error');
      }
    });

    // Click to open file dialog
    dropZone.addEventListener('click', async () => {
      try {
        const resp = await window.electronAPI.extensions.openInstallFileDialog();
        if (resp && resp.success && resp.path) {
          await handleInstallFromFilePath(resp.path);
        }
      } catch (e) {
        console.error('[Extensions] Open dialog error:', e);
      }
    });
  }

  const fileInput = document.getElementById('extensions-file-input');
  if (fileInput) {
    // Keep file input as a fallback and use blob upload if path is not available
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) {
        if (file.path) {
          await handleInstallFromFilePath(file.path);
        } else {
          const lower = String(file.name || '').toLowerCase();
          if (!(lower.endsWith('.zip') || lower.endsWith('.crx') || lower.endsWith('.crx3'))) {
            showStatusMessage('Unsupported file type. Select a .zip or .crx', 'warning');
            return;
          }
          try {
            const buf = await file.arrayBuffer();
            const resp = await window.electronAPI.extensions.installFromBlob(file.name, buf);
            if (resp && resp.success !== false) {
              const warnCount = resp.extension?.warnings?.length || 0;
              const msg = warnCount > 0 ? `Extension installed with ${warnCount} warning${warnCount>1?'s':''}` : 'Extension installed successfully';
              showStatusMessage(msg, warnCount > 0 ? 'warning' : 'success');
              await loadExtensions();
            } else {
              const msg = resp && resp.error ? resp.error : 'Unknown error';
              showStatusMessage(`Install failed: ${msg}`, 'error');
            }
          } catch (e) {
            console.error('[Extensions] File input upload error:', e);
            showStatusMessage('Install failed', 'error');
          }
        }
        fileInput.value = '';
      }
    });
  }
}

// Re-measure clamped overflows on resize for non-expanded cards
let _resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    try {
      const root = document;
      const cards = Array.from(root.querySelectorAll('#user-extensions-grid .extension-card, #system-extensions-grid .extension-card'));
      cards.forEach((card) => {
        const id = card.querySelector('.show-more-btn')?.dataset?.extensionId;
        if (!id) return;
        // Only re-measure when not expanded
        if (!extensionExpanded[id]) {
          setupCardDescription(card, { id });
        }
      });
    } catch (e) {
      // noop
    }
  }, 150);
});

// Initialize when DOM is loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
