/**
 * Settings Page JavaScript - Unified Preload Frontend
 * 
 * Secure settings interface using unified preload script with context-aware API exposure.
 * Receives full electronAPI access when on settings pages with comprehensive fallbacks.
 * 
 */

let settingsAPI;
let eventCleanupFunctions = [];
let navigationInProgress = false;

function validateSearchTemplate(tpl) {
  if (typeof tpl !== "string")
    return { valid: false, reason: "Template must be a string." };

  const s = tpl.trim();
  if (!s) return { valid: false, reason: "Template cannot be empty." };

  try {
    new URL(s); // just test if it's a valid URL structure
    return { valid: true };
  } catch {
    return { valid: false, reason: "Template must be a valid URL." };
  }
}

function setTemplateFieldState(inputEl, messageEl, state) {
  inputEl.classList.remove("invalid", "valid");
  messageEl.classList.remove("error", "success");

  if (state.valid) {
    inputEl.classList.add("valid");
    messageEl.classList.add("success");
    messageEl.innerHTML =
      "✅ Press <b>Enter</b> to set this custom search engine.";
  } else {
    inputEl.classList.add("invalid");
    messageEl.classList.add("error");
    messageEl.textContent = state.reason || "Invalid template.";
  }
}

/**
 * Checks if the provided search template matches any built-in search engine.
 * @param {string} tpl - The custom search template URL.
 * @returns {boolean} - True if it's a built-in search engine, otherwise false.
 */
async function isBuiltInSearchEngine(tpl) {
  try {
    if (!window.electronAPI?.onCheckBuiltInEngine) {
      console.warn("onCheckBuiltInEngine API not available in this context");
      return false;
    }

    const result = await window.electronAPI.onCheckBuiltInEngine(tpl);
    return result;
  } catch (err) {
    console.error('IPC check failed:', err);
    return false;
  }
}

// Initialize API access with fallback handling
function initializeAPI() {
  console.log('Settings: Attempting to initialize API...');
  console.log('Settings: window.electronAPI available:', !!window.electronAPI);
  console.log('Settings: window.peersky available:', !!window.peersky);
  
  // Primary: unified preload electronAPI (for settings pages)
  if (window.electronAPI?.settings) {
    console.log('Settings: Using electronAPI from unified preload');
    settingsAPI = window.electronAPI;
    return true;
  }
  
  // Secondary: peersky API (fallback if context detection fails)
  if (window.peersky?.settings) {
    console.log('Settings: Using peersky.settings API');
    settingsAPI = {
      settings: window.peersky.settings,
      ...window.peersky.events,
      readCSS: window.peersky.css?.readCSS
    };
    return true;
  }
  
  // Fallback: Direct IPC (development mode)
  if (window.electronIPC) {
    settingsAPI = createFallbackAPI(window.electronIPC);
    return true;
  }
  
  // Legacy fallbacks
  const ipcSources = [
    () => require('electron').ipcRenderer,
    () => parent.require('electron').ipcRenderer,
    () => top.require('electron').ipcRenderer
  ];
  
  for (const getIPC of ipcSources) {
    try {
      const ipc = getIPC();
      if (ipc) {
        settingsAPI = createFallbackAPI(ipc);
        return true;
      }
    } catch (e) {
      // Continue to next fallback
    }
  }
  
  return false;
}

