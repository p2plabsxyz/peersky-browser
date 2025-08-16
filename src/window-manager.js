import { app, BrowserWindow, ipcMain, webContents } from "electron";
import path from "path";
import fs from "fs-extra";
import ScopedFS from 'scoped-fs';
import { fileURLToPath } from "url";
import { attachContextMenus } from "./context-menu.js";
import { randomUUID } from "crypto";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const USER_DATA_PATH = app.getPath("userData");
const BOOKMARKS_FILE = path.join(USER_DATA_PATH, "bookmarks.json");
const PERSIST_FILE = path.join(USER_DATA_PATH, "lastOpened.json");

const DEFAULT_SAVE_INTERVAL = 30 * 1000;
const cssPath = path.join(__dirname, "pages", "theme");
const cssFS = new ScopedFS(cssPath);

ipcMain.handle("peersky-read-css", async (event, name) => {
  try {
    const safeName = path.basename(name).replace(/\.css$/, '') + '.css';
    const data = await new Promise((resolve, reject) => {
      cssFS.readFile(safeName, (err, buffer) => {
        if (err) {
          reject(err);
        } else {
          resolve(buffer.toString('utf8'));
        }
      });
    });
    return data;
  } catch (err) {
    console.error(`Failed to read CSS ${name}:`, err);
    return "";
  }
});

class WindowManager {
  constructor() {
    this.windows = new Set();
    this.saverTimer = null;
    this.saverInterval = DEFAULT_SAVE_INTERVAL;
    this.isSaving = false;
    this.isQuitting = false;
    this.shutdownInProgress = false;
    this.saveQueue = Promise.resolve();
    this.registerListeners();
    
    // Add signal handlers for graceful shutdown
    process.on('SIGINT', this.handleGracefulShutdown.bind(this));
    process.on('SIGTERM', this.handleGracefulShutdown.bind(this));
    
    // Enhanced app event handlers for proper UI quit handling
    app.on('before-quit', (event) => {
      if (!this.isQuitting && !this.shutdownInProgress) {
        event.preventDefault();
        this.handleGracefulShutdown();
      }
    });
    
    // Handle when all windows are closed (UI quit)
    app.on('window-all-closed', () => {
      if (!this.isQuitting && !this.shutdownInProgress) {
        // On macOS, keep app running, on other platforms quit
        if (process.platform !== 'darwin') {
          this.handleGracefulShutdown();
        }
      }
    });

    // Handle app activation (macOS specific)
    app.on('activate', () => {
      if (this.windows.size === 0 && !this.isQuitting) {
        this.open();
      }
    });
  }

