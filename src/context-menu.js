import { Menu, MenuItem, clipboard, dialog } from "electron";
import WindowManager from "./window-manager.js";
import path from "path";

const isMac = process.platform === "darwin";

// Ensure a single instance of WindowManager is used
let windowManagerInstance = null;

export function setWindowManager(instance) {
  windowManagerInstance = instance;
}

export function attachContextMenus(browserWindow, windowManager) {
  // Assign the WindowManager instance if not already set
  if (!windowManagerInstance) {
    windowManagerInstance = windowManager;
  }

  const attachMenuToWebContents = (webContents) => {
    webContents.on("context-menu", (event, params) => {
      const menu = new Menu();

      // Add Undo, Redo for editable text fields with platform-specific accelerators
      if (params.isEditable) {
        menu.append(
          new MenuItem({
            label: "Undo",
            role: "undo",
            accelerator: "CommandOrControl+Z",
          })
        );
        menu.append(
          new MenuItem({
            label: "Redo",
            role: "redo",
            accelerator: isMac ? "Command+Shift+Z" : "Control+Y",
          })
        );
        menu.append(new MenuItem({ type: "separator" }));
      }

      // Cut, Copy, Paste, Delete, and Select All with accelerators
      if (params.isEditable || params.selectionText.trim().length > 0) {
        menu.append(
          new MenuItem({
            label: "Cut",
            role: "cut",
            accelerator: "CommandOrControl+X",
            enabled: params.editFlags.canCut,
          })
        );
        menu.append(
          new MenuItem({
            label: "Copy",
            role: "copy",
            accelerator: "CommandOrControl+C",
            enabled: params.editFlags.canCopy,
          })
        );
        menu.append(
          new MenuItem({
            label: "Paste",
            role: "paste",
            accelerator: "CommandOrControl+V",
            enabled: params.editFlags.canPaste,
          })
        );
        menu.append(
          new MenuItem({
            label: "Delete",
            role: "delete",
          })
        );
        menu.append(
          new MenuItem({
            label: "Select All",
            role: "selectAll",
            accelerator: "CommandOrControl+A",
          })
        );
        menu.append(new MenuItem({ type: "separator" }));
      }

      // Navigation controls with no accelerators
      menu.append(
        new MenuItem({
          label: "Back",
          enabled: webContents.canGoBack(),
          click: () => {
            // Try tab-based navigation first, fallback to direct webContents
            browserWindow.webContents.executeJavaScript(`
              const tabBar = document.querySelector('#tabbar');
              if (tabBar && typeof tabBar.goBackActiveTab === 'function') {
                tabBar.goBackActiveTab();
              } else {
                // Direct webContents navigation for single webview
                return 'fallback';
              }
            `).then(result => {
              if (result === 'fallback') {
                webContents.goBack();
              }
            }).catch(() => webContents.goBack());
          },
        })
      );
      menu.append(
        new MenuItem({
          label: "Forward",
          enabled: webContents.canGoForward(),
          click: () => {
            browserWindow.webContents.executeJavaScript(`
              const tabBar = document.querySelector('#tabbar');
              if (tabBar && typeof tabBar.goForwardActiveTab === 'function') {
                tabBar.goForwardActiveTab();
              } else {
                return 'fallback';
              }
            `).then(result => {
              if (result === 'fallback') {
                webContents.goForward();
              }
            }).catch(() => webContents.goForward());
          },
        })
      );
      menu.append(
        new MenuItem({
          label: "Reload",
          click: () => {
            browserWindow.webContents.executeJavaScript(`
              const tabBar = document.querySelector('#tabbar');
              if (tabBar && typeof tabBar.reloadActiveTab === 'function') {
                tabBar.reloadActiveTab();
              } else {
                return 'fallback';
              }
            `).then(result => {
              if (result === 'fallback') {
                webContents.reload();
              }
            }).catch(() => webContents.reload());
          },
        })
      );

      menu.append(new MenuItem({ type: "separator" }));

      // Print
      menu.append(
        new MenuItem({
          label: "Print...",
          accelerator: "CommandOrControl+P",
          click: () => {
            webContents.print({ printBackground: true }, (success, failureReason) => {
              if (!success) {
                console.error("Print failed:", failureReason);
                // Fallback: try window.print in the page context
                webContents
                  .executeJavaScript("window.print()")
                  .catch((err) => console.error("window.print fallback failed:", err));
              }
            });
          },
        })
      );

      menu.append(new MenuItem({ type: "separator" }));

      // Element inspection
      menu.append(
        new MenuItem({
          label: "Inspect",
          click: () => {
            if (!webContents.isDevToolsOpened()) {
              webContents.openDevTools({ mode: "detach" });
            }
            webContents.inspectElement(params.x, params.y);
          },
        })
      );

    // Image handling features (copy, copy address, save as)
        if (params.mediaType === "image" && params.srcURL) {
        menu.append(
          new MenuItem({
            label: "Copy Image",
            click: () => {
              try {
                // Use copyImageAt for best quality
                const img = webContents.copyImageAt(params.x, params.y);
                if (img && !img.isEmpty()) {
                  clipboard.writeImage(img);
                }
              } catch (e) {
                console.error("Copy Image failed:", e);
              }
            },
          })
        );
        menu.append(
          new MenuItem({
            label: "Copy Image Address",
            click: () => clipboard.writeText(params.srcURL),
          })
        );
        menu.append(
          new MenuItem({
            label: "Save Image As...",
            click: async () => {
              try {
                // Extract filename from URL
                const urlPath = new URL(params.srcURL).pathname;
                const defaultName = path.basename(urlPath) || "image.png";
                
                // Show save dialog
                const result = await dialog.showSaveDialog(browserWindow, {
                  title: "Save Image",
                  defaultPath: defaultName,
                  filters: [
                    {
                      name: "Image Files",
                      extensions: [
                        "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg",
                        "apng", "avif", "heic", "heif", "jxl",
                        "ico", "cur", "tif", "tiff",
                        "xbm", "pnm", "ppm", "pgm", "pbm"
                      ]
                    },
                    { name: "All Files", extensions: ["*"] }
                  ],
                });

                if (!result.canceled && result.filePath) {
                  // Validate URL scheme
                  try {
                    const u = new URL(params.srcURL);
                    const allowedSchemes = new Set(["http:", "https:", "ipfs:", "hyper:"]);

                    if (!allowedSchemes.has(u.protocol)) {
                      console.warn("Blocked download for unsupported scheme:", u.protocol);
                      return;
                    }
                  } catch (err) {
                    console.error("Invalid URL:", params.srcURL);
                    return;
                  }
                  
                  // Listen for the download and move it to the chosen location
                  webContents.session.once("will-download", (event, item) => {
                    // Guard clause to ensure this download matches our intended file
                    if (item.getURL() !== params.srcURL) return;
                    item.setSavePath(result.filePath);
                    
                    item.on("updated", (event, state) => {
                      if (state === "interrupted") {
                        console.error("Download interrupted");
                      }
                    });
                    
                    item.once("done", (event, state) => {
                      if (state === "completed") {
                        console.log("Image saved successfully to:", result.filePath);
                      } else {
                        console.error("Download failed:", state);
                      }
                    });
                  });

                  // Download the image using webContents session
                  webContents.session.downloadURL(params.srcURL);
                }
              } catch (e) {
                console.error("Save Image failed:", e);
              }
            },
          })
        );
    menu.append(new MenuItem({ type: "separator" }));
  }

      // Link handling
      if (params.linkURL) {
        menu.append(
          new MenuItem({
            label: "Copy Link Address",
            click: () => clipboard.writeText(params.linkURL),
          })
        );
        menu.append(
          new MenuItem({
            label: "Open Link in New Tab",
            click: () => {
              // First, attempt to add the URL as a new tab in the current window
              
              browserWindow.webContents
                .executeJavaScript(`
                  (function() {
                    const tabBar = document.querySelector('tab-bar');
                    const url = ${JSON.stringify(params.linkURL)};
                    if (tabBar && typeof tabBar.addTab === 'function') {
                      tabBar.addTab(url);
                      return true;
                    }
                    const oldTabBar = document.querySelector('#tabbar');
                    if (oldTabBar && typeof oldTabBar.addTab === 'function') {
                      oldTabBar.addTab(url);
                      return true;
                    }
                    return false;
                  })()
                `)
                .then((added) => {
                  if (!added) {
                    console.warn('Failed to find tab bar for new tab');
                  }
                })
                .catch((err) => {
                  console.error('Failed to add tab from context menu:', err);
                });
            },
          })
        );
        menu.append(
          new MenuItem({
            label: "Open Link in New Window",
            click: () => {
              if (windowManagerInstance) {
                windowManagerInstance.open({ url: params.linkURL, newWindow: true });
              } else {
                console.error("WindowManager instance not set.");
              }
            },
          })
        );
      }

      menu.popup();
    });
  };

  // Attach to main window's webContents
  attachMenuToWebContents(browserWindow.webContents);

  // Ensure window.open from overlays (e.g., extension popups rendered in this webContents) opens as a tab
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const escapedUrl = url.replace(/'/g, "\\'");
      browserWindow.webContents
        .executeJavaScript(`
          const tabBar = document.querySelector('#tabbar');
          if (tabBar && typeof tabBar.addTab === 'function') {
            tabBar.addTab('${escapedUrl}', 'New Tab');
            return true;
          } else {
            return false;
          }
        `)
        .then((added) => {
          if (!added && windowManagerInstance) {
            windowManagerInstance.open({ url });
          }
        })
        .catch((err) => {
          console.error('Failed to add tab from main windowOpenHandler:', err);
          if (windowManagerInstance) {
            windowManagerInstance.open({ url });
          }
        });
    } catch (e) {
      console.warn('Error in main windowOpenHandler:', e);
      if (windowManagerInstance) {
        windowManagerInstance.open({ url });
      }
    }
    return { action: 'deny' };
  });

  // Track popup limits per webview to reduce abuse
  const webviewPopupLimits = new Map(); // wcId -> { recent: number[] }
  const MAX_POPUPS_PER_10S = 3;
  const MAX_POPUPS_PER_MIN = 10;

  const withinPopupLimits = (wcId) => {
    const now = Date.now();
    const state = webviewPopupLimits.get(wcId) || { recent: [] };
    // keep only last 60s
    state.recent = state.recent.filter((t) => now - t < 60_000);
    // sliding windows
    const last10s = state.recent.filter((t) => now - t < 10_000).length;
    const last60s = state.recent.length;
    if (last10s >= MAX_POPUPS_PER_10S || last60s >= MAX_POPUPS_PER_MIN) {
      webviewPopupLimits.set(wcId, state);
      return false;
    }
    state.recent.push(now);
    webviewPopupLimits.set(wcId, state);
    return true;
  };

  const isSafePopupUrl = (url) => {
    if (!url || url === 'about:blank') return true; // common for OAuth bootstraps
    try {
      const u = new URL(url);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch (_) {
      // Non-standard or invalid URL – treat as unsafe
      return false;
    }
  };

  // Attach to all existing webviews
  browserWindow.webContents.on(
    "did-attach-webview",
    (event, webviewWebContents) => {
      attachMenuToWebContents(webviewWebContents);

      // Webview popups: allow native popups with opener for OAuth/extension flows
      webviewWebContents.setWindowOpenHandler((details) => {
        const { url, features = '', disposition } = details;
        const featuresLower = String(features || '').toLowerCase();
        const hasNoOpener = /(?:^|,)(noopener|noreferrer)(?:=1)?(?:,|$)/.test(featuresLower);
        const wantsBackground = disposition === 'background-tab' || /(?:^|,)background(?:=1)?(?:,|$)/.test(featuresLower);
        const hasPopupFeatures = /(?:^|,|\s)(width|height|left|top)=/i.test(featuresLower);
        const isAboutBlank = url === 'about:blank';

        // If explicitly no opener requested, prefer tab UX instead of popup
        if (hasNoOpener) {
          try {
            const escapedUrlNo = (url || '').replace(/'/g, "\\'");
            browserWindow.webContents
              .executeJavaScript(`
                (function() {
                  const tabBar = document.querySelector('tab-bar');
                  if (tabBar && typeof tabBar.addTab === 'function') {
                    tabBar.addTab('${escapedUrlNo}');
                    return true;
                  }
                  const oldTabBar = document.querySelector('#tabbar');
                  if (oldTabBar && typeof oldTabBar.addTab === 'function') {
                    oldTabBar.addTab('${escapedUrlNo}');
                    return true;
                  }
                  return false;
                })()
              `)
              .then((added) => {
                if (!added && windowManagerInstance) {
                  windowManagerInstance.open({ url });
                }
              })
              .catch(() => {
                if (windowManagerInstance) windowManagerInstance.open({ url });
              });
          } catch (_) {}
          return { action: 'deny' };
        }

        // Only allow http/https or about:blank; block others
        if (!isSafePopupUrl(url)) {
          // Preserve previous behavior for unsafe schemes: re-route to tab/window
          try {
            const escapedUrl = (url || '').replace(/'/g, "\\'");
            browserWindow.webContents
              .executeJavaScript(`
                (function() {
                  const tabBar = document.querySelector('tab-bar');
                  if (tabBar && typeof tabBar.addTab === 'function') {
                    tabBar.addTab('${escapedUrl}');
                    return true;
                  }
                  const oldTabBar = document.querySelector('#tabbar');
                  if (oldTabBar && typeof oldTabBar.addTab === 'function') {
                    oldTabBar.addTab('${escapedUrl}');
                    return true;
                  }
                  return false;
                })()
              `)
              .then((added) => {
                if (!added && windowManagerInstance) {
                  windowManagerInstance.open({ url });
                }
              })
              .catch((err) => {
                console.error('Failed to add tab from unsafe-scheme windowOpenHandler:', err);
                if (windowManagerInstance) {
                  windowManagerInstance.open({ url });
                }
              });
          } catch (_) {}
          return { action: 'deny' };
        }

        // Enforce modest rate limits per webview to discourage abuse
        if (!withinPopupLimits(webviewWebContents.id)) {
          console.warn('Popup blocked: rate limit exceeded for webview', webviewWebContents.id);
          return { action: 'deny' };
        }

        if (!hasPopupFeatures && !isAboutBlank && disposition !== 'new-window') {
          try {
            const escapedUrl = (url || '').replace(/'/g, "\\'");
            browserWindow.webContents
              .executeJavaScript(`
                (function() {
                  const tabBar = document.querySelector('tab-bar');
                  if (tabBar && typeof tabBar.addTab === 'function') {
                    tabBar.addTab('${escapedUrl}');
                    return true;
                  }
                  const oldTabBar = document.querySelector('#tabbar');
                  if (oldTabBar && typeof oldTabBar.addTab === 'function') {
                    oldTabBar.addTab('${escapedUrl}');
                    return true;
                  }
                  return false;
                })()
              `)
              .then((added) => {
                if (!added && windowManagerInstance) {
                  windowManagerInstance.open({ url });
                }
              })
              .catch(() => {
                if (windowManagerInstance) windowManagerInstance.open({ url });
              });
          } catch (_) {
            if (windowManagerInstance) windowManagerInstance.open({ url });
          }
          return { action: 'deny' };
        }

        // Build safe overrides but preserve important inherited prefs like partition
        const lastPrefs = (typeof webviewWebContents.getLastWebPreferences === 'function'
          ? webviewWebContents.getLastWebPreferences()
          : {}) || {};

        const overridePrefs = {
          // Keep Node disabled and isolation/sandbox on
          nodeIntegration: false,
          contextIsolation: lastPrefs.contextIsolation !== false,
          sandbox: lastPrefs.sandbox !== false,
          webSecurity: true,
          // Ensure native opener relationship
          nativeWindowOpen: true,
          // Preserve session/partition and affinity for cookie continuity
          partition: lastPrefs.partition,
          affinity: lastPrefs.affinity,
          // Never enable remote in popups
          enableRemoteModule: false,
        };

        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            show: wantsBackground ? false : true,
            focusable: wantsBackground ? false : true,
            skipTaskbar: !!wantsBackground,
            parent: browserWindow,
            autoHideMenuBar: true,
            width: 600,
            height: 700,
            webPreferences: {
              ...overridePrefs,
              backgroundThrottling: wantsBackground ? false : true,
            },
          },
        };
      });
    }
  );
}
