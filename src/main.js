import electron from "electron";
const { app, protocol: globalProtocol, ipcMain, BrowserWindow, webContents, Menu } = electron;
import { createHandler as createBrowserHandler } from "./protocols/peersky-protocol.js";
import { createHandler as createBrowserThemeHandler } from "./protocols/theme-handler.js";
import { createHandler as createIPFSHandler } from "./protocols/ipfs-handler.js";
import { createHandler as createHyperHandler } from "./protocols/hyper-handler.js";
import { createHandler as createWeb3Handler } from "./protocols/web3-handler.js";
import { createHandler as createFileHandler } from "./protocols/file-handler.js";
import { createHandler as createBittorrentHandler } from "./protocols/bittorrent-handler.js";
import { ipfsOptions, hyperOptions } from "./protocols/config.js";
import { createMenuTemplate } from "./actions.js";
import WindowManager from "./window-manager.js";
import settingsManager from "./settings-manager.js";
import { setWindowManager } from "./context-menu.js";
import { isBuiltInSearchEngine } from "./search-engine.js";
import "./llm.js";
// import { setupAutoUpdater } from "./auto-updater.js";

// Import and initialize extension system
import extensionManager from "./extensions/index.js";
import { setupExtensionIpcHandlers } from "./extensions/extensions-ipc.js";
import { getBrowserSession, usePersist } from "./session.js";

const P2P_PROTOCOL = {
  standard: true,
  secure: true,
  allowServiceWorkers: true,
  supportFetchAPI: true,
  bypassCSP: false,
  corsEnabled: true,
  stream: true,
};

const BROWSER_PROTOCOL = {
  standard: false,
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

let windowManager;

globalProtocol.registerSchemesAsPrivileged([
  { scheme: "peersky", privileges: BROWSER_PROTOCOL },
  { scheme: "browser", privileges: BROWSER_PROTOCOL },
  { scheme: "ipfs", privileges: P2P_PROTOCOL },
  { scheme: "ipns", privileges: P2P_PROTOCOL },
  { scheme: "pubsub", privileges: P2P_PROTOCOL },
  { scheme: "hyper", privileges: P2P_PROTOCOL },
  { scheme: "web3", privileges: P2P_PROTOCOL },
  { scheme: "file", privileges: FILE_PROTOCOL },
  { scheme: "bittorrent", privileges: P2P_PROTOCOL },
  { scheme: "bt", privileges: P2P_PROTOCOL },
  { scheme: "magnet", privileges: MAGNET_PROTOCOL },
]);

app.whenReady().then(async () => {
  windowManager = new WindowManager();

  // Set the WindowManager instance in context-menu.js
  setWindowManager(windowManager);
  
  // Get consistent session for protocols and extensions
  const userSession = getBrowserSession();
  await setupProtocols(userSession);

  // Global webview partition alignment and security hardening
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (_event, webPreferences, params) => {
      // Force consistent partition when using persist mode
      if (usePersist()) params.partition = 'persist:peersky';
      
      // Basic hardening for webviews (safe defaults)
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
    });
  });

  // Default-deny permissions for security
  userSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  // Initialize extension system
  try {
    console.log("Initializing extension system...");
    await extensionManager.initialize({ app, session: userSession });
    console.log("Extension system initialized successfully");

    // Setup extension IPC handlers
    setupExtensionIpcHandlers(extensionManager);
    console.log("Extension IPC handlers registered");
  } catch (error) {
    console.error("Failed to initialize extension system:", error);
  }

  // Load saved windows or open a new one
  await windowManager.openSavedWindows();
  if (windowManager.all.length === 0) {
    windowManager.open({ isMainWindow: true });
  }

  // Register shortcuts from menu template (NOTE: all these shortcuts works on a window only if a window is in focus)
  const menuTemplate = createMenuTemplate(windowManager);
  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  // Add diagnostics to main window after creation
  const mainWindow = windowManager.all[0];
  if (mainWindow?.window?.webContents) {
    mainWindow.window.webContents.on('did-fail-load', (_e, code, desc, url) =>
      console.error(JSON.stringify({ evt: 'did-fail-load', code, desc, url }))
    );
    mainWindow.window.webContents.on('render-process-gone', (_e, details) =>
      console.error(JSON.stringify({ evt: 'render-process-gone', details }))
    );

    // Runtime partition assertion (development only)
    if (usePersist()) {
      const partition = mainWindow.window.webContents.session.getPartition();
      if (partition !== 'persist:peersky') {
        throw new Error(`Session mismatch: expected 'persist:peersky', got '${partition}'`);
      }
      console.log('[Session] Runtime assertion passed: using persist:peersky');
    }
  }

  windowManager.startSaver();

  // Initialize AutoUpdater after windowManager is ready
  // console.log("App is prepared, setting up AutoUpdater...");
  // setupAutoUpdater();
});

