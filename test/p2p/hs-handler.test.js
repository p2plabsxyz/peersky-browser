import { expect } from "chai";
import esmock from "esmock";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import * as Y from "yjs";

let activeConnections = null;

async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref?.();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(Number(port));
      });
    });
  });
}

class FakeHolesail {
  static rooms = new Map();
  static nextKey = 1;

  static reset() {
    FakeHolesail.rooms.clear();
    FakeHolesail.nextKey = 1;
  }

  static urlParser(key) {
    const entry = FakeHolesail.rooms.get(key);
    return {
      secure: Boolean(entry?.secure),
      udp: Boolean(entry?.udp),
      port: Number(entry?.port || 0),
    };
  }

  constructor(options = {}) {
    this.options = options;
    this.info = null;
    this.dht = null;
    this.seed = null;
  }

  async ready() {
    if (this.options.server) {
      const port = Number(this.options.port || await getAvailablePort());
      const key =
        typeof this.options.key === "string" && this.options.key.length > 0
          ? this.options.key
          : `hs://room-${FakeHolesail.nextKey++}`;
      const seedValue = this.seed || Buffer.from(`seed-${key}`.padEnd(32, "0").slice(0, 32));
      this.info = {
        url: key,
        key: `key-${key}`,
        secure: Boolean(this.options.secure),
        udp: Boolean(this.options.udp),
        port,
      };
      this.dht = { seed: seedValue };
      FakeHolesail.rooms.set(key, {
        key,
        port,
        secure: this.info.secure,
        udp: this.info.udp,
        seed: seedValue,
      });
      return;
    }

    if (this.options.client) {
      const entry = FakeHolesail.rooms.get(this.options.key);
      const port = Number(this.options.port || entry?.port || await getAvailablePort());
      this.info = {
        port,
        secure: this.options.secure ?? entry?.secure ?? false,
        udp: this.options.udp ?? entry?.udp ?? false,
      };
    }
  }

  async close() {}
}

async function loadHsHandler(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });

  const module = await esmock("../../src/protocols/hs-handler.js", {
    holesail: {
      default: FakeHolesail,
    },
    electron: {
      app: {
        getAppPath: () => process.cwd(),
        // hs-handler uses "userData" in this test path. For simplicity we
        // return the same fixture dir for any path key.
        getPath: (_pathType) => userDataDir,
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (value) => Buffer.from(String(value)),
        decryptString: (buffer) => Buffer.from(buffer).toString(),
      },
    },
  });

  const handler = await module.createHandler();
  return { handler };
}

async function protocolPost(handler, action, payload) {
  const response = await handler(
    new Request(`hs://p2pmd?action=${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    }),
  );
  const data = await response.json();
  return { response, data };
}

async function getDoc(localUrl) {
  const res = await fetch(`${localUrl}/doc`);
  expect(res.status).to.equal(200);
  return res.json();
}

async function getStatus(localUrl) {
  const res = await fetch(`${localUrl}/status`);
  expect(res.status).to.equal(200);
  return res.json();
}

async function getYjsState(localUrl) {
  const res = await fetch(`${localUrl}/doc/yjsstate`);
  expect(res.status).to.equal(200);
  return res.json();
}

async function getYjsStateWithRetry(localUrl, attempts = 8) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await getYjsState(localUrl);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 120 * (i + 1)));
    }
  }
  throw lastError || new Error("Unable to read /doc/yjsstate after retries");
}

async function getActivity(localUrl) {
  const res = await fetch(`${localUrl}/activity`);
  expect(res.status).to.equal(200);
  return res.json();
}

async function postPresence(localUrl, payload) {
  const res = await fetch(`${localUrl}/presence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(res.status).to.equal(200);
  const body = await res.json();
  expect(body.ok).to.equal(true);
}

function findPeer(status, clientId) {
  const list = Array.isArray(status?.peerList) ? status.peerList : [];
  return list.find((peer) => peer && peer.clientId === clientId) || null;
}

async function waitForEditActivity(localUrl, clientIds, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const payload = await getActivity(localUrl);
    const activity = Array.isArray(payload?.activity) ? payload.activity : [];
    const matched = new Set();
    for (const entry of activity) {
      if (entry?.type === "edit" && clientIds.includes(entry.clientId)) {
        matched.add(entry.clientId);
      }
    }
    if (matched.size === clientIds.length) {
      return activity;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for edit activity for: ${clientIds.join(", ")}`);
}

async function setDoc(localUrl, payload) {
  const res = await fetch(`${localUrl}/doc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(res.status).to.equal(200);
  const body = await res.json();
  expect(body.ok).to.equal(true);
}

async function setDocUpdate(localUrl, payload) {
  const res = await fetch(`${localUrl}/doc/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(res.status).to.equal(200);
  const body = await res.json();
  expect(body.ok).to.equal(true);
}

async function appendLine(localUrl, clientId, name, line) {
  const current = await getDoc(localUrl);
  const next = current.content ? `${current.content}\n${line}` : line;
  await setDoc(localUrl, { content: next, clientId, name });
}

async function connectPeer(localUrl, clientId, role) {
  const controller = new AbortController();
  let timer = null;
  const connectPromise = fetch(
    `${localUrl}/events?clientId=${encodeURIComponent(clientId)}&role=${encodeURIComponent(role)}`,
    { signal: controller.signal },
  );
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("SSE connect timeout"));
    }, 5000);
    timer.unref?.();
  });
  const response = await Promise.race([connectPromise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  expect(response.status).to.equal(200);
  const connection = { controller, response };
  if (activeConnections) activeConnections.add(connection);
  return connection;
}

async function connectPeerWithRetry(localUrl, clientId, role, attempts = 5) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await connectPeer(localUrl, clientId, role);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 120 * (i + 1)));
    }
  }
  throw lastError || new Error("SSE reconnect failed");
}

function disconnectPeer(peerConn) {
  if (!peerConn) return;
  try {
    peerConn.controller.abort();
  } catch {}
  try {
    peerConn.response.body?.cancel();
  } catch {}
  if (activeConnections) activeConnections.delete(peerConn);
}

function buildLineReplaceUpdate(base64State, target, replacement) {
  // Each update is built from its own Y.Doc seeded from the same base state
  // to model independent peer edits that must merge on the server.
  const doc = new Y.Doc();
  const ytext = doc.getText("content");
  const decodedState = Buffer.from(base64State, "base64");
  Y.applyUpdate(doc, new Uint8Array(decodedState), "seed");

  const before = ytext.toString();
  const start = before.indexOf(target);
  if (start === -1) {
    throw new Error(`Missing target text "${target}"`);
  }

  doc.transact(() => {
    ytext.delete(start, target.length);
    ytext.insert(start, replacement);
  }, "edit");

  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

describe("HS protocol handler", function () {
  this.timeout(30000);

  let handler;
  let userDataDir;

  beforeEach(async function () {
    FakeHolesail.reset();
    activeConnections = new Set();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "peersky-hs-test-"));
    ({ handler } = await loadHsHandler(userDataDir));
  });

  afterEach(async function () {
    if (activeConnections && activeConnections.size > 0) {
      for (const conn of Array.from(activeConnections)) {
        disconnectPeer(conn);
      }
      activeConnections.clear();
    }
    activeConnections = null;
    try {
      await protocolPost(handler, "close", {});
    } catch {}
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it("keeps peer edits when host disconnects and reconnects", async function () {
    const { response: createResponse, data: room } = await protocolPost(handler, "create", { secure: false, udp: false });
    expect(createResponse.status).to.equal(200);

    const baseLines = ["Mac: Line 1", "Mac: Line 2"];
    await setDoc(room.localUrl, { content: baseLines.join("\n"), clientId: "device-a", name: "Mac" });

    const hostConn = await connectPeer(room.localUrl, "device-a", "host");
    const peerConn = await connectPeer(room.localUrl, "device-b", "client");

    await postPresence(room.localUrl, {
      clientId: "device-b",
      role: "client",
      name: "Phone",
      color: "#00AAFF",
      cursorLine: 3,
      cursorColumn: 5,
      lineAttributions: {
        3: { name: "Phone", color: "#00AAFF" },
      },
      isTyping: true,
    });
    const preDisconnectStatus = await getStatus(room.localUrl);
    const preDisconnectPeer = findPeer(preDisconnectStatus, "device-b");
    expect(preDisconnectPeer).to.not.equal(null);
    expect(preDisconnectPeer.cursorLine).to.equal(3);
    expect(preDisconnectPeer.cursorColumn).to.equal(5);
    expect(preDisconnectPeer.lineAttributions).to.have.property("3");

    disconnectPeer(hostConn);

    await appendLine(room.localUrl, "device-b", "Phone", "Phone: Host is gone");
    await appendLine(room.localUrl, "device-b", "Phone", "Phone: Still editing");
    await waitForEditActivity(room.localUrl, ["device-b"]);

    const { response: rehostResponse, data: rehostData } = await protocolPost(handler, "rehost", {
      key: room.key,
      secure: false,
      udp: false,
      initialContent: "",
    });
    expect(rehostResponse.status).to.equal(200);
    expect(rehostData.localUrl).to.be.a("string");
    const yjsSnapshot = await getYjsStateWithRetry(rehostData.localUrl);
    expect(yjsSnapshot.yjsState).to.be.a("string");
    expect(yjsSnapshot.yjsState.length).to.be.greaterThan(0);

    const hostReconnect = await connectPeerWithRetry(rehostData.localUrl, "device-a", "host");
    const peerReconnect = await connectPeerWithRetry(rehostData.localUrl, "device-b", "client");
    const statusAfterRehost = await getStatus(rehostData.localUrl);
    const phoneAfterRehost = findPeer(statusAfterRehost, "device-b");
    expect(phoneAfterRehost).to.not.equal(null);
    // Cursor is a live-presence field and should not keep the stale pre-rehost
    // value until the peer posts presence again.
    expect(phoneAfterRehost.cursorLine).to.not.equal(3);
    expect(phoneAfterRehost.lineAttributions).to.have.property("3");
    const doc = await getDoc(rehostData.localUrl);
    const lines = doc.content.split("\n");

    expect(lines).to.deep.equal([
      "Mac: Line 1",
      "Mac: Line 2",
      "Phone: Host is gone",
      "Phone: Still editing",
    ]);

    disconnectPeer(peerConn);
    disconnectPeer(peerReconnect);
    disconnectPeer(hostReconnect);
  });

  it("keeps host edits when peer disconnects and reconnects", async function () {
    const { response: createResponse, data: room } = await protocolPost(handler, "create", { secure: false, udp: false });
    expect(createResponse.status).to.equal(200);

    await setDoc(room.localUrl, { content: "Shared: Start", clientId: "device-a", name: "Mac" });

    const hostConn = await connectPeer(room.localUrl, "device-a", "host");
    const peerConn = await connectPeer(room.localUrl, "device-b", "client");
    await postPresence(room.localUrl, {
      clientId: "device-a",
      role: "host",
      name: "Mac",
      color: "#AA5500",
      cursorLine: 2,
      cursorColumn: 1,
      lineAttributions: {
        2: { name: "Mac", color: "#AA5500" },
      },
      isTyping: true,
    });
    const preDisconnectStatus = await getStatus(room.localUrl);
    const preDisconnectHost = findPeer(preDisconnectStatus, "device-a");
    expect(preDisconnectHost).to.not.equal(null);
    expect(preDisconnectHost.cursorLine).to.equal(2);
    expect(preDisconnectHost.lineAttributions).to.have.property("2");

    disconnectPeer(peerConn);

    await appendLine(room.localUrl, "device-a", "Mac", "Mac: Peer left, editing alone");
    await appendLine(room.localUrl, "device-a", "Mac", "Mac: More changes");

    const peerReconnect = await connectPeer(room.localUrl, "device-b", "client");
    const doc = await getDoc(room.localUrl);
    const lines = doc.content.split("\n");

    expect(lines).to.deep.equal([
      "Shared: Start",
      "Mac: Peer left, editing alone",
      "Mac: More changes",
    ]);

    disconnectPeer(hostConn);
    disconnectPeer(peerReconnect);
  });

  it("syncs host edits to a laptop peer connected via action=join", async function () {
    const { response: createResponse, data: room } = await protocolPost(handler, "create", { secure: false, udp: false });
    expect(createResponse.status).to.equal(200);

    await setDoc(room.localUrl, { content: "Shared: Start", clientId: "device-a", name: "Mac" });
    const hostConn = await connectPeer(room.localUrl, "device-a", "host");

    const laptopUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "peersky-hs-join-"));
    const { handler: laptopHandler } = await loadHsHandler(laptopUserDataDir);

    let laptopConn = null;
    try {
      // Use a separate handler instance so join exercises the client path.
      const { response: joinResponse, data: joinData } = await protocolPost(laptopHandler, "join", {
        key: room.key,
        secure: false,
        udp: false,
      });
      expect(joinResponse.status).to.equal(200);
      expect(joinData.localUrl).to.be.a("string");

      laptopConn = await connectPeer(joinData.localUrl, "device-laptop", "client");
      await postPresence(joinData.localUrl, {
        clientId: "device-laptop",
        role: "client",
        name: "Laptop",
        color: "#229922",
        cursorLine: 1,
        cursorColumn: 4,
        lineAttributions: {
          1: { name: "Laptop", color: "#229922" },
        },
        isTyping: true,
      });
      const joinStatus = await getStatus(joinData.localUrl);
      const laptopPeer = findPeer(joinStatus, "device-laptop");
      expect(laptopPeer).to.not.equal(null);
      expect(laptopPeer.cursorLine).to.equal(1);
      expect(laptopPeer.lineAttributions).to.have.property("1");

      await appendLine(room.localUrl, "device-a", "Mac", "Mac: host edit after laptop join");
      await waitForEditActivity(room.localUrl, ["device-a"]);
      const doc = await getDoc(joinData.localUrl);
      const lines = doc.content.split("\n");

      expect(lines).to.deep.equal([
        "Shared: Start",
        "Mac: host edit after laptop join",
      ]);
    } finally {
      disconnectPeer(laptopConn);
      try {
        await protocolPost(laptopHandler, "close", {});
      } catch {}
      fs.rmSync(laptopUserDataDir, { recursive: true, force: true });
      disconnectPeer(hostConn);
    }
  });

  it("returns active room details via action=resume", async function () {
    const { response: createResponse, data: room } = await protocolPost(handler, "create", { secure: false, udp: false });
    expect(createResponse.status).to.equal(200);

    const { response: resumeResponse, data: resumeData } = await protocolPost(handler, "resume", { key: room.key });
    expect(resumeResponse.status).to.equal(200);
    expect(resumeData.key).to.equal(room.key);
    expect(resumeData.localUrl).to.equal(room.localUrl);
    expect(resumeData.localPort).to.equal(room.localPort);
  });

  it("preserves edits from two peers when host reconnects in a three-peer room", async function () {
    const { response: createResponse, data: room } = await protocolPost(handler, "create", { secure: false, udp: false });
    expect(createResponse.status).to.equal(200);

    await setDoc(room.localUrl, { content: "Shared: Start", clientId: "device-a", name: "Mac" });

    const hostConn = await connectPeer(room.localUrl, "device-a", "host");
    const peerBConn = await connectPeer(room.localUrl, "device-b", "client");
    const peerCConn = await connectPeer(room.localUrl, "device-c", "client");
    await postPresence(room.localUrl, {
      clientId: "device-b",
      role: "client",
      name: "B",
      color: "#3366CC",
      cursorLine: 2,
      cursorColumn: 2,
      lineAttributions: { 2: { name: "B", color: "#3366CC" } },
      isTyping: true,
    });
    await postPresence(room.localUrl, {
      clientId: "device-c",
      role: "client",
      name: "C",
      color: "#CC6633",
      cursorLine: 3,
      cursorColumn: 2,
      lineAttributions: { 3: { name: "C", color: "#CC6633" } },
      isTyping: true,
    });
    const threePeerStatus = await getStatus(room.localUrl);
    expect(findPeer(threePeerStatus, "device-b")?.lineAttributions).to.have.property("2");
    expect(findPeer(threePeerStatus, "device-c")?.lineAttributions).to.have.property("3");

    disconnectPeer(hostConn);

    await appendLine(room.localUrl, "device-b", "B", "B: editing");
    await appendLine(room.localUrl, "device-c", "C", "C: also editing");

    const hostReconnect = await connectPeer(room.localUrl, "device-a", "host");
    const doc = await getDoc(room.localUrl);
    const lines = doc.content.split("\n");

    expect(lines).to.deep.equal([
      "Shared: Start",
      "B: editing",
      "C: also editing",
    ]);

    disconnectPeer(peerBConn);
    disconnectPeer(peerCConn);
    disconnectPeer(hostReconnect);
  });

  it("merges concurrent line edits from two peers via CRDT updates", async function () {
    const { response: createResponse, data: room } = await protocolPost(handler, "create", { secure: false, udp: false });
    expect(createResponse.status).to.equal(200);

    const initial = ["Line 1: base", "Line 2: base", "Line 3: base", "Line 4: base"].join("\n");
    await setDoc(room.localUrl, { content: initial, clientId: "device-a", name: "Mac" });
    const hostConn = await connectPeer(room.localUrl, "device-a", "host");
    const peerConn = await connectPeer(room.localUrl, "device-b", "client");
    await postPresence(room.localUrl, {
      clientId: "device-a",
      role: "host",
      name: "Mac",
      color: "#AA0000",
      cursorLine: 1,
      cursorColumn: 4,
      lineAttributions: {
        1: { name: "Mac", color: "#AA0000" },
      },
      isTyping: true,
    });
    await postPresence(room.localUrl, {
      clientId: "device-b",
      role: "client",
      name: "Phone",
      color: "#0000AA",
      cursorLine: 1,
      cursorColumn: 6,
      lineAttributions: {
        1: { name: "Phone", color: "#0000AA" },
      },
      isTyping: true,
    });

    const yjsRes = await fetch(`${room.localUrl}/doc/yjsstate`);
    expect(yjsRes.status).to.equal(200);
    const yjsPayload = await yjsRes.json();
    expect(yjsPayload.yjsState).to.be.a("string");

    const updateA = buildLineReplaceUpdate(yjsPayload.yjsState, "Line 1: base", "Mac: edited line 1");
    const updateB = buildLineReplaceUpdate(yjsPayload.yjsState, "Line 3: base", "Phone: edited line 3");

    await Promise.all([
      setDocUpdate(room.localUrl, {
        clientId: "device-a",
        name: "Mac",
        color: "#AA0000",
        cursorLine: 1,
        cursorColumn: 8,
        lineAttributions: {
          1: { name: "Mac", color: "#AA0000" },
        },
        update: updateA,
      }),
      setDocUpdate(room.localUrl, {
        clientId: "device-b",
        name: "Phone",
        color: "#0000AA",
        cursorLine: 3,
        cursorColumn: 8,
        lineAttributions: {
          3: { name: "Phone", color: "#0000AA" },
        },
        update: updateB,
      }),
    ]);

    const doc = await getDoc(room.localUrl);
    expect(doc.content).to.contain("Mac: edited line 1");
    expect(doc.content).to.contain("Phone: edited line 3");
    expect(doc.content).to.contain("Line 2: base");
    expect(doc.content).to.contain("Line 4: base");
    const status = await getStatus(room.localUrl);
    const hostPeer = findPeer(status, "device-a");
    const phonePeer = findPeer(status, "device-b");
    expect(hostPeer).to.not.equal(null);
    expect(phonePeer).to.not.equal(null);
    expect(hostPeer.cursorLine).to.equal(1);
    expect(phonePeer.cursorLine).to.equal(3);
    expect(hostPeer.lineAttributions).to.have.property("1");
    expect(phonePeer.lineAttributions).to.have.property("3");
    // Host editing line 1 should evict line-1 ownership from other peers.
    expect(phonePeer.lineAttributions).to.not.have.property("1");
    await waitForEditActivity(room.localUrl, ["device-a", "device-b"]);

    disconnectPeer(hostConn);
    disconnectPeer(peerConn);
  });
});
