import { app, session, protocol as globalProtocol, ipcMain, BrowserWindow, Menu, shell, webContents} from "electron";
import { createLogger } from './logger.js';
import fs from "fs/promises";
import path from "path";
import crypto from "crypto"
import { createHandler as createBrowserHandler } from "./protocols/peersky-protocol.js";
import { createHandler as createBrowserThemeHandler } from "./protocols/theme-handler.js";
import { createHandler as createIPFSHandler } from "./protocols/ipfs-handler.js";
import { createHandler as createHyperHandler } from "./protocols/hyper-handler.js";
import { createHandler as createHSHandler } from "./protocols/hs-handler.js";
import { createHandler as createWeb3Handler } from "./protocols/web3-handler.js";
import { createHandler as createFileHandler } from "./protocols/file-handler.js";
import { createHandler as createBittorrentHandler, setupBittorrentIpc } from "./protocols/bittorrent-handler.js";
import { ipfsOptions, hyperOptions } from "./protocols/config.js";
import { createMenuTemplate } from "./actions.js";
import WindowManager from "./window-manager.js";
import settingsManager from "./settings-manager.js";
import p2pAppRegistry from "./p2p-app-registry.js";
import { setWindowManager } from "./context-menu.js";
import { isBuiltInSearchEngine } from "./search-engine.js";
import "./llm.js";
import "./llm-memory.js";
import { setupAutoUpdater } from "./auto-updater.js";

// Import and initialize extension system
import extensionManager from "./extensions/index.js";
import { setupExtensionIpcHandlers } from "./extensions/extensions-ipc.js";
import { getBrowserSession, usePersist } from "./session.js";
import { setupPermissionHandler } from "./permissions.js";
import { setupP2pmdPdfExportIpc } from "./pages/p2p/p2pmd/pdf-export-ipc.js";

const P2P_PROTOCOL = {
  standard: true,
  secure: true,
  allowServiceWorkers: true,
  supportFetchAPI: true,
  bypassCSP: false,
  corsEnabled: true,
  stream: true,
};

const WEB3_PROTOCOL = {
  standard: false,
  secure: true,
  allowServiceWorkers: true,
  supportFetchAPI: true,
  bypassCSP: false,
  corsEnabled: true,
  stream: true,
};

const BROWSER_PROTOCOL = {
  standard: true,
  secure: true,
  allowServiceWorkers: false,
  supportFetchAPI: true,
  bypassCSP: false,
  corsEnabled: true,
};

const FILE_PROTOCOL = {
  standard: true,
  secure: false,
  allowServiceWorkers: false,
  supportFetchAPI: true,
  bypassCSP: true,
  corsEnabled: true,
  stream: true,
};

// Magnet URIs are just identifiers that redirect to bt:// — minimal privileges
const MAGNET_PROTOCOL = {
  standard: false,
  secure: false,
  allowServiceWorkers: false,
  supportFetchAPI: false,
  bypassCSP: false,
  corsEnabled: true,
};

const log = createLogger('main');

let windowManager = null;

const trustedUIWebContents = new Set();

app.on("browser-window-created", (event, win) => {
  trustedUIWebContents.add(win.webContents.id);
  win.webContents.once("destroyed", () =>
    trustedUIWebContents.delete(win.webContents.id),
  );
});

app.on("web-contents-created", (event, wc) => {
  wc.on("did-navigate", (e, url) => {
    if (url.startsWith("peersky://downloads")) {
      trustedUIWebContents.add(wc.id);
    } else {
      if (!BrowserWindow.fromWebContents(wc)) {
        trustedUIWebContents.delete(wc.id);
      }
    }
  });
  wc.once("destroyed", () => trustedUIWebContents.delete(wc.id));
});

const webviewTabShortcutNavAttached = new WeakSet();

