// Settings page JavaScript - Frontend functionality
// IPC communication with settings-manager.js

// Import Electron IPC for renderer process
let ipcRenderer;
try {
  ipcRenderer = require('electron').ipcRenderer;
} catch (e) {
  try {
    ipcRenderer = parent.require('electron').ipcRenderer;
  } catch (e2) {
    try {
      ipcRenderer = top.require('electron').ipcRenderer;
    } catch (e3) {
      console.error('Could not access ipcRenderer:', e3);
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Check if IPC is available
  if (!ipcRenderer) {
    console.error('IPC not available - settings will not persist');
  } else {
    // Listen for theme changes from main process
    ipcRenderer.on('theme-changed', (event, newTheme) => {
      console.log('Theme changed to:', newTheme);
      
      // Update form field if different
      const themeToggle = document.getElementById('theme-toggle');
      if (themeToggle && themeToggle.value !== newTheme) {
        themeToggle.value = newTheme;
        updateCustomDropdownDisplays();
      }
      
      // Reload theme CSS
      reloadThemeCSS();
    });
    
    // Listen for other setting changes
    ipcRenderer.on('search-engine-changed', (event, newEngine) => {
      console.log('Search engine changed to:', newEngine);
      const searchEngine = document.getElementById('search-engine');
      if (searchEngine && searchEngine.value !== newEngine) {
        searchEngine.value = newEngine;
        updateCustomDropdownDisplays();
      }
    });
    
    ipcRenderer.on('show-clock-changed', (event, showClock) => {
      console.log('Show clock changed to:', showClock);
      const clockToggle = document.getElementById('show-clock');
      if (clockToggle && clockToggle.checked !== showClock) {
        clockToggle.checked = showClock;
      }
    });
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
        console.log('Cache clearing not implemented yet');
        alert('Cache clearing will be implemented in a future update.');
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
    
    // Show success message
    showSettingsSavedMessage('Theme updated successfully');
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
  if (!ipcRenderer) {
    console.warn('IPC not available, using defaults');
    loadDefaultSettings();
    return;
  }
  
  try {
    console.log('Loading settings from backend...');
    const settings = await ipcRenderer.invoke('settings-get-all');
    console.log('Settings loaded:', settings);
    populateFormFields(settings);
  } catch (error) {
    console.error('Failed to load settings:', error);
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
  if (!ipcRenderer) {
    console.warn('IPC not available, setting not saved:', key, value);
    return;
  }
  
  try {
    console.log('Saving setting to backend:', key, value);
    const result = await ipcRenderer.invoke('settings-set', key, value);
    console.log('Setting saved successfully:', result);
    return result;
  } catch (error) {
    console.error('Failed to save setting:', error);
    alert(`Failed to save ${key}: ${error.message}`);
    await loadSettingsFromBackend();
    throw error;
  }
}

async function resetSettingsToDefaults() {
  if (!ipcRenderer) {
    console.warn('IPC not available, cannot reset settings');
    return;
  }
  
  try {
    if (!confirm('Are you sure you want to reset all settings to defaults? This cannot be undone.')) {
      return;
    }
    
    console.log('Resetting settings to defaults...');
    const result = await ipcRenderer.invoke('settings-reset');
    console.log('Settings reset successfully:', result);
    
    await loadSettingsFromBackend();
    alert('Settings have been reset to defaults.');
    return result;
  } catch (error) {
    console.error('Failed to reset settings:', error);
    alert(`Failed to reset settings: ${error.message}`);
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

// Show temporary success message using CSS classes only
function showSettingsSavedMessage(message) {
  // Remove any existing message
  const existingMessage = document.querySelector('.settings-saved-message');
  if (existingMessage) {
    existingMessage.remove();
  }
  
  // Create new message element with CSS classes only
  const messageEl = document.createElement('div');
  messageEl.className = 'settings-saved-message';
  messageEl.textContent = message;
  
  document.body.appendChild(messageEl);
  
  // Animate in using CSS
  setTimeout(() => {
    messageEl.classList.add('show');
  }, 10);
  
  // Remove after 3 seconds
  setTimeout(() => {
    messageEl.classList.remove('show');
    setTimeout(() => {
      if (messageEl.parentNode) {
        messageEl.parentNode.removeChild(messageEl);
      }
    }, 300);
  }, 3000);
}