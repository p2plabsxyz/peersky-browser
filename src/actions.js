import { app, BrowserWindow, webContents } from 'electron'
import { createLogger } from './logger.js'
import { goBackActiveTab, goForwardActiveTab } from './history-nav.js'
import { toggleDockedDevTools } from './devtools-dock.js'
import { tabBarCall } from './tab-shortcuts.js'
const log = createLogger('actions')

// Runs a tab bar method in the focused window, whichever tab layout it has.
function onTabBar (method, ...args) {
  const focusedWindow = BrowserWindow.getFocusedWindow()
  if (!focusedWindow) return
  focusedWindow.webContents.executeJavaScript(tabBarCall(method, ...args))
    .catch((err) => log.error(`${method} failed:`, err))
}

// Chrome's ways to a tab that no menu shows: Cmd+1 to Cmd+8 for that tab and
// Cmd+9 for the last, and on a Mac Ctrl+Tab and Cmd+Shift+] and [ as well as
// Cmd+Option+Right and Left. Elsewhere F5 reloads, and with Shift or Ctrl it
// fetches everything again. As in Chrome, a page has the numbers and the
// reloads first, and never the keys that go to the next tab (main.js).
function hiddenShortcuts (isMac) {
  const hidden = (label, accelerator, click) => ({ label, accelerator, visible: false, click })
  const actions = {}
  for (let number = 1; number <= 8; number++) {
    actions[`SelectTab${number}`] = hidden(`Tab ${number}`, `CommandOrControl+${number}`, () => onTabBar('selectTabByNumber', number))
  }
  actions.SelectLastTab = hidden('Last Tab', 'CommandOrControl+9', () => onTabBar('selectTabByNumber', 9))
  if (isMac) {
    actions.NextTabControl = hidden('Next Tab', 'Control+Tab', () => onTabBar('selectAdjacentTab', 1))
    actions.PreviousTabControl = hidden('Previous Tab', 'Control+Shift+Tab', () => onTabBar('selectAdjacentTab', -1))
    actions.NextTabBracket = hidden('Next Tab', 'Command+Shift+]', () => onTabBar('selectAdjacentTab', 1))
    actions.PreviousTabBracket = hidden('Previous Tab', 'Command+Shift+[', () => onTabBar('selectAdjacentTab', -1))
  } else {
    actions.ReloadF5 = hidden('Reload', 'F5', () => onTabBar('reloadActiveTab'))
    actions.ForceReloadShiftF5 = hidden('Force Reload', 'Shift+F5', () => onTabBar('reloadActiveTab', { ignoreCache: true }))
    actions.ForceReloadCtrlF5 = hidden('Force Reload', 'Control+F5', () => onTabBar('reloadActiveTab', { ignoreCache: true }))
  }
  return actions
}

// A null step means reset.
function zoomActiveTab (step) {
  const focusedWindow = BrowserWindow.getFocusedWindow()
  if (!focusedWindow) return
  const call = step === null ? 'resetActiveTabZoom()' : `zoomActiveTab(${step})`
  focusedWindow.webContents.executeJavaScript(`{
    const tabBar = document.querySelector('#tabbar');
    if (tabBar && typeof tabBar.zoomActiveTab === 'function') tabBar.${call};
  }`).catch((err) => log.error('Zoom action failed:', err))
}