function openResetP2PModal() {
  return new Promise((resolve) => {
    const $ = (h) => {
      const t = document.createElement('template');
      t.innerHTML = h.trim();
      return t.content.firstChild;
    };

    const backdrop = $('<div class="modal-backdrop"></div>');
    const modal = $(`
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="reset-title">
        <div class="modal-header">
          <h3 id="reset-title" class="modal-title">Reset P2P Data</h3>
        </div>

        <div class="modal-body">
          <div class="copy">
            This will clear all IPFS/Hyper/BitTorrent data while <span class="emphasis">preserving</span> your peer identities by default.
          </div>

          <label class="checkbox-row">
            <input type="checkbox" id="modal-reset-identities">
            <span>
              Also reset identities (<code>libp2p-key</code> & <code>swarm-keypair.json</code>) — not recommended
            </span>
          </label>
        </div>

        <div class="modal-actions">
          <button class="btn-ghost" id="modal-cancel">Cancel <span class="kbd">Esc</span></button>
          <button class="btn-warning-solid" id="modal-confirm">Reset</button>
        </div>
      </div>
    `);

    document.body.append(backdrop, modal);

    const confirmBtn = modal.querySelector('#modal-confirm');
    const cancelBtn  = modal.querySelector('#modal-cancel');
    const idsCb      = modal.querySelector('#modal-reset-identities');

    // Toggle confirm button style (warning ↔ danger) based on checkbox
    const updateConfirmStyle = () => {
      confirmBtn.classList.toggle('btn-danger-solid', idsCb.checked);
      confirmBtn.classList.toggle('btn-warning-solid', !idsCb.checked);
    };
    idsCb.addEventListener('change', updateConfirmStyle);
    updateConfirmStyle();

    const cleanup = () => {
      modal.remove();
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') { cleanup(); resolve({ confirmed: false }); }
      if (e.key === 'Enter')  { doConfirm(); }
      if (e.key === 'Tab') {
        // simple focus trap
        const order = [idsCb, cancelBtn, confirmBtn];
        const idx = order.indexOf(document.activeElement);
        const next = (idx + (e.shiftKey ? -1 : 1) + order.length) % order.length;
        order[next].focus();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', onKey);

    const doConfirm = () => {
      confirmBtn.disabled = true;
      const resetIdentities = !!idsCb.checked;
      cleanup();
      resolve({ confirmed: true, resetIdentities });
    };

    cancelBtn.addEventListener('click', () => { cleanup(); resolve({ confirmed: false }); });
    confirmBtn.addEventListener('click', doConfirm);

    // initial focus
    setTimeout(() => idsCb.focus(), 10);
  });
}


// Create fallback API wrapper
function createFallbackAPI(ipc) {
  const wrapCallback = (eventName, callback) => {
    const wrappedCallback = (event, ...args) => callback(...args);
    ipc.on(eventName, wrappedCallback);
    return () => ipc.removeListener(eventName, wrappedCallback);
  };

  return {
    settings: {
      getAll: () => ipc.invoke('settings-get-all'),
      get: (key) => ipc.invoke('settings-get', key),
      set: (key, value) => ipc.invoke('settings-set', key, value),
      reset: () => ipc.invoke('settings-reset'),
      clearBrowserCache: () => ipc.invoke('settings-clear-cache'),
      resetP2P: (opts = {}) => ipc.invoke('settings-reset-p2p', opts),
      uploadWallpaper: (filePath) => ipc.invoke('settings-upload-wallpaper', filePath)
    },
    onThemeChanged: (callback) => wrapCallback('theme-changed', callback),
    onSearchEngineChanged: (callback) => wrapCallback('search-engine-changed', callback),
    onShowClockChanged: (callback) => wrapCallback('show-clock-changed', callback),
    onWallpaperChanged: (callback) => wrapCallback('wallpaper-changed', callback)
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize API access
  if (!initializeAPI()) {
    console.error('Settings: No API access available - settings will not persist');
    showSettingsSavedMessage('Settings API not available', 'error');
    loadDefaultSettings();
    return;
  }
  
  // Set up event listeners with cleanup tracking
  try {
    if (settingsAPI.onThemeChanged) {
      const cleanup1 = settingsAPI.onThemeChanged((newTheme) => {
        const themeToggle = document.getElementById('theme-toggle');
        if (themeToggle && themeToggle.value !== newTheme) {
          themeToggle.value = newTheme;
          updateCustomDropdownDisplays();
        }
        // Theme variables update automatically with unified theme system
        // reloadThemeCSS(); // No longer needed
      });
      eventCleanupFunctions.push(cleanup1);
    }
    
    if (settingsAPI.onSearchEngineChanged) {
      const cleanup2 = settingsAPI.onSearchEngineChanged((newEngine) => {
        const searchEngine = document.getElementById('search-engine');
        if (searchEngine && searchEngine.value !== newEngine) {
          searchEngine.value = newEngine;
          updateCustomDropdownDisplays();
        }

        // Toggle the Custom URL row live when engine changes
        const row = document.getElementById("custom-search-row");
        if (row) {
          row.style.display = newEngine === "custom" ? "" : "none";
        }
      });
      eventCleanupFunctions.push(cleanup2);
    }
    
    if (settingsAPI.onShowClockChanged) {
      const cleanup3 = settingsAPI.onShowClockChanged((showClock) => {
        const clockToggle = document.getElementById('show-clock');
        if (clockToggle && clockToggle.checked !== showClock) {
          clockToggle.checked = showClock;
        }
      });
      eventCleanupFunctions.push(cleanup3);
    }
    
    if (settingsAPI.onWallpaperChanged) {
      const cleanup4 = settingsAPI.onWallpaperChanged((wallpaperType) => {
        const wallpaperSelector = document.getElementById('wallpaper-selector');
        if (wallpaperSelector && wallpaperSelector.value !== wallpaperType) {
          wallpaperSelector.value = wallpaperType;
          updateCustomDropdownDisplays();
        }
      });
      eventCleanupFunctions.push(cleanup4);
    }

    if (settingsAPI.onVerticalTabsChanged) {
      const cleanup4 = settingsAPI.onVerticalTabsChanged((enabled) => {
        const verticalToggle = document.getElementById('vertical-tabs');
        if (verticalToggle && verticalToggle.checked !== enabled) {
          verticalToggle.checked = enabled;
        }
      });
      eventCleanupFunctions.push(cleanup4);
    }
  } catch (error) {
    console.error('Settings: Failed to set up event listeners:', error);
  }
  
  // Initialize sidebar navigation
  initializeSidebarNavigation();
  
  // Initialize custom dropdowns
  initializeCustomDropdowns();
  
  // Get form elements
  const searchEngine = document.getElementById('search-engine');
  const customSearchRow = document.getElementById("custom-search-row");
  const customSearchTemplate = document.getElementById(
    "custom-search-template"
  );
  const customSearchMessage = document.getElementById("custom-search-message");

  const themeToggle = document.getElementById('theme-toggle');
  const showClock = document.getElementById('show-clock');
  const verticalTabs = document.getElementById('vertical-tabs');
  const keepTabsExpanded = document.getElementById('keep-tabs-expanded');
  const wallpaperSelector = document.getElementById('wallpaper-selector');
  const wallpaperFile = document.getElementById('wallpaper-file');
  const wallpaperBrowse = document.getElementById('wallpaper-browse');
  const wallpaperRemove = document.getElementById('wallpaper-remove');
  const wallpaperPreview = document.getElementById('wallpaper-preview');
  const clearBrowserCacheBtn = document.getElementById('clear-browser-cache');
  const resetP2PBtn = document.getElementById('reset-p2p');
  // Handle built-in wallpaper selector change
  wallpaperSelector?.addEventListener('change', async (e) => {
    const selectedValue = e.target.value;
    console.log('Built-in wallpaper changed to:', selectedValue);
    await saveSettingToBackend('wallpaper', selectedValue);
  });

  // Handle browse button click
  wallpaperBrowse?.addEventListener('click', () => {
    wallpaperFile.click();
  });

  // Handle remove custom wallpaper
  wallpaperRemove?.addEventListener('click', async () => {
    if (confirm('Remove custom wallpaper and switch to default?')) {
      try {
        // Switch back to default wallpaper
        await saveSettingToBackend('wallpaper', 'redwoods');
        
        // Update UI
        wallpaperSelector.value = 'redwoods';
        updateCustomDropdownDisplays();
        updateCustomWallpaperUI(false);
        
        showSettingsSavedMessage('Custom wallpaper removed', 'success');
      } catch (error) {
        console.error('Failed to remove custom wallpaper:', error);
        showSettingsSavedMessage('Failed to remove custom wallpaper', 'error');
      }
    }
  });

  // Handle wallpaper file selection
  wallpaperFile?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      try {
        console.log('Selected wallpaper file:', file.name);
        
        // Check if settingsAPI supports wallpaper upload
        if (!settingsAPI.settings.uploadWallpaper) {
          showSettingsSavedMessage('Wallpaper upload not supported', 'error');
          return;
        }
        
        // Validate file size (max 10MB)
        if (file.size > 10 * 1024 * 1024) {
          showSettingsSavedMessage('File too large. Please select an image smaller than 10MB.', 'error');
          return;
        }
        
        showSettingsSavedMessage('Uploading wallpaper...', 'warning');
        
        // Read file content using FileReader
        const fileContent = await readFileAsBase64(file);
        
        // Upload wallpaper using file data
        const result = await settingsAPI.settings.uploadWallpaper({
          name: file.name,
          content: fileContent
        });
        
        if (result.success) {
          // Update UI to show custom wallpaper is active
          updateCustomWallpaperUI(true);
          
          showSettingsSavedMessage('Wallpaper uploaded successfully!', 'success');
          console.log('Wallpaper uploaded:', result.path);
        } else {
          showSettingsSavedMessage('Failed to upload wallpaper', 'error');
        }
        
      } catch (error) {
        console.error('Failed to upload wallpaper:', error);
        showSettingsSavedMessage(`Failed to upload wallpaper: ${error.message}`, 'error');
      }
    }
  });

  // Handle clear cache button
  clearBrowserCacheBtn?.addEventListener('click', async () => {
    if (!settingsAPI?.settings?.clearBrowserCache) return;
    if (!confirm('Clear browser cache? This removes website cache, cookies, and temporary storage.')) return;

    try {
      clearBrowserCacheBtn.disabled = true;
      const res = await settingsAPI.settings.clearBrowserCache();
      showSettingsSavedMessage(res?.message || 'Browser cache cleared', 'success');
    } catch (err) {
      console.error(err);
      showSettingsSavedMessage(`Failed to clear browser cache: ${err.message}`, 'error');
    } finally {
      clearBrowserCacheBtn.disabled = false;
    }
  });

  resetP2PBtn?.addEventListener('click', async () => {
    const choice = await openResetP2PModal(); // { confirmed, resetIdentities }
    if (!choice?.confirmed) return;

    try {
      resetP2PBtn.disabled = true;
      const res = await settingsAPI.settings.resetP2P({ resetIdentities: !!choice.resetIdentities });
      showSettingsSavedMessage(res?.message || 'P2P data reset', 'success');
    } catch (err) {
      console.error(err);
      showSettingsSavedMessage(`Failed to reset P2P data: ${err.message}`, 'error');
    } finally {
      resetP2PBtn.disabled = false;
    }
  });

  // Add change listeners for form elements
   searchEngine?.addEventListener("change", async (e) => {
    const value = e.target.value;
    console.log("Search engine changed (UI):", value);

    if (value === "custom") {
      // Show inline input/modal, but do NOT save the engine yet
      if (customSearchRow) customSearchRow.style.display = "";
      // optional UX: prefill from existing template and focus
      customSearchTemplate?.focus();
      customSearchTemplate?.select?.();
      return; // do NOT call settings.set('searchEngine', 'custom') yet
    }

    // For all non-custom engines, persist immediately and hide the row
    await saveSettingToBackend("searchEngine", value);
    if (customSearchRow) customSearchRow.style.display = "none";
  });

  customSearchTemplate?.addEventListener("input", async () => {
      const tpl = customSearchTemplate.value.trim();
      const state = validateSearchTemplate(tpl);

       const isBuiltIn = await isBuiltInSearchEngine(tpl);


      if (isBuiltIn) {
        state.valid = false;
        state.reason = "This search engine already exists in the browser.";
      }

      setTemplateFieldState(customSearchTemplate, customSearchMessage, state);
  });

  // Save custom search template on Enter
  customSearchTemplate?.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const tpl = customSearchTemplate.value.trim();
    const state = validateSearchTemplate(tpl);

    const isBuiltIn = await isBuiltInSearchEngine(tpl);

    if (isBuiltIn) {
      state.valid = false;
      state.reason = "This search engine already exists in the browser.";
    }
    setTemplateFieldState(customSearchTemplate, customSearchMessage, state);
    if (!state.valid) return;


  // 🚫 Check for built-in search engines
  if (isBuiltIn) {
    customSearchMessage.style.display = "block";
    customSearchMessage.textContent = "This search engine already exists in the browser.";
    return;
  }

    try {
      // Save template first
      await saveSettingToBackend("customSearchTemplate", tpl);
      // Then set engine to custom (only now)
      if (searchEngine && searchEngine.value !== "custom") {
        searchEngine.value = "custom";
      }
      await saveSettingToBackend("searchEngine", "custom");

      // ✅ Hide the helper message once successfully set
      customSearchMessage.textContent = "";
      customSearchMessage.style.display = "none";

      if (customSearchRow) customSearchRow.style.display = "";
      showSettingsSavedMessage("Custom search template saved", "success");
    } catch (err) {
      console.error(err);
      showSettingsSavedMessage("Failed to save custom template", "error");
    }
  });

  themeToggle?.addEventListener('change', async (e) => {
    console.log('Theme changed:', e.target.value);
    
    // Apply theme immediately for instant feedback
    applyThemeImmediately(e.target.value);
    
    await saveSettingToBackend('theme', e.target.value);
  });

  showClock?.addEventListener('change', async (e) => {
    console.log('Show clock changed:', e.target.checked);
    await saveSettingToBackend('showClock', e.target.checked);
  });

  verticalTabs?.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    console.log('Vertical tabs changed:', enabled);
    await saveSettingToBackend('verticalTabs', enabled);
    try {
      if (enabled) {
        settingsAPI.hideTabComponents?.();
      } else {
        settingsAPI.loadTabComponents?.();
      }
    } catch (err) {
      console.error('Failed to toggle tab components:', err);
    }
  });

  keepTabsExpanded?.addEventListener('change', async (e) => {
    const keepExpanded = e.target.checked;
    console.log('Keep tabs expanded changed:', keepExpanded);
    await saveSettingToBackend('keepTabsExpanded', keepExpanded);
  });

  // Initialize custom wallpaper UI state
  updateCustomWallpaperUI(false);
  
  // Initialize LLM settings handlers
  initializeLLMSettings();
  
  // Load settings from backend
  loadSettingsFromBackend();
});

