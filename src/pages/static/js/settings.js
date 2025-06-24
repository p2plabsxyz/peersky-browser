// Settings page JavaScript - Frontend functionality
// This will be connected to backend in Phase 2

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
      // TODO: Phase 2 - Handle file upload and setting
    }
  });

  // Handle clear cache button
  clearCache?.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear the browser cache? This action cannot be undone.')) {
      console.log('Clear cache requested');
      // TODO: Phase 2 - Implement cache clearing
    }
  });

  // Add change listeners for form elements (Phase 2 will save these)
  searchEngine?.addEventListener('change', (e) => {
    console.log('Search engine changed:', e.target.value);
    // TODO: Phase 2 - Save to settings
  });

  themeToggle?.addEventListener('change', (e) => {
    console.log('Theme changed:', e.target.value);
    // TODO: Phase 2 - Save to settings and apply theme
  });

  showClock?.addEventListener('change', (e) => {
    console.log('Show clock changed:', e.target.checked);
    // TODO: Phase 2 - Save to settings
  });

  // Initialize default values (Phase 2 will load from backend)
  loadDefaultSettings();
});

function loadDefaultSettings() {
  // Set default values - Phase 2 will load from backend
  const searchEngine = document.getElementById('search-engine');
  const themeToggle = document.getElementById('theme-toggle');
  const showClock = document.getElementById('show-clock');
  
  if (searchEngine) searchEngine.value = 'duckduckgo';
  if (themeToggle) themeToggle.value = 'system';
  if (showClock) showClock.checked = true;
}