  registerListeners() {
    ipcMain.on("new-window", () => {
      this.open();
    });

    // Add quit handler for UI quit button
    ipcMain.on("quit-app", () => {
      console.log("Quit app requested from UI");
      this.handleGracefulShutdown();
    });

    // Add window close handler that checks if it's the last window
    ipcMain.on("close-window", (event) => {
      const senderId = event.sender.id;
      const window = this.findWindowBySenderId(senderId);
      
      if (window) {
        // If this is the last window, trigger graceful shutdown
        if (this.windows.size === 1 && !this.isQuitting) {
          this.handleGracefulShutdown();
        } else {
          // Otherwise just close this window normally
          window.window.close();
        }
      }
    });

    ipcMain.on("add-bookmark", (_, { url, title, favicon }) => {
      this.addBookmark({ url, title, favicon });
    });

    ipcMain.handle("get-bookmarks", () => {
      return this.loadBookmarks();
    });

    ipcMain.handle("delete-bookmark", (event, { url }) => {
      return this.deleteBookmark(url);
    });

    ipcMain.handle("get-tabs", () => {
      return this.getTabs();
    });

    ipcMain.handle("close-tab", (event, id) => {
      this.sendToMainWindow('close-tab', id);
    });

    ipcMain.handle("activate-tab", async (event, id) => {
      console.log('Activating tab:', id);
      
      // Find which window contains this tab
      let targetWindow = null;
      
      for (const peerskyWindow of this.windows.values()) {
        if (peerskyWindow.window && !peerskyWindow.window.isDestroyed()) {
          try {
            const hasTab = await peerskyWindow.window.webContents.executeJavaScript(`
              (function() {
                try {
                  const tabBar = document.querySelector('#tabbar');
                  if (tabBar && tabBar.tabs) {
                    return tabBar.tabs.some(tab => tab.id === '${id}');
                  }
                  return false;
                } catch (error) {
                  console.error('Error checking for tab:', error);
                  return false;
                }
              })()
            `);
            
            if (hasTab) {
              targetWindow = peerskyWindow;
              break;
            }
          } catch (error) {
            console.log('Error checking tab in window:', error);
            // Continue to next window
          }
        }
      }
      
      if (targetWindow) {
        // Bring the window to front
        if (targetWindow.window.isMinimized()) {
          targetWindow.window.restore();
        }
        targetWindow.window.focus();
        targetWindow.window.show();
        
        // Activate the tab in that window
        targetWindow.window.webContents.send('activate-tab', id);
        
        return { success: true, windowId: targetWindow.windowId };
      } else {
        // Fallback to main window if tab not found
        console.warn(`Tab ${id} not found in any window, falling back to main window`);
        this.sendToMainWindow('activate-tab', id);
        return { success: false, message: 'Tab not found, sent to main window' };
      }
    });
    
    ipcMain.handle("group-action", (event, data) => {
      const { action, groupId } = data;
      
      // For "add-tab" action, send to specific window
      if (action === 'add-tab' || action === 'edit') {
        // Find the window that sent this request
        let senderWindow = this.findWindowByWebContentsId(event.sender.id);
        
        // If not found directly, it might be a webview - try to find parent window
        if (!senderWindow) {          
          // Try to find the parent window by checking all webContents
          const allWebContents = webContents.getAllWebContents();
          
          for (const wc of allWebContents) {
            if (wc.id === event.sender.id) {
              
              // Check if this webContents has a hostWebContents (parent)
              if (wc.hostWebContents) {
                senderWindow = this.findWindowByWebContentsId(wc.hostWebContents.id);
                if (senderWindow) {
                  break;
                }
              }
            }
          }
        }
                
        if (senderWindow) {
          // Send the action to the originating window (or its parent if it was a webview)
          this.sendToSpecificWindow(senderWindow, 'group-action', data);
        } else {
          // Fallback to main window if sender not found
          console.warn('Could not find sender window for group action, falling back to main window');
          this.sendToMainWindow('group-action', data);
        }
      } else{
        // For edit, toggle, ungroup, close-group actions, broadcast to ALL windows        
        this.windows.forEach(peerskyWindow => {
          if (peerskyWindow.window && !peerskyWindow.window.isDestroyed()) {
            peerskyWindow.window.webContents.send('group-action', data);
          }
        });
      }
      return { success: true };
    });
  }

  findWindowBySenderId(senderId) {
    for (const window of this.windows) {
      if (window.window.webContents.id === senderId) {
        return window;
      }
    }
    return null;
  }

  findWindowByWebContentsId(webContentsId) {
    for (const window of this.windows) {
      if (window.window.webContents.id === webContentsId) {
        return window;
      }
    }
    return null;
  }

  setQuitting(flag) {
    this.isQuitting = flag;
  }

  addBookmark(newBookmark) {
    if (!newBookmark || !newBookmark.url) {
      console.error("Invalid bookmark data provided.");
      return;
    }
    try {
      const bookmarks = this.loadBookmarks();
      const existingIndex = bookmarks.findIndex(
        (b) => b.url === newBookmark.url
      );

      if (existingIndex > -1) {
        bookmarks[existingIndex] = {
          ...bookmarks[existingIndex],
          ...newBookmark,
        };
        console.log(`Bookmark updated: ${newBookmark.url}`);
      } else {
        bookmarks.push({ ...newBookmark, dateAdded: new Date().toISOString() });
        console.log(`Bookmark added: ${newBookmark.url}`);
      }

      fs.writeJsonSync(BOOKMARKS_FILE, bookmarks, { spaces: 2 });
    } catch (error) {
      console.error("Error adding bookmark:", error);
    }
  }

