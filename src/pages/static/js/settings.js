/**
 * Settings Page JavaScript - Unified Preload Frontend
 * 
 * Secure settings interface using unified preload script with context-aware API exposure.
 * Receives full electronAPI access when on settings pages with comprehensive fallbacks.
 */

let settingsAPI;
let eventCleanupFunctions = [];

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
      clearCache: () => ipc.invoke('settings-clear-cache')
    },
    onThemeChanged: (callback) => wrapCallback('theme-changed', callback),
    onSearchEngineChanged: (callback) => wrapCallback('search-engine-changed', callback),
    onShowClockChanged: (callback) => wrapCallback('show-clock-changed', callback)
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
        reloadThemeCSS();
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
  } catch (error) {
    console.error('Settings: Failed to set up event listeners:', error);
  }
  
  // Initialize custom dropdowns
  initializeCustomDropdowns();
  
  // Get form elements
  const searchEngine = document.getElementById('search-engine');
  const themeToggle = document.getElementById('theme-toggle');
  const showClock = document.getElementById('show-clock');
  const wallpaperSelector = document.getElementById('wallpaper-selector');
  const wallpaperFile = document.getElementById('wallpaper-file');
  const wallpaperBrowse = document.getElementById('wallpaper-browse');
  const clearCache = document.getElementById('clear-cache');

  // Handle wallpaper selector change
  wallpaperSelector?.addEventListener('change', async (e) => {
    if (e.target.value === 'custom') {
      wallpaperFile?.classList.remove('hidden');
      wallpaperBrowse?.classList.remove('hidden');
    } else {
      wallpaperFile?.classList.add('hidden');
      wallpaperBrowse?.classList.add('hidden');
      await saveSettingToBackend('wallpaper', e.target.value);
    }
  });

  // Handle browse button click
  wallpaperBrowse?.addEventListener('click', () => {
    wallpaperFile.click();
  });

  // Handle wallpaper file selection
  wallpaperFile?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      console.log('Selected wallpaper file:', file.name);
      console.log('Wallpaper upload not implemented yet');
    }
  });

  // Handle clear cache button
  clearCache?.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear the browser cache? This action cannot be undone.')) {
      try {
        console.log('Clear cache requested');
        const result = await settingsAPI.settings.clearCache();
        
        if (result.success) {
          alert('Cache cleared successfully!');
          console.log('Cache clearing completed:', result.message);
        } else {
          alert('Cache clearing failed. Please try again.');
          console.error('Cache clearing failed:', result);
        }
      } catch (error) {
        console.error('Failed to clear cache:', error);
        alert(`Failed to clear cache: ${error.message}`);
      }
    }
  });

  // Add change listeners for form elements
  searchEngine?.addEventListener('change', async (e) => {
    console.log('Search engine changed:', e.target.value);
    await saveSettingToBackend('searchEngine', e.target.value);
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

  // Load settings from backend
  loadSettingsFromBackend();
});

function loadDefaultSettings() {
  const searchEngine = document.getElementById('search-engine');
  const themeToggle = document.getElementById('theme-toggle');
  const showClock = document.getElementById('show-clock');
  
  if (searchEngine) searchEngine.value = 'duckduckgo';
  if (themeToggle) themeToggle.value = 'dark';
  if (showClock) showClock.checked = true;
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
  const searchEngine = document.getElementById('search-engine');
  const themeToggle = document.getElementById('theme-toggle');
  const showClock = document.getElementById('show-clock');
  const wallpaperSelector = document.getElementById('wallpaper-selector');
  
  if (searchEngine && settings.searchEngine) {
    searchEngine.value = settings.searchEngine;
  }
  if (themeToggle && settings.theme) {
    themeToggle.value = settings.theme;
  }
  if (showClock && typeof settings.showClock === 'boolean') {
    showClock.checked = settings.showClock;
  }
  if (wallpaperSelector && settings.wallpaper) {
    wallpaperSelector.value = settings.wallpaper;
  }
  
  // Update custom dropdown displays after loading settings
  updateCustomDropdownDisplays();
  
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
      'theme': 'Theme updated successfully!',
      'showClock': 'Clock setting updated successfully!',
      'wallpaper': 'Wallpaper updated successfully!'
    };
    
    const message = successMessages[key] || `${key} updated successfully!`;
    showSettingsSavedMessage(message, 'success');
    return result;
  } catch (error) {
    console.error('Settings: Failed to save setting:', error);
    
    // Create user-friendly error messages
    const errorMessages = {
      'searchEngine': 'Failed to save search engine setting',
      'theme': 'Failed to save theme setting',
      'showClock': 'Failed to save clock setting',
      'wallpaper': 'Failed to save wallpaper setting'
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
    // Reload theme CSS files
    reloadThemeCSS();
    
    // Update theme class on document
    document.documentElement.classList.remove(...Array.from(document.documentElement.classList).filter(c => c.startsWith('theme-')));
    document.documentElement.classList.add(`theme-${themeName}`);
    
    console.log('Theme applied immediately:', themeName);
  } catch (error) {
    console.error('Failed to apply theme immediately:', error);
  }
}

function reloadThemeCSS() {
  // Reload CSS imports for theme files
  const styleElements = document.querySelectorAll('style');
  styleElements.forEach(style => {
    const text = style.textContent || style.innerText;
    if (text && text.includes('browser://theme/')) {
      const newStyle = document.createElement('style');
      newStyle.textContent = text;
      style.parentNode.replaceChild(newStyle, style);
    }
  });
  
  // Reload CSS links with cache busting
  const linkElements = document.querySelectorAll('link[href*="browser://theme/"]');
  linkElements.forEach(link => {
    const href = link.href.split('?')[0];
    link.href = `${href}?t=${Date.now()}`;
  });
  
  console.log('Theme CSS reloaded');
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
  document.addEventListener('click', () => {
    document.querySelectorAll('.custom-select.open').forEach(select => {
      select.classList.remove('open');
    });
  });
  
  // Update dropdown displays based on current values
  updateCustomDropdownDisplays();
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
  
  // Add type-specific styling
  if (type === 'error') {
    messageEl.style.backgroundColor = '#f44336';
    messageEl.style.color = 'white';
  } else if (type === 'warning') {
    messageEl.style.backgroundColor = '#ff9800';
    messageEl.style.color = 'white';
  } else {
    messageEl.style.backgroundColor = '#4caf50';
    messageEl.style.color = 'white';
  }
  
  document.body.appendChild(messageEl);
  
  // Animate in using CSS
  setTimeout(() => {
    messageEl.classList.add('show');
  }, 10);
  
  // Remove after duration based on type
  const duration = type === 'error' ? 5000 : 3000;
  setTimeout(() => {
    messageEl.classList.remove('show');
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

// Cleanup on page unload
window.addEventListener('beforeunload', cleanup);