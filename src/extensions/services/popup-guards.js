/**
 * Extension Popup Guards
 * 
 * This module provides navigation guards for extension popups to:
 * 1. Handle OAuth flows properly (maintain window.opener)
 * 2. Protect popups from being closed during stabilization period
 * 3. Allow extension popups to open child windows freely (for login flows)
 * 
 * @module popup-guards
 */

import { app, BrowserWindow } from 'electron';
import { openUrlInPeerskyTab } from './open-url-in-browser-tab.js';

// Popup stabilization period - prevent closing for this duration after creation
const POPUP_STABILIZATION_MS = 2000;

// Track popup windows with their creation timestamps
const popupCreationTimes = new WeakMap();

// Track which windows are extension-related
const extensionRelatedWindows = new WeakSet();

/**
 * Check if a popup is in its stabilization period (should not be closed)
 */
export function isPopupStabilizing(popup) {
  if (!popup || popup.isDestroyed()) return false;
  const createdAt = popupCreationTimes.get(popup);
  if (!createdAt) return false;
  return (Date.now() - createdAt) < POPUP_STABILIZATION_MS;
}

/**
 * Register a popup for stabilization tracking
 */
export function registerPopupForStabilization(popup) {
  if (!popup || popup.isDestroyed()) return;
  popupCreationTimes.set(popup, Date.now());
  extensionRelatedWindows.add(popup);
  console.log('[PopupGuards] Registered popup for stabilization tracking');
}

/**
 * Check if a URL is an extension URL
 */
function isExtensionUrl(url) {
  if (!url) return false;
  return url.startsWith('chrome-extension://');
}

async function openExtensionUrlInTab(url) {
  try {
    const opened = await openUrlInPeerskyTab(url, 'Extension Page');
    if (!opened) {
    console.warn('[PopupGuards] No window with tabbar found for extension URL');
    }
  } catch (e) {
    console.error('[PopupGuards] Failed to open extension URL in tab:', e);
  }
}

/**
 * Install popup navigation guards on the extension manager
 */
export function installExtensionPopupGuards(manager) {
  if (!manager || !manager.app) {
    console.warn('[PopupGuards] No manager or app provided');
    return;
  }

  console.log('[PopupGuards] Installing extension popup guards...');

  // Close extension popups when focus moves elsewhere (outside click)
  if (!manager.__peerskyPopupFocusHandlerInstalled) {
    manager.__peerskyPopupFocusHandlerInstalled = true;
    app.on('browser-window-focus', (_event, focusedWindow) => {
      const popups = manager.activePopups;
      if (!popups || popups.size === 0) return;
      for (const popup of [...popups]) {
        if (!popup || popup.isDestroyed()) {
          popups.delete(popup);
          continue;
        }
        if (focusedWindow && popup === focusedWindow) continue;
        // If focus moves back to the popup's opener (main browser window),
        // don't auto-close. Some extension popups (eg ArchiveWeb.page) trigger
        // tab creation/navigation and focus remains on the opener while the popup
        // is still expected to stay open.
        try {
          const opener = manager.popupToOpener?.get?.(popup) || popup.getParentWindow?.();
          if (focusedWindow && opener && focusedWindow === opener) continue;
        } catch (_) { }
        if (isPopupStabilizing(popup)) continue;
        try { popup.close(); } catch (_) { }
      }
    });
  }

  // Override closeAllPopups to respect stabilization period
  const originalCloseAllPopups = manager.closeAllPopups?.bind(manager);
  if (originalCloseAllPopups) {
    manager.closeAllPopups = function (force = false) {
      if (!this.activePopups || this.activePopups.size === 0) return;

      // Check for stabilizing popups
      const stabilizing = [...this.activePopups].filter(p =>
        !p.isDestroyed() && isPopupStabilizing(p)
      );

      if (stabilizing.length > 0 && !force) {
        console.log(`[PopupGuards] ${stabilizing.length} popup(s) stabilizing, skipping close`);

        // Only close non-stabilizing popups
        for (const popup of this.activePopups) {
          if (popup.isDestroyed()) {
            this.activePopups.delete(popup);
            continue;
          }
          if (!isPopupStabilizing(popup)) {
            try { popup.close(); } catch (_) { }
          }
        }
        return;
      }

      // Otherwise call original
      originalCloseAllPopups();
    };
  }

  // Track ALL browser windows created - register extension-related ones for stabilization
  app.on('browser-window-created', (_event, newWindow) => {
    // Check parent window - if parent is extension-related, child is too
    const parent = newWindow.getParentWindow?.();
    if (parent && extensionRelatedWindows.has(parent)) {
      registerPopupForStabilization(newWindow);
      if (manager.activePopups) {
        manager.activePopups.add(newWindow);
        newWindow.on('closed', () => manager.activePopups.delete(newWindow));
      }
      console.log('[PopupGuards] Child popup of extension window registered');
    }

    // Also check URL once loaded
    newWindow.webContents.once('did-finish-load', () => {
      const url = newWindow.webContents.getURL();
      if (isExtensionUrl(url)) {
        registerPopupForStabilization(newWindow);
        if (manager.activePopups) {
          manager.activePopups.add(newWindow);
          newWindow.on('closed', () => manager.activePopups.delete(newWindow));
        }
      }
    });

    // Register on did-start-navigation too (catches about:blank -> URL transitions)
    newWindow.webContents.once('did-start-navigation', (_e, url) => {
      if (isExtensionUrl(url) && !popupCreationTimes.has(newWindow)) {
        registerPopupForStabilization(newWindow);
        if (manager.activePopups) {
          manager.activePopups.add(newWindow);
          newWindow.on('closed', () => manager.activePopups.delete(newWindow));
        }
      }
    });
  });

  // For extension popup web contents: allow ALL window.open calls
  // Don't be restrictive - extensions need to open login popups freely
  manager.app.on('web-contents-created', (_e, wc) => {
    if (wc.__peerskyPopupGuardsInstalled) return;
    wc.__peerskyPopupGuardsInstalled = true;

    let isFromExtension = false;

    // Track if this web contents is from an extension
    wc.on('did-start-navigation', (_evt, url, _isInPlace, isMainFrame) => {
      if (isMainFrame && isExtensionUrl(url)) {
        isFromExtension = true;
      }
    });

    // Allow all popups from extension contexts - don't block anything
    // The context-menu.js already has proper rate limiting for webviews
    wc.setWindowOpenHandler((details) => {
      const { url } = details;

      // If from extension, handle window.open requests
      if (isFromExtension) {
        // chrome-extension:// pages (like ArchiveWeb.page's index.html) should
        // open as proper browser tabs, matching Chrome's behaviour.
        if (isExtensionUrl(url)) {
          openExtensionUrlInTab(url);
          return { action: 'deny' };
        }

        // Non-extension URLs (OAuth login popups, etc.) still open as popup windows
        // Register the new window for stabilization when it's created
        app.once('browser-window-created', (_evt, newWin) => {
          registerPopupForStabilization(newWin);
          if (manager.activePopups) {
            manager.activePopups.add(newWin);
            newWin.on('closed', () => manager.activePopups.delete(newWin));
          }
        });

        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 400,
            height: 600,
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              nativeWindowOpen: true,  // CRITICAL for window.opener
            }
          }
        };
      }

      // For non-extension contexts, allow by default (let context-menu.js handle)
      return { action: 'allow' };
    });
  });

  console.log('[PopupGuards] Extension popup guards installed');
}

export default { installExtensionPopupGuards, isPopupStabilizing, registerPopupForStabilization };
