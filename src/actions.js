import { app, BrowserWindow, globalShortcut } from "electron";
import WindowManager from './window-manager.js';

export function createActions(windowManager) {
  const actions = {
    OpenDevTools: {
      label: "Open Dev Tools",
      accelerator: "CommandOrControl+Shift+I",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.webContents.openDevTools({ mode: "detach" });
        }
      },
    },
    NewWindow: {
      label: "New Window",
      accelerator: "CommandOrControl+N",
      click: () => {
        windowManager.open();
      },
    },
    Forward: {
      label: "Forward",
      accelerator: "CommandOrControl+]",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`{
            const webview = document.querySelector('webview');
            if (webview && webview.canGoForward()) {
              webview.goForward();
            }
          }`);
        }
      },
    },
    Back: {
      label: "Back",
      accelerator: "CommandOrControl+[",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`{
            const webview = document.querySelector('webview');
            if (webview && webview.canGoBack()) {
              webview.goBack();
            }
          }`);
        }
      },
    },
    FocusURLBar: {
      label: "Focus URL Bar",
      accelerator: "CommandOrControl+L",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`
            document.getElementById('url').focus();
          `);
        }
      },
    },
    Reload: {
      label: "Reload",
      accelerator: "CommandOrControl+R",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`{
              const webview = document.querySelector('webview');
              if (webview) {
                webview.reload();
              }
            }`);
        }
      },
    },
    Minimize: {
      label: "Minimize",
      accelerator: "CommandOrControl+M",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.minimize();
        }
      },
    },
    Close: {
      label: "Close",
      accelerator: "CommandOrControl+W",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`
            try {
              const tabBar = document.querySelector('#tabbar');
              if (tabBar && tabBar.tabs && tabBar.tabs.length > 1 && typeof tabBar.closeTab === 'function' && typeof tabBar.getActiveTab === 'function') {
                const activeTab = tabBar.getActiveTab();
                if (activeTab && activeTab.id) {
                  tabBar.closeTab(activeTab.id);
                }
              } else {
                window.close();
              }
            } catch (error) {
              console.error('Error in Close action:', error);
              window.close();
            }
          `).catch(error => {
            console.error('Script execution failed in Close action:', error);
          });
        }
      },
    },
    FullScreen: {
      label: "Toggle Full Screen",
      accelerator: "F11",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.setFullScreen(!focusedWindow.isFullScreen());
        }
      },
    },
    FindInPage: {
      label: "Find in Page",
      accelerator: "CommandOrControl+F",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`
            var findMenu = document.querySelector('find-menu');
            if (findMenu) {
              findMenu.toggle();
              setTimeout(() => {
                var input = findMenu.querySelector('.find-menu-input');
                if (input) {
                  input.focus();
                }
              }, 100); // Timeout to ensure the menu is visible and ready to receive focus
            }
          `);
        }
      },
    },
    NewTab: {
      label: "New Tab",
      accelerator: "CommandOrControl+T",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`
            try {
              const tabBar = document.querySelector('#tabbar');
              if (tabBar && typeof tabBar.addTab === 'function') {
                tabBar.addTab();
              }
            } catch (error) {
              console.error('Error adding tab:', error);
            }
          `).catch(error => {
            console.error('Script execution failed:', error);
          });
        }
      },
    },
    CloseTab: {
      label: "Close Tab",
      accelerator: "CommandOrControl+Shift+W",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`
            try {
              const tabBar = document.querySelector('#tabbar');
              if (tabBar && typeof tabBar.getActiveTab === 'function' && typeof tabBar.closeTab === 'function') {
                const activeTab = tabBar.getActiveTab();
                if (activeTab && activeTab.id) {
                  tabBar.closeTab(activeTab.id);
                }
              }
            } catch (error) {
              console.error('Error closing tab:', error);
            }
          `).catch(error => {
            console.error('Script execution failed:', error);
          });
        }
      },
    },
    NextTab: {
      label: "Next Tab",
      accelerator: "CommandOrControl+Tab",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`
            try {
              const tabBar = document.querySelector('#tabbar');
              if (tabBar && tabBar.tabs && tabBar.tabs.length > 1) {
                const activeIndex = tabBar.tabs.findIndex(tab => tab.id === tabBar.activeTabId);
                const nextIndex = (activeIndex + 1) % tabBar.tabs.length;
                if (typeof tabBar.selectTab === 'function') {
                  tabBar.selectTab(tabBar.tabs[nextIndex].id);
                }
              }
            } catch (error) {
              console.error('Error switching to next tab:', error);
            }
          `).catch(error => {
            console.error('Script execution failed:', error);
          });
        }
      },
    },
    PreviousTab: {
      label: "Previous Tab",
      accelerator: "CommandOrControl+Shift+Tab",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`
            try {
              const tabBar = document.querySelector('#tabbar');
              if (tabBar && tabBar.tabs && tabBar.tabs.length > 1) {
                const activeIndex = tabBar.tabs.findIndex(tab => tab.id === tabBar.activeTabId);
                const prevIndex = (activeIndex - 1 + tabBar.tabs.length) % tabBar.tabs.length;
                if (typeof tabBar.selectTab === 'function') {
                  tabBar.selectTab(tabBar.tabs[prevIndex].id);
                }
              }
            } catch (error) {
              console.error('Error switching to previous tab:', error);
            }
          `).catch(error => {
            console.error('Script execution failed:', error);
          });
        }
      },
    },
  };

  return actions;
}

export function registerShortcuts(windowManager) {
  const actions = createActions(windowManager);

  const registerFindShortcut = (focusedWindow) => {
    if (focusedWindow) {
      globalShortcut.register("CommandOrControl+F", () => {
        actions.FindInPage.click(focusedWindow);
      });
    }
  };

  const unregisterFindShortcut = () => {
    globalShortcut.unregister("CommandOrControl+F");
  };

  // Register and unregister `Ctrl+F` based on focus
  app.on("browser-window-focus", (event, win) => {
    registerFindShortcut(win);
  });

  app.on("browser-window-blur", () => {
    unregisterFindShortcut();
  });

  // Register remaining shortcuts
  Object.keys(actions).forEach((key) => {
    const action = actions[key];
    if (key !== "FindInPage") {
      // Register other shortcuts except `Ctrl+F`
      globalShortcut.register(action.accelerator, () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow) action.click(focusedWindow);
      });
    }
  });
}