function loadDefaultSettings() {
  const searchEngine = document.getElementById('search-engine');
  const themeToggle = document.getElementById('theme-toggle');
  const showClock = document.getElementById('show-clock');
  const verticalTabs = document.getElementById('vertical-tabs');
  const keepTabsExpanded = document.getElementById('keep-tabs-expanded');
  const wallpaperSelector = document.getElementById('wallpaper-selector');
  
  if (searchEngine) searchEngine.value = 'duckduckgo_noai';
  if (themeToggle) themeToggle.value = 'dark';
  if (showClock) showClock.checked = true;
  if (verticalTabs) verticalTabs.checked = false;
  if (keepTabsExpanded) keepTabsExpanded.checked = false;
  if (wallpaperSelector) wallpaperSelector.value = 'redwoods';
}

// Load settings from backend
async function loadSettingsFromBackend() {
  if (!settingsAPI?.settings) {
    console.warn('Settings: API not available, using defaults');
    loadDefaultSettings();
    return;
  }
  
  try {
    const settings = await settingsAPI.settings.getAll();
    populateFormFields(settings);
  } catch (error) {
    console.error('Settings: Failed to load settings:', error);
    showSettingsSavedMessage(`Failed to load settings: ${error.message}`, 'error');
    loadDefaultSettings();
  }
}

