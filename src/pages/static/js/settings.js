// Settings page JavaScript - Frontend functionality
// IPC communication with settings-manager.js

// Import Electron IPC for renderer process
// Try different ways to access ipcRenderer in iframe context
let ipcRenderer;
try {
  // First try direct require
  ipcRenderer = require('electron').ipcRenderer;
} catch (e) {
  try {
    // Try parent window's require
    ipcRenderer = parent.require('electron').ipcRenderer;
  } catch (e2) {
    try {
      // Try top window's require
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
    // Still allow UI to work for testing
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
      wallpaperFile.style.display = 'block';
      wallpaperBrowse.style.display = 'inline-block';
    } else {
      wallpaperFile.style.display = 'none';
      wallpaperBrowse.style.display = 'none';
      // Save wallpaper setting when switching away from custom
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
      // TODO: Implement wallpaper upload in future commits
      console.log('Wallpaper upload not implemented yet');
    }
  });

  // Handle clear cache button
  clearCache?.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear the browser cache? This action cannot be undone.')) {
      try {
        console.log('Clear cache requested');
        // TODO: Implement cache clearing in future commits
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
    await saveSettingToBackend('theme', e.target.value);
    // TODO: Apply theme immediately in future commits
  });

  showClock?.addEventListener('change', async (e) => {
    console.log('Show clock changed:', e.target.checked);
    await saveSettingToBackend('showClock', e.target.checked);
  });

  // Load settings from backend
  loadSettingsFromBackend();
});

function loadDefaultSettings() {
  // Set default values - TODO: Replace with loadSettingsFromBackend()
  const searchEngine = document.getElementById('search-engine');
  const themeToggle = document.getElementById('theme-toggle');
  const showClock = document.getElementById('show-clock');
  
  if (searchEngine) searchEngine.value = 'duckduckgo';
  if (themeToggle) themeToggle.value = 'system';
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
    // Fallback to defaults if backend fails
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
    
    // TODO: Show success notification in future commits
    return result;
  } catch (error) {
    console.error('Failed to save setting:', error);
    alert(`Failed to save ${key}: ${error.message}`);
    
    // Reload settings to revert form to current backend state
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
    
    // Reload form with new default values
    await loadSettingsFromBackend();
    
    alert('Settings have been reset to defaults.');
    return result;
  } catch (error) {
    console.error('Failed to reset settings:', error);
    alert(`Failed to reset settings: ${error.message}`);
    throw error;
  }
}

// TODO: Add theme application functions
function applyTheme(themeName) {
  // TODO: Apply theme changes to current page
  // TODO: Notify other windows of theme change
  console.log('TODO: Apply theme:', themeName);
}

// TODO: Add wallpaper handling functions
function updateWallpaperPreview(imagePath) {
  // TODO: Show wallpaper preview in settings
  console.log('TODO: Update wallpaper preview:', imagePath);
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