export function createActions (windowManager) {
  const actions = {
    OpenDevTools: {
      label: 'Open Dev Tools',
      accelerator: 'CommandOrControl+Shift+I',
      click: async () => {
        const focusedWindow = BrowserWindow.getFocusedWindow()
        if (!focusedWindow) return
        const host = focusedWindow.webContents
        if (!app.isPackaged) {
          host.openDevTools({ mode: 'detach' })
          return
        }
        // The shell's console has node, so "paste this into DevTools" scams
        // would own the machine. Users get the active tab's DevTools instead.
        const guestId = await host.executeJavaScript(
          "document.querySelector('#tabbar')?.getActiveWebview()?.getWebContentsId() ?? null"
        ).catch(() => null)
        const guest = Number.isInteger(guestId) ? webContents.fromId(guestId) : null
        if (guest && guest.hostWebContents?.id === host.id) {
          toggleDockedDevTools(guest)
        } else if (host.getLastWebPreferences()?.nodeIntegration !== true) {
          host.openDevTools({ mode: 'detach' })
        }
      }
    },
    NewWindow: {
      label: 'New Window',
      accelerator: 'CommandOrControl+N',
      click: () => {
        const newWin = windowManager.open({ newWindow: true })
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
            `)
          })
        }
      }
    },
    NewIncognitoWindow: {
      label: 'New Incognito Window',
      accelerator: 'CommandOrControl+Shift+N',
      click: () => {
        windowManager.open({ incognito: true })
      }
    },
    NewTab: {
      label: 'New Tab',
      accelerator: 'CommandOrControl+T',
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow()
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
          }`)
        }
      }
    },
    // A tab's page never has this key, as in Chrome (main.js).
    ReopenClosedTab: {
      label: 'Reopen Closed Tab',
      accelerator: 'CommandOrControl+Shift+T',
      click: () => onTabBar('reopenClosedTab')
    },
    Forward: {
      label: 'Forward',
      accelerator: 'CommandOrControl+]',
      click: () => goForwardActiveTab(BrowserWindow.getFocusedWindow())
    },
    Back: {
      label: 'Back',
      accelerator: 'CommandOrControl+[',
      click: () => goBackActiveTab(BrowserWindow.getFocusedWindow())
    },
    FocusURLBar: {
      label: 'Focus URL Bar',
      accelerator: 'CommandOrControl+L',
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow()
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
          `)
        }
      }
    },
    Reload: {
      label: 'Reload',
      accelerator: 'CommandOrControl+R',
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow()
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
                if (firstWebview) firstWebview.reload();
              }
            }
          }`)
            .catch((err) => log.error('Reload action script failed:', err))
        }
      }
    },
    ForceReload: {
      label: 'Force Reload',
      accelerator: 'CommandOrControl+Shift+R',
      click: () => onTabBar('reloadActiveTab', { ignoreCache: true })
    },
    ZoomIn: {
      label: 'Zoom In',
      accelerator: 'CommandOrControl+Plus',
      click: () => zoomActiveTab(0.5)
    },
    // Most keyboards put + behind shift, so bind the bare key too.
    ZoomInEquals: {
      label: 'Zoom In',
      accelerator: 'CommandOrControl+=',
      visible: false,
      click: () => zoomActiveTab(0.5)
    },
    ZoomOut: {
      label: 'Zoom Out',
      accelerator: 'CommandOrControl+-',
      click: () => zoomActiveTab(-0.5)
    },
    ActualSize: {
      label: 'Actual Size',
      accelerator: 'CommandOrControl+0',
      click: () => zoomActiveTab(null)
    },
    Print: {
      label: 'Print...',
      accelerator: 'CommandOrControl+P',
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow()
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
          `).catch(err => log.error('Print action failed:', err))
        }
      }
    },
    Minimize: {
      label: 'Minimize',
      accelerator: 'CommandOrControl+M',
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow()
        if (focusedWindow) {
          focusedWindow.minimize()
        }
      }
    },
    Close: {
      label: 'Close',
      accelerator: 'CommandOrControl+W',
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow()
        if (focusedWindow) {
          // The tab's page is asked first, as in Chrome; the last tab takes
          // the window with it once its page lets it go.
          focusedWindow.webContents.executeJavaScript(`
            try {
              const tabBar = document.querySelector('#tabbar');
              const activeTab = tabBar && typeof tabBar.getActiveTab === 'function' ? tabBar.getActiveTab() : null;
              if (activeTab && activeTab.id && typeof tabBar.askToCloseTab === 'function') {
                tabBar.askToCloseTab(activeTab.id);
              } else {
                window.close();
              }
            } catch (error) {
              console.error('Error in Close action:', error);
              window.close();
            }
          `).catch(error => {
            log.error('Script execution failed in Close action:', error)
          })
        }
      }
    },
    FullScreen: {
      label: 'Toggle Full Screen',
      accelerator: 'F11',
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow()
        if (focusedWindow) {
          focusedWindow.setFullScreen(!focusedWindow.isFullScreen())
        }
      }
    },
    FindInPage: {
      label: 'Find in Page',
      accelerator: 'CommandOrControl+F',
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow()
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
          `)
        }
      }
    },
    // Not role: 'close', whose built-in Cmd+W was the same shortcut as Close:
    // two menu items on one key, and this one takes every tab in the window.
    CloseWindow: {
      label: 'Close Window',
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow()
        if (focusedWindow) focusedWindow.close()
      }
    },
    CloseTab: {
      label: 'Close Tab',
      accelerator: 'CommandOrControl+Shift+W',
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow()
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`
            try {
              const tabBar = document.querySelector('#tabbar');
              if (tabBar && typeof tabBar.getActiveTab === 'function' && typeof tabBar.askToCloseTab === 'function') {
                const activeTab = tabBar.getActiveTab();
                if (activeTab && activeTab.id) {
                  tabBar.askToCloseTab(activeTab.id);
                }
              }
            } catch (error) {
              console.error('Error closing tab:', error);
            }
          `).catch(error => {
            log.error('Script execution failed:', error)
          })
        }
      }
    },
    NextTab: {
      label: 'Next Tab',
      accelerator: process.platform === 'darwin'
        ? 'CommandOrControl+Option+Right'
        : 'CommandOrControl+Tab',
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow()
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
            log.error('Script execution failed:', error)
          })
        }
      }
    },
    PreviousTab: {
      label: 'Previous Tab',
      accelerator: process.platform === 'darwin'
        ? 'CommandOrControl+Option+Left'
        : 'CommandOrControl+Shift+Tab',
      click: () => {
        const focusedWindow = BrowserWindow.getFocusedWindow()
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
            log.error('Script execution failed:', error)
          })
        }
      }
    },
    ...hiddenShortcuts(process.platform === 'darwin')
  }

  return actions
}