  deleteBookmark(urlToDelete) {
    if (!urlToDelete) return false;
    try {
      console.log(`Attempting to delete bookmark: ${urlToDelete}`);
      const bookmarks = this.loadBookmarks();
      const updatedBookmarks = bookmarks.filter((b) => b.url !== urlToDelete);

      if (bookmarks.length === updatedBookmarks.length) {
        console.warn(
          `Attempted to delete a non-existent bookmark: ${urlToDelete}`
        );
        return false;
      }

      fs.writeJsonSync(BOOKMARKS_FILE, updatedBookmarks, { spaces: 2 });
      console.log(`Bookmark deleted: ${urlToDelete}`);
      return true;
    } catch (error) {
      console.error(`Error deleting bookmark: ${urlToDelete}`, error);
      return false;
    }
  }

  loadBookmarks() {
    try {
      if (!fs.existsSync(BOOKMARKS_FILE)) {
        console.log("Bookmarks file does not exist, creating a new one.");
        fs.writeJsonSync(BOOKMARKS_FILE, [], { spaces: 2 });
      }
      const bookmarks = fs.readJsonSync(BOOKMARKS_FILE);
      if (!Array.isArray(bookmarks)) {
        console.error(
          "Bookmarks file is not an array, resetting to empty array."
        );
        return [];
      }
      return bookmarks;
    } catch (error) {
      console.error("Error loading bookmarks:", error);
      return [];
    }
  }

  getMainWindow() {
    const entry = this.windows.values().next();
    if (entry && entry.value) {
      return entry.value.window;
    }
    return null;
  }

  getMainPeerskyWindow() {
    const entry = this.windows.values().next();
    if (entry && entry.value) {
      return entry.value;
    }
    return null;
  }

  sendToMainWindow(channel, data) {
    const win = this.getMainWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }

  sendToSpecificWindow(peerskyWindow, channel, data) {
    const win = peerskyWindow.window;
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  }

  async getTabs() {
    const results = {};
    
    for (const peerskyWin of this.windows) {
      const win = peerskyWin.window;
      if (!win || win.webContents.isDestroyed()) continue;
      
      try {
        const windowId = peerskyWin.windowId;
        const tabsData = await win.webContents.executeJavaScript(`
          (() => {
            try {
              const stored = localStorage.getItem("peersky-browser-tabs");
              if (!stored) return null;
              const allTabs = JSON.parse(stored);
              return allTabs["${windowId}"] || null;
            } catch (e) {
              console.error("Failed to parse tabs data:", e);
              return null;
            }
          })()
        `);
        
        if (tabsData) {
          results[windowId] = tabsData;
        }
      } catch (e) {
        console.error(`Failed to read tabs from window ${peerskyWin.windowId}:`, e);
      }
    }
    
    return Object.keys(results).length > 0 ? results : null;
  }

  open(options = {}) {
    const window = new PeerskyWindow(options, this);
    this.windows.add(window);

    window.window.on("closed", () => {
      // Remove the window from the set
      this.windows.delete(window);
      // Remove IPC listener
      ipcMain.removeListener(
        `webview-did-navigate-${window.id}`,
        window.navigateListener
      );
      
      // Save state after window is closed, only if not quitting
      if (!this.isQuitting && !this.shutdownInProgress) {
        this.saveOpened();
      }
      
      // If this was the last window and we're not already quitting, trigger shutdown
      if (this.windows.size === 0 && !this.isQuitting && !this.shutdownInProgress) {
        if (process.platform !== 'darwin') {
          this.handleGracefulShutdown();
        }
      }
    });

    // Enhanced window event handlers with better quit detection
    window.window.on("close", (event) => {
      // If we're not in shutdown mode and this is the last window, prevent close and trigger shutdown
      if (!this.isQuitting && !this.shutdownInProgress && this.windows.size === 1) {
        event.preventDefault();
        this.handleGracefulShutdown();
        return;
      }
    });

    // Save state when the window is moved, resized, or navigated, only if not quitting
    window.window.on("move", () => {
      if (!this.isQuitting && !this.shutdownInProgress) this.saveOpened();
    });
    window.window.on("resize", () => {
      if (!this.isQuitting && !this.shutdownInProgress) this.saveOpened();
    });
    window.webContents.on("did-navigate", () => {
      if (!this.isQuitting && !this.shutdownInProgress) this.saveOpened();
    });

    return window;
  }

