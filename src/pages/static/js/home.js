/**
 * Home Page Wallpaper Management
 * Handles dynamic wallpaper loading and updates
 */

// Apply wallpaper from settings
async function applyWallpaper() {
  try {
    const wallpaperUrl = await window.electronAPI?.getWallpaperUrl?.() || 'peersky://static/assets/redwoods.jpg';
    document.body.style.backgroundImage = `url("${wallpaperUrl}")`;
    console.log('Wallpaper applied:', wallpaperUrl);
  } catch (error) {
    console.error('Failed to apply wallpaper:', error);
    document.body.style.backgroundImage = 'url("peersky://static/assets/redwoods.jpg")';
  }
}

// Initialize wallpaper system
function initializeWallpaper() {
  // Listen for wallpaper changes
  window.electronAPI?.onWallpaperChanged?.(() => {
    console.log('Wallpaper changed, reapplying...');
    applyWallpaper();
  });
  
  // Apply wallpaper when page loads
  document.addEventListener('DOMContentLoaded', applyWallpaper);
  window.addEventListener('load', applyWallpaper);
}

// Start wallpaper system
initializeWallpaper();