function attachWebviewTabShortcutNav(wc) {
  if (!wc || wc.isDestroyed()) return;
  if (typeof wc.getType !== "function" || wc.getType() !== "webview") return;
  if (webviewTabShortcutNavAttached.has(wc)) return;
  webviewTabShortcutNavAttached.add(wc);

  const runOnShell = (next) => {
    const win = BrowserWindow.fromWebContents(wc);
    if (!win || win.isDestroyed()) return;
    const shellWc = win.webContents;
    if (shellWc.isDestroyed()) return;
    const script = next
      ? `(()=>{try{const t=document.querySelector('#tabbar');if(!t||!t.tabs||t.tabs.length<2)return;const i=t.tabs.findIndex(x=>x.id===t.activeTabId);if(i<0)return;t.selectTab(t.tabs[(i+1)%t.tabs.length].id);}catch(e){console.error(e);}})()`
      : `(()=>{try{const t=document.querySelector('#tabbar');if(!t||!t.tabs||t.tabs.length<2)return;const i=t.tabs.findIndex(x=>x.id===t.activeTabId);if(i<0)return;t.selectTab(t.tabs[(i-1+t.tabs.length)%t.tabs.length].id);}catch(e){console.error(e);}})()`;
    shellWc.executeJavaScript(script).catch(() => {});
  };

  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    const isMac = process.platform === "darwin";
    let goNext = null;
    if (isMac) {
      if (input.meta && input.alt && (input.key === "ArrowRight" || input.key === "ArrowLeft")) {
        goNext = input.key === "ArrowRight";
      }
    } else if (input.control && input.key === "Tab") {
      goNext = !input.shift;
    }

    if (goNext === null) return;
    event.preventDefault();
    runOnShell(goNext);
  });
}

globalProtocol.registerSchemesAsPrivileged([
  { scheme: "peersky", privileges: BROWSER_PROTOCOL },
  { scheme: "browser", privileges: BROWSER_PROTOCOL },
  { scheme: "ipfs", privileges: P2P_PROTOCOL },
  { scheme: "ipns", privileges: P2P_PROTOCOL },
  { scheme: "pubsub", privileges: P2P_PROTOCOL },
  { scheme: "hyper", privileges: P2P_PROTOCOL },
  { scheme: "hs", privileges: P2P_PROTOCOL },
  { scheme: "web3", privileges: WEB3_PROTOCOL },
  { scheme: "file", privileges: FILE_PROTOCOL },
  { scheme: "bittorrent", privileges: P2P_PROTOCOL },
  { scheme: "bt", privileges: P2P_PROTOCOL },
  { scheme: "magnet", privileges: MAGNET_PROTOCOL },
]);

app.whenReady().then(async () => {
  windowManager = new WindowManager();
  await p2pAppRegistry.init();
  p2pAppRegistry.setupIpc();

  // Set the WindowManager instance in context-menu.js
  setWindowManager(windowManager);

  // Get consistent session for protocols and extensions
  const userSession = getBrowserSession();
  await setupProtocols(userSession);
  installExtensionWebRequestBridge(userSession);
  setupBittorrentIpc();

  userSession.on("will-download", (event, item, sessionWebContents) => {
    const downloadId = crypto.randomUUID();

    activeDownloadItems.set(downloadId, item);

    const broadcastProgress = (state, forcePaused = null) => {
      const data = {
        id: downloadId,
        filename: item.getFilename(),
        received: item.getReceivedBytes(),
        total: item.getTotalBytes(),
        state: state,
        isPaused: forcePaused !== null ? forcePaused : item.isPaused(),
        canResume: item.canResume(),
        percent: item.getTotalBytes()
          ? Math.round((item.getReceivedBytes() / item.getTotalBytes()) * 100)
          : 0,
      };

      trustedUIWebContents.forEach((id) => {
        const wc = webContents.fromId(id);
        if (wc && !wc.isDestroyed()) {
          wc.send("download-progress", data);
        } else {
          trustedUIWebContents.delete(id);
        }
      });
    };

    item.manualBroadcast = broadcastProgress;

    const progressInterval = setInterval(() => {
      if (item.getState() === "progressing") {
        broadcastProgress(item.getState());
      }
    }, 100);

    item.on("done", async (event, state) => {
      clearInterval(progressInterval);

      activeDownloadItems.delete(downloadId);
      broadcastProgress(state);

      if (state === "completed") {
        const downloadInfo = {
          id: downloadId,
          filename: item.getFilename(),
          size: item.getTotalBytes(),
          timestamp: Date.now(),
          savePath: item.getSavePath(),
          url: item.getURL(),
        };
        await saveDownloadHistory(downloadInfo);
      }
    });
  });

  // Global webview partition alignment and security hardening
  app.on('web-contents-created', (_e, wc) => {
    attachWebviewTabShortcutNav(wc);
    wc.on('will-attach-webview', (_event, webPreferences, params) => {
      // Force consistent partition when using persist mode
      if (usePersist()) params.partition = 'persist:peersky';
      
      // Basic hardening for webviews (safe defaults)
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
    });
  });

  await setupPermissionHandler(userSession);

  // Initialize extension system
  try {
    log.info("Initializing extension system...");
    await extensionManager.initialize({ app, session: userSession });
    log.info("Extension system initialized successfully");

    // Setup extension IPC handlers
    setupExtensionIpcHandlers(extensionManager);
    log.info("Extension IPC handlers registered");
  } catch (error) {
    log.error("Failed to initialize extension system:", error);
  }

  // Check for --new-window argument (from Windows taskbar jump list)
  const hasNewWindowArg = process.argv.includes('--new-window');
  
  // Load saved windows or open a new one
  await windowManager.openSavedWindows();
  if (windowManager.all.length === 0 || hasNewWindowArg) {
    windowManager.open({ isMainWindow: windowManager.all.length === 0 });
  }

  // Register shortcuts from menu template (NOTE: all these shortcuts works on a window only if a window is in focus)
  const menuTemplate = createMenuTemplate(windowManager);
  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  // Add diagnostics to main window after creation
  const mainWindow = windowManager.all[0];
  if (mainWindow?.window?.webContents) {
    mainWindow.window.webContents.on('did-fail-load', (_e, code, desc, url) =>
      log.error(JSON.stringify({ evt: 'did-fail-load', code, desc, url }))
    );
    mainWindow.window.webContents.on('render-process-gone', (_e, details) =>
      log.error(JSON.stringify({ evt: 'render-process-gone', details }))
    );

    // Runtime partition assertion (development only)
    if (usePersist()) {
      const partition = mainWindow.window.webContents.session.getPartition();
      if (partition !== 'persist:peersky') {
        throw new Error(`Session mismatch: expected 'persist:peersky', got '${partition}'`);
      }
      log.info('[Session] Runtime assertion passed: using persist:peersky');
    }
  }

  windowManager.startSaver();

  // Setup dock/taskbar menu for "New Window" option
  if (process.platform === 'darwin') {
    // macOS dock menu
    const dockMenu = Menu.buildFromTemplate([
      {
        label: 'New Window',
        click: () => {
          windowManager.open({ isMainWindow: false });
        }
      }
    ]);
    app.dock.setMenu(dockMenu);
  } else if (process.platform === 'win32') {
    // Windows taskbar jump list
    app.setUserTasks([
      {
        program: process.execPath,
        arguments: '--new-window',
        iconPath: process.execPath,
        iconIndex: 0,
        title: 'New Window',
        description: 'Open a new browser window'
      }
    ]);
  }

  // Initialize AutoUpdater after windowManager is ready
  setupAutoUpdater();
});

// Introduce a flag to prevent multiple 'before-quit' handling
let isQuitting = false;

