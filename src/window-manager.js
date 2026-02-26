import { app, BrowserWindow, ipcMain, webContents, session } from "electron";
import path from "path";
import fs from "fs-extra";
import ScopedFS from 'scoped-fs';
import { fileURLToPath } from "url";
import { attachContextMenus } from "./context-menu.js";
import { randomUUID } from "crypto";
import { getPartition } from "./session.js";
import extensionManager from "./extensions/index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const USER_DATA_PATH = app.getPath("userData");
const BOOKMARKS_FILE = path.join(USER_DATA_PATH, "bookmarks.json");
const PERSIST_FILE = path.join(USER_DATA_PATH, "lastOpened.json");

const DEFAULT_SAVE_INTERVAL = 30 * 1000;
const cssPath = path.join(__dirname, "pages", "theme");
const cssFS = new ScopedFS(cssPath);

ipcMain.handle("peersky-read-css", async (_event, name) => {
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
    this.finalSaveCompleted = false;
    this.saveQueue = Promise.resolve();
    this.registerListeners();

    // Treat Ctrl+C / SIGTERM as explicit quits in dev:
    if (!app.isPackaged) {
      const handleSignal = (signal) => {
        if (this.shutdownInProgress) {
          console.log(`${signal} received while shutdown already in progress – ignoring.`);
          return;
        }
      
        this.isQuitting = true;
        this.shutdownInProgress = true;
        this.stopSaver();
      
        console.log(`${signal} received – saving session state WITHOUT clearing it, then exiting.`);
      
        (async () => {
          try {
            await this.saveCompleteState();
          } catch (error) {
            console.error(`Error during ${signal} shutdown save:`, error);
          } finally {
            this.finalSaveCompleted = true;
            app.exit(0);
          }
        })();
      };
    
      process.on('SIGINT', () => handleSignal('SIGINT'));
      process.on('SIGTERM', () => handleSignal('SIGTERM'));
    }

    app.on('before-quit', (event) => {
      // Avoid re-entering if something calls app.quit() again
      if (this.shutdownInProgress) {
        console.log('before-quit: shutdown already in progress, ignoring.');
        return;
      }
    
      console.log('before-quit: performing final session save (without clearing).');
      this.isQuitting = true;
      this.shutdownInProgress = true;
      this.stopSaver();
    
      // Prevent the default quit, we'll exit manually after the async save
      event.preventDefault();
    
      (async () => {
        try {
          await this.saveCompleteState();
        } catch (error) {
          console.error('Error during final save in before-quit:', error);
        } finally {
          this.finalSaveCompleted = true;
          // Important: app.exit() does not re-emit 'before-quit'
          app.exit(0);
        }
      })();
    });
  }

  registerListeners() {
    ipcMain.on("new-window", () => {
      this.open();
    });

    // Explicit quit from UI (custom Quit button, etc.).
    // We just call app.quit(); app.on('before-quit') will save session files.
    ipcMain.on("quit-app", () => {
      console.log("Quit app requested from UI");
      this.isQuitting = true;
      app.quit();
    });

    // Close the current window and let Electron/main.js decide
    // whether the app should quit (non-macOS) or stay alive (macOS).
    ipcMain.on("close-window", (event) => {
      const senderId = event.sender.id;
      const window = this.findWindowBySenderId(senderId);

      if (window) {
        window.window.close();
      }
    });

    ipcMain.on("add-bookmark", (_, { url, title, favicon }) => {
      this.addBookmark({ url, title, favicon });
    });

    ipcMain.on('get-tab-navigation', (event, webContentsId) => {
      try {
        const wc = webContents.fromId(webContentsId);
        if (!wc || wc.isDestroyed() || !wc.navigationHistory) {
          event.returnValue = null;
          return;
        }
        const history = wc.navigationHistory;
        const entries = history.getAllEntries() || [];
        const activeIndex = history.getActiveIndex();
        event.returnValue = { entries, activeIndex };
      } catch (err) {
        console.warn('get-tab-navigation failed:', err);
        event.returnValue = null;
      }
    });

    ipcMain.handle('restore-navigation-history', async (event, { webContentsId, entries, activeIndex }) => {
      try {
        const wc = webContents.fromId(webContentsId);
        if (!wc || wc.isDestroyed() || !wc.navigationHistory) return;
        await wc.navigationHistory.restore({
          entries,
          index: activeIndex
        });
      } catch (err) {
        console.warn('restore-navigation-history failed:', err);
      }
    });


    ipcMain.handle("get-bookmarks", () => {
      return this.loadBookmarks();
    });

    ipcMain.handle("delete-bookmark", (_event, { url }) => {
      return this.deleteBookmark(url);
    });

    ipcMain.handle("get-tabs", () => {
      return this.getTabs();
    });

    ipcMain.handle("close-tab", (_event, id) => {
      this.sendToMainWindow('close-tab', id);
    });

    ipcMain.handle("activate-tab", async (_event, id) => {
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
    
    ipcMain.handle("group-action", (_event, data) => {
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

    // If there are no live windows…
    if (validWindows.length === 0) {
      // When the app is quitting (Cmd+Q, menu Quit, SIGINT, etc.), we MUST NOT clear
      // the session files. We just leave whatever was last saved on disk.
      if (this.isQuitting || this.shutdownInProgress) {
        console.warn('No valid windows to save during quit – leaving window state file untouched.');
        return;
      }
    
      // But if the app is still running and the user has closed the last window,
      // we DO clear the file so the next launch starts fresh
      console.warn('No valid windows to save – clearing window state file so session does not restore.');
      try {
        const tempPath = PERSIST_FILE + ".tmp";
        await fs.outputJson(tempPath, [], { spaces: 2 });
        await fs.move(tempPath, PERSIST_FILE, { overwrite: true });
        console.log(`Wrote empty window state to ${PERSIST_FILE}`);
      } catch (error) {
        console.error("Error clearing window state file:", error);
      }
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

    // If, for some reason, we ended up with nothing, also clear the file
    // TODO: If this happens during app quit/shutdown, we probably should NOT clear
    // the existing file. Match the earlier logic where (isQuitting || shutdownInProgress). keeps the last good snapshot instead of wiping it.
    if (windowStates.length === 0) {
      console.warn('No window states collected during save – clearing window state file.');
      try {
        const tempPath = PERSIST_FILE + ".tmp";
        await fs.outputJson(tempPath, [], { spaces: 2 });
        await fs.move(tempPath, PERSIST_FILE, { overwrite: true });
        console.log(`Wrote empty window state to ${PERSIST_FILE}`);
      } catch (error) {
        console.error("Error clearing window state file:", error);
      }
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
      const TABS_FILE = path.join(USER_DATA_PATH, "tabs.json");

      // 🔑 If there are no tabs/windows, clear the tabs file
      if (!allTabsData || Object.keys(allTabsData).length === 0) {
        // Same logic as window states: if we're quitting, do NOT clear the file.
        if (this.isQuitting || this.shutdownInProgress) {
          console.warn("No tabs data to save during quit – leaving tabs file untouched.");
          return;
        }
      
        console.warn("No tabs data to save – clearing tabs file so session does not restore.");
        try {
          const tempPath = TABS_FILE + ".tmp";
          await fs.outputJson(tempPath, {}, { spaces: 2 });
          await fs.move(tempPath, TABS_FILE, { overwrite: true });
          console.log(`Wrote empty tabs data to ${TABS_FILE}`);
        } catch (error) {
          console.error("Error clearing tabs data file:", error);
        }
        return;
      }

      const windowCount = Object.keys(allTabsData).length;

      console.log(`Saving tabs for ${windowCount} windows...`);

      const tempPath = TABS_FILE + ".tmp";
      await fs.outputJson(tempPath, allTabsData, { spaces: 2 });
      await fs.move(tempPath, TABS_FILE, { overwrite: true });

      console.log(`Successfully saved tabs data to ${TABS_FILE} (${windowCount} windows)`);
    } catch (error) {
      console.error("Error writing tabs data to file:", error);
      throw error;
    }
  }

  async saveOpened(forceSave = false) {
    // Prevent saving when the last window has no tabs (closing last tab)
    if (
      this.windows.size === 1 &&
      !this.isQuitting &&
      !this.shutdownInProgress
    ) {
      const onlyWindow = [...this.windows][0];
      if (onlyWindow && onlyWindow.savedTabs === null) {
        console.log("Preventing save: last window has no tabs (closing last tab).");
        return;
      }
    }

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
        partition: getPartition(),
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

    // Register window with extension system for browser actions
    try {
      extensionManager.addWindow(this.window, this.window.webContents);
    } catch (error) {
      console.warn('Failed to register window with extension system:', error);
    }

    // Register webviews with the extension system as soon as they attach
    // This ensures extensions (especially MV3) can target tabs at document_start
    try {
      this.window.webContents.on("did-attach-webview", (_event, webviewWebContents) => {
        try {
          if (webviewWebContents && !webviewWebContents.isDestroyed()) {
            extensionManager.addWindow(this.window, webviewWebContents);
          }
        } catch (e) {
          console.warn("Failed to register attached webview with extension system:", e);
        }
      });
    } catch (e) {
      console.warn("Unable to observe did-attach-webview for extension registration:", e);
    }

    // Reference to windowManager for saving state
    this.windowManager = windowManager;

    // Define the listener function
    this.navigateListener = (_event, url) => {
      this.currentURL = url;
      console.log(`Navigation detected in window ${this.id}: ${url}`);
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
      // Unregister window from extension system
      try {
        // Store webContents reference before window is fully destroyed
        const webContents = this.window?.webContents;
        if (webContents && !webContents.isDestroyed()) {
          extensionManager.removeWindow(webContents);
        }
      } catch (error) {
        // Silently ignore errors during shutdown - the extension system is likely shutting down too
        console.debug('Extension system cleanup during shutdown:', error.message);
      }

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
      partition: getPartition(),
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
