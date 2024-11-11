import { app, session, protocol as globalProtocol } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { createHandler as createIPFSHandler } from "./protocols/ipfs-handler.js";
import { createHandler as createBrowserHandler } from "./protocols/browser-protocol.js";
import { createHandler as createHyperHandler } from "./protocols/hyper-handler.js";
import { createHandler as createWeb3Handler } from "./protocols/web3-handler.js";
import { ipfsOptions, hyperOptions } from "./protocols/config.js";
import { registerShortcuts } from "./actions.js";
import { setupAutoUpdater } from "./auto-updater.js";
import WindowManager from "./window-manager.js";

const __dirname = fileURLToPath(new URL("./", import.meta.url));

// // Uncomment while locally testing the AutoUpdater
// Object.defineProperty(app, 'isPackaged', {
//   value: true
// });

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
  { scheme: "ipfs", privileges: P2P_PROTOCOL },
  { scheme: "ipns", privileges: P2P_PROTOCOL },
  { scheme: "hyper", privileges: P2P_PROTOCOL },
  { scheme: "web3", privileges: P2P_PROTOCOL },
  { scheme: "peersky", privileges: BROWSER_PROTOCOL },
]);

app.whenReady().then(async () => {
  windowManager = new WindowManager();

  await setupProtocols(session.defaultSession);

  // Load saved windows or open a new one
  await windowManager.openSavedWindows();
  if (windowManager.all.length === 0) {
    windowManager.open({ isMainWindow: true });
  }

  registerShortcuts(windowManager); // Pass windowManager to registerShortcuts

  windowManager.startSaver();

  // initializeAutoUpdater(); // Initialize auto-updater
  console.log("App is prepared, setting up autoUpdater...");
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
  sessionProtocol.registerStreamProtocol("ipfs", ipfsProtocolHandler);
  sessionProtocol.registerStreamProtocol("ipns", ipfsProtocolHandler);
  globalProtocol.registerStreamProtocol("ipfs", ipfsProtocolHandler);
  globalProtocol.registerStreamProtocol("ipns", ipfsProtocolHandler);

  const hyperProtocolHandler = await createHyperHandler(hyperOptions, session);
  sessionProtocol.registerStreamProtocol("hyper", hyperProtocolHandler);
  globalProtocol.registerStreamProtocol("hyper", hyperProtocolHandler);

  const web3ProtocolHandler = await createWeb3Handler();
  sessionProtocol.registerStreamProtocol("web3", web3ProtocolHandler);
  globalProtocol.registerStreamProtocol("web3", web3ProtocolHandler);

  const browserProtocolHandler = await createBrowserHandler();
  sessionProtocol.registerStreamProtocol("peersky", browserProtocolHandler);
  globalProtocol.registerStreamProtocol("peersky", browserProtocolHandler);
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

app.on("before-quit", () => {
  windowManager.saveOpened();
  windowManager.stopSaver();
});

export { windowManager };