// Populate form fields with settings data
function populateFormFields(settings) {
  const searchEngine = document.getElementById("search-engine");
  const customSearchRow = document.getElementById("custom-search-row"); 
  const customSearchTemplate = document.getElementById(
    "custom-search-template"
  );
  const customSearchMessage = document.getElementById("custom-search-message");


  const themeToggle = document.getElementById('theme-toggle');
  const showClock = document.getElementById('show-clock');
  const verticalTabs = document.getElementById('vertical-tabs');
  const keepTabsExpanded = document.getElementById('keep-tabs-expanded');
  const wallpaperSelector = document.getElementById('wallpaper-selector');
  
  if (searchEngine && settings.searchEngine) {
    searchEngine.value = settings.searchEngine;
  }

  // Show/hide the custom row based on saved engine
  if (customSearchRow) {
    customSearchRow.style.display =
      settings.searchEngine === "custom" ? "" : "none";
  }

  // Prefill template input
  if (customSearchTemplate) {
    const tpl = settings.customSearchTemplate || "https://duckduckgo.com/?q=%s";
    customSearchTemplate.value = tpl;

    const state = validateSearchTemplate(tpl);

    // Apply only visual input state (valid/invalid)…
    customSearchTemplate.classList.remove("invalid", "valid");
    if (state.valid) customSearchTemplate.classList.add("valid");
    else customSearchTemplate.classList.add("invalid");

    // …and control the message based on whether the engine is already set
    // If engine is already 'custom' and template is valid, HIDE the message.
    if (settings.searchEngine === "custom" && state.valid) {
      customSearchMessage.textContent = "";
      customSearchMessage.classList.remove("error", "success");
      customSearchMessage.style.display = "none";
    } else {
      // Otherwise show the neutral hint (not the success text)
      customSearchMessage.style.display = "";
      customSearchMessage.classList.remove("error", "success");
      customSearchMessage.innerHTML = 'Please include a placeholder for the search term. If none, the browser will automatically add a search query parameter <code>?q=</code>.';
    }
  }

  if (themeToggle && settings.theme) {
    themeToggle.value = settings.theme;
    
    // Apply theme immediately on page load (no transition disabling for settings)
    applyThemeImmediately(settings.theme);
  }
  if (showClock && typeof settings.showClock === 'boolean') {
    showClock.checked = settings.showClock;
  }
  if (verticalTabs && typeof settings.verticalTabs === 'boolean') {
    verticalTabs.checked = settings.verticalTabs;
  }
  if (keepTabsExpanded && typeof settings.keepTabsExpanded === 'boolean') {
    keepTabsExpanded.checked = settings.keepTabsExpanded;
  }
  if (wallpaperSelector && settings.wallpaper) {
    // Only set built-in wallpaper values, ignore custom
    if (settings.wallpaper === 'redwoods' || settings.wallpaper === 'mountains') {
      wallpaperSelector.value = settings.wallpaper;
    } else if (settings.wallpaper === 'custom') {
      // For custom wallpaper, show custom UI but keep built-in selector unchanged
      updateCustomWallpaperUI(true);
    }
  }
  
  // Populate LLM settings (supports both Ollama and OpenRouter)
  if (settings.llm) {
    const llmEnabled = document.getElementById('llm-enabled');
    const llmConfig = document.getElementById('llm-config');
    const ollamaUrl = document.getElementById('ollama-url');
    const apiKey = document.getElementById('api-key');
    const ollamaModel = document.getElementById('ollama-model');
    
    if (llmEnabled) {
      llmEnabled.checked = settings.llm.enabled || false;
      if (llmConfig) {
        llmConfig.style.display = settings.llm.enabled ? 'block' : 'none';
      }
    }
    
    if (ollamaUrl && settings.llm.baseURL) {
      ollamaUrl.value = settings.llm.baseURL;
    }
    
    if (apiKey && settings.llm.apiKey) {
      // Mask API key if it's not 'ollama'
      if (settings.llm.apiKey !== 'ollama') {
        apiKey.type = 'password';
        apiKey.value = settings.llm.apiKey;
      } else {
        apiKey.type = 'text';
        apiKey.value = settings.llm.apiKey;
      }
    }
    
    if (ollamaModel && settings.llm.model) {
      ollamaModel.value = settings.llm.model;
    }
  }
  
  // Update custom dropdown displays after loading settings
  updateCustomDropdownDisplays();
  
  // Remove any remaining loader
  const loader = document.getElementById('theme-loader');
  if (loader) {
    loader.style.opacity = '0';
    setTimeout(() => loader.remove(), 200);
  }
  
  console.log('Form fields populated with settings');
}