  get all() {
    return [...this.windows.values()];
  }

  async handleGracefulShutdown() {
    if (this.shutdownInProgress) {
      console.log('Shutdown already in progress, ignoring additional signals');
      return;
    }
    
    this.shutdownInProgress = true;
    this.isQuitting = true;
    console.log('Graceful shutdown initiated...');
    
    this.stopSaver();
    
    // Wait for any ongoing saves to complete
    await this.saveQueue;
    
    const forceExitTimeout = setTimeout(() => {
      console.log('Forced exit after timeout');
      process.exit(1);
    }, 5000);
    
    try {
      // Save both window states and tabs
      await this.saveCompleteState();
      console.log('Application state saved successfully, exiting now.');
      
      // Close all windows
      for (const window of this.windows) {
        if (!window.window.isDestroyed()) {
          window.window.destroy();
        }
      }
      
    } catch (error) {
      console.error('Error during shutdown save:', error);
    } finally {
      clearTimeout(forceExitTimeout);
      app.quit();
    }
  }

  async saveCompleteState() {
    // Save both window positions/sizes and tab data
    const savePromises = [
      this.saveWindowStates(),
      this.saveAllTabsData()
    ];
    
    await Promise.allSettled(savePromises);
  }

  async saveWindowStates() {
    const windowStates = [];
    
    for (const window of this.all) {
      if (window.window.isDestroyed() || window.window.webContents.isDestroyed()) {
        continue;
      }
      
      try {
        const url = await window.getURL();
        const position = window.window.getPosition();
        const size = window.window.getSize();
        const windowId = window.windowId;
        
        windowStates.push({ windowId, url, position, size });
      } catch (error) {
        console.error(`Error saving window state for window ${window.id}:`, error);
      }
    }

    try {
      const tempPath = PERSIST_FILE + ".tmp";
      await fs.outputJson(tempPath, windowStates, { spaces: 2 });
      await fs.move(tempPath, PERSIST_FILE, { overwrite: true });
      console.log(`Window states saved to ${PERSIST_FILE}`);
    } catch (error) {
      console.error("Error writing window states to file:", error);
      throw error;
    }
  }

  async saveAllTabsData() {
    console.log("Saving all tabs data...");
    const allTabsData = await this.getTabs();
    
    if (!allTabsData) {
      console.log("No tabs data to save");
      return;
    }
    
    const TABS_FILE = path.join(USER_DATA_PATH, "tabs.json");
    
    try {
      const tempPath = TABS_FILE + ".tmp";
      await fs.outputJson(tempPath, allTabsData, { spaces: 2 });
      await fs.move(tempPath, TABS_FILE, { overwrite: true });
      console.log(`Tabs data saved to ${TABS_FILE}`);
    } catch (error) {
      console.error("Error writing tabs data to file:", error);
      throw error;
    }
  }

  async saveOpened(forceSave = false) {
    // Queue saves to prevent concurrent operations
    this.saveQueue = this.saveQueue.then(async () => {
      if (this.isSaving && !forceSave) {
        console.warn("saveOpened is already in progress.");
        return;
      }
      
      if (this.shutdownInProgress && !forceSave) {
        console.warn("Shutdown in progress, skipping regular save.");
        return;
      }
      
      this.isSaving = true;
      
      try {
        await this.saveWindowStates();
        return true;
      } catch (error) {
        console.error("Error in saveOpened:", error);
        return false;
      } finally {
        this.isSaving = false;
      }
    });
    
    return this.saveQueue;
  }

  async loadSaved() {
    try {
      const exists = await fs.pathExists(PERSIST_FILE);
      if (!exists) {
        console.log("Persist file does not exist.");
        return [];
      }

      const data = await fs.readFile(PERSIST_FILE, "utf8");
      if (!data.trim()) {
        console.log("Persist file is empty.");
        return [];
      }

      let windowStates;
      try {
        windowStates = JSON.parse(data);
      } catch (parseError) {
        console.error("Error parsing JSON from lastOpened.json:", parseError);
        const backupPath = PERSIST_FILE + ".backup";
        await fs.move(PERSIST_FILE, backupPath, { overwrite: true });
        console.warn(`Corrupted lastOpened.json backed up to ${backupPath}. Starting fresh.`);
        windowStates = [];
      }

      if (!Array.isArray(windowStates)) {
        console.error("Invalid format for window states. Expected an array.");
        return [];
      }

      console.log(`Loaded ${windowStates.length} window state(s) from persist file.`);
      return windowStates;
    } catch (e) {
      console.error("Error loading saved windows", e);
      return [];
    }
  }

