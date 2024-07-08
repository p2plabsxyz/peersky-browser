import { app, BrowserWindow, protocol as globalProtocol, session } from "electron";
import { join } from "path";
import { fileURLToPath } from "url";
import { createHandler as createIPFSHandler } from "./protocols/ipfs-handler.js";
import { createHandler as createBrowserHandler } from "./protocols/browser-protocol.js";
import { createHandler as createHyperHandler } from './protocols/hyper-handler.js';
import { createHandler as createWeb3Handler } from './protocols/web3-handler.js';
import { ipfsOptions, hyperOptions } from "./protocols/config.js";

const __dirname = fileURLToPath(new URL('./', import.meta.url))

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

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      nativeWindowOpen: true,
      webviewTag: true,
    },
  });

  mainWindow.loadFile(join(__dirname, "./pages/index.html"));
  mainWindow.webContents.openDevTools();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

globalProtocol.registerSchemesAsPrivileged([
  { scheme: "ipfs", privileges: P2P_PROTOCOL },
  { scheme: "ipns", privileges: P2P_PROTOCOL },
  { scheme: "hyper", privileges: P2P_PROTOCOL },
  { scheme: "web3", privileges: P2P_PROTOCOL },
  { scheme: "peersky", privileges: BROWSER_PROTOCOL },
]);

app.whenReady().then(async () => {
  await setupProtocols(session.defaultSession);
  createWindow();
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
  if (mainWindow === null) {
    createWindow();
  }
});
