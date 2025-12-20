// Browser actions (click/open popup) and helpers

import { app, BrowserWindow, Menu, webContents } from 'electron';
import { registerPopupForStabilization } from './popup-guards.js';

export async function listBrowserActions(manager, window) {
  const actions = [];
  for (const extension of manager.loadedExtensions.values()) {
    if (extension.enabled && extension.manifest) {
      const action = extension.manifest.action || extension.manifest.browser_action;
      actions.push({
        id: extension.id,
        extensionId: extension.electronId,
        name: extension.displayName || extension.name,
        title: (action && (action.default_title || extension.displayName || extension.name)) || (extension.displayName || extension.name),
        icon: extension.iconPath,
        popup: action ? action.default_popup : undefined,
        badgeText: '',
        badgeBackgroundColor: '#666',
        enabled: true,
        hasAction: Boolean(action)
      });
    }
  }
  if (actions.length > 0) {
    console.log(`ExtensionManager: Found ${actions.length} browser actions`);
  }
  return actions;
}

export async function clickBrowserAction(manager, actionId, window) {
  const extension = manager.loadedExtensions.get(actionId);
  if (!extension || !extension.enabled) {
    console.warn(`ExtensionManager: Extension ${actionId} not found or disabled`);
    return;
  }
  const action = extension.manifest?.action || extension.manifest?.browser_action;
  if (!action) {
    console.warn(`ExtensionManager: Extension ${actionId} has no browser action`);
    return;
  }
  if (manager.electronChromeExtensions && extension.electronId) {
    try {
      console.log(`ExtensionManager: Triggering browser action click for ${extension.displayName || extension.name}`);
      const activeTab = window.webContents;
      if (manager.electronChromeExtensions.api && manager.electronChromeExtensions.api.browserAction) {
        const browserActionAPI = manager.electronChromeExtensions.api.browserAction;
        const tabInfo = { id: activeTab.id, windowId: window.id, url: activeTab.getURL(), active: true };
        try {
          if (browserActionAPI.onClicked) {
            browserActionAPI.onClicked.trigger(tabInfo);
            console.log(`ExtensionManager: Browser action API triggered for ${extension.displayName || extension.name}`);
            return;
          }
          if (browserActionAPI.click) {
            await browserActionAPI.click(extension.electronId, tabInfo);
            console.log(`ExtensionManager: Browser action click API called for ${extension.displayName || extension.name}`);
            return;
          }
        } catch (apiError) {
          console.warn(`ExtensionManager: Browser action API failed for ${extension.displayName || extension.name}:`, apiError);
        }
      }
      if (manager.electronChromeExtensions.getBrowserAction) {
        const browserAction = manager.electronChromeExtensions.getBrowserAction(extension.electronId);
        if (browserAction && browserAction.onClicked) {
          const tabInfo = { id: activeTab.id, windowId: window.id, url: activeTab.getURL() };
          browserAction.onClicked.trigger(tabInfo);
          console.log(`ExtensionManager: Browser action onClicked triggered for ${extension.displayName || extension.name}`);
          return;
        }
      }
      console.warn(`ExtensionManager: No suitable browser action trigger found for ${extension.displayName || extension.name}`);
    } catch (error) {
      console.error(`ExtensionManager: Failed to trigger browser action for ${extension.displayName || extension.name}:`, error);
    }
  }
}