app.on("before-quit", async (event) => {
  if (isQuitting) {
    return;
  }
  event.preventDefault(); // Prevent the default quit behavior

  log.info("Before quit: Saving window states...");

  isQuitting = true; // Set the quitting flag

  windowManager.setQuitting(true); // Inform WindowManager that quitting is happening

  // Shutdown extension system
  try {
    await extensionManager.shutdown();
    log.info("Extension system shutdown successfully");
  } catch (error) {
    log.error("Error shutting down extension system:", error);
  }

  windowManager
    .saveOpened()
    .then(() => {
      log.info("Window states saved successfully.");
      windowManager.stopSaver();
      app.quit(); // Proceed to quit the app
    })
    .catch((error) => {
      log.error("Error saving window states on quit:", error);
      windowManager.stopSaver();
      app.quit(); // Proceed to quit the app even if saving fails
    });
});

async function setupProtocols(session) {
  const { protocol: sessionProtocol } = session;

  app.setAsDefaultProtocolClient("peersky");
  app.setAsDefaultProtocolClient("file");
  app.setAsDefaultProtocolClient("browser");
  app.setAsDefaultProtocolClient("ipfs");
  app.setAsDefaultProtocolClient("ipns");
  app.setAsDefaultProtocolClient("hyper");
  app.setAsDefaultProtocolClient("hs");
  app.setAsDefaultProtocolClient("web3");
  app.setAsDefaultProtocolClient("bittorrent");
  app.setAsDefaultProtocolClient("bt");
  app.setAsDefaultProtocolClient("magnet");

  const browserProtocolHandler = await createBrowserHandler();
  sessionProtocol.handle("peersky", browserProtocolHandler);

  const browserThemeHandler = await createBrowserThemeHandler();
  sessionProtocol.handle("browser", browserThemeHandler);

  const ipfsProtocolHandler = await createIPFSHandler(ipfsOptions, session);
  sessionProtocol.handle("ipfs", ipfsProtocolHandler);
  sessionProtocol.handle("ipns", ipfsProtocolHandler);
  sessionProtocol.handle("pubsub", ipfsProtocolHandler);

  const hyperProtocolHandler = await createHyperHandler(hyperOptions);
  sessionProtocol.handle("hyper", hyperProtocolHandler);

  const hsProtocolHandler = await createHSHandler();
  sessionProtocol.handle("hs", hsProtocolHandler);

  const web3ProtocolHandler = await createWeb3Handler();
  sessionProtocol.handle("web3", web3ProtocolHandler);

  const fileProtocolHandler = await createFileHandler();
  sessionProtocol.handle("file", fileProtocolHandler);

  const bittorrentProtocolHandler = await createBittorrentHandler();
  sessionProtocol.handle("bittorrent", bittorrentProtocolHandler);
  sessionProtocol.handle("bt", bittorrentProtocolHandler);
  sessionProtocol.handle("magnet", bittorrentProtocolHandler);
}