  async loadSavedTabs() {
    const TABS_FILE = path.join(USER_DATA_PATH, "tabs.json");
    
    try {
      const exists = await fs.pathExists(TABS_FILE);
      if (!exists) {
        console.log("Tabs file does not exist.");
        return {};
      }

      const data = await fs.readFile(TABS_FILE, "utf8");
      if (!data.trim()) {
        console.log("Tabs file is empty.");
        return {};
      }

      let tabsData;
      try {
        tabsData = JSON.parse(data);
      } catch (parseError) {
        console.error("Error parsing JSON from tabs.json:", parseError);
        const backupPath = TABS_FILE + ".backup";
        await fs.move(TABS_FILE, backupPath, { overwrite: true });
        console.warn(`Corrupted tabs.json backed up to ${backupPath}. Starting fresh.`);
        tabsData = {};
      }

      return tabsData;
    } catch (e) {
      console.error("Error loading saved tabs", e);
      return {};
    }
  }

  async openSavedWindows() {
    const [windowStates, savedTabs] = await Promise.all([
      this.loadSaved(),
      this.loadSavedTabs()
    ]);

    if (windowStates.length === 0) {
      console.log("No windows to restore, creating default window.");
      this.open(); // Create default window
      return;
    }

    for (const [index, state] of windowStates.entries()) {
      console.log(`Opening saved window ${index + 1}:`, state);
      const options = { 
        windowId: state.windowId,
        savedTabs: savedTabs[state.windowId] || null
      };
      
      if (state.position && Array.isArray(state.position)) {
        const [x, y] = state.position;
        options.x = x;
        options.y = y;
      }
      
      if (state.size && Array.isArray(state.size)) {
        const [width, height] = state.size;
        options.width = width;
        options.height = height;
      }
      
      if (state.url) {
        options.url = state.url;
      } else {
        options.url = "peersky://home";
      }
      
      this.open(options);
    }

    console.log(`${windowStates.length} window(s) restored.`);
  }

  startSaver() {
    this.saverTimer = setInterval(() => {
      this.saveOpened();
    }, this.saverInterval);
    console.log(
      `Window state saver started with interval ${this.saverInterval}ms.`
    );
  }

  stopSaver() {
    if (this.saverTimer) {
      clearInterval(this.saverTimer);
      this.saverTimer = null;
      console.log("Window state saver stopped.");
    }
  }
}

class PeerskyWindow {
  constructor(options = {}, windowManager) {
    const { url, isMainWindow = false, newWindow = false, windowId, savedTabs, isolate, singleTab, ...windowOptions } = options;
    this.window = new BrowserWindow({
      width: 800,
      height: 600,
      frame: false,
      titleBarStyle: 'hidden',
      vibrancy: 'dark',
      backgroundMaterial: 'mica',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        nativeWindowOpen: true,
        webviewTag: true,
      },
      ...windowOptions,
    });

    this.id = this.window.webContents.id;
    this.windowId = windowId || randomUUID();
    this.savedTabs = savedTabs; // Store saved tabs for restoration
    
    const loadURL = path.join(__dirname, "pages", "index.html");
    const query = { 
      query: { 
        url: url || "peersky://home",
        ...(newWindow && { newWindow: 'true' }),
        windowId: this.windowId,
        ...(savedTabs && { restoreTabs: 'true' }),
        ...(isolate && { isolate: 'true' }),
        ...(singleTab && { 
          singleTabUrl: singleTab.url,
          singleTabTitle: singleTab.title
        })
      }
    };
    this.window.loadFile(loadURL, query);

    // Configure window transparency and vibrancy effects
    this.window.setVibrancy('fullscreen-ui');
    this.window.setBackgroundColor('#00000000');
    this.window.setBackgroundMaterial('mica');

    // Attach context menus
    attachContextMenus(this.window, windowManager);

