import path from "path";
import electron from "electron";

import extensionManager from "../../src/extensions/index.js";
import { createHandler as createPeerskyHandler } from "../../src/protocols/peersky-protocol.js";

const { app, protocol: globalProtocol, session, BrowserWindow } = electron;

const RESULT_PREFIX = "__PEERSKY_RESULT__";

function parseArgs(argv) {
  const args = { mode: "probe", userData: null, fixture: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--mode") args.mode = value;
    if (key === "--user-data") args.userData = value;
    if (key === "--fixture") args.fixture = value;
  }
  return args;
}

function emitResult(payload) {
  console.log(`${RESULT_PREFIX}${JSON.stringify(payload)}`);
}

function getProbeExtension() {
  const all = Array.from(extensionManager.loadedExtensions.values());
  return all.find((ext) => ext && (ext.name === "p2p-probe-extension" || ext.displayName === "p2p-probe-extension"));
}

async function ensureTestProtocols(browserSession) {
  const peerskyHandler = await createPeerskyHandler();
  browserSession.protocol.handle("peersky", peerskyHandler);
  browserSession.protocol.handle("hyper", createStaticP2PHandler("hyper"));
  browserSession.protocol.handle("ipfs", createStaticP2PHandler("ipfs"));
}

function createStaticP2PHandler(scheme) {
  return async function staticP2PHandler(request) {
    const method = String(request.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return new Response(`${scheme} writes are blocked`, {
        status: 403,
        headers: {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return new Response(`${scheme}-ok`, {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "*",
      },
    });
  };
}

async function runProbePage(extensionId) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  try {
    await win.loadURL(`chrome-extension://${extensionId}/probe.html`);
    const result = await win.webContents.executeJavaScript("window.__runProbe && window.__runProbe()", true);
    return result;
  } finally {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }
}

try {
  globalProtocol.registerSchemesAsPrivileged([
    {
      scheme: "peersky",
      privileges: {
        standard: false,
        secure: true,
        allowServiceWorkers: false,
        supportFetchAPI: true,
        bypassCSP: false,
        corsEnabled: true,
      },
    },
    {
      scheme: "hyper",
      privileges: {
        standard: false,
        secure: true,
        allowServiceWorkers: false,
        supportFetchAPI: true,
        bypassCSP: false,
        corsEnabled: true,
      },
    },
    {
      scheme: "ipfs",
      privileges: {
        standard: false,
        secure: true,
        allowServiceWorkers: false,
        supportFetchAPI: true,
        bypassCSP: false,
        corsEnabled: true,
      },
    },
  ]);
} catch {
}

app.commandLine.appendSwitch("disable-gpu");

const args = parseArgs(process.argv.slice(2));

app.whenReady().then(async () => {
  try {
    if (!args.userData || !args.fixture) {
      throw new Error("Missing required --user-data or --fixture argument");
    }

    app.setPath("userData", path.resolve(args.userData));

    const browserSession = session.defaultSession;
    await ensureTestProtocols(browserSession);

    await extensionManager.initialize({ app, session: browserSession });

    let extension = getProbeExtension();
    if (args.mode === "install-and-probe" && !extension) {
      const installResult = await extensionManager.installExtension(path.resolve(args.fixture));
      extension = installResult.extension;
    }

    if (args.mode === "uninstall") {
      if (extension) {
        await extensionManager.uninstallExtension(extension.id);
      }
      emitResult({ ok: true, mode: args.mode, uninstalled: !!extension });
      await extensionManager.shutdown();
      app.exit(0);
      return;
    }

    if (!extension) {
      throw new Error("Probe extension is not installed");
    }

    const probe = await runProbePage(extension.electronId || extension.id);

    emitResult({
      ok: true,
      mode: args.mode,
      extensionId: extension.id,
      electronId: extension.electronId || null,
      probe,
    });

    await extensionManager.shutdown();
    app.exit(0);
  } catch (error) {
    emitResult({ ok: false, mode: args.mode, error: String(error && error.message ? error.message : error) });
    try {
      await extensionManager.shutdown();
    } catch {
    }
    app.exit(1);
  }
});
