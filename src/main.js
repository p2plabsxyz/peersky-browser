import { app, BrowserWindow, protocol as globalProtocol, session } from "electron";
import { join } from "path";
import { fileURLToPath } from "url";
import { createHandler as createIPFSHandler } from "./protocols/ipfs-handler.js";
import { createHandler as createBrowserHandler } from "./protocols/browser-protocol.js";
import { createHandler as createHyperHandler } from './protocols/hyper-handler.js';
import { createHandler as createWeb3Handler } from './protocols/web3-handler.js';
import { ipfsOptions, hyperOptions } from "./protocols/config.js";
import { attachContextMenus } from "./context-menu.js";
import { registerShortcuts } from "./actions.js";
import { setupAutoUpdater } from "./auto-updater.js";

const __dirname = fileURLToPath(new URL('./', import.meta.url));

// // Uncomment while locally testing the AutoUpdater
// Object.defineProperty(app, 'isPackaged', {
//   value: true
// });

let mainWindow;

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

async function createWindow(url, isMainWindow = false) {
  const windowOptions = {
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      nativeWindowOpen: true,
      webviewTag: true,
    },
  };

  const window = new BrowserWindow(windowOptions);

  if (isMainWindow) {
    mainWindow = window;
    window.loadFile(join(__dirname, "./pages/index.html"), { query: { url: 'peersky://home' } });
    window.webContents.openDevTools();
  } else {
    window.loadFile(join(__dirname, "./pages/index.html"), { query: { url: url || 'peersky://home' } });
  }

  attachContextMenus(window);

  window.on("closed", () => {
    if (isMainWindow) {
      mainWindow = null;
    }
  });

  window.webContents.on("did-finish-load", () => {
    attachContextMenus(window);
  });

  // Ensure context menu is reattached on navigation within the window
  window.webContents.on("did-navigate", () => {
    attachContextMenus(window);
  });

  return window;
}

globalProtocol.registerSchemesAsPrivileged([
  { scheme: "ipfs", privileges: P2P_PROTOCOL },
  { scheme: "ipns", privileges: P2P_PROTOCOL },
  { scheme: "pubsub", privileges: P2P_PROTOCOL },
  { scheme: "hyper", privileges: P2P_PROTOCOL },
  { scheme: "web3", privileges: P2P_PROTOCOL },
  { scheme: "peersky", privileges: BROWSER_PROTOCOL },
]);

app.whenReady().then(async () => {
  await setupProtocols(session.defaultSession);
  createWindow(null, true);
  registerShortcuts();
    // initializeAutoUpdater(); // Initialize auto-updater
  console.log('App is prepared, setting up autoUpdater...');
  setupAutoUpdater();
});

async function setupProtocols(session) {
  const { protocol: sessionProtocol } = session;

  app.setAsDefaultProtocolClient("ipfs");
  app.setAsDefaultProtocolClient("ipns");
  app.setAsDefaultProtocolClient("hyper");
  app.setAsDefaultProtocolClient("web3");
  app.setAsDefaultProtocolClient("peersky");

  const ipfsProtocolHandler = await createIPFSHandler(ipfsOptions, session);
  sessionProtocol.registerStreamProtocol("ipfs", ipfsProtocolHandler, P2P_PROTOCOL);
  sessionProtocol.registerStreamProtocol("ipns", ipfsProtocolHandler, P2P_PROTOCOL);
  sessionProtocol.registerStreamProtocol("pubsub", ipfsProtocolHandler, P2P_PROTOCOL);

  const hyperProtocolHandler = await createHyperHandler(hyperOptions, session);
  sessionProtocol.registerStreamProtocol("hyper", hyperProtocolHandler, P2P_PROTOCOL);

  const web3ProtocolHandler = await createWeb3Handler();
  sessionProtocol.registerStreamProtocol("web3", web3ProtocolHandler, P2P_PROTOCOL);

  const browserProtocolHandler = await createBrowserHandler();
  sessionProtocol.registerStreamProtocol("peersky", browserProtocolHandler, BROWSER_PROTOCOL);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow(null, true);
  }
});

export { createWindow };