    // Reference to windowManager for saving state
    this.windowManager = windowManager;

    // Define the listener function
    this.navigateListener = (event, url) => {
      this.currentURL = url;
      console.log(`Navigation detected in window ${this.id}: ${url}`);
      windowManager.saveOpened();
    };

    // Listen for navigation events from renderer
    ipcMain.on(`webview-did-navigate-${this.id}`, this.navigateListener);

    // Inject JavaScript into renderer to set up IPC communication
    this.window.webContents.on("did-finish-load", () => {
      if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
        // Restore tabs if available
        if (this.savedTabs) {
          this.window.webContents.executeJavaScript(`
            // Restore tabs data to localStorage
            localStorage.setItem('peersky-browser-tabs', JSON.stringify({
              '${this.windowId}': ${JSON.stringify(this.savedTabs)}
            }));
            
            // Trigger tab restoration in the renderer
            window.dispatchEvent(new CustomEvent('restore-tabs', { 
              detail: { windowId: '${this.windowId}' }
            }));
          `).catch(error => {
            console.error("Error restoring tabs:", error);
          });
        }
        
        this.window.webContents.executeJavaScript(`
          (function () {
            const { ipcRenderer } = require('electron');
            const sendNav = (url) => ipcRenderer.send('webview-did-navigate-${this.id}', url);
            const tabBar = document.querySelector('#tabbar');

            if (tabBar) {
              tabBar.addEventListener('tab-navigated', (e) => {
                if (e && e.detail && e.detail.url) sendNav(e.detail.url);
              });
            }
            ipcRenderer.send('set-window-id', ${this.id});
          })();
        `).catch((error) => {
          console.error("Error injecting script into webContents:", error);
        });
      }
    });

    this.window.on("closed", () => {
      ipcMain.removeListener(
        `webview-did-navigate-${this.id}`,
        this.navigateListener
      );
    });
  }

  get webContents() {
    return this.window.webContents;
  }

  async getURL() {
    // First check if window is destroyed to avoid unnecessary errors
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
      return "peersky://home";
    }
    
    try {
      // Add timeout to prevent hanging during shutdown
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('getURL timeout')), 1000);
      });
      
      const urlPromise = this.window.webContents.executeJavaScript(`
        (function() {
          // Try to get URL from the tab bar system
          const tabBar = document.querySelector('#tabbar');
          if (tabBar && tabBar.activeTabId) {
            const activeTab = tabBar.tabs.find(tab => tab.id === tabBar.activeTabId);
            return activeTab ? activeTab.url : 'peersky://home';
          }
          
          // Fallback: try to get from nav box URL input
          const urlInput = document.querySelector('#url');
          if (urlInput && urlInput.value) {
            return urlInput.value;
          }
          
          return 'peersky://home';
        })()
      `);
      
      // Race the promises to ensure we don't hang
      const url = await Promise.race([urlPromise, timeoutPromise]);
      return url;
    } catch (error) {
      console.error("Error getting URL:", error);
      return "peersky://home";
    }
  }
}

// handling for isolated windows
export function createIsolatedWindow(options = {}) {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    frame: false,
    titleBarStyle: 'hidden',
    vibrancy: 'dark',
    backgroundMaterial: 'mica',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      nativeWindowOpen: true,
      webviewTag: true,
    },
  });

  if (options.isolate && options.singleTab) {
    // For isolated windows, pass the specific tab data as URL parameters
    const url = new URL(path.join(__dirname, 'pages', 'index.html'), 'file:');
    url.searchParams.set('url', options.singleTab.url);
    url.searchParams.set('title', options.singleTab.title);
    url.searchParams.set('isolate', 'true'); 
    win.loadURL(url.toString());
  } else if (options.url) {
    // Regular new window with specific URL
    const url = new URL(path.join(__dirname, 'pages', 'index.html'), 'file:');
    url.searchParams.set('url', options.url);
    win.loadURL(url.toString());
  } else {
    // Default window
    win.loadFile(path.join(__dirname, 'pages', 'index.html'));
  }

  // Configure window transparency and vibrancy effects
  win.setVibrancy('fullscreen-ui');
  win.setBackgroundColor('#00000000');
  win.setBackgroundMaterial('mica');

  return win;
}

export default WindowManager;