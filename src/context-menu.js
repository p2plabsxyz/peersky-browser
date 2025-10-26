import { Menu, MenuItem, clipboard } from "electron";
import WindowManager from "./window-manager.js";

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
              const escapedUrl = params.linkURL.replace(/'/g, "\\'");
              
              browserWindow.webContents
                .executeJavaScript(`
                  const tabBar = document.querySelector('#tabbar');
                  if (tabBar && typeof tabBar.addTab === 'function') {
                    tabBar.addTab('${escapedUrl}');
                    // Indicate success so main process knows no fallback is required
                    true;
                  } else {
                    // Tab bar not available – signal fallback
                    false;
                  }
                `)
                .then((added) => {
                  if (!added && windowManagerInstance) {
                    // Fallback: open in new window if tab creation failed
                    windowManagerInstance.open({ url: params.linkURL });
                  }
                })
                .catch((err) => {
                  console.error('Failed to add tab from context menu:', err);
                  if (windowManagerInstance) {
                    windowManagerInstance.open({ url: params.linkURL });
                  }
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

  // Attach to all existing webviews
  browserWindow.webContents.on(
    "did-attach-webview",
    (event, webviewWebContents) => {
      attachMenuToWebContents(webviewWebContents);

      // Intercept window.open / target="_blank" requests and try to add them as tabs
      webviewWebContents.setWindowOpenHandler(({ url }) => {
        // First, attempt to add the URL as a new tab in the current window (renderer side)
        const escapedUrl = url.replace(/'/g, "\\'");

        browserWindow.webContents
          .executeJavaScript(`
            const tabBar = document.querySelector('#tabbar');
            if (tabBar && typeof tabBar.addTab === 'function') {
              tabBar.addTab('${escapedUrl}');
              // Indicate success so main process knows no fallback is required
              true;
            } else {
              // Tab bar not available – signal fallback
              false;
            }
          `)
          .then((added) => {
            if (!added && windowManagerInstance) {
              // Fallback: open in new window if tab creation failed
              windowManagerInstance.open({ url });
            }
          })
          .catch((err) => {
            console.error('Failed to add tab from windowOpenHandler:', err);
            if (windowManagerInstance) {
              windowManagerInstance.open({ url });
            }
          });

        // Always deny the automatic window creation – we will handle it ourselves
        return { action: 'deny' };
      });
    }
  );
}
