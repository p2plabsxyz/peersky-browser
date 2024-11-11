import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import fs from "fs-extra";
import { fileURLToPath } from "url";
import { attachContextMenus } from "./context-menu.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PERSIST_FILE = path.join(app.getPath("userData"), "lastOpened.json");
const DEFAULT_SAVE_INTERVAL = 30 * 1000;

class WindowManager {
  constructor() {
    this.windows = new Set();
    this.saverTimer = null;
    this.saverInterval = DEFAULT_SAVE_INTERVAL;
    this.isSaving = false; // Flag to prevent concurrent saves
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
      // Save the state after the window is closed
      this.saveOpened();
    });

    // Save state when the window is moved, resized, or navigated
    window.window.on("move", () => this.saveOpened());
    window.window.on("resize", () => this.saveOpened());
    window.webContents.on("did-navigate", () => this.saveOpened());

    return window;
  }

  get all() {
    return [...this.windows.values()];
  }

  async saveOpened() {
    if (this.isSaving) return; // Prevent concurrent saves
    this.isSaving = true;

    const windowStates = [];
    for (const window of this.all) {
      // Skip destroyed windows
      if (
        window.window.isDestroyed() ||
        window.window.webContents.isDestroyed()
      ) {
        continue;
      }
      try {
        const url = await window.getURL();
        const position = window.window.getPosition();
        const size = window.window.getSize();
        windowStates.push({ url, position, size });
      } catch (error) {
        console.error("Error saving window state:", error);
      }
    }

    try {
      // Write to a temporary file first to prevent data corruption
      const tempPath = PERSIST_FILE + ".tmp";
      fs.outputJsonSync(tempPath, windowStates);
      fs.moveSync(tempPath, PERSIST_FILE, { overwrite: true });
    } catch (error) {
      console.error("Error writing window states to file:", error);
    }

    this.isSaving = false;
  }

  async loadSaved() {
    try {
      const exists = await fs.pathExists(PERSIST_FILE);
      if (!exists) {
        return [];
      }

      const data = await fs.readFile(PERSIST_FILE, "utf8");
      if (!data.trim()) {
        // Check for empty or whitespace-only content
        return [];
      }

      // Attempt to parse JSON, handle unexpected characters gracefully
      let windowStates;
      try {
        windowStates = JSON.parse(data);
      } catch (parseError) {
        console.error("Error parsing JSON from lastOpened.json:", parseError);
        // Backup the corrupted file and reset the state
        const backupPath = PERSIST_FILE + ".backup";
        fs.moveSync(PERSIST_FILE, backupPath, { overwrite: true });
        console.warn(
          `Corrupted lastOpened.json backed up to ${backupPath}. Starting fresh.`
        );
        windowStates = [];
      }

      // Validate that windowStates is an array
      if (!Array.isArray(windowStates)) {
        console.error("Invalid format for window states. Expected an array.");
        return [];
      }

      return windowStates;
    } catch (e) {
      console.error("Error loading saved windows", e);
      return [];
    }
  }

  async openSavedWindows() {
    const windowStates = await this.loadSaved();

    for (const state of windowStates) {
      const options = {};
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
  }

  startSaver() {
    this.saverTimer = setInterval(() => {
      this.saveOpened();
    }, this.saverInterval);
  }

  stopSaver() {
    if (this.saverTimer) {
      clearInterval(this.saverTimer);
      this.saverTimer = null;
    }
  }
}

class PeerskyWindow {
  constructor(options = {}, windowManager) {
    const { url, isMainWindow = false, ...windowOptions } = options;
    this.window = new BrowserWindow({
      width: 800,
      height: 600,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        nativeWindowOpen: true,
        webviewTag: true,
      },
      ...windowOptions,
    });

    this.id = this.window.webContents.id;

    const loadURL = path.join(__dirname, "./pages/index.html");
    const query = { query: { url: url || "peersky://home" } };
    this.window.loadFile(loadURL, query);

    // Attach context menus
    attachContextMenus(this.window, windowManager);

    // Reference to windowManager for saving state
    this.windowManager = windowManager;

    // Define the listener function
    this.navigateListener = (event, url) => {
      this.currentURL = url;
      windowManager.saveOpened();
    };

    // Listen for navigation events from renderer
    ipcMain.on(`webview-did-navigate-${this.id}`, this.navigateListener);

    // Inject JavaScript into renderer to set up IPC communication
    this.window.webContents.on("did-finish-load", () => {
      // Check if the window is still alive
      if (
        !this.window.isDestroyed() &&
        !this.window.webContents.isDestroyed()
      ) {
        this.window.webContents
          .executeJavaScript(
            `
          const { ipcRenderer } = require('electron');
          const webview = document.querySelector('tracked-box').webviewElement;
          if (webview) {
            webview.addEventListener('did-navigate', (e) => {
              ipcRenderer.send('webview-did-navigate-${this.id}', webview.src);
            });
          }
        `
          )
          .catch((error) => {
            console.error("Error injecting script into webContents:", error);
          });
      }
    });

    this.window.on("closed", () => {
      // Clean up IPC listener
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
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
      return "peersky://home";
    }
    try {
      const url = await this.window.webContents.executeJavaScript(`
        (function() {
          const webview = document.querySelector('tracked-box').webviewElement;
          return webview ? webview.src : 'peersky://home';
        })()
      `);
      return url;
    } catch (error) {
      console.error("Error getting URL:", error);
      return "peersky://home";
    }
  }
}

export default WindowManager;