async function saveSettingToBackend(key, value) {
  if (!settingsAPI?.settings) {
    console.warn('Settings: API not available, setting not saved:', key, value);
    showSettingsSavedMessage('Settings not available', 'error');
    return;
  }
  
  try {
    const result = await settingsAPI.settings.set(key, value);
    
    // Create user-friendly success messages
    const successMessages = {
      'searchEngine': 'Search engine updated successfully!',
      'customSearchTemplate': "Custom template updated successfully!",
      'theme': 'Theme updated successfully!',
      'showClock': 'Clock setting updated successfully!',
      'wallpaper': 'Wallpaper updated successfully!',
      'verticalTabs': 'Vertical tabs setting updated successfully!'
    };
    
    const message = successMessages[key] || `${key} updated successfully!`;
    showSettingsSavedMessage(message, 'success');
    return result;
  } catch (error) {
    console.error('Settings: Failed to save setting:', error);
    
    // Create user-friendly error messages
    const errorMessages = {
      'searchEngine': 'Failed to save search engine setting',
      'customSearchTemplate': "Failed to save custom template",
      'theme': 'Failed to save theme setting',
      'showClock': 'Failed to save clock setting',
      'wallpaper': 'Failed to save wallpaper setting',
      'verticalTabs': 'Failed to save vertical tabs setting'
    };
    
    const errorMessage = errorMessages[key] || `Failed to save ${key} setting`;
    showSettingsSavedMessage(`${errorMessage}: ${error.message}`, 'error');
    
    // Reload settings to sync UI with backend state
    await loadSettingsFromBackend();
    throw error;
  }
}

async function resetSettingsToDefaults() {
  if (!settingsAPI?.settings) {
    console.warn('Settings: API not available, cannot reset settings');
    showSettingsSavedMessage('Settings not available', 'error');
    return;
  }
  
  if (!confirm('Are you sure you want to reset all settings to defaults? This cannot be undone.')) {
    return;
  }
  
  try {
    const result = await settingsAPI.settings.reset();
    await loadSettingsFromBackend();
    showSettingsSavedMessage('Settings have been reset to defaults', 'success');
    return result;
  } catch (error) {
    console.error('Settings: Failed to reset settings:', error);
    showSettingsSavedMessage(`Failed to reset settings: ${error.message}`, 'error');
    throw error;
  }
}

// Apply theme immediately to current page for instant feedback
function applyThemeImmediately(themeName) {
  try {
    // Set theme attribute FIRST for immediate variable updates
    document.documentElement.setAttribute('data-theme', themeName);
    
    // Remove old theme classes (legacy support)
    document.documentElement.classList.remove(...Array.from(document.documentElement.classList).filter(c => c.startsWith('theme-')));
    
    console.log('Theme applied immediately:', themeName);
  } catch (error) {
    console.error('Failed to apply theme immediately:', error);
  }
}

// Sidebar navigation functionality for page switching
function initializeSidebarNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const pages = document.querySelectorAll('.settings-page');
  
  // Handle nav clicks for page switching
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      const sectionName = item.getAttribute('data-section');
      
      // If no data-section attribute, allow normal navigation (for external links like bookmarks)
      if (!sectionName) {
        return; // Allow default behavior
      }
      
      e.preventDefault();
      navigateToSection(sectionName);
    });
  });
  
  // Parse URL subpath and navigate to appropriate section
  const currentPath = window.location.pathname || window.location.hash;
  const currentHref = window.location.href;
  let targetSection = 'appearance'; // default
  
  // Check for URL subpath (e.g., /settings/search or peersky://settings/search)
  const subpathMatch = currentPath.match(/\/settings\/(\w+)/) || currentHref.match(/\/settings\/(\w+)/);
  if (subpathMatch) {
    targetSection = subpathMatch[1];
  }
  // Check for hash-based navigation (backward compatibility)
  else if (currentPath.includes('#')) {
    const hashSection = currentPath.replace('#', '');
    if (hashSection && ['appearance', 'search','tabs', 'extensions'].includes(hashSection)) {
      targetSection = hashSection;
    }
  }
  
  // Update UI to show the determined section (don't trigger navigation on page load)
  updateSectionUI(targetSection);
  
  // Handle browser back/forward navigation
  window.addEventListener('popstate', (event) => {
    let sectionFromHistory = 'appearance'; // default
    
    if (event.state && event.state.section) {
      sectionFromHistory = event.state.section;
    } else {
      // Parse current URL to determine section
      const currentPath = window.location.pathname || window.location.hash;
      const currentHref = window.location.href;
      const subpathMatch = currentPath.match(/\/settings\/(\w+)/) || currentHref.match(/\/settings\/(\w+)/);
      if (subpathMatch) {
        sectionFromHistory = subpathMatch[1];
      } else if (currentPath.includes('#')) {
        const hashSection = currentPath.replace('#', '');
        if (hashSection && ['appearance', 'search', 'extensions'].includes(hashSection)) {
          sectionFromHistory = hashSection;
        }
      }
    }
    
    updateSectionUI(sectionFromHistory);
  });
}