function installExtensionWebRequestBridge(session) {
  const shouldForwardToExtensions = (rawUrl) => {
    const url = typeof rawUrl === "string" ? rawUrl : "";
    if (!url) return false;
    if (url.startsWith("file://")) return false;
    if (url.startsWith("chrome-extension://")) return false;
    try {
      const proto = new URL(url).protocol;
      return proto === "http:" || proto === "https:" || proto === "ws:" || proto === "wss:" || proto === "ftp:";
    } catch (_) {
      return false;
    }
  };

  session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, async (details, callback) => {
    const url = details?.url || "";
    if (!shouldForwardToExtensions(url)) {
      callback({});
      return;
    }
    let result = {};
    try {
      result =
        (await extensionManager.electronChromeExtensions?.notifyWebRequestOnBeforeRequest(
          details,
        )) ?? {};
    } catch (e) {
      console.warn("[webRequest] onBeforeRequest extension dispatch failed:", e?.message);
    }
    callback(result);
  });

  session.webRequest.onBeforeSendHeaders(
    { urls: ["<all_urls>"] },
    async (details, callback) => {
      const url = details?.url || "";
      if (!shouldForwardToExtensions(url)) {
        callback({});
        return;
      }

      let result = {};
      try {
        result =
          (await extensionManager.electronChromeExtensions?.notifyWebRequestOnBeforeSendHeaders(
            details,
          )) ?? {};
      } catch (e) {
        console.warn(
          "[webRequest] onBeforeSendHeaders extension dispatch failed:",
          e?.message,
        );
      }

      callback(result);
    },
  );

  session.webRequest.onSendHeaders({ urls: ["<all_urls>"] }, async (details) => {
    const url = details?.url || "";
    if (!shouldForwardToExtensions(url)) {
      return;
    }
    try {
      await extensionManager.electronChromeExtensions?.notifyWebRequestOnSendHeaders(details);
    } catch (e) {
      console.warn("[webRequest] onSendHeaders extension dispatch failed:", e?.message);
    }
  });

  session.webRequest.onHeadersReceived(
    { urls: ["<all_urls>"] },
    async (details, callback) => {
      const url = details?.url || "";
      if (!shouldForwardToExtensions(url)) {
        callback({});
        return;
      }

      let result = {};
      try {
        result =
          (await extensionManager.electronChromeExtensions?.notifyWebRequestOnHeadersReceived(
            details,
          )) ?? {};
      } catch (e) {
        console.warn(
          "[webRequest] onHeadersReceived extension dispatch failed:",
          e?.message,
        );
      }

      callback(result);
    },
  );

  session.webRequest.onResponseStarted({ urls: ["<all_urls>"] }, async (details) => {
    const url = details?.url || "";
    if (!shouldForwardToExtensions(url)) {
      return;
    }
    try {
      await extensionManager.electronChromeExtensions?.notifyWebRequestOnResponseStarted(
        details,
      );
    } catch (e) {
      console.warn(
        "[webRequest] onResponseStarted extension dispatch failed:",
        e?.message,
      );
    }
  });

  session.webRequest.onCompleted({ urls: ["<all_urls>"] }, async (details) => {
    const url = details?.url || "";
    if (!shouldForwardToExtensions(url)) {
      return;
    }
    try {
      await extensionManager.electronChromeExtensions?.notifyWebRequestOnCompleted(details);
    } catch (e) {
      console.warn("[webRequest] onCompleted extension dispatch failed:", e?.message);
    }
  });

  session.webRequest.onErrorOccurred({ urls: ["<all_urls>"] }, async (details) => {
    const url = details?.url || "";
    if (!shouldForwardToExtensions(url)) {
      return;
    }
    try {
      await extensionManager.electronChromeExtensions?.notifyWebRequestOnErrorOccurred(
        details,
      );
    } catch (e) {
      console.warn(
        "[webRequest] onErrorOccurred extension dispatch failed:",
        e?.message,
      );
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (windowManager.all.length === 0) {
    windowManager.open({ isMainWindow: true });
  }
});

ipcMain.on('remove-all-tempIcon', () => {
  try {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win || win.isDestroyed()) continue;
      const wc = win.webContents;
      if (!wc || wc.isDestroyed()) continue;
      wc.send('remove-all-tempIcon');
    }
  } catch (error) {
    log.error('Error sending remove-all-tempIcon:', error);
  }
});

ipcMain.on('refresh-browser-actions', () => {
  try {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win || win.isDestroyed()) continue;
      const wc = win.webContents;
      if (!wc || wc.isDestroyed()) continue;
      wc.send('refresh-browser-actions');
    }
  } catch (error) {
    log.error('Error sending refresh-browser-actions:', error);
  }
});

ipcMain.on("open-tab-in-main-window", (_event, url) => {
  const mainWindow = BrowserWindow.getAllWindows()[0]; 
  if (!mainWindow) return;
  mainWindow.webContents.send('create-new-tab', url);
});

