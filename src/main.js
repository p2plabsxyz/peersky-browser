import { app, session, protocol as globalProtocol, ipcMain, BrowserWindow,Menu,shell,dialog, webContents} from "electron";
import { createHandler as createBrowserHandler } from "./protocols/peersky-protocol.js";
import { createHandler as createBrowserThemeHandler } from "./protocols/theme-handler.js";
import { createHandler as createIPFSHandler } from "./protocols/ipfs-handler.js";
import { createHandler as createHyperHandler } from "./protocols/hyper-handler.js";
import { createHandler as createWeb3Handler } from "./protocols/web3-handler.js";
import { ipfsOptions, hyperOptions } from "./protocols/config.js";
import { registerShortcuts } from "./actions.js";
import WindowManager, { createIsolatedWindow } from "./window-manager.js";
import settingsManager from "./settings-manager.js";
import { attachContextMenus, setWindowManager } from "./context-menu.js";
// import { setupAutoUpdater } from "./auto-updater.js";

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

let windowManager;

globalProtocol.registerSchemesAsPrivileged([
  { scheme: "peersky", privileges: BROWSER_PROTOCOL },
  { scheme: "browser", privileges: BROWSER_PROTOCOL },
  { scheme: "ipfs", privileges: P2P_PROTOCOL },
  { scheme: "ipns", privileges: P2P_PROTOCOL },
  { scheme: "pubsub", privileges: P2P_PROTOCOL },
  { scheme: "hyper", privileges: P2P_PROTOCOL },
  { scheme: "web3", privileges: P2P_PROTOCOL },
]);

app.whenReady().then(async () => {
  windowManager = new WindowManager();

  // Set the WindowManager instance in context-menu.js
  setWindowManager(windowManager);
  await setupProtocols(session.defaultSession);

  // Load saved windows or open a new one
  await windowManager.openSavedWindows();
  if (windowManager.all.length === 0) {
    windowManager.open({ isMainWindow: true });
  }

  registerShortcuts(windowManager); // Pass windowManager to registerShortcuts

  windowManager.startSaver();

  // Initialize AutoUpdater after windowManager is ready
  // console.log("App is prepared, setting up AutoUpdater...");
  // setupAutoUpdater();
});

// Introduce a flag to prevent multiple 'before-quit' handling
let isQuitting = false;

app.on("before-quit", (event) => {
  if (isQuitting) {
    return;
  }
  event.preventDefault(); // Prevent the default quit behavior

  console.log("Before quit: Saving window states...");

  isQuitting = true; // Set the quitting flag

  windowManager.setQuitting(true); // Inform WindowManager that quitting is happening

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
  app.setAsDefaultProtocolClient("browser");
  app.setAsDefaultProtocolClient("ipfs");
  app.setAsDefaultProtocolClient("ipns");
  app.setAsDefaultProtocolClient("hyper");
  app.setAsDefaultProtocolClient("web3");

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

ipcMain.on("window-control", (event, command) => {
  const window = BrowserWindow.fromWebContents(event.sender);
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
ipcMain.on('new-window-with-tab', (event, tabData) => {
  // Create new isolated window with the specific tab
  createIsolatedWindow({
    isolate: true,
    singleTab: {
      url: tabData.url,
      title: tabData.title
    }
  });
});

ipcMain.on('new-window', (event, options = {}) => {
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

export { windowManager };