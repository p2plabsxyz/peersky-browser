import { expect } from "chai";
import sinon from "sinon";
import os from "os";
import path from "path";
import { mkdtemp, mkdir, writeFile } from "fs/promises";

import { checkInstallRateLimit } from "../../src/extensions/extensions-ipc.js";
import * as RegistryService from "../../src/extensions/services/registry.js";
import * as LoaderService from "../../src/extensions/services/loader.js";
import * as WebStoreService from "../../src/extensions/services/webstore.js";

async function makeTempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("Extension lifecycle and restart tests", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("enforces install rate limiting per sender", function () {
    const senderId = Math.floor(Math.random() * 1_000_000) + 1;

    for (let i = 0; i < 5; i += 1) {
      expect(() => checkInstallRateLimit(senderId)).to.not.throw();
    }

    expect(() => checkInstallRateLimit(senderId)).to.throw("Too many installation attempts");

    const anotherSender = senderId + 99;
    expect(() => checkInstallRateLimit(anotherSender)).to.not.throw();
  });

  it("persists extension registry and reloads enabled extensions after restart", async function () {
    const tempRoot = await makeTempDir("peersky-ext-restart-");
    const extensionPath = path.join(tempRoot, "extensions", "abc123", "1.0.0_0");
    await mkdir(extensionPath, { recursive: true });

    const registryFile = path.join(tempRoot, "extensions", "extensions.json");

    const extRecord = {
      id: "abc123",
      name: "Restart Test",
      displayName: "Restart Test",
      displayDescription: "Test extension",
      version: "1.0.0",
      enabled: true,
      installedPath: extensionPath,
      manifest: { manifest_version: 3, name: "Restart Test", version: "1.0.0" },
      source: "local",
    };

    const managerBeforeRestart = {
      extensionsRegistryFile: registryFile,
      loadedExtensions: new Map([[extRecord.id, { ...extRecord }]]),
    };

    await RegistryService.writeRegistry(managerBeforeRestart);

    const loadExtension = sinon.stub().resolves({ id: "abc123" });

    const managerAfterRestart = {
      app: { getLocale: () => "en" },
      extensionsBaseDir: path.join(tempRoot, "extensions"),
      extensionsRegistryFile: registryFile,
      loadedExtensions: new Map(),
      session: { loadExtension },
    };

    await RegistryService.loadRegistry(managerAfterRestart);
    expect(managerAfterRestart.loadedExtensions.has("abc123")).to.equal(true);

    await LoaderService.loadExtensionsIntoElectron(managerAfterRestart);

    expect(loadExtension.calledOnce).to.equal(true);
    const loaded = managerAfterRestart.loadedExtensions.get("abc123");
    expect(loaded.electronId).to.equal("abc123");
  });

  it("updates web store extension to latest version and reloads it", async function () {
    const tempRoot = await makeTempDir("peersky-ext-update-");
    const userExtensions = path.join(tempRoot, "extensions");
    const extId = "abcdefghijklmnopabcdefghijklmnop";

    const v1Dir = path.join(userExtensions, extId, "1.0.0_0");
    const v2Dir = path.join(userExtensions, extId, "1.1.0_0");
    await mkdir(v1Dir, { recursive: true });
    await mkdir(v2Dir, { recursive: true });

    const manifestV1 = { manifest_version: 3, name: "Updater", version: "1.0.0", icons: { "64": "icon.png" } };
    const manifestV2 = { manifest_version: 3, name: "Updater", version: "1.1.0", icons: { "64": "icon.png" } };
    await writeFile(path.join(v1Dir, "manifest.json"), JSON.stringify(manifestV1), "utf8");
    await writeFile(path.join(v2Dir, "manifest.json"), JSON.stringify(manifestV2), "utf8");

    const removeExtension = sinon.stub().resolves();
    const loadExtension = sinon.stub().resolves({ id: extId });
    const updateAll = sinon.stub().resolves({
      updated: [{ id: extId, from: "1.0.0", to: "1.1.0" }],
      skipped: [],
      errors: [],
    });

    const manager = {
      app: { getPath: (k) => (k === "userData" ? tempRoot : tempRoot) },
      extensionsBaseDir: userExtensions,
      extensionsRegistryFile: path.join(userExtensions, "extensions.json"),
      loadedExtensions: new Map([
        [
          extId,
          {
            id: extId,
            name: "Updater",
            version: "1.0.0",
            enabled: true,
            source: "webstore",
            installedPath: v1Dir,
            electronId: extId,
            manifest: manifestV1,
          },
        ],
      ]),
      chromeWebStore: { updateAll },
      session: {
        removeExtension,
        loadExtension,
        getExtension: sinon.stub().returns(true),
      },
    };

    const result = await WebStoreService.updateAllExtensions(manager);

    expect(updateAll.calledOnce).to.equal(true);
    expect(removeExtension.calledOnce).to.equal(true);
    expect(loadExtension.calledOnce).to.equal(true);
    expect(result.updated).to.have.length(1);
    expect(result.updated[0].to).to.equal("1.1.0");
  });
});