ipcMain.on("window-control", (_event, command) => {
  const window = BrowserWindow.fromWebContents(_event.sender);
  if (!window) return;
  
  switch (command) {
    case "minimize":
      window.minimize();
      break;
    case "maximize":
      if (window.isMaximized()) {
        window.unmaximize();
      } else {
        window.maximize();
      }
      break;
    case "close":
      window.close();
      break;
  }
});

// IPC handler for opening files in new tabs (used by BitTorrent pages)
ipcMain.on('open-url-in-tab', (event, fileUrl) => {
  // Security: only allow file:// URLs
  if (typeof fileUrl !== 'string' || !fileUrl.startsWith('file://')) {
    log.warn('[IPC] open-url-in-tab blocked non-file URL:', fileUrl);
    return;
  }
  
  // Find the parent window
  const parentWindow = BrowserWindow.fromWebContents(event.sender)
    || BrowserWindow.getFocusedWindow()
    || BrowserWindow.getAllWindows()[0];
  
  if (parentWindow) {
    // Send IPC message to renderer to add tab (safer than executeJavaScript)
    parentWindow.webContents.send('add-tab-from-main', fileUrl);
  }
});

ipcMain.on('new-window', (_event, options = {}) => {
  if (options.isolate) {
    windowManager.open({ ...options, restoreTabs: false }); // not restoring other tabs of isolated window
  } else {
    windowManager.open(options);
  }
});

const DOWNLOADS_FILE = path.join(app.getPath("userData"), "downloads.json");
const activeDownloadItems = new Map();

async function saveDownloadHistory(downloadInfo) {
  try {
    let downloads = [];
    try {
      const data = await fs.readFile(DOWNLOADS_FILE, "utf-8");
      downloads = JSON.parse(data);
    } catch (e) {
      // File doesn't exist or is invalid, start fresh
    }

    downloads.unshift(downloadInfo);

    if (downloads.length > 100) downloads.length = 100;

    await fs.writeFile(DOWNLOADS_FILE, JSON.stringify(downloads, null, 2));
  } catch (err) {
    log.error("Failed to save download history:", err);
  }
}

ipcMain.handle("get-downloads", async () => {
  try {
    const data = await fs.readFile(DOWNLOADS_FILE, "utf-8");
    const downloads = JSON.parse(data);

    // Check if each file still exists on the user's disk
    const enhancedDownloads = await Promise.all(
      downloads.map(async (item) => {
        try {
          await fs.access(item.savePath);
          return { ...item, fileExists: true };
        } catch {
          // File was deleted or moved
          return { ...item, fileExists: false };
        }
      })
    );

    return enhancedDownloads;
  } catch (e) {
    return []; // Return empty array if no history exists yet
  }
});

ipcMain.handle("get-active-downloads", async () => {
  const active = [];
  for (const [id, item] of activeDownloadItems.entries()) {
    active.push({
      id,
      filename: item.getFilename(),
      received: item.getReceivedBytes(),
      total: item.getTotalBytes(),
      state: item.getState(),
      isPaused: item.isPaused(),
      canResume: item.canResume(),
      percent: item.getTotalBytes() ? Math.round((item.getReceivedBytes() / item.getTotalBytes()) * 100) : 0
    });
  }
  return active;
});