// Navigate to a specific settings section
function navigateToSection(sectionName) {
  // Prevent rapid successive navigation attempts
  if (navigationInProgress) {
    return;
  }
  
  const targetURL = `peersky://settings/${sectionName}`;
  
  // Check if we're already on the target URL to avoid unnecessary reloads
  const currentURL = window.location.href.split('#')[0]; // Remove any hash
  if (currentURL === targetURL) {
    updateSectionUI(sectionName);
    return;
  }
  
  // Set navigation lock
  navigationInProgress = true;
  setTimeout(() => { navigationInProgress = false; }, 300);
  
  // Navigate to the new URL - this will cause a reload but give us proper URLs
  window.location.href = targetURL;
}

// Update the UI to show the correct section (separated for reuse)
function updateSectionUI(sectionName) {
  const navItems = document.querySelectorAll('.nav-item');
  const pages = document.querySelectorAll('.settings-page');
  const targetPageId = sectionName + '-section';
  
  // Update active nav item
  navItems.forEach(nav => nav.classList.remove('active'));
  const targetNavItem = document.querySelector(`[data-section="${sectionName}"]`);
  if (targetNavItem) {
    targetNavItem.classList.add('active');
  }
  
  // Show corresponding page
  pages.forEach(page => page.classList.remove('active'));
  const targetPage = document.getElementById(targetPageId);
  if (targetPage) {
    targetPage.classList.add('active');
  }
}

// Custom dropdown functionality
function initializeCustomDropdowns() {
  const customSelects = document.querySelectorAll('.custom-select');
  
  customSelects.forEach(select => {
    const display = select.querySelector('.select-display');
    const dropdown = select.querySelector('.select-dropdown');
    const options = select.querySelectorAll('.select-option');
    const hiddenInput = select.parentElement.querySelector('input[type="hidden"]');
    
    // Toggle dropdown on display click
    display.addEventListener('click', (e) => {
      e.stopPropagation();
      
      // Close other dropdowns
      document.querySelectorAll('.custom-select.open').forEach(otherSelect => {
        if (otherSelect !== select) {
          otherSelect.classList.remove('open');
        }
      });
      
      // Toggle current dropdown
      select.classList.toggle('open');
    });
    
    // Handle option selection
    options.forEach(option => {
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        
        const value = option.dataset.value;
        const text = option.textContent;
        
        // Update display
        display.textContent = text;
        display.dataset.value = value;
        
        // Update hidden input
        if (hiddenInput) {
          hiddenInput.value = value;
          
          // Trigger change event for settings saving
          const changeEvent = new Event('change', { bubbles: true });
          hiddenInput.dispatchEvent(changeEvent);
          
        }
        
        // Update selected state
        options.forEach(opt => opt.classList.remove('selected'));
        option.classList.add('selected');
        
        // Close dropdown
        select.classList.remove('open');
      });
    });
  });
  
  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-select')) {
      document.querySelectorAll('.custom-select.open').forEach(select => {
        select.classList.remove('open');
      });
    }
  });
  
  // Update dropdown displays based on current values
  updateCustomDropdownDisplays();
}

// Update custom wallpaper UI state
function updateCustomWallpaperUI(isCustomActive) {
  const wallpaperRemove = document.getElementById('wallpaper-remove');
  const wallpaperPreview = document.getElementById('wallpaper-preview');
  
  if (isCustomActive) {
    wallpaperRemove?.style.setProperty('display', 'inline-flex');
    wallpaperPreview?.style.setProperty('display', 'block');
  } else {
    wallpaperRemove?.style.setProperty('display', 'none');
    wallpaperPreview?.style.setProperty('display', 'none');
  }
}

// Read file as base64 using FileReader
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // Remove the data URL prefix (data:image/jpeg;base64,)
      const base64Content = reader.result.split(',')[1];
      resolve(base64Content);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}


// Update custom dropdown displays with current values
function updateCustomDropdownDisplays() {
  const customSelects = document.querySelectorAll('.custom-select');
  
  customSelects.forEach(select => {
    const display = select.querySelector('.select-display');
    const options = select.querySelectorAll('.select-option');
    const hiddenInput = select.parentElement.querySelector('input[type="hidden"]');
    
    if (hiddenInput && hiddenInput.value) {
      const selectedOption = [...options].find(opt => opt.dataset.value === hiddenInput.value);
      if (selectedOption) {
        display.textContent = selectedOption.textContent;
        display.dataset.value = selectedOption.dataset.value;
        
        // Update selected state
        options.forEach(opt => opt.classList.remove('selected'));
        selectedOption.classList.add('selected');
      }
    }
  });
}

