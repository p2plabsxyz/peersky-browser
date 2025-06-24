// Settings page JavaScript - Frontend functionality
// Phase 2: IPC communication with settings-manager.js

// TODO: Import Electron IPC for renderer process
// const { ipcRenderer } = require('electron');

document.addEventListener('DOMContentLoaded', () => {
  // Get form elements
  const searchEngine = document.getElementById('search-engine');
  const themeToggle = document.getElementById('theme-toggle');
  const showClock = document.getElementById('show-clock');
  const wallpaperSelector = document.getElementById('wallpaper-selector');
  const wallpaperFile = document.getElementById('wallpaper-file');
  const wallpaperBrowse = document.getElementById('wallpaper-browse');
  const clearCache = document.getElementById('clear-cache');

  // Handle wallpaper selector change
  wallpaperSelector?.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      wallpaperFile.style.display = 'block';
      wallpaperBrowse.style.display = 'inline-block';
    } else {
      wallpaperFile.style.display = 'none';
      wallpaperBrowse.style.display = 'none';
    }
  });

  // Handle browse button click
  wallpaperBrowse?.addEventListener('click', () => {
    wallpaperFile.click();
  });

  // Handle wallpaper file selection
  wallpaperFile?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      console.log('Selected wallpaper file:', file.name);
      // TODO: Call ipcRenderer.invoke('settings-upload-wallpaper', file.path)
      // TODO: Update wallpaper preview
      // TODO: Save wallpaper setting
    }
  });

  // Handle clear cache button
  clearCache?.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear the browser cache? This action cannot be undone.')) {
      console.log('Clear cache requested');
      // TODO: Call ipcRenderer.invoke('settings-clear-cache')
      // TODO: Show success/error message
      // TODO: Update UI to reflect cleared state
    }
  });

  // Add change listeners for form elements
  searchEngine?.addEventListener('change', (e) => {
    console.log('Search engine changed:', e.target.value);
    // TODO: Call ipcRenderer.invoke('settings-set', 'searchEngine', e.target.value)
  });

  themeToggle?.addEventListener('change', (e) => {
    console.log('Theme changed:', e.target.value);
    // TODO: Call ipcRenderer.invoke('settings-set', 'theme', e.target.value)
    // TODO: Apply theme immediately
  });

  showClock?.addEventListener('change', (e) => {
    console.log('Show clock changed:', e.target.checked);
    // TODO: Call ipcRenderer.invoke('settings-set', 'showClock', e.target.checked)
  });

  // TODO: Load settings from backend instead of defaults
  // loadSettingsFromBackend();
  loadDefaultSettings();
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

// TODO: Add Phase 2 functions
async function loadSettingsFromBackend() {
  // TODO: Call ipcRenderer.invoke('settings-get-all')
  // TODO: Populate form fields with loaded settings
  // TODO: Handle loading errors
  console.log('TODO: Load settings from backend');
}

async function saveSettingToBackend(key, value) {
  // TODO: Call ipcRenderer.invoke('settings-set', key, value)
  // TODO: Handle save errors
  // TODO: Show success feedback
  console.log('TODO: Save setting to backend:', key, value);
}

async function resetSettingsToDefaults() {
  // TODO: Call ipcRenderer.invoke('settings-reset')
  // TODO: Reload form with default values
  // TODO: Apply changes to browser
  console.log('TODO: Reset settings to defaults');
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