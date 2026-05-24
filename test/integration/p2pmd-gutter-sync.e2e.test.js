import { expect } from "chai";
import os from "os";
import path from "path";
import fs from "fs/promises";
import http from "http";
import { spawn } from "child_process";
import electronPath from "electron";

const RESULT_PREFIX = "__PEERSKY_RESULT__";
const HARNESS_TIMEOUT_MS = 260_000;
const MAX_GAP_PX = 48;
const EXPECTED_FINAL_TEXT =
  "second line after block by person 2\nthird line after block by person 3\n\n# person3\n- line1\n- line2\n- line3\n\n# person1\n- line1\n- line2\n- line3\n\n# person2\n- line1\n- line2\n- line3";

function createRoomServer() {
  let docContent = "";
  let yjsStateB64 = null;
  const peers = new Map();
  const clients = new Set();

  function broadcast(eventName, data) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  }

  function broadcastPeerList() {
    broadcast("peerlist", Array.from(peers.values()));
  }

  function parseBody(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (error) {
          reject(error);
        }
      });
      req.on("error", reject);
    });
  }

  function json(res, statusCode, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      const clientId = url.searchParams.get("clientId") || `anon-${Date.now()}`;
      const role = url.searchParams.get("role") || "client";
      const color = url.searchParams.get("color") || "#888888";
      const name = url.searchParams.get("name") || clientId.slice(0, 8);

      if (!peers.has(clientId)) {
        peers.set(clientId, { clientId, role, color, name, cursorLine: 1, cursorColumn: 1 });
        broadcastPeerList();
      }

      clients.add(res);
      res.write(`event: update\ndata: ${JSON.stringify({ content: docContent })}\n\n`);
      res.write(`event: peerlist\ndata: ${JSON.stringify(Array.from(peers.values()))}\n\n`);
      if (yjsStateB64) {
        res.write(`event: yjsupdate\ndata: ${yjsStateB64}\n\n`);
      }

      req.on("close", () => {
        clients.delete(res);
        peers.delete(clientId);
        broadcastPeerList();
      });
      return;
    }

    if (pathname === "/status" && req.method === "GET") {
      return json(res, 200, { peers: peers.size, peerList: Array.from(peers.values()) });
    }

    if (pathname === "/doc" && req.method === "GET") {
      return json(res, 200, { content: docContent });
    }

    if (pathname === "/doc" && req.method === "POST") {
      try {
        const body = await parseBody(req);
        if (typeof body.content === "string") {
          docContent = body.content;
          if (body.clientId && peers.has(body.clientId) && body.lineAttributions) {
            const peer = peers.get(body.clientId);
            peer.lineAttributions = body.lineAttributions;
            if (body.name) peer.name = body.name;
            if (body.color) peer.color = body.color;
          }
          broadcast("update", { content: docContent, latexModeEnabled: false });
          broadcastPeerList();
        }
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 400, { error: String(error.message) });
      }
    }

    if (pathname === "/doc/update" && req.method === "POST") {
      try {
        const body = await parseBody(req);
        if (typeof body.update === "string") {
          yjsStateB64 = body.update;
          if (typeof body.content === "string") docContent = body.content;
          if (body.clientId && body.lineAttributions) {
            const peer = peers.get(body.clientId) || { clientId: body.clientId };
            peer.lineAttributions = body.lineAttributions;
            if (body.name) peer.name = body.name;
            if (body.color) peer.color = body.color;
            peers.set(body.clientId, peer);
          }
          broadcast("yjsupdate", body.update);
          broadcastPeerList();
        }
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 400, { error: String(error.message) });
      }
    }

    if (pathname === "/doc/yjsstate" && req.method === "GET") {
      return json(res, 200, { yjsState: yjsStateB64 });
    }

    if (pathname === "/presence" && req.method === "POST") {
      try {
        const body = await parseBody(req);
        if (body.clientId) {
          const existing = peers.get(body.clientId) || {};
          peers.set(body.clientId, { ...existing, ...body });
          broadcastPeerList();
        }
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 400, { error: String(error.message) });
      }
    }

    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    res.end("Not found");
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, localUrl: `http://127.0.0.1:${port}` });
    });
    server.on("error", reject);
  });
}

function runHarness({ userDataDir, localUrl, timeoutMs = HARNESS_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const harnessPath = path.resolve("test/integration/p2pmd-gutter-sync-harness.mjs");
    const args = [harnessPath, "--user-data", userDataDir, "--room-url", localUrl];
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
      reject(new Error(`Harness timeout after ${timeoutMs}ms`));
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
        reject(
          new Error(
            `No harness result payload. code=${code}\n` +
              `--- stdout tail ---\n${stdout.slice(-4000)}\n` +
              `--- stderr tail ---\n${stderr.slice(-4000)}`
          )
        );
        return;
      }
      resolve({ code, result: parsed, stdout, stderr });
    });
  });
}

function formatDiagnostics(result, stdout, stderr) {
  let out = "";
  if (result?.error) {
    out += `Harness error: ${result.error}\n`;
  }
  for (const inst of result?.instances || []) {
    out += `\n[${inst.name}/${inst.role}] converged=${inst.converged} markCount=${inst.markCount} distinctAuthors=${inst.distinctAuthors}\n`;
    out += `  names=${JSON.stringify(inst.distinctAuthorNames || [])}\n`;
    out += `  authorTokens=${JSON.stringify(inst.distinctAuthorTokens || [])}\n`;
    out += `  gaps=${JSON.stringify(inst.gutterGaps || [])}\n`;
    out += `  lineOwners=${JSON.stringify((inst.lineOwners || []).map((l) => ({ line: l.line, text: l.text, name: l.name, token: l.token })))}\n`;
    out += `  textHead=${JSON.stringify((inst.text || "").slice(0, 220))}\n`;
    out += `  screenshot=${inst.screenshotPath || "(none)"}\n`;
  }
  if (stderr) out += `\n--- harness stderr ---\n${stderr.slice(-2000)}\n`;
  if (stdout) out += `\n--- harness stdout tail ---\n${stdout.slice(-2000)}\n`;
  return out;
}

describe("p2pmd: 3-peer gutter sync E2E (distributed edits)", function () {
  this.timeout(HARNESS_TIMEOUT_MS + 20_000);

  let roomServerHandle = null;
  let userDataDir = null;

  before(async function () {
    roomServerHandle = await createRoomServer();
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "peersky-p2pmd-gutter-e2e-"));
    userDataDir = path.join(tmpRoot, "user-data");
    await fs.mkdir(userDataDir, { recursive: true });
  });

  after(async function () {
    if (roomServerHandle?.server) {
      await new Promise((resolve) => roomServerHandle.server.close(resolve));
    }
  });

  it("keeps text and gutter attribution synced across all 3 peers", async function () {
    const { result, stdout, stderr } = await runHarness({
      userDataDir,
      localUrl: roomServerHandle.localUrl,
    });

    if (!result.ok) {
      throw new Error(formatDiagnostics(result, stdout, stderr));
    }

    expect(result.instances, "Expected 3 instance snapshots").to.have.length(3);

    const failures = [];
    const nonEmptyLineOwnerByInstance = {};
    for (const inst of result.instances) {
      if ((inst.text || "").trim() !== EXPECTED_FINAL_TEXT.trim()) failures.push(`${inst.name}: text mismatch`);
      if (inst.converged !== true) failures.push(`${inst.name}: convergence flag false`);
      if (!(inst.markCount > 0)) failures.push(`${inst.name}: no gutter marks`);
      if (!(inst.markCount >= 3)) failures.push(`${inst.name}: too few gutter marks (${inst.markCount})`);
      if (!(inst.distinctAuthors >= 3)) failures.push(`${inst.name}: expected >=3 author groups, got ${inst.distinctAuthors}`);

      const marks = Array.isArray(inst.marks) ? inst.marks : [];
      const sorted = [...marks].sort((a, b) => (a.top || 0) - (b.top || 0));
      const firstTop = sorted.length ? Number(sorted[0].top || 0) : Infinity;
      const lastTop = sorted.length ? Number(sorted[sorted.length - 1].top || 0) : -Infinity;
      if (!(firstTop < 170)) failures.push(`${inst.name}: first gutter mark starts too low (${firstTop})`);
      if (!((lastTop - firstTop) > 120)) failures.push(`${inst.name}: gutter marks do not span content (${lastTop - firstTop})`);

      for (const gap of inst.gutterGaps || []) {
        if (!(gap <= MAX_GAP_PX)) failures.push(`${inst.name}: large blank gutter gap ${gap}px`);
      }

      const nonEmpty = (inst.lineOwners || [])
        .filter((line) => String(line.text || "").trim().length > 0)
        .map((line) => ({ line: line.line, text: line.text, name: line.name || null, token: line.token || null }));
      nonEmptyLineOwnerByInstance[inst.name] = nonEmpty;
      for (const line of nonEmpty) {
        if (!line.name) failures.push(`${inst.name}: missing owner at line ${line.line} (${line.text})`);
      }
    }

    // Cross-peer strict sync: each non-empty line should resolve to the same owner token on all peers.
    const [baseName, ...otherNames] = Object.keys(nonEmptyLineOwnerByInstance);
    const baseOwners = nonEmptyLineOwnerByInstance[baseName] || [];
    for (const peerName of otherNames) {
      const peerOwners = nonEmptyLineOwnerByInstance[peerName] || [];
      if (peerOwners.length !== baseOwners.length) {
        failures.push(`${peerName}: non-empty line owner length mismatch (${peerOwners.length} vs ${baseOwners.length})`);
        continue;
      }
      for (let i = 0; i < baseOwners.length; i += 1) {
        const a = baseOwners[i];
        const b = peerOwners[i];
        if (a.line !== b.line || a.text !== b.text) {
          failures.push(`${peerName}: line structure mismatch at index ${i}`);
          continue;
        }
        if ((a.token || null) !== (b.token || null)) {
          failures.push(`${peerName}: owner token mismatch at line ${a.line} (${a.text})`);
        }
      }
    }

    // Semantic correctness for delete + trailing-space churn scenario:
    // line ownership should remain stable for each person block.
    // Top lines can legitimately change owner if another peer edits them.
    const expectedOwnerByLine = new Map([
      [1, "person2"],
      [2, "person2"],
      [4, "person3"], [5, "person3"], [6, "person3"], [7, "person3"],
      [9, "person1"], [10, "person1"], [11, "person1"], [12, "person1"],
      [14, "person2"], [15, "person2"], [16, "person2"], [17, "person2"],
    ]);
    for (const inst of result.instances) {
      const byLine = new Map((inst.lineOwners || []).map((line) => [line.line, line]));
      for (const [lineNo, expectedOwner] of expectedOwnerByLine.entries()) {
        const found = byLine.get(lineNo);
        const foundName = String(found?.name || "").trim().toLowerCase();
        if (foundName !== expectedOwner) {
          failures.push(`${inst.name}: line ${lineNo} expected owner ${expectedOwner}, got ${foundName || "(none)"}`);
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(`${failures.join("\n")}\n\n${formatDiagnostics(result, stdout, stderr)}`);
    }
  });
});