// Introduce a flag to prevent multiple 'before-quit' handling
let isQuitting = false;

app.on("before-quit", async (event) => {
  if (isQuitting) {
    return;
  }
  event.preventDefault(); // Prevent the default quit behavior

  console.log("Before quit: Saving window states...");

  isQuitting = true; // Set the quitting flag

  windowManager.setQuitting(true); // Inform WindowManager that quitting is happening

  // Shutdown extension system
  try {
    await extensionManager.shutdown();
    console.log("Extension system shutdown successfully");
  } catch (error) {
    console.error("Error shutting down extension system:", error);
  }

  windowManager
    .saveOpened()
    .then(() => {
      console.log("Window states saved successfully.");
      windowManager.stopSaver();
      app.quit(); // Proceed to quit the app
    })
    .catch((error) => {
      console.error("Error saving window states on quit:", error);
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
  app.setAsDefaultProtocolClient("web3");
  app.setAsDefaultProtocolClient("bittorrent");
  app.setAsDefaultProtocolClient("bt");
  app.setAsDefaultProtocolClient("magnet");

  const browserProtocolHandler = await createBrowserHandler();
  sessionProtocol.registerStreamProtocol("peersky", browserProtocolHandler, BROWSER_PROTOCOL);

  const browserThemeHandler = await createBrowserThemeHandler();
  sessionProtocol.registerStreamProtocol("browser", browserThemeHandler, BROWSER_PROTOCOL);

  const ipfsProtocolHandler = await createIPFSHandler(ipfsOptions, session);
  sessionProtocol.registerStreamProtocol("ipfs", ipfsProtocolHandler, P2P_PROTOCOL);
  sessionProtocol.registerStreamProtocol("ipns", ipfsProtocolHandler, P2P_PROTOCOL);
  sessionProtocol.registerStreamProtocol("pubsub", ipfsProtocolHandler, P2P_PROTOCOL);

  const hyperProtocolHandler = await createHyperHandler(hyperOptions, session);
  sessionProtocol.registerStreamProtocol("hyper", hyperProtocolHandler, P2P_PROTOCOL);

  const web3ProtocolHandler = await createWeb3Handler();
  sessionProtocol.registerStreamProtocol("web3", web3ProtocolHandler, P2P_PROTOCOL);

  const fileProtocolHandler = await createFileHandler();
  sessionProtocol.handle("file", fileProtocolHandler);

  const bittorrentProtocolHandler = await createBittorrentHandler();
  sessionProtocol.handle("bittorrent", bittorrentProtocolHandler);
  sessionProtocol.handle("bt", bittorrentProtocolHandler);
  sessionProtocol.handle("magnet", bittorrentProtocolHandler);
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
    const mainWindow = windows.find(w => w && !w.isDestroyed());
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('remove-all-tempIcon');
    }
  } catch (error) {
    console.error('Error sending remove-all-tempIcon:', error);
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
    console.error('Error sending refresh-browser-actions:', error);
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

// IPC handler for moving tabs to new window
ipcMain.on('new-window-with-tab', (_event, tabData) => {
  // Create new window using WindowManager for proper persistence
  windowManager.open({
    url: tabData.url,
    newWindow: true,
    isolate: true,
    singleTab: {
      url: tabData.url,
      title: tabData.title
    }
  });
});

// IPC handler for opening files in new tabs (used by BitTorrent pages)
ipcMain.on('open-url-in-tab', (event, fileUrl) => {
  // Security: only allow file:// URLs
  if (typeof fileUrl !== 'string' || !fileUrl.startsWith('file://')) {
    console.warn('[IPC] open-url-in-tab blocked non-file URL:', fileUrl);
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
    console.error(`Error getting memory usage for webContents ID ${webContentsId}:`, error);
    return null;
  }
});

ipcMain.on('group-action', (_event, data) => {
  console.log('Group action received:', data);
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
  console.log('Updating group properties across all windows:', groupId, properties);
  
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
    console.error('Error in check-built-in-engine:', error);
    return false; // fallback if anything goes wrong
  }
});
export { windowManager };
