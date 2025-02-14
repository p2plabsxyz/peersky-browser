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
import { attachContextMenus, setWindowManager } from "./context-menu.js";

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
  { scheme: "pubsub", privileges: P2P_PROTOCOL },
  { scheme: "hyper", privileges: P2P_PROTOCOL },
  { scheme: "web3", privileges: P2P_PROTOCOL },
  { scheme: "peersky", privileges: BROWSER_PROTOCOL },
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
  console.log("App is prepared, setting up AutoUpdater...");
  setupAutoUpdater();
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
  if (windowManager.all.length === 0) {
    windowManager.open({ isMainWindow: true });
  }
});

export { windowManager };