ipcMain.handle("remove-download", async (event, id) => {
  try {
    let downloads = [];
    try {
      const data = await fs.readFile(DOWNLOADS_FILE, "utf-8");
      downloads = JSON.parse(data);
    } catch (e) {}

    const targetDownload = downloads.find((d) => d.id === id);

    if (!targetDownload) {
      throw new Error("Download record not found in history.");
    }

    try {
      await fs.unlink(targetDownload.savePath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        log.warn("Could not delete file from disk:", err);
      }
    }

    downloads = downloads.filter((d) => d.id !== id);
    await fs.writeFile(DOWNLOADS_FILE, JSON.stringify(downloads, null, 2));

    return { success: true };
  } catch (err) {
    log.error("Error removing download:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-tab-memory-usage', async (event, webContentsId) => {
  try{
    const wc = webContents.fromId(webContentsId);
    if (!wc) {
      throw new Error(`WebContents with ID ${webContentsId} not found`);
    }

    const processId = wc.getOSProcessId();
    const metrics = app.getAppMetrics();

    const processMetrics = metrics.find(m => m.pid === processId);

    if(processMetrics && processMetrics.memory) {
      return {
        workingSetSize : processMetrics.memory.workingSetSize*1024, // KB to Bytes
        peakWorkingSetSize : processMetrics.memory.peakWorkingSetSize*1024,
        privateBytes : processMetrics.memory.privateBytes*1024,
      }
    }
    return null;
  }
  catch (error) {
    log.error(`Error getting memory usage for webContents ID ${webContentsId}:`, error);
    return null;
  }
});

ipcMain.on("download-pause", (event, id) => {
  const item = activeDownloadItems.get(id);
  if (item) {
    if (!item.isPaused()) item.pause();
    if (item.manualBroadcast) item.manualBroadcast(item.getState(), true);
  }
});

ipcMain.on("download-resume", (event, id) => {
  const item = activeDownloadItems.get(id);
  if (item) {
    if (item.canResume()) item.resume();
    if (item.manualBroadcast) item.manualBroadcast(item.getState(), false);
  }
});

ipcMain.on('download-cancel', (event, id) => {
  const item = activeDownloadItems.get(id);
  if (item) item.cancel();
});

// IPC handler to check if a specific webContents is currently playing audio
ipcMain.on('is-webcontents-audible', (event, webContentsId) => {
  try {
    const wc = webContents.fromId(webContentsId);
    event.returnValue = wc ? wc.isCurrentlyAudible() : false;
  } catch (error) {
    console.error(`Error checking audibility for webContents ID ${webContentsId}:`, error);
    event.returnValue = false;
  }
});

ipcMain.on('get-tab-navigation', (event, webContentsId) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc || !wc.navigationHistory) {
      event.returnValue = null;
      return;
    }

    const entries = [];
    const length = wc.navigationHistory.length();
    for (let i = 0; i < length; i++) {
      const entry = wc.navigationHistory.getEntryAtIndex(i);
      entries.push({ url: entry.url, title: entry.title });
    }

    event.returnValue = {
      entries,
      activeIndex: wc.navigationHistory.getActiveIndex()
    };
  } catch (error) {
    log.error(`Error getting navigation history for webContents ID ${webContentsId}:`, error);
    event.returnValue = null;
  }
});

// Electron cannot natively overwrite a WebContents history stack after recreation,
// so the fallback is handled in the UI layer (savedNavigation on the tab object).
ipcMain.handle('restore-navigation-history', async (_event, _data) => {
  return { success: true, note: 'Native history rewrite not supported; relying on UI fallback.' };
});

ipcMain.on('group-action', (_event, data) => {
  log.info('Group action received:', data);
  const { action, groupId } = data;
  
  // Broadcast to all windows
  windowManager.all.forEach(peerskyWindow => {
    if (peerskyWindow.window && !peerskyWindow.window.isDestroyed()) {
      peerskyWindow.window.webContents.send('group-action', { action, groupId });
    }
  });
  
  return { success: true }; 
});

ipcMain.on('update-group-properties', (_event, groupId, properties) => {
  log.info('Updating group properties across all windows:', groupId, properties);
  
  // Broadcast to all windows
  windowManager.all.forEach(peerskyWindow => {
    if (peerskyWindow.window && !peerskyWindow.window.isDestroyed()) {
      peerskyWindow.window.webContents.send('group-properties-updated', groupId, properties);
    }
  });
});
ipcMain.handle('check-built-in-engine', (event, template) => {
  try {
    return isBuiltInSearchEngine(template);
  } catch (error) {
    log.error('Error in check-built-in-engine:', error);
    return false; // fallback if anything goes wrong
  }
});

setupP2pmdPdfExportIpc();

export { windowManager };