export async function openBrowserAction(manager, actionId, window, anchorRect) {
  try {
    const extension = manager.loadedExtensions.get(actionId);
    if (!extension || !extension.enabled) {
      console.warn(`ExtensionManager: Extension ${actionId} not found or disabled`);
      return { success: false, error: 'Extension not found or disabled' };
    }
    const action = extension.manifest?.action || extension.manifest?.browser_action;
    if (!action) {
      console.warn(`ExtensionManager: Extension ${actionId} has no browser action`);
      return { success: false, error: 'No browser action found' };
    }
    if (!action.default_popup) {
      console.log(`ExtensionManager: Extension ${extension.displayName || extension.name} has no popup, triggering click instead`);
      await clickBrowserAction(manager, actionId, window);
      return { success: true };
    }
    const popupRelRaw = String(action.default_popup || '').replace(/^\//, '');
    const popupExists = await doesExtensionFileExist(extension.installedPath, popupRelRaw);
    let resolvedPopupRel = popupRelRaw;
    if (!popupExists) {
      const alt = await resolvePopupRelativePath(extension.installedPath, popupRelRaw);
      if (alt) {
        console.warn(`ExtensionManager: Manifest popup missing (${popupRelRaw}), using detected ${alt}`);
        resolvedPopupRel = alt;
      }
    }
    if (manager.electronChromeExtensions && extension.electronId) {
      try {
        console.log(`ExtensionManager: Opening popup for ${extension.displayName || extension.name} at`, anchorRect);
        const activeWebview = await getAndRegisterActiveWebview(manager, window);
        const activeTab = activeWebview || window.webContents;
        try {
          if (manager.electronChromeExtensions.setActiveTab) {
            manager.electronChromeExtensions.setActiveTab(activeTab);
          } else if (manager.electronChromeExtensions.activateTab) {
            manager.electronChromeExtensions.activateTab(activeTab);
          } else if (manager.electronChromeExtensions.selectTab) {
            manager.electronChromeExtensions.selectTab(activeTab);
          }
        } catch (error) {
          console.warn(`[ExtensionManager] Could not set active tab:`, error);
        }
        if (manager.electronChromeExtensions.getBrowserAction && popupExists) {
          const browserAction = manager.electronChromeExtensions.getBrowserAction(extension.electronId);
          if (browserAction && browserAction.onClicked) {
            browserAction.onClicked.trigger(activeTab);
            console.log(`ExtensionManager: Browser action triggered for ${extension.displayName || extension.name}`);
            return { success: true };
          }
        }
        if (manager.electronChromeExtensions.api && popupExists) {
          try {
            const api = manager.electronChromeExtensions.api;
            if (api.browserAction && api.browserAction.openPopup) {
              app.once("browser-window-created", (event, newWindow) => {
                // Register for stabilization IMMEDIATELY to prevent race condition
                registerPopupForStabilization(newWindow);
                if (manager.activePopups) {
                  manager.activePopups.add(newWindow);
                  newWindow.on('closed', () => manager.activePopups.delete(newWindow));
                }

                newWindow.webContents.once("did-finish-load", () => {
                  const url = newWindow.webContents.getURL();
                  if (url.includes(`chrome-extension://${extension.electronId}/`)) {
                    try { manager.addWindow(newWindow, newWindow.webContents); } catch (_) { }
                    newWindow.webContents.on("context-menu", (evt, params) => {
                      const menu = Menu.buildFromTemplate([
                        {
                          label: "Inspect", click: () => {
                            try { if (!newWindow.webContents.isDevToolsOpened()) { newWindow.webContents.openDevTools({ mode: "detach" }); } } catch (_) { }
                            try { newWindow.webContents.inspectElement(params.x, params.y); } catch (_) { }
                          }
                        }
                      ]);
                      try { menu.popup({ window: newWindow, x: params.x, y: params.y }); } catch (_) { menu.popup({ window: newWindow }); }
                    });
                    function lockWindowPosition(win, getPosition) {
                      if (!win || win.isDestroyed()) return;
                      const _setBounds = win.setBounds.bind(win);
                      const _setBoundsSafe = (newBounds) => {
                        if (win.isDestroyed()) return;
                        const pos = getPosition(newBounds);
                        _setBounds({ x: pos.x, y: pos.y, width: newBounds.width, height: newBounds.height });
                      };
                      win.setBounds = _setBoundsSafe;
                    }
                    const calcPosition = (popupBounds) => {
                      const mainBounds = window.getBounds();
                      return { x: (mainBounds.x + anchorRect.x - popupBounds.width + anchorRect.width), y: mainBounds.y + anchorRect.y + 38 };
                    };
                    lockWindowPosition(newWindow, calcPosition);
                    newWindow.on("closed", () => {
                      const mainWindow = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
                      if (mainWindow) { mainWindow.webContents.send("remove-all-tempIcon"); }
                    });
                  }
                });
              });
              await api.browserAction.openPopup({ extension: { id: extension.electronId } }, { windowId: window.id });
              console.log(`ExtensionManager: Popup opened directly for ${extension.displayName || extension.name}`);
              return { success: true };
            }
          } catch (directError) {
            console.warn(`ExtensionManager: Direct popup API failed for ${extension.displayName || extension.name}:`, directError);
          }
        }
        console.log(`ExtensionManager: Falling back to regular click for ${extension.displayName || extension.name}`);
        await clickBrowserAction(manager, actionId, window);
        if (resolvedPopupRel) {
          console.log(`ExtensionManager: Attempting manual popup creation for ${extension.displayName || extension.name}`);
          try {
            const popupUrl = `chrome-extension://${extension.electronId}/${resolvedPopupRel}`;
            const popupWindow = new (await import('electron')).BrowserWindow({
              width: 400, height: 600, x: Math.round(anchorRect.x), y: Math.round(anchorRect.bottom + 5), show: false, frame: false, resizable: false,
              webPreferences: { nodeIntegration: false, contextIsolation: true, enableRemoteModule: false, partition: window.webContents.session.partition }
            });
            // Register for stabilization to prevent early closure
            registerPopupForStabilization(popupWindow);
            if (manager.activePopups) {
              manager.activePopups.add(popupWindow);
              popupWindow.on('closed', () => manager.activePopups.delete(popupWindow));
            }
            try { manager.addWindow(popupWindow, popupWindow.webContents); } catch (_) { }

            const isExternalUrl = (u) => /^(https?:|ipfs:|ipns:|hyper:|web3:)/i.test(u);
            popupWindow.webContents.setWindowOpenHandler(({ url }) => {
              if (isExternalUrl(url)) { try { manager.electronChromeExtensions?.createTab?.({ url, active: true }); } catch (_) { } return { action: 'deny' }; }
              return { action: 'allow' };
            });
            await popupWindow.loadURL(popupUrl);
            popupWindow.showInactive();
            return { success: true };
          } catch (manualError) {
            console.error(`ExtensionManager: Manual popup creation failed for ${extension.displayName || extension.name}:`, manualError);
          }
        }
        return { success: true };
      } catch (error) {
        console.error(`ExtensionManager: Failed to open popup for ${extension.displayName || extension.name}:`, error);
        return { success: false, error: error.message };
      }
    }
    return { success: false, error: 'Extension system not available' };
  } catch (error) {
    console.error('ExtensionManager: Browser action popup failed:', error);
    return { success: false, error: error.message };
  }
}

export function closeAllPopups(manager) {
  if (manager.activePopups?.size > 0) {
    console.log(`[ExtensionManager] Closing ${manager.activePopups.size} active popups`);
    for (const popup of manager.activePopups) {
      try { if (!popup.isDestroyed()) { popup.close(); } } catch (error) { console.warn('[ExtensionManager] Error closing popup:', error); }
    }
    manager.activePopups.clear();
  }
}

export async function getAndRegisterActiveWebview(manager, window) {
  try {
    const activeTabData = await window.webContents.executeJavaScript(`
      (function() {
        try {
          const tabBar = document.querySelector('#tabbar');
          if (!tabBar || !tabBar.getActiveTab) return null;
          const activeTab = tabBar.getActiveTab();
          if (!activeTab) return null;
          const activeWebview = tabBar.getActiveWebview();
          if (!activeWebview) return null;
          return { tabId: activeTab.id, url: activeTab.url, title: activeTab.title, webContentsId: activeWebview.getWebContentsId() };
        } catch (error) { console.error('[ExtensionManager] Error getting active tab:', error); return null; }
      })();
    `);
    if (!activeTabData || !activeTabData.webContentsId) return null;
    const activeWebviewContents = webContents.fromId(activeTabData.webContentsId);
    if (!activeWebviewContents) {
      console.warn(`[ExtensionManager] WebContents ${activeTabData.webContentsId} not found`);
      return null;
    }
    manager.addWindow(window, activeWebviewContents);
    return activeWebviewContents;
  } catch (error) {
    console.error('[ExtensionManager] Failed to get and register active webview:', error);
    return null;
  }
}

export async function doesExtensionFileExist(root, rel) {
  try {
    const fs = await import('fs/promises');
    const pathMod = await import('path');
    const p = pathMod.join(root, rel);
    await fs.access(p);
    return true;
  } catch (_) { return false; }
}

export async function resolvePopupRelativePath(root, desiredRel) {
  const fs = await import('fs/promises');
  const pathMod = await import('path');
  const desiredBase = desiredRel ? pathMod.basename(desiredRel) : 'popup.html';
  const candidates = [desiredRel, 'popup.html', 'popup/index.html', 'ui/popup.html', 'dist/popup.html', 'build/popup.html'];
  for (const rel of candidates) {
    if (!rel) continue;
    try { await fs.access(pathMod.join(root, rel)); return rel; } catch (_) { }
  }
  try {
    const found = await findFileByName(root, desiredBase, 2);
    if (found) return pathMod.relative(root, found);
  } catch (_) { }
  return null;
}

async function findFileByName(dir, name, depth) {
  const fs = await import('fs/promises');
  const pathMod = await import('path');
  if (depth < 0) return null;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = pathMod.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue;
        const r = await findFileByName(full, name, depth - 1);
        if (r) return r;
      } else if (e.name === name) {
        return full;
      }
    }
  } catch (_) { }
  return null;
}

