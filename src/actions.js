import { app, BrowserWindow } from "electron";
import WindowManager from './window-manager.js';

export function createActions(windowManager) {
  const actions = {
    OpenDevTools: {
      label: "Open Dev Tools",
      accelerator: "CommandOrControl+Shift+I",
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow) {
          focusedWindow.webContents.openDevTools({ mode: "detach" });
        }
      },
    },
    NewWindow: {
      label: "New Window",
      accelerator: "CommandOrControl+N",
      click: () => {
        const newWin = windowManager.open({ newWindow: true });
        if (newWin && newWin.webContents) {
          newWin.webContents.once('did-finish-load', () => {
            newWin.webContents.executeJavaScript(`
              setTimeout(() => {
                const urlInput = document.getElementById('url');
                if (urlInput) {
                  urlInput.focus();
                  urlInput.select();
                }
              }, 900);
            `);
          });
        }
      },
    },
    NewTab: {
      label: "New Tab",
      accelerator: "CommandOrControl+T",
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`{
            const tabBar = document.querySelector('#tabbar');
            if (tabBar && typeof tabBar.addTab === 'function') {
              tabBar.addTab();
              // Ensure URL bar gets focus after tab creation
              setTimeout(() => {
                const urlInput = document.getElementById('url');
                if (urlInput) {
                  urlInput.focus();
                  urlInput.select();
                }
              }, 150);
            }
          }`);
        }
      },
    },
    Forward: {
      label: "Forward",
      accelerator: "CommandOrControl+]",
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`{
            const tabBar = document.querySelector('#tabbar');
            if (tabBar && typeof tabBar.goForwardActiveTab === 'function') {
              tabBar.goForwardActiveTab();
            } else {
              // Fallback for single webview
              const webview = document.querySelector('webview');
              if (webview && webview.canGoForward()) {
                webview.goForward();
              }
            }
          }`);
        }
      },
    },
    Back: {
      label: "Back",
      accelerator: "CommandOrControl+[",
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`{
            const tabBar = document.querySelector('#tabbar');
            if (tabBar && typeof tabBar.goBackActiveTab === 'function') {
              tabBar.goBackActiveTab();
            } else {
              // Fallback for single webview
              const webview = document.querySelector('webview');
              if (webview && webview.canGoBack()) {
                webview.goBack();
              }
            }
          }`);
        }
      },
    },
    FocusURLBar: {
      label: "Focus URL Bar",
      accelerator: "CommandOrControl+L",
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`
            function focusUrlBar() {
              const urlInput = document.getElementById('url');
              if (urlInput) {
                urlInput.focus();
                urlInput.select();
                return true;
              }
              return false;
            }
            
            // Try to focus immediately
            if (!focusUrlBar()) {
              // If not found, wait a bit for DOM to be ready
              setTimeout(() => {
                if (!focusUrlBar()) {
                  // Last resort: wait longer for new tab/window initialization
                  setTimeout(() => {
                    focusUrlBar();
                  }, 200);
                }
              }, 50);
            }
          `);
        }
      },
    },
    Reload: {
      label: "Reload",
      accelerator: "CommandOrControl+R",
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`{
            const tabBar = document.querySelector('#tabbar');
            if (tabBar && typeof tabBar.reloadActiveTab === 'function' && tabBar.activeTabId) {
              // Only use tab-based reload if we have an active tab
              console.log('Reloading active tab:', tabBar.activeTabId);
              tabBar.reloadActiveTab();
            } else {
              // Fallback: find the currently visible webview only
              const webviews = document.querySelectorAll('webview');
              let activeWebview = null;
              
              // Find the visible webview (not hidden)
              for (const webview of webviews) {
                if (webview.style.display !== 'none' && webview.offsetParent !== null) {
                  activeWebview = webview;
                  break;
                }
              }
              
              if (activeWebview) {
                console.log('Reloading visible webview:', activeWebview.src);
                activeWebview.reload();
              } else {
                // Last resort: reload the first webview
                const firstWebview = document.querySelector('webview');
                if (firstWebview) {
                  console.log('Reloading first webview as fallback');
                  firstWebview.reload();
                }
              }
            }
          }`);
        }
      },
    },
    Print: {
      label: "Print...",
      accelerator: "CommandOrControl+P",
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`
            (function() {
              const tabBar = document.querySelector('#tabbar');
              if (tabBar && typeof tabBar.getActiveWebview === 'function') {
                const activeWebview = tabBar.getActiveWebview();
                if (activeWebview) {
                  activeWebview.executeJavaScript('window.print()');
                  return true;
                }
              }
              // Fallback: find the currently visible webview
              const webviews = document.querySelectorAll('webview');
              for (const webview of webviews) {
                if (webview.style.display !== 'none' && webview.offsetParent !== null) {
                  webview.executeJavaScript('window.print()');
                  return true;
                }
              }
              return false;
            })()
          `).catch(err => console.error('Print action failed:', err));
        }
      },
    },
    Minimize: {
      label: "Minimize",
      accelerator: "CommandOrControl+M",
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow) {
          focusedWindow.minimize();
        }
      },
    },
    Close: {
      label: "Close",
      accelerator: "CommandOrControl+W",
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
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
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow) {
          focusedWindow.setFullScreen(!focusedWindow.isFullScreen());
        }
      },
    },
    FindInPage: {
      label: "Find in Page",
      accelerator: "CommandOrControl+F",
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
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
    CloseTab: {
      label: "Close Tab",
      accelerator: "CommandOrControl+Shift+W",
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
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
      accelerator: process.platform === "darwin"
    ? "CommandOrControl+Option+Right"
    : "CommandOrControl+Tab",
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
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
      accelerator: process.platform === "darwin"
    ? "CommandOrControl+Option+Left"
    : "CommandOrControl+Shift+Tab",
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
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

export function createMenuTemplate(windowManager) {
    const actions = createActions(windowManager);
    
    const isMac = process.platform === 'darwin';

    const template = [
        // { role: 'appMenu' }
        ...(isMac ? [{
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        }] : []),
        // { role: 'fileMenu' }
        {
            label: 'File',
            submenu: [
                {...actions.NewWindow},
                {...actions.NewTab},
                { type: 'separator' },
                {...actions.Print},
                { type: 'separator' },
                {...actions.CloseTab},
                {...actions.Close},
                { type: 'separator' },
                isMac ? { role: 'close' } : { role: 'quit' }
            ]
        },
        // { role: 'editMenu' }
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                ...(isMac ? [
                    { role: 'pasteAndMatchStyle' },
                    { role: 'delete' },
                    { role: 'selectAll' },
                    { type: 'separator' },
                    {
                        label: 'Speech',
                        submenu: [
                            { role: 'startSpeaking' },
                            { role: 'stopSpeaking' }
                        ]
                    }
                ] : [
                    { role: 'delete' },
                    { type: 'separator' },
                    { role: 'selectAll' }
                ]),
                { type: 'separator' },
                {...actions.FindInPage}
            ]
        },
        // { role: 'viewMenu' }
        {
            label: 'View',
            submenu: [
                {...actions.Reload},
                { type: 'separator' },
                {...actions.FullScreen},
                {...actions.OpenDevTools}
            ]
        },
        // { role: 'windowMenu' }
        {
            label: 'Window',
            submenu: [
                {...actions.Minimize},
                {...actions.NextTab},
                {...actions.PreviousTab},
                ...(isMac ? [
                    { type: 'separator' },
                    { role: 'front' },
                    { type: 'separator' },
                    { role: 'window' }
                ] : [
                    {...actions.Close}
                ])
            ]
        },
        // { role: 'goMenu }
        {
            label: 'Go',
            submenu: [
                {...actions.Back},
                {...actions.Forward},
                { type: 'separator' },
                {...actions.FocusURLBar}
            ]
        },
        {
            role: 'help',
            submenu: [
                {
                    label: 'Learn More',
                    click: async () => {
                        const { shell } = require('electron');
                        await shell.openExternal('https://peersky.xyz');
                    }
                }
            ]
        }
    ];

    return template;
}