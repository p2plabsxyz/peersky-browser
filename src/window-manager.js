import { app, BrowserWindow, ipcMain, webContents, session } from "electron";
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
const tabHistories = new Map();
const tabToWebContents = new Map();

function ensureTabHistory(tabId) {
  if (!tabHistories.has(tabId)) {
    tabHistories.set(tabId, { history: [], index: -1, ignoreNextNav: false });
  }
  return tabHistories.get(tabId);
}

function normalizeUrlForHistory(raw) {
  try {
    if (typeof raw !== 'string' || !raw.trim()) return raw;
    const u = new URL(raw, 'http://localhost'); // base for relative URLs
    // Remove the DuckDuckGo `ia=web` noise and common tracking params
    u.searchParams.delete('ia');
    for (const p of Array.from(u.searchParams.keys())) {
      if (p.startsWith('utm_')) u.searchParams.delete(p);
    }
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      let out = u.toString();
      if (out.endsWith('/') && u.pathname === '/') {
        out = out.slice(0, -1);
      }
      return out;
    }
    return raw;
  } catch (err) {
    return raw;
  }
}

function pushTabUrl(tabId, url, isInPage = false) {
  if (!tabId) return;
  if (typeof url !== 'string' || !url) return;
  const normalized = normalizeUrlForHistory(url);
  const entry = ensureTabHistory(tabId);

  if (entry.index >= 0 && normalizeUrlForHistory(entry.history[entry.index]) === normalized && !isInPage) return;

  if (entry.index + 1 < entry.history.length) {
    entry.history = entry.history.slice(0, entry.index + 1);
  }

  // push normalized URL (but keep original if you prefer; normalized reduces duplicates)
  entry.history.push(normalized);
  entry.index = entry.history.length - 1;

  const MAX = 200;
  if (entry.history.length > MAX) {
    entry.history = entry.history.slice(entry.history.length - MAX);
    entry.index = entry.history.length - 1;
  }
}


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
    this.isClosingLastWindow = false
    this.shutdownInProgress = false;
    this.saveQueue = Promise.resolve();
    this.finalSaveCompleted = false;
    this.isClearingState = false;
    this.registerListeners();

    // Add signal handlers for graceful shutdown
    process.on('SIGINT', this.handleGracefulShutdown.bind(this));
    process.on('SIGTERM', this.handleGracefulShutdown.bind(this));

    // Enhanced app event handlers for proper UI quit handling
    app.on('before-quit', (event) => {
      // If we're clearing state (windows closed), don't save
      if (this.isClearingState) {
        return;
      }
      
      if (!this.finalSaveCompleted) {
        event.preventDefault();

        if (!this.isQuitting && !this.shutdownInProgress) {
          this.handleGracefulShutdown();
        }
      }
    });

    // Handle when all windows are closed (UI quit)
    app.on('window-all-closed', async () => {
      if (!this.isQuitting && !this.shutdownInProgress) {
        // On macOS, keep app running, on other platforms quit
        // Clear saved state since user closed all windows (didn't quit)
        this.isClearingState = true;
        this.isQuitting = true;
        this.shutdownInProgress = true;
        this.finalSaveCompleted = true; // Prevent before-quit from trying to save
        this.stopSaver();
        await this.clearSavedState();

        if (process.platform !== 'darwin') {
          app.quit();
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
        this.saveOpened(true);
      } else {
        // For edit, toggle, ungroup, close-group actions, broadcast to ALL windows        
        this.windows.forEach(peerskyWindow => {
          if (peerskyWindow.window && !peerskyWindow.window.isDestroyed()) {
            peerskyWindow.window.webContents.send('group-action', data);
          }
        });
      }
      return { success: true };
    });

    // Handle save-state events from renderer (tabs/windows changed)
    ipcMain.on("save-state", () => {
      if (!this.isQuitting && !this.shutdownInProgress) {
        this.saveOpened();
      }
    });

    ipcMain.handle('nav-can-go-back', (event, tabId) => {
      return this.canGoBack(tabId);
    });

    ipcMain.handle('nav-can-go-forward', (event, tabId) => {
      return this.canGoForward(tabId);
    });

    ipcMain.handle('nav-go-back', async (event, { tabId, webContentsId }) => {
      const wcId = webContentsId || tabToWebContents.get(tabId);
      const wc = wcId ? webContents.fromId(wcId) : event.sender;    
      return await this.goBack(tabId, wc);
    });

    ipcMain.handle('nav-go-forward', async (event, { tabId, webContentsId }) => {
      const wcId = webContentsId || tabToWebContents.get(tabId);
      const wc = wcId ? webContents.fromId(wcId) : event.sender;
      return await this.goForward(tabId, wc);
    });

    ipcMain.on('register-tab-webcontents', (event, { tabId, webContentsId }) => {
      try {
        if (!tabId || !webContentsId) return;
        tabToWebContents.set(tabId, webContentsId);
      } catch (err) {
        console.error('register-tab-webcontents error', err);
      }
    });

    // remove mapping when renderer notifies tab closed
    ipcMain.on('unregister-tab-webcontents', (event, { tabId }) => {
      try {
        if (!tabId) return;
        tabToWebContents.delete(tabId);
      } catch (err) {
        console.error('unregister-tab-webcontents error', err);
      }
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

   sendNavStateToWindow(winWebContents, tabId) {
    try {
      if (!winWebContents || winWebContents.isDestroyed()) return;
      const e = tabHistories.get(tabId) || { history: [], index: -1 };
      const canBack = e.index > 0;
      const canForward = (e.index + 1) < e.history.length;
      winWebContents.send('nav-state-changed', { tabId, canBack, canForward });
    } catch (err) {
      console.error('sendNavStateToWindow error', err);
    }
  }

  async getTabs() {
    const results = {};
    const validWindows = Array.from(this.windows).filter(w =>
      w.window && !w.window.isDestroyed() && !w.window.webContents.isDestroyed()
    );

    console.log(`Getting tabs from ${validWindows.length} windows`);

    for (const peerskyWin of validWindows) {
      const win = peerskyWin.window;

      try {
        const windowId = peerskyWin.windowId;
        const tabsData = await win.webContents.executeJavaScript(`
        (() => {
          try {
            const tabBar = document.querySelector('tab-bar, vertical-tabs');
            if (tabBar && typeof tabBar.getTabsStateForSaving === 'function') {
              return tabBar.getTabsStateForSaving();
            }
            // Fallback to localStorage if the new method isn't available for some reason.
            console.warn('Falling back to localStorage to get tab state for window ${windowId}');
            const stored = localStorage.getItem("peersky-browser-tabs");
            if (!stored) return null;
            const allTabs = JSON.parse(stored);
            return allTabs["${windowId}"] || null;
          } catch (e) {
            console.error("Failed to get tabs data from renderer:", e);
            return null;
          }
        })()
      `);

        if (tabsData && tabsData.tabs) {
          results[windowId] = tabsData;
          console.log(`Got ${tabsData.tabs.length} tabs from window ${windowId}`);
        }
      } catch (e) {
        console.error(`Failed to read tabs from window ${peerskyWin.windowId}:`, e.message);
      }
    }

    return Object.keys(results).length > 0 ? results : null;
  }

  open(options = {}) {
    const window = new PeerskyWindow(options, this);
    this.windows.add(window);

    window.window.on("closed", () => {
      const wasLastWindow = this.windows.size === 1;
      this.windows.delete(window);
      ipcMain.removeListener(
        `webview-did-navigate-${window.id}`,
        window.navigateListener
      );

      // Only save if not shutting down and not closing the last window
      if (!this.isQuitting && !this.shutdownInProgress && !wasLastWindow) {
        this.saveOpened();
      }
    });

    window.window.on("close", (event) => {
      if (this.shutdownInProgress && !this.finalSaveCompleted) {
        console.log(`Preventing window ${window.id} from closing until save completes`);
        event.preventDefault();
        return;
      }
      
      // If this is the last window, mark that we're clearing state
      if (this.windows.size === 1) {
        this.isClearingState = true;
        this.stopSaver();
      }
    });

    // Only save on move/resize if not shutting down
    window.window.on("move", () => {
      if (!this.isQuitting && !this.shutdownInProgress) {
        this.saveOpened();
      }
    });

    window.window.on("resize", () => {
      if (!this.isQuitting && !this.shutdownInProgress) {
        this.saveOpened();
      }
    });

    window.webContents.on("did-navigate", () => {
      if (!this.isQuitting && !this.shutdownInProgress) {
        this.saveOpened();
      }
    });

    return window;
  }

  get all() {
    return [...this.windows.values()];
  }
  async clearSavedState() {
    try {
      console.log("Clearing saved session state (files and browser data)...");
      const TABS_FILE = path.join(USER_DATA_PATH, "tabs.json");

      // Promise to clear session storage (localStorage, etc.)
      const clearSessionPromise = session.defaultSession.clearStorageData();

      // Promise to clear our custom state files
      const clearFilesPromise = (async () => {
        await fs.outputJson(PERSIST_FILE, [], { spaces: 2 });
        await fs.outputJson(TABS_FILE, {}, { spaces: 2 });
      })();

      await Promise.all([clearSessionPromise, clearFilesPromise]);

      console.log("Session state has been cleared successfully.");
    } catch (error) {
      console.error("Error clearing saved session state:", error);
    }
  }
  async handleGracefulShutdown() {
    if (this.shutdownInProgress) {
      console.log('Shutdown already in progress, ignoring additional signals');
      return;
    }

    // Set flags IMMEDIATELY to block window closes and new saves
    this.shutdownInProgress = true;
    this.isQuitting = true;
    console.log('Graceful shutdown initiated...');

    // Stop the periodic saver immediately
    this.stopSaver();

    const forceExitTimeout = setTimeout(() => {
      console.log('Forced exit after timeout');
      process.exit(1);
    }, 8000);

    try {
      console.log('Saving final state before exit...');
      await this.saveCompleteState();
      this.finalSaveCompleted = true;
      console.log('State saved successfully. Now safe to close windows.');

      // ONLY AFTER successful save, close all windows
      console.log('Destroying windows...');
      const windowsToClose = Array.from(this.windows);
      for (const window of windowsToClose) {
        if (!window.window.isDestroyed()) {
          window.window.destroy();
        }
      }

    } catch (error) {
      console.error('Error during shutdown:', error);
    } finally {
      clearTimeout(forceExitTimeout);
      console.log('Exiting application...');
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
    console.log(`Starting saveWindowStates with ${this.windows.size} windows`);

    // Filter out destroyed windows BEFORE starting async operations
    const validWindows = Array.from(this.windows).filter(window => {
      try {
        return !window.window.isDestroyed() &&
          !window.window.webContents.isDestroyed();
      } catch (e) {
        console.error(`Error checking window ${window.id}:`, e);
        return false;
      }
    });

    console.log(`Found ${validWindows.length} valid windows to save`);

    if (validWindows.length === 0) {
      console.warn('No valid windows to save!');
      return;
    }

    const windowStates = [];

    // Save each window's state with individual error handling
    for (const window of validWindows) {
      try {
        // Double-check window is still valid
        if (window.window.isDestroyed() || window.window.webContents.isDestroyed()) {
          console.log(`Window ${window.id} was destroyed during save, skipping`);
          continue;
        }

        // Get window properties synchronously to avoid race conditions
        const position = window.window.getPosition();
        const size = window.window.getSize();
        const windowId = window.windowId;

        // Get URL with timeout
        const urlPromise = window.getURL();
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('URL fetch timeout')), 2000);
        });

        const url = await Promise.race([urlPromise, timeoutPromise]);

        windowStates.push({ windowId, url, position, size });
        console.log(`Saved state for window ${windowId}: ${url}`);

      } catch (error) {
        console.error(`Error saving window ${window.id}:`, error.message);
        // Continue with other windows
      }
    }

    if (windowStates.length === 0) {
      console.error('Failed to save any window states!');
      // Don't write an empty file - keep the existing one
      return;
    }

    try {
      const tempPath = PERSIST_FILE + ".tmp";
      await fs.outputJson(tempPath, windowStates, { spaces: 2 });
      await fs.move(tempPath, PERSIST_FILE, { overwrite: true });
      console.log(`Successfully saved ${windowStates.length} window states to ${PERSIST_FILE}`);
    } catch (error) {
      console.error("Error writing window states to file:", error);
      throw error;
    }
  }

  async saveAllTabsData() {
    console.log("Starting saveAllTabsData...");

    try {
      const allTabsData = await this.getTabs();

      if (!allTabsData || Object.keys(allTabsData).length === 0) {
        console.warn("No tabs data to save - keeping existing file");
        return;
      }

      const TABS_FILE = path.join(USER_DATA_PATH, "tabs.json");
      const windowCount = Object.keys(allTabsData).length;

      console.log(`Saving tabs for ${windowCount} windows...`);

      try {
        for (const windowId of Object.keys(allTabsData)) {
          const winObj = allTabsData[windowId];
          if (!winObj || !Array.isArray(winObj.tabs)) continue;
          for (const tabObj of winObj.tabs) {
            if (!tabObj || !tabObj.id) continue;
            const hist = tabHistories.get(tabObj.id);
            if (hist && Array.isArray(hist.history) && hist.history.length > 0) {
              // attach history and index (non-destructive)
              tabObj.__history = hist.history.slice(); // copy
              tabObj.__historyIndex = hist.index;
            } else {
              // ensure fields exist for consistent format
              tabObj.__history = tabObj.__history || [];
              tabObj.__historyIndex = (typeof tabObj.__historyIndex === 'number') ? tabObj.__historyIndex : -1;
            }
          }
        }
      } catch (mergeErr) {
        console.error('Error merging tab histories into allTabsData:', mergeErr);
      }

      const tempPath = TABS_FILE + ".tmp";
      await fs.outputJson(tempPath, allTabsData, { spaces: 2 });
      await fs.move(tempPath, TABS_FILE, { overwrite: true });

      console.log(`Successfully saved tabs data to ${TABS_FILE} (${windowCount} windows)`);
    } catch (error) {
      console.error("Error writing tabs data to file:", error);
      throw error;
    }
  }

  canGoBack(tabId) {
    const e = tabHistories.get(tabId);
    return !!(e && e.index > 0);
  }

  canGoForward(tabId) {
    const e = tabHistories.get(tabId);
    return !!(e && e.index + 1 < e.history.length);
  }

  async goBack(tabId, targetWebContents) {
    const e = tabHistories.get(tabId);
    if (!e || e.index <= 0) return false;
    e.index -= 1;
    const url = e.history[e.index];
    e.ignoreNextNav = true;
    try {
      await targetWebContents.loadURL(url);
      this.saveOpened();
      try {
        const bw = BrowserWindow.fromWebContents(targetWebContents);
        if (bw && !bw.isDestroyed()) {
          bw.webContents.send('nav-state-changed', { tabId, canBack: this.canGoBack(tabId), canForward: this.canGoForward(tabId) });
        } else {
          // fallback: use any mapped webcontents registered for this tab
          const mappedId = tabToWebContents.get(tabId);
          if (mappedId) {
            const wc = webContents.fromId(mappedId);
            if (wc && !wc.isDestroyed()) {
              wc.send('nav-state-changed', { tabId, canBack: this.canGoBack(tabId), canForward: this.canGoForward(tabId) });
            }
          }
        }
      } catch (err) {
        console.error('Error sending nav-state after programmatic navigation', err);
      }
      return true;
    } catch (err) {
      console.error('goBack loadURL failed', err);
      return false;
    }
  }

  async goForward(tabId, targetWebContents) {
    const e = tabHistories.get(tabId);
    if (!e || e.index + 1 >= e.history.length) return false;
    e.index += 1;
    const url = e.history[e.index];
    e.ignoreNextNav = true;
    try {
      await targetWebContents.loadURL(url);
      this.saveOpened();
      try {
        const bw = BrowserWindow.fromWebContents(targetWebContents);
        if (bw && !bw.isDestroyed()) {
          bw.webContents.send('nav-state-changed', { tabId, canBack: this.canGoBack(tabId), canForward: this.canGoForward(tabId) });
        } else {
          // fallback: use any mapped webcontents registered for this tab
          const mappedId = tabToWebContents.get(tabId);
          if (mappedId) {
            const wc = webContents.fromId(mappedId);
            if (wc && !wc.isDestroyed()) {
              wc.send('nav-state-changed', { tabId, canBack: this.canGoBack(tabId), canForward: this.canGoForward(tabId) });
            }
          }
        }
      } catch (err) {
        console.error('Error sending nav-state after programmatic navigation', err);
      }
      return true;
    } catch (err) {
      console.error('goForward loadURL failed', err);
      return false;
    }
  }

  async saveOpened(forceSave = false) {
    //Never save(periodic saves) during shutdown
    if (this.shutdownInProgress) {
      console.log("Shutdown in progress - saveOpened blocked");
      return;
    }

    if (this.finalSaveCompleted) {
      console.log("Final save completed - saveOpened blocked");
      return;
    }

    // Queue saves to prevent concurrent operations
    this.saveQueue = this.saveQueue.then(async () => {
      // Double-check we're not shutting down
      if (this.shutdownInProgress || this.finalSaveCompleted) {
        return;
      }

      if (this.isSaving && !forceSave) {
        console.warn("Save already in progress");
        return;
      }

      this.isSaving = true;

      try {
        await this.saveCompleteState();
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

      try {
        const savedForWindow = savedTabs[state.windowId];
        if (savedForWindow && Array.isArray(savedForWindow.tabs)) {
          for (const tabObj of savedForWindow.tabs) {
            if (!tabObj || !tabObj.id) continue;
            if (Array.isArray(tabObj.__history) && tabObj.__history.length > 0) {
              tabHistories.set(tabObj.id, {
                history: tabObj.__history.slice(),
                index: typeof tabObj.__historyIndex === 'number'
                  ? tabObj.__historyIndex
                  : (tabObj.__history.length - 1),
                ignoreNextNav: true 
              });
            }
          }
        }
      } catch (err) {
        console.error('Error preloading tab histories for window', state.windowId, err);
      }

      const peerskyWindow = this.open(options);

      try {
        const savedForWindow = savedTabs[state.windowId];
        if (peerskyWindow && savedForWindow && Array.isArray(savedForWindow.tabs)) {
          for (const tabObj of savedForWindow.tabs) {
            if (!tabObj || !tabObj.id) continue;
              // ensure tabHistories already preloaded earlier in the loop
              this.sendNavStateToWindow(peerskyWindow.window.webContents, tabObj.id);
            }
          }
      } catch (err) {
        console.error('Error sending initial nav state for window', state.windowId, err);
        }
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
    this.windowId = windowId || randomUUID()
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
    this.navigateListener = (event, tabId, url, isInPage = false) => {
      this.currentURL = url;

      try {
        if (!tabId) {
          // no tab id — still trigger save so state isn't lost
          console.warn(`[NAV-LISTENER] No tabId for url=${url}`);
        } else {
          const entry = ensureTabHistory(tabId);
          if (entry.ignoreNextNav) {
            // we triggered the navigation programmatically — ignore this single event
            entry.ignoreNextNav = false;
          } else {
            try {
              windowManager.sendNavStateToWindow(this.window.webContents, tabId);
            } catch (err) {
              // ignore
            }
            pushTabUrl(tabId, url, !!isInPage);
          }
        }
      } catch (err) {
        console.error('[NAV-LISTENER] Error updating tab history:', err);
      }

      // persist tabs/windows state
      windowManager.saveOpened();
    };
    // Listen for navigation events from renderer
    ipcMain.on(`webview-did-navigate-${this.id}`, this.navigateListener);

    // Inject JavaScript into renderer to set up IPC communication
    this.window.webContents.on("did-finish-load", () => {
      if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
        if (this.savedTabs) {
          this.window.webContents.executeJavaScript(`
        (function() {
          try {
            // CRITICAL: Merge with existing localStorage, don't overwrite
            const existingData = localStorage.getItem('peersky-browser-tabs');
            let allTabsData = {};
            
            if (existingData) {
              try {
                allTabsData = JSON.parse(existingData);
              } catch (e) {
                console.error('Failed to parse existing tabs data:', e);
              }
            }
            
            // Add this window's tabs to the collection
            allTabsData['${this.windowId}'] = ${JSON.stringify(this.savedTabs)};
            
            // Save merged data
            localStorage.setItem('peersky-browser-tabs', JSON.stringify(allTabsData));
            
            console.log('Restored tabs for window ${this.windowId}');
            
            // Trigger tab restoration
            window.dispatchEvent(new CustomEvent('restore-tabs', { 
              detail: { windowId: '${this.windowId}' }
            }));
          } catch (error) {
            console.error('Error restoring tabs:', error);
          }
        })();
      `).catch(error => {
            console.error("Error restoring tabs:", error);
          });
        }

        this.window.webContents.executeJavaScript(`
      (function () {
        const { ipcRenderer } = require('electron');
        const sendNav = (tabId, url, isInPage = false) => ipcRenderer.send('webview-did-navigate-${this.id}', tabId, url, isInPage);
        const tabBar = document.querySelector('#tabbar');

        if (tabBar) {
          tabBar.addEventListener('tab-navigated', (e) => {
            try {
              const detail = e && e.detail ? e.detail : {};
              const tabId = detail.id || detail.tabId || tabBar.activeTabId || null;
              const url = detail.url || null;
              const isInPage = !!detail.isInPage;
              if (tabId && url) {
                sendNav(tabId, url, isInPage);
              }
            } catch (error) {
              console.error('Error sending nav event:', error);
            }
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
      // Increase timeout to 2000ms to handle slow shutdowns
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('getURL timeout')), 2000);
      });

      const urlPromise = this.window.webContents.executeJavaScript(`
      (function() {
        try {
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
        } catch (error) {
          return 'peersky://home';
        }
      })()
    `);

      // Race the promises to ensure we don't hang
      const url = await Promise.race([urlPromise, timeoutPromise]);
      return url;
    } catch (error) {
      // Don't log timeout errors during shutdown
      if (!this.windowManager || !this.windowManager.shutdownInProgress) {
        console.error("Error getting URL:", error);
      }
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