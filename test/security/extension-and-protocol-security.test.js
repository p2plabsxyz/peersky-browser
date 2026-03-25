import { expect } from "chai";
import { readFile } from "fs/promises";

import ManifestValidator from "../../src/extensions/manifest-validator.js";
import DEFAULT_POLICY from "../../src/extensions/policy.js";
import { ERR, validateInstallSource } from "../../src/extensions/util.js";
import { enforceExtensionWritePolicy } from "../../src/protocols/request-policy.js";

describe("Protocol and extension security guardrails", function () {
  it("keeps P2P and peersky schemes fetch-enabled and webviews sandboxed", async function () {
    const mainJs = await readFile("src/main.js", "utf8");

    expect(mainJs).to.include('supportFetchAPI: true');
    expect(mainJs).to.include('sessionProtocol.handle("peersky"');
    const hasIpfsRegistration =
      mainJs.includes('sessionProtocol.handle("ipfs"') ||
      mainJs.includes('sessionProtocol.registerStreamProtocol("ipfs"');
    expect(hasIpfsRegistration).to.equal(true);
    expect(mainJs).to.include('sessionProtocol.handle("hyper"');

    expect(mainJs).to.include("will-attach-webview");
    expect(mainJs).to.include("webPreferences.nodeIntegration = false");
    expect(mainJs).to.include("webPreferences.contextIsolation = true");
    expect(mainJs).to.include("webPreferences.sandbox = true");

    const ipfsHandlerJs = await readFile("src/protocols/ipfs-handler.js", "utf8");
    expect(ipfsHandlerJs).to.include("enforceExtensionWritePolicy");
    expect(mainJs).to.include("createIPFSHandler(ipfsOptions, session, { isExtensionWriteAllowed })");
  });

  it("blocks extension writes to ipfs:// without permission and allows them with explicit grant", async function () {
    const extensionRequest = {
      method: "PUT",
      url: "ipfs://bafyfoo/index.html",
      referrer: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html",
      headers: {},
    };

    const blocked = await enforceExtensionWritePolicy({
      request: extensionRequest,
      scheme: "ipfs",
      isExtensionWriteAllowed: async () => false,
    });
    expect(blocked).to.not.equal(null);
    expect(blocked.status).to.equal(403);
    const body = await blocked.text();
    expect(body).to.include("not allowed to write ipfs content");

    const allowed = await enforceExtensionWritePolicy({
      request: extensionRequest,
      scheme: "ipfs",
      isExtensionWriteAllowed: async () => true,
    });
    expect(allowed).to.equal(null);

    const nonExtension = await enforceExtensionWritePolicy({
      request: { ...extensionRequest, referrer: "ipfs://bafyfoo/" },
      scheme: "ipfs",
      isExtensionWriteAllowed: async () => false,
    });
    expect(nonExtension).to.equal(null);

    const getRequest = await enforceExtensionWritePolicy({
      request: { ...extensionRequest, method: "GET" },
      scheme: "ipfs",
      isExtensionWriteAllowed: async () => false,
    });
    expect(getRequest).to.equal(null);
  });

  it("enforces manifest permission risk checks", function () {
    const validator = new ManifestValidator(DEFAULT_POLICY);

    const blockedResult = validator.validate({
      manifest_version: 3,
      name: "Blocked API",
      version: "1.0.0",
      permissions: ["nativeMessaging"],
      host_permissions: [],
    });

    expect(blockedResult.isValid).to.equal(false);
    expect(blockedResult.errors.join(" ")).to.contain("Blocked permission: nativeMessaging");

    const dangerousResult = validator.validate({
      manifest_version: 3,
      name: "Dangerous Host",
      version: "1.0.0",
      permissions: ["storage"],
      host_permissions: ["<all_urls>"],
    });

    expect(dangerousResult.warnings.join(" ")).to.contain("High-risk host permission");
  });

  it("rejects traversal patterns in extension install paths", async function () {
    try {
      await validateInstallSource("../evil-extension", {
        allowDirectories: true,
        allowFiles: true,
        allowedFileExtensions: [".zip", ".crx"],
      });
      throw new Error("expected validateInstallSource to throw");
    } catch (error) {
      expect(error.code).to.equal(ERR.E_PATH_TRAVERSAL);
    }
  });

  it("keeps extension API scoped and external pages minimal in preload", async function () {
    const preload = await readFile("src/pages/unified-preload.js", "utf8");

    expect(preload).to.include("const isExtensions = url.startsWith('peersky://extensions')");
    expect(preload).to.include("const isExternal = !isInternal");
    expect(preload).to.include("extensions: extensionAPI");
    expect(preload).to.include("External minimal API exposed (no settings access)");
  });
});
