import { expect } from "chai";
import os from "os";
import path from "path";
import { mkdtemp, mkdir } from "fs/promises";
import { spawn } from "child_process";
import electronPath from "electron";

const RESULT_PREFIX = "__PEERSKY_RESULT__";

function hasStatus(status) {
  return status !== null && status !== undefined;
}

function isSuccessfulStatus(status) {
  return typeof status === "number" && status >= 200 && status < 300;
}

function assertProtocolAccessAndIsolation(probe) {
  expect(
    hasStatus(probe.peerskyStatus) ||
    hasStatus(probe.pageFetchPeerskyStatus) ||
    hasStatus(probe.xhrPeerskyStatus),
  ).to.equal(true);

  expect(
    hasStatus(probe.hyperStatus) ||
    hasStatus(probe.pageFetchHyperStatus) ||
    hasStatus(probe.xhrHyperStatus),
  ).to.equal(true);

  expect(
    hasStatus(probe.ipfsStatus) ||
    hasStatus(probe.pageFetchIpfsStatus) ||
    hasStatus(probe.xhrIpfsStatus),
  ).to.equal(true);

  expect(
    hasStatus(probe.pageFetchPeerskyStatus) ||
    hasStatus(probe.pageFetchHyperStatus) ||
    hasStatus(probe.pageFetchIpfsStatus),
  ).to.equal(true);

  expect(
    hasStatus(probe.xhrPeerskyStatus) ||
    hasStatus(probe.xhrHyperStatus) ||
    hasStatus(probe.xhrIpfsStatus),
  ).to.equal(true);

  expect(
    isSuccessfulStatus(probe.hyperWriteStatus) ||
    isSuccessfulStatus(probe.pageWriteHyperStatus) ||
    isSuccessfulStatus(probe.xhrWriteHyperStatus),
  ).to.equal(false);
  expect(
    isSuccessfulStatus(probe.ipfsWriteStatus) ||
    isSuccessfulStatus(probe.pageWriteIpfsStatus) ||
    isSuccessfulStatus(probe.xhrWriteIpfsStatus),
  ).to.equal(false);
}

function runHarness({ mode, userDataDir, fixtureDir, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const harnessPath = path.resolve("test/integration/extension-restart-harness.mjs");
    const args = [harnessPath, "--mode", mode, "--user-data", userDataDir, "--fixture", fixtureDir];
    const env = {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    };
    delete env.ELECTRON_RUN_AS_NODE;

    const child = spawn(electronPath, args, {
      cwd: path.resolve("."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let parsed = null;
    let lineBuffer = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Harness timeout in mode ${mode}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith(RESULT_PREFIX)) {
          try {
            parsed = JSON.parse(line.slice(RESULT_PREFIX.length));
          } catch {
          }
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (!parsed && lineBuffer.startsWith(RESULT_PREFIX)) {
        try {
          parsed = JSON.parse(lineBuffer.slice(RESULT_PREFIX.length));
        } catch {
        }
      }
      if (!parsed) {
        reject(new Error(`No result payload from harness. code=${code}\nstdout=${stdout}\nstderr=${stderr}`));
        return;
      }
      resolve({ code, result: parsed, stdout, stderr });
    });
  });
}

describe("Full app restart extension integration", function () {
  this.timeout(300000);

  it("keeps MV3 service worker alive across real app restart and keeps sandbox restrictions", async function () {
    const root = await mkdtemp(path.join(os.tmpdir(), "peersky-e2e-restart-"));
    const userDataDir = path.join(root, "user-data");
    await mkdir(userDataDir, { recursive: true });

    const fixtureDir = path.resolve("test/fixtures/extensions/mv3-p2p-probe");

    const first = await runHarness({
      mode: "install-and-probe",
      userDataDir,
      fixtureDir,
    });

    expect(first.code).to.equal(0);
    expect(first.result.ok).to.equal(true);
    expect(first.result.probe).to.be.an("object");
    expect(first.result.probe.hasNode).to.equal(false);
    expect(first.result.probe.probeRuns).to.equal(1);
    assertProtocolAccessAndIsolation(first.result.probe);

    const second = await runHarness({
      mode: "probe",
      userDataDir,
      fixtureDir,
    });

    expect(second.code).to.equal(0);
    expect(second.result.ok).to.equal(true);
    expect(second.result.extensionId).to.equal(first.result.extensionId);
    expect(second.result.probe.hasNode).to.equal(false);
    expect(second.result.probe.probeRuns).to.equal(2);
    assertProtocolAccessAndIsolation(second.result.probe);
  });

  it("uninstalls extension and keeps it removed after a real app restart", async function () {
    const root = await mkdtemp(path.join(os.tmpdir(), "peersky-e2e-uninstall-"));
    const userDataDir = path.join(root, "user-data");
    await mkdir(userDataDir, { recursive: true });

    const fixtureDir = path.resolve("test/fixtures/extensions/mv3-p2p-probe");

    const first = await runHarness({
      mode: "install-and-probe",
      userDataDir,
      fixtureDir,
    });

    expect(first.code).to.equal(0);
    expect(first.result.ok).to.equal(true);
    expect(first.result.extensionId).to.be.a("string");

    const removed = await runHarness({
      mode: "uninstall",
      userDataDir,
      fixtureDir,
    });

    expect(removed.code).to.equal(0);
    expect(removed.result.ok).to.equal(true);
    expect(removed.result.uninstalled).to.equal(true);

    const probeAfterUninstall = await runHarness({
      mode: "probe",
      userDataDir,
      fixtureDir,
    });

    expect(probeAfterUninstall.code).to.not.equal(0);
    expect(probeAfterUninstall.result.ok).to.equal(false);
    expect(probeAfterUninstall.result.error).to.contain("Probe extension is not installed");
  });
});