// Show temporary message with type support (success, error, warning)
function showSettingsSavedMessage(message, type = 'success') {
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

// Cleanup function for event listeners
function cleanup() {
  eventCleanupFunctions.forEach(cleanupFn => {
    try {
      cleanupFn();
    } catch (error) {
      console.error('Settings: Error during cleanup:', error);
    }
  });
  eventCleanupFunctions = [];
}

// Initialize LLM settings handlers
function initializeLLMSettings() {
  const llmEnabled = document.getElementById('llm-enabled');
  const llmConfig = document.getElementById('llm-config');
  
  if (!llmEnabled) return; // LLM section not present
  
  // Clean up any leftover progress containers on page load
  const existingProgress = document.getElementById('llm-download-progress');
  if (existingProgress) {
    // Always remove on page load if LLM is disabled
    if (!llmEnabled.checked) {
      existingProgress.remove();
    }
  }
  
  // Toggle LLM configuration visibility
  llmEnabled?.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    llmConfig.style.display = enabled ? 'block' : 'none';
    
    // Clean up progress container when LLM is disabled
    if (!enabled) {
      const progressContainer = document.getElementById('llm-download-progress');
      if (progressContainer) {
        progressContainer.remove();
      }
    }
    
    // Save the complete LLM settings with the new enabled state
    await saveLLMSettings();
  });
  
  // Listen for download progress updates
  if (window.electronAPI) {
    console.log('Setting up LLM event listeners...');
    
    if (window.electronAPI.onLLMDownloadProgress) {
      window.electronAPI.onLLMDownloadProgress((progress) => {
        console.log('Download progress:', progress);
        updateDownloadProgress(progress);
      });
    } else {
      console.warn('onLLMDownloadProgress not available');
    }
    
    if (window.electronAPI.onLLMModelsUpdated) {
      console.log('Setting up onLLMModelsUpdated listener');
      window.electronAPI.onLLMModelsUpdated((data) => {
        console.log('Models updated for:', data.model);
      });
    } else {
      console.warn('onLLMModelsUpdated not available');
    }
  } else {
    console.warn('electronAPI not available for LLM events');
  }
  
  // Save settings on input change
  const ollamaUrl = document.getElementById('ollama-url');
  const apiKey = document.getElementById('api-key');
  const ollamaModel = document.getElementById('ollama-model');
  
  // Add show/hide toggle for API key with eye icons
  const toggleApiKeyIcon = document.getElementById('toggle-api-key-visibility');
  
  // Function to update icon based on input type
  const updateIcon = () => {
    if (!toggleApiKeyIcon || !apiKey) return;
    if (apiKey.type === 'password') {
      toggleApiKeyIcon.src = 'peersky://static/assets/svg/eye.svg';
      toggleApiKeyIcon.title = 'Show API key';
    } else {
      toggleApiKeyIcon.src = 'peersky://static/assets/svg/eye-slash.svg';
      toggleApiKeyIcon.title = 'Hide API key';
    }
  };
  
  // Toggle API key visibility based on value
  const updateApiKeyMasking = () => {
    const value = apiKey.value.trim();
    // Show as password if it's not 'ollama'
    if (value && value !== 'ollama') {
      apiKey.type = 'password';
    } else {
      apiKey.type = 'text';
    }
    updateIcon(); // Update icon when input type changes
  };
  // Only toggle masking when the value is “settled”
  apiKey.addEventListener('change', updateApiKeyMasking);
  apiKey.addEventListener('blur', updateApiKeyMasking);

  if (toggleApiKeyIcon && apiKey) {
    // Set initial state
    updateIcon();
    
    // Toggle on click
    toggleApiKeyIcon.addEventListener('click', () => {
      if (apiKey.type === 'password') {
        apiKey.type = 'text';
      } else {
        apiKey.type = 'password';
      }
      updateIcon();
    });
  }
  
  if (ollamaUrl) {
    ollamaUrl.addEventListener('change', () => saveLLMSettings());
  }
  
  if (apiKey) {
    apiKey.addEventListener('change', () => saveLLMSettings());
  }
  
  // Handle model input changes - save and check/install on blur
  if (ollamaModel) {
    ollamaModel.addEventListener('blur', async function() {
      const modelName = this.value.trim();
      if (modelName) {
        await saveLLMSettings();
      }
    });
    
    // Also handle Enter key
    ollamaModel.addEventListener('keypress', async function(e) {
      if (e.key === 'Enter') {
        const modelName = this.value.trim();
        if (modelName) {
          await saveLLMSettings();
        }
      }
    });
  }
  
  // Helper function to save LLM settings (supports both Ollama and OpenRouter)
  async function saveLLMSettings() {
    const llmEnabled = document.getElementById('llm-enabled');
    const ollamaModelInput = document.getElementById('ollama-model');
    const apiKeyInput = document.getElementById('api-key');
    const baseURLInput = document.getElementById('ollama-url');
    
    // Get values from inputs
    const ollamaModelValue = ollamaModelInput?.value?.trim() || 'qwen2.5-coder:3b';
    const apiKeyValue = apiKeyInput?.value?.trim() || 'ollama';
    const baseURLValue = baseURLInput?.value?.trim() || 'http://127.0.0.1:11434/';
    
    // Basic validation - just check it's not empty
    if (!ollamaModelValue) {
      showSettingsSavedMessage('Please enter a model name', 'error');
      return;
    }
    
    // Check if using OpenRouter and validate API key
    const isOpenRouter = baseURLValue.includes('openrouter.ai');
    if (isOpenRouter && (!apiKeyValue || apiKeyValue === 'ollama')) {
      showSettingsSavedMessage('Please enter your OpenRouter API key', 'error');
      return;
    }
    
    // Simple settings structure config
    const settings = {
      enabled: llmEnabled?.checked || false,
      baseURL: baseURLValue,
      apiKey: apiKeyValue,
      model: ollamaModelValue
    };
    
    console.log('Saving LLM settings with model:', settings.model);
    
    // Save to backend and trigger model download if needed
    try {
      // Use the LLM IPC handler to trigger download if model changed
      if (window.electronAPI?.llm?.updateSettings) {
        console.log('Using IPC to update settings and check model...');
        const result = await window.electronAPI.llm.updateSettings(settings);
        if (result.success) {
          console.log('LLM settings saved and model check initiated');
          // Also save to regular settings to persist
          await saveSettingToBackend('llm', settings);
        } else {
          throw new Error(result.error || 'Failed to update LLM settings');
        }
      } else {
        console.log('electronAPI.llm not available, using fallback');
        // Fallback to regular save
        await saveSettingToBackend('llm', settings);
      }
    } catch (error) {
      console.error('Failed to save LLM settings:', error);
      
      // Don't show progress bar for model not found errors
      if (error.message && error.message.includes('not found')) {
        showSettingsSavedMessage(`Model not found. Please check available models at ollama.com/library`, 'error');
      } else {
        showSettingsSavedMessage(`Failed to save LLM settings: ${error.message}`, 'error');
      }
    }
  }
  
  // Function to update download progress
  function updateDownloadProgress(progress) {
    
    // Create or update progress bar
    let progressContainer = document.getElementById('llm-download-progress');
    if (!progressContainer) {
      // Create progress container after the model selector
      const modelRow = document.getElementById('ollama-model')?.closest('.setting-row');
      if (modelRow) {
        progressContainer = document.createElement('div');
        progressContainer.id = 'llm-download-progress';
        progressContainer.className = 'setting-row';
        progressContainer.style.display = 'none';
        progressContainer.innerHTML = `
          <div class="setting-control">
            <div class="progress-bar-container" style="width: 100%; background: var(--settings-bg-primary); border-radius: 4px; height: 20px; position: relative;">
              <div class="progress-bar" style="background: var(--accent-color); height: 100%; border-radius: 4px; transition: width 0.3s; width: 0%;"></div>
              <div class="progress-text" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: white; font-size: 12px;">0%</div>
            </div>
            <div class="progress-status" style="font-size: 12px; color: var(--settings-text-secondary);"></div>
          </div>
        `;
        modelRow.parentNode.insertBefore(progressContainer, modelRow.nextSibling);
      }
    }
    
    if (progressContainer) {
      const progressBar = progressContainer.querySelector('.progress-bar');
      const progressText = progressContainer.querySelector('.progress-text');
      const progressStatus = progressContainer.querySelector('.progress-status');
      
      if (progress.status === 'starting') {
        progressContainer.style.display = 'block';
        progressBar.style.width = '0%';
        progressBar.style.backgroundColor = '#06b6d4';
        progressText.textContent = '0%';
        progressStatus.textContent = `Starting download of ${progress.model}...`;
      } else if (progress.status === 'downloading') {
        progressContainer.style.display = 'block';
        const percent = progress.percent >= 0 ? progress.percent : 0;
        progressBar.style.width = `${percent}%`;
        progressBar.style.backgroundColor = '#06b6d4';
        progressText.textContent = `${percent}%`;
        progressStatus.textContent = progress.message || 'Downloading...';
      } else if (progress.status === 'complete') {
        progressBar.style.width = '100%';
        progressBar.style.backgroundColor = '#28a745';
        progressText.textContent = '100%';
        progressStatus.textContent = 'Download complete!';
        // Remove focus from model input
        const modelInput = document.getElementById('ollama-model');
        if (modelInput) {
          modelInput.blur();
        }
        // Remove progress container after 2 seconds
        setTimeout(() => {
          progressContainer.remove();
        }, 2000);
      } else if (progress.status === 'error') {
        // Show error briefly then remove
        progressContainer.style.display = 'block';
        progressBar.style.width = '100%';
        progressBar.style.backgroundColor = '#dc3545';
        progressText.textContent = 'Error';
        
        // Check if model doesn't exist vs other errors
        if (progress.message && (progress.message.includes('does not exist') || progress.message.includes('file does not exist'))) {
          // Model doesn't exist - show error briefly then remove
          progressStatus.textContent = 'Model not found';
          setTimeout(() => {
            progressContainer.remove();
            // Show alert dialog after removing progress
            alert(`Model '${progress.model}' does not exist in the Ollama library.\n\nPlease check available models at ollama.com/library`);
          }, 1000);
        } else {
          // Other error - show message and remove after 3 seconds
          progressStatus.textContent = progress.message || 'Download failed';
          setTimeout(() => {
            progressContainer.remove();
          }, 3000);
        }
      }
    }
  }
  
  // Check for incomplete downloads from previous session
  setTimeout(async () => {
    try {
      const settings = await settingsAPI?.settings?.getAll?.();
      if (settings?.llm?.model) {
        checkForIncompleteDownloads(settings.llm.model);
      }
    } catch (err) {
      console.error('Error checking for incomplete LLM downloads:', err);
    }
  }, 100);
  
  // Function to check for incomplete downloads and auto-resume
  async function checkForIncompleteDownloads(modelName) {
    if (!modelName) return;
    
    try {
      // Check if LLM is enabled first
      const llmEnabled = document.getElementById('llm-enabled');
      if (!llmEnabled?.checked) {
        console.log('LLM not enabled, skipping download check');
        return;
      }
      
      // Check if the model exists using the configured Ollama URL
      const baseURLInput = document.getElementById('ollama-url');
      let baseURL = baseURLInput?.value?.trim() || 'http://127.0.0.1:11434';

      // Normalize trailing slash
      if (baseURL.endsWith('/')) {
        baseURL = baseURL.slice(0, -1);
      }

      const tagsURL = `${baseURL}/api/tags`;

      const response = await fetch(tagsURL);
      if (response.ok) {
        const data = await response.json();
        const models = data.models || [];
        const modelExists = models.some(m => m.name === modelName);
        
        if (!modelExists) {
          // Model doesn't exist locally, auto-resume download
          console.log(`Model ${modelName} not found locally, auto-resuming download...`);
          
          // Check if using Ollama (not OpenRouter)
          const baseURLInput = document.getElementById('ollama-url');
          const isOpenRouter = baseURLInput?.value?.includes('openrouter.ai');
          
          if (!isOpenRouter) {
            // Trigger download by saving settings (which will check and download)
            await saveLLMSettings();
          }
        } else {
          console.log(`Model ${modelName} is already installed`);
        }
      }
    } catch (error) {
      console.error('Error checking for incomplete downloads:', error);
    }
  }
}

// Gracefully detach webviews before clearing
window.detachWebviews = () => {
  const webviews = document.querySelectorAll('webview');
  webviews.forEach(wv => {
    try {
      wv.remove();
    } catch (err) {
      console.warn('Failed to detach webview:', err);
    }
  });
  console.log('All WebViews detached for safe cache clearing');
};

// Reinitialize after clear
window.electronAPI.on('reload-ui-after-cache', () => {
  console.log('Reloading UI after cache clear...');
  window.location.reload();
});

// Cleanup on page unload
window.addEventListener('beforeunload', cleanup);