export function createMenuTemplate (windowManager) {
  const actions = createActions(windowManager)

  const isMac = process.platform === 'darwin'

  const template = [
    // { role: 'appMenu' }
    ...(isMac
      ? [{
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
        }]
      : []),
    // { role: 'fileMenu' }
    {
      label: 'File',
      submenu: [
        { ...actions.NewWindow },
        { ...actions.NewIncognitoWindow },
        { ...actions.NewTab },
        { ...actions.ReopenClosedTab },
        { type: 'separator' },
        { ...actions.Print },
        { type: 'separator' },
        { ...actions.CloseTab },
        { ...actions.Close },
        { type: 'separator' },
        isMac ? { ...actions.CloseWindow } : { role: 'quit' }
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
        ...(isMac
          ? [
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
            ]
          : [
              { role: 'delete' },
              { type: 'separator' },
              { role: 'selectAll' }
            ]),
        { type: 'separator' },
        { ...actions.FindInPage }
      ]
    },
    // { role: 'viewMenu' }
    {
      label: 'View',
      submenu: [
        { ...actions.Reload },
        { ...actions.ForceReload },
        ...(isMac ? [] : [{ ...actions.ReloadF5 }, { ...actions.ForceReloadShiftF5 }, { ...actions.ForceReloadCtrlF5 }]),
        { type: 'separator' },
        { ...actions.ZoomIn },
        { ...actions.ZoomInEquals },
        { ...actions.ZoomOut },
        { ...actions.ActualSize },
        { type: 'separator' },
        { ...actions.FullScreen },
        { ...actions.OpenDevTools }
      ]
    },
    // { role: 'windowMenu' }
    {
      label: 'Window',
      submenu: [
        { ...actions.Minimize },
        { ...actions.NextTab },
        { ...actions.PreviousTab },
        ...['SelectTab1', 'SelectTab2', 'SelectTab3', 'SelectTab4', 'SelectTab5', 'SelectTab6', 'SelectTab7', 'SelectTab8', 'SelectLastTab']
          .map((name) => ({ ...actions[name] })),
        ...(isMac
          ? [{ ...actions.NextTabControl }, { ...actions.PreviousTabControl }, { ...actions.NextTabBracket }, { ...actions.PreviousTabBracket }]
          : []),
        ...(isMac
          ? [
              { type: 'separator' },
              { role: 'front' },
              { type: 'separator' },
              { role: 'window' }
            ]
          : [
              { ...actions.Close }
            ])
      ]
    },
    // { role: 'goMenu }
    {
      label: 'Go',
      submenu: [
        { ...actions.Back },
        { ...actions.Forward },
        { type: 'separator' },
        { ...actions.FocusURLBar }
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Learn More',
          click: async () => {
            const { shell } = require('electron')
            await shell.openExternal('https://peersky.xyz')
          }
        }
      ]
    }
  ]

  return template
}
