import { expect } from "chai";
import sinon from "sinon";
import esmock from "esmock";
import { fork as forkProcess } from "child_process";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import path from "path";
import { EventEmitter } from "events";

const _testDir = path.dirname(fileURLToPath(import.meta.url));
const TRACKERS_JSON = path.join(_testDir, "../../src/protocols/bt/trackers.json");

const HASH_HEX = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const MAGNET = `magnet:?xt=urn:btih:${HASH_HEX}&dn=Test`;

function btihFromMagnet(s) {
  const m = String(s).match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return m ? m[1].toLowerCase() : HASH_HEX;
}

// Pretends to be the forked worker: emits `ready`, then answers send({ id, action, ... })
// the same way src/protocols/bt/worker.js does for sendCommand().
function makeFakeChild(onCommand) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let firedReady = false;
  const _on = child.on.bind(child);
  child.on = function (ev, fn) {
    const r = _on(ev, fn);
    if (ev === "message" && !firedReady) {
      firedReady = true;
      queueMicrotask(() => child.emit("message", { type: "ready" }));
    }
    return r;
  };
  const run = onCommand(child);
  child.send = sinon.spy((msg) => queueMicrotask(() => run(msg)));
  return child;
}

function defaultWorkerReplies(proc) {
  return (msg) => {
    const { id, action } = msg;
    if (!id) return;
    if (action === "start") {
      const ih = btihFromMagnet(msg.magnetUri);
      proc.emit("message", { id, type: "started", infoHash: ih, magnetURI: msg.magnetUri });
      return;
    }
    if (action === "seed") {
      const ih = btihFromMagnet(msg.magnetUri);
      proc.emit("message", {
        id,
        type: "started",
        infoHash: ih,
        magnetURI: msg.magnetUri,
        mode: "seed",
      });
      return;
    }
    if (action === "pause") {
      proc.emit("message", { id, type: "paused", infoHash: msg.hash || HASH_HEX });
      return;
    }
    if (action === "resume") {
      proc.emit("message", { id, type: "resumed", infoHash: msg.hash || HASH_HEX });
      return;
    }
    if (action === "remove") {
      proc.emit("message", { id, type: "removed", infoHash: msg.hash || HASH_HEX });
      return;
    }
    if (action === "stop") {
      proc.emit("message", {
        id,
        type: "stopped",
        infoHash: msg.hash || HASH_HEX,
        magnetURI: MAGNET,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
      });
      return;
    }
    if (action === "unseed") {
      proc.emit("message", { id, type: "unseeded", infoHash: msg.hash || HASH_HEX });
      return;
    }
    proc.emit("message", { id, error: `Unknown action: ${action}` });
  };
}

async function jsonBody(res) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

function apiToken(html) {
  const m = String(html).match(/var apiToken = "([a-f0-9]+)"/);
  return m ? m[1] : null;
}

function apiQuery(parts) {
  return `bt://api?${new URLSearchParams({ action: "api", ...parts }).toString()}`;
}

describe("BitTorrent protocol handler", function () {
  this.timeout(20000);

  const realSetInterval = global.setInterval;
  const intervalHandles = [];
  before(function () {
    global.setInterval = function (fn, ms, ...rest) {
      const handle = realSetInterval(fn, ms, ...rest);
      // bittorrent-handler.js schedules a 30s crash-safety save interval.
      if (ms === 30000) {
        intervalHandles.push(handle);
        if (handle && typeof handle.unref === "function") handle.unref();
      }
      return handle;
    };
  });
  after(function () {
    global.setInterval = realSetInterval;
  });

  /** Dirs created by loadHandler when caller does not pass userDataDir / downloadsDir */
  const tmpDirs = [];

  afterEach(function () {
    sinon.restore();
    while (intervalHandles.length) {
      try {
        clearInterval(intervalHandles.pop());
      } catch {
        /* ignore */
      }
    }
    while (tmpDirs.length) {
      const d = tmpDirs.pop();
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  async function loadHandler(opts = {}) {
    const { userDataDir, downloadsDir, replyAs } = opts;
    let ud = userDataDir;
    let dd = downloadsDir;
    if (!ud) {
      ud = fs.mkdtempSync(path.join(os.tmpdir(), "peersky-bt-ud-"));
      tmpDirs.push(ud);
    }
    if (!dd) {
      dd = fs.mkdtempSync(path.join(os.tmpdir(), "peersky-bt-dl-"));
      tmpDirs.push(dd);
    }
    const fork = sinon.stub();

    // strict so ../settings-manager.js is not merged with the real module (pulls permissions → electron).
    const mod = await esmock.strict("../../src/protocols/bittorrent-handler.js", {
      child_process: { fork },
      electron: {
        app: {
          getPath(t) {
            if (t === "userData") return ud;
            if (t === "downloads") return dd;
            return path.join(ud, t);
          },
        },
        ipcMain: { handle: sinon.stub() },
      },
      "../../src/logger.js": {
        createLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
      "../../src/settings-manager.js": {
        default: { settings: { theme: "dark" } },
      },
    });

    const child = makeFakeChild((proc) => (replyAs ? replyAs(proc) : defaultWorkerReplies(proc)));
    fork.returns(child);

    const handler = await mod.createHandler();
    return { handler, child, ud, dd };
  }

  it("serves torrent UI on bt:// and puts apiToken in the page", async () => {
    const { handler } = await loadHandler();
    const res = await handler(new Request(`bt://${HASH_HEX}/`));
    expect(res.status).to.equal(200);
    expect(res.headers.get("Content-Type")).to.match(/text\/html/);
    const html = await res.text();
    expect(html).to.include("BitTorrent");
    expect(apiToken(html)).to.have.lengthOf(48);
  });

  it("serves torrent UI for magnet: URLs", async () => {
    const { handler } = await loadHandler();
    const res = await handler(new Request(MAGNET));
    expect(res.status).to.equal(200);
    expect(apiToken(await res.text())).to.be.a("string");
  });

  it("rejects API calls when request.url is not bt/bittorrent/magnet", async () => {
    const { handler, child } = await loadHandler();
    const n = child.send.callCount;
    const res = await handler(
      new Request(`https://evil.example/x?action=api&api=status&hash=${HASH_HEX}`),
    );
    expect(res.status).to.equal(403);
    expect((await jsonBody(res)).error).to.equal("Forbidden: API only accessible from BitTorrent protocol");
    expect(child.send.callCount).to.equal(n);
  });

  it("mutations without POST get 405 and no CORS wildcard", async () => {
    const { handler, child } = await loadHandler();
    const n = child.send.callCount;
    const url = apiQuery({ api: "start", magnet: encodeURIComponent(MAGNET) });
    const res = await handler(new Request(url, { method: "GET" }));
    expect(res.status).to.equal(405);
    expect(res.headers.get("Access-Control-Allow-Origin")).to.equal(null);
    expect(child.send.callCount).to.equal(n);
  });

  it("mutations need a valid token; pause works with token from the UI page", async () => {
    const { handler, child } = await loadHandler();
    const token = apiToken(await (await handler(new Request(`bt://${HASH_HEX}/`))).text());
    expect(token).to.be.a("string");

    const start = apiQuery({ api: "start", magnet: encodeURIComponent(MAGNET) });
    expect((await handler(new Request(start, { method: "POST", headers: { "X-BT-Token": "invalid" } }))).status).to.equal(403);
    expect(child.send.callCount).to.equal(0);

    const bad = `${start}&token=${"0".repeat(48)}`;
    expect((await handler(new Request(bad, { method: "POST", headers: { "X-BT-Token": "0".repeat(48) } }))).status).to.equal(403);

    const pause = apiQuery({ api: "pause", hash: HASH_HEX });
    const res = await handler(new Request(pause, { method: "POST", headers: { "X-BT-Token": token } }));
    expect(res.status).to.equal(200);
    const body = await jsonBody(res);
    expect(body).to.include({ success: true, paused: true });
    const ipc = child.send.getCalls().map((c) => c.args[0]);
    expect(ipc.some((m) => m.action === "pause" && m.hash === HASH_HEX)).to.equal(true);
  });

  it("accepts X-BT-Token header for mutations", async () => {
    const { handler, child } = await loadHandler();
    const token = apiToken(await (await handler(new Request(`bt://${HASH_HEX}/`))).text());
    const url = apiQuery({ api: "pause", hash: HASH_HEX });
    const res = await handler(new Request(url, { method: "POST", headers: { "X-BT-Token": token } }));
    expect(res.status).to.equal(200);
    const ipc = child.send.getCalls().map((c) => c.args[0]);
    expect(ipc.some((m) => m.action === "pause" && m.hash === HASH_HEX)).to.equal(true);
  });

  it("status is 404 until worker pushes a status-update, then reads from cache", async () => {
    const { handler, child } = await loadHandler();
    const st = apiQuery({ api: "status", hash: HASH_HEX });
    expect((await handler(new Request(st))).status).to.equal(404);

    child.emit("message", {
      type: "status-update",
      infoHash: HASH_HEX,
      name: "Fixture",
      progress: 0.5,
      downloaded: 100,
      uploaded: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0,
      done: false,
      paused: false,
      files: [],
      magnetURI: MAGNET,
      downloadPath: "/tmp",
    });

    const res = await handler(new Request(st));
    expect(res.status).to.equal(200);
    const data = await jsonBody(res);
    expect(data.name).to.equal("Fixture");
    expect(data.infoHash).to.equal(HASH_HEX);
    expect(data).to.not.have.property("type");
  });

  it("list returns cached torrents sorted by name then infoHash", async () => {
    const { handler, child } = await loadHandler();
    child.emit("message", { type: "status-update", infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "zeta", files: [] });
    child.emit("message", { type: "status-update", infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "alpha", files: [] });
    child.emit("message", { type: "status-update", infoHash: "9999999999999999999999999999999999999999", name: "alpha", files: [] });

    const res = await handler(new Request(apiQuery({ api: "list" })));
    expect(res.status).to.equal(200);
    const body = await jsonBody(res);
    expect(body.torrents.map((t) => t.infoHash)).to.deep.equal([
      "9999999999999999999999999999999999999999",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });

  it("token endpoint mints a token usable for a mutation", async () => {
    const { handler } = await loadHandler();
    const tokenRes = await handler(new Request(apiQuery({ api: "token" })));
    expect(tokenRes.status).to.equal(200);
    const tokenBody = await jsonBody(tokenRes);
    expect(tokenBody.token).to.be.a("string").with.lengthOf(48);

    const start = apiQuery({ api: "start", magnet: encodeURIComponent(MAGNET) });
    const startRes = await handler(new Request(start, { method: "POST", headers: { "X-BT-Token": tokenBody.token } }));
    expect(startRes.status).to.equal(200);
  });

  it("start merges custom tr= with defaults and returns success", async () => {
    const { handler, child } = await loadHandler();
    const token = apiToken(await (await handler(new Request(`bt://${HASH_HEX}/`))).text());
    const magnet = `${MAGNET}&tr=${encodeURIComponent("udp://tracker.example.com:6969/announce")}`;
    const url = apiQuery({ api: "start", magnet: encodeURIComponent(magnet) });
    const res = await handler(new Request(url, { method: "POST", headers: { "X-BT-Token": token } }));
    expect(res.status).to.equal(200);
    const body = await jsonBody(res);
    expect(body.success).to.equal(true);
    expect(body.infoHash).to.equal(HASH_HEX);

    const start = child.send.getCalls().map((c) => c.args[0]).find((m) => m.action === "start");
    expect(start.announce.length).to.be.greaterThan(0);
    expect(start.announce.join(",")).to.include("tracker.example.com");
    const defaults = JSON.parse(fs.readFileSync(TRACKERS_JSON, "utf8"));
    for (const tr of defaults) {
      expect(start.announce).to.include(tr);
    }
  });

  it("seed hits the worker with action seed", async () => {
    const { handler, child } = await loadHandler();
    const token = apiToken(await (await handler(new Request(`bt://${HASH_HEX}/`))).text());
    const url = apiQuery({ api: "seed", magnet: encodeURIComponent(MAGNET), hash: HASH_HEX });
    const res = await handler(new Request(url, { method: "POST", headers: { "X-BT-Token": token } }));
    expect(res.status).to.equal(200);
    expect((await jsonBody(res)).mode).to.equal("seed");
    const seed = child.send.getCalls().map((c) => c.args[0]).find((m) => m.action === "seed");
    expect(seed.magnetUri).to.include("urn:btih");
  });

  it("stop and unseed dispatch their worker actions", async () => {
    const { handler, child } = await loadHandler();
    const token = apiToken(await (await handler(new Request(`bt://${HASH_HEX}/`))).text());

    const stopRes = await handler(new Request(apiQuery({ api: "stop", hash: HASH_HEX }), { method: "POST", headers: { "X-BT-Token": token } }));
    expect(stopRes.status).to.equal(200);
    expect((await jsonBody(stopRes)).stopped).to.equal(true);

    const unseedRes = await handler(new Request(apiQuery({ api: "unseed", hash: HASH_HEX }), { method: "POST", headers: { "X-BT-Token": token } }));
    expect(unseedRes.status).to.equal(200);
    expect((await jsonBody(unseedRes)).mode).to.equal("download");

    const actions = child.send.getCalls().map((c) => c.args[0].action);
    expect(actions).to.include("stop");
    expect(actions).to.include("unseed");
  });

  it("bt://hash/path streams a file when cache lists it and bytes exist on disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peersky-bt-serve-"));
    const rel = "readme.txt";
    fs.writeFileSync(path.join(dir, rel), "hello-bt-file", "utf8");

    try {
      const { handler, child } = await loadHandler({ downloadsDir: dir });
      child.emit("message", {
        type: "status-update",
        infoHash: HASH_HEX,
        name: "T",
        downloadPath: dir,
        progress: 1,
        downloaded: 10,
        uploaded: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        done: true,
        paused: false,
        files: [{ index: 0, name: rel, path: rel, length: 14, downloaded: 14, progress: 1 }],
        magnetURI: MAGNET,
      });

      const res = await handler(new Request(`bt://${HASH_HEX}/${rel}`));
      expect(res.status).to.equal(200);
      expect(await res.text()).to.equal("hello-bt-file");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects path segments that escape the torrent root (../ after normalize)", async () => {
    const { handler, child } = await loadHandler();
    child.emit("message", {
      type: "status-update",
      infoHash: HASH_HEX,
      downloadPath: "/tmp",
      files: [{ index: 0, name: "x", path: "x", length: 1, downloaded: 0, progress: 0 }],
      magnetURI: MAGNET,
    });
    const res = await handler(new Request(`bt://${HASH_HEX}/%2E%2E%2Fsecret`));
    expect(res.status).to.equal(400);
    expect(await res.text()).to.include("Invalid torrent file path");
  });

  it("resume + worker miss re-adds a download via start from cached magnet", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peersky-bt-resume-dl-"));
    try {
      let resumes = 0;
      const { handler, child } = await loadHandler({
        replyAs(proc) {
          return (msg) => {
            const { id, action } = msg;
            if (!id) return;
            if (action === "resume") {
              resumes += 1;
              proc.emit("message", { id, error: "Torrent not found" });
              return;
            }
            if (action === "start") {
              proc.emit("message", {
                id,
                type: "started",
                infoHash: HASH_HEX,
                magnetURI: decodeURIComponent(msg.magnetUri),
              });
              return;
            }
            defaultWorkerReplies(proc)(msg);
          };
        },
      });

      child.emit("message", {
        type: "status-update",
        infoHash: HASH_HEX,
        mode: "download",
        magnetURI: MAGNET,
        downloadPath: dir,
        done: false,
        paused: true,
        files: [],
        progress: 0,
        downloaded: 0,
        uploaded: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
      });

      const token = apiToken(await (await handler(new Request(`bt://${HASH_HEX}/`))).text());
      const res = await handler(new Request(apiQuery({ api: "resume", hash: HASH_HEX }), { method: "POST", headers: { "X-BT-Token": token } }));
      expect(res.status).to.equal(200);
      expect((await jsonBody(res)).success).to.equal(true);
      expect(resumes).to.equal(1);
      const actions = child.send.getCalls().map((c) => c.args[0].action);
      expect(actions).to.include.members(["resume", "start"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resume + worker miss re-adds seeding via seed from cached magnet when mode was seed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peersky-bt-resume-seed-"));
    try {
      let resumes = 0;
      const { handler, child } = await loadHandler({
        replyAs(proc) {
          return (msg) => {
            const { id, action } = msg;
            if (!id) return;
            if (action === "resume") {
              resumes += 1;
              proc.emit("message", { id, error: "Torrent not found" });
              return;
            }
            if (action === "seed") {
              proc.emit("message", {
                id,
                type: "started",
                infoHash: HASH_HEX,
                magnetURI: decodeURIComponent(msg.magnetUri),
                mode: "seed",
              });
              return;
            }
            defaultWorkerReplies(proc)(msg);
          };
        },
      });

      child.emit("message", {
        type: "status-update",
        infoHash: HASH_HEX,
        mode: "seed",
        magnetURI: MAGNET,
        downloadPath: dir,
        done: true,
        paused: true,
        files: [],
        progress: 1,
        downloaded: 100,
        uploaded: 10,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
      });

      const token = apiToken(await (await handler(new Request(`bt://${HASH_HEX}/`))).text());
      const res = await handler(new Request(apiQuery({ api: "resume", hash: HASH_HEX }), { method: "POST", headers: { "X-BT-Token": token } }));
      expect(res.status).to.equal(200);
      expect(resumes).to.equal(1);
      const actions = child.send.getCalls().map((c) => c.args[0].action);
      expect(actions).to.include.members(["resume", "seed"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resume calls worker resume only when torrent exists (no start)", async () => {
    const { handler, child } = await loadHandler();
    child.emit("message", {
      type: "status-update",
      infoHash: HASH_HEX,
      magnetURI: MAGNET,
      downloadPath: "/tmp",
      paused: true,
      done: false,
      progress: 0.4,
      downloaded: 100,
      uploaded: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0,
      files: [],
    });
    const token = apiToken(await (await handler(new Request(`bt://${HASH_HEX}/`))).text());
    const res = await handler(
      new Request(apiQuery({ api: "resume", hash: HASH_HEX }), { method: "POST", headers: { "X-BT-Token": token } }),
    );
    expect(res.status).to.equal(200);
    expect(await jsonBody(res)).to.deep.include({ success: true, paused: false });
    const actions = child.send.getCalls().map((c) => c.args[0].action);
    expect(actions.filter((a) => a === "resume").length).to.equal(1);
    expect(actions).to.not.include("start");

    // The handler doesn't flip cache.paused on resume; it reflects the next worker status update.
    const cachedBeforeUpdate = await jsonBody(await handler(new Request(apiQuery({ api: "status", hash: HASH_HEX }))));
    expect(cachedBeforeUpdate.paused).to.equal(true);

    child.emit("message", {
      type: "status-update",
      infoHash: HASH_HEX,
      magnetURI: MAGNET,
      downloadPath: "/tmp",
      paused: false,
      done: false,
      progress: 0.4,
      downloaded: 100,
      uploaded: 0,
      downloadSpeed: 1024,
      uploadSpeed: 0,
      numPeers: 2,
      files: [],
    });
    const st = await jsonBody(await handler(new Request(apiQuery({ api: "status", hash: HASH_HEX }))));
    expect(st.paused).to.equal(false);
  });

  it("worker done bumps cache to done with speeds cleared", async () => {
    const { handler, child } = await loadHandler();
    child.emit("message", {
      type: "status-update",
      infoHash: HASH_HEX,
      name: "DoneSoon",
      magnetURI: MAGNET,
      downloadPath: "/tmp",
      paused: false,
      done: false,
      progress: 0.99,
      downloaded: 999,
      uploaded: 0,
      downloadSpeed: 5000,
      uploadSpeed: 0,
      numPeers: 3,
      files: [],
    });
    child.emit("message", { type: "done", infoHash: HASH_HEX });
    const st = await jsonBody(await handler(new Request(apiQuery({ api: "status", hash: HASH_HEX }))));
    expect(st.done).to.equal(true);
    expect(st.downloadSpeed).to.equal(0);
    expect(st.uploadSpeed).to.equal(0);
  });

  it("status passes through seeding fields from worker updates", async () => {
    const { handler, child } = await loadHandler();
    child.emit("message", {
      type: "status-update",
      infoHash: HASH_HEX,
      name: "SeedBox",
      magnetURI: MAGNET,
      downloadPath: "/tmp",
      mode: "seed",
      isSeeding: true,
      paused: false,
      done: true,
      progress: 1,
      downloaded: 1000,
      uploaded: 400,
      downloadSpeed: 0,
      uploadSpeed: 8192,
      numPeers: 5,
      seedingSince: Date.now() - 5000,
      files: [],
    });
    const st = await jsonBody(await handler(new Request(apiQuery({ api: "status", hash: HASH_HEX }))));
    expect(st.mode).to.equal("seed");
    expect(st.isSeeding).to.equal(true);
    expect(st.uploadSpeed).to.be.above(0);
  });

  it("stop clears speeds and flags in cached status", async () => {
    const { handler, child } = await loadHandler();
    child.emit("message", {
      type: "status-update",
      infoHash: HASH_HEX,
      magnetURI: MAGNET,
      downloadPath: "/tmp",
      paused: false,
      stopped: false,
      done: false,
      progress: 0.5,
      downloaded: 50,
      uploaded: 0,
      downloadSpeed: 3000,
      uploadSpeed: 0,
      numPeers: 4,
      files: [],
    });
    const token = apiToken(await (await handler(new Request(`bt://${HASH_HEX}/`))).text());
    const stopRes = await handler(
      new Request(apiQuery({ api: "stop", hash: HASH_HEX }), { method: "POST", headers: { "X-BT-Token": token } }),
    );
    expect(stopRes.status).to.equal(200);

    const st = await jsonBody(await handler(new Request(apiQuery({ api: "status", hash: HASH_HEX }))));
    expect(st.stopped).to.equal(true);
    expect(st.paused).to.equal(true);
    expect(st.isSeeding).to.equal(false);
    expect(st.downloadSpeed).to.equal(0);
    expect(st.uploadSpeed).to.equal(0);
    expect(st.numPeers).to.equal(0);
  });

  it("unseed zeros upload and marks cache as download + paused", async () => {
    const { handler, child } = await loadHandler();
    child.emit("message", {
      type: "status-update",
      infoHash: HASH_HEX,
      magnetURI: MAGNET,
      downloadPath: "/tmp",
      mode: "seed",
      isSeeding: true,
      paused: false,
      done: true,
      progress: 1,
      downloaded: 100,
      uploaded: 50,
      downloadSpeed: 0,
      uploadSpeed: 16000,
      numPeers: 8,
      files: [],
    });
    const token = apiToken(await (await handler(new Request(`bt://${HASH_HEX}/`))).text());
    const unseedRes = await handler(
      new Request(apiQuery({ api: "unseed", hash: HASH_HEX }), { method: "POST", headers: { "X-BT-Token": token } }),
    );
    expect(unseedRes.status).to.equal(200);

    const st = await jsonBody(await handler(new Request(apiQuery({ api: "status", hash: HASH_HEX }))));
    expect(st.mode).to.equal("download");
    expect(st.isSeeding).to.equal(false);
    expect(st.paused).to.equal(true);
    expect(st.uploadSpeed).to.equal(0);
    expect(st.numPeers).to.equal(0);
  });

  it("remove drops torrent data from disk when cache has a named folder", async () => {
    const dd = fs.mkdtempSync(path.join(os.tmpdir(), "peersky-bt-rm-"));
    const tname = "RmTorFolder";
    fs.mkdirSync(path.join(dd, tname), { recursive: true });
    fs.writeFileSync(path.join(dd, tname, "keep-me.txt"), "data", "utf8");

    try {
      const { handler, child } = await loadHandler({ downloadsDir: dd });
      child.emit("message", {
        type: "status-update",
        infoHash: HASH_HEX,
        name: tname,
        magnetURI: MAGNET,
        downloadPath: dd,
        paused: true,
        done: true,
        progress: 1,
        downloaded: 4,
        uploaded: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        files: [{ index: 0, name: "keep-me.txt", path: "keep-me.txt", length: 4, downloaded: 4, progress: 1 }],
      });

      const token = apiToken(await (await handler(new Request(`bt://${HASH_HEX}/`))).text());
      const rmRes = await handler(
        new Request(apiQuery({ api: "remove", hash: HASH_HEX }), { method: "POST", headers: { "X-BT-Token": token } }),
      );
      expect(rmRes.status).to.equal(200);
      expect((await jsonBody(rmRes)).removed).to.equal(true);

      expect(fs.existsSync(path.join(dd, tname))).to.equal(false);
      expect((await handler(new Request(apiQuery({ api: "status", hash: HASH_HEX })))).status).to.equal(404);
    } finally {
      fs.rmSync(dd, { recursive: true, force: true });
    }
  });

  it("resume from cache returns 409 when another torrent is actively seeding", async () => {
    const { handler, child } = await loadHandler({
      replyAs(proc) {
        return (msg) => {
          if (msg.id && msg.action === "resume") {
            proc.emit("message", { id: msg.id, error: "Torrent not found" });
            return;
          }
          defaultWorkerReplies(proc)(msg);
        };
      },
    });

    child.emit("message", {
      type: "status-update",
      infoHash: HASH_HEX,
      mode: "download",
      magnetURI: MAGNET,
      paused: true,
      files: [],
    });
    child.emit("message", {
      type: "status-update",
      infoHash: "1111111111111111111111111111111111111111",
      mode: "seed",
      isSeeding: true,
      paused: false,
      files: [],
    });

    const token = apiToken(await (await handler(new Request(`bt://${HASH_HEX}/`))).text());
    const res = await handler(
      new Request(apiQuery({ api: "resume", hash: HASH_HEX }), { method: "POST", headers: { "X-BT-Token": token } }),
    );
    expect(res.status).to.equal(409);
    expect((await jsonBody(res)).error).to.include("Cannot resume while another torrent is actively seeding");
  });

  it("base32 btih in hostname still renders a magnet link in the UI", async () => {
    const b32 = "YNKEUYQYHGNZBULYSH6QUYSTMFPUVV52";
    const { handler } = await loadHandler();
    const html = await (await handler(new Request(`bt://${b32}/`))).text();
    expect(html).to.include("magnet:?xt=urn:btih:");
  });
});

describe("BitTorrent worker lifecycle", function () {
  this.timeout(20000);

  function fakeWebTorrentModuleSource() {
    return `
import { EventEmitter } from "events";

function btihFromMagnet(uri) {
  const m = String(uri).match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return m ? m[1].toLowerCase() : "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
}

class FakeTorrent extends EventEmitter {
  constructor(magnetURI) {
    super();
    this.magnetURI = magnetURI;
    this.infoHash = btihFromMagnet(magnetURI);
    this.name = "FakeTorrent";
    this.length = 1024 * 1024;
    this.files = [{ name: "file.txt", path: "file.txt", length: 3, downloaded: 0, progress: 0 }];
    this.wires = [];
    this.pieces = [0];
    this.progress = 0.5;
    this.downloaded = 1;
    this.uploaded = 0;
    this.downloadSpeed = 1234;
    this.uploadSpeed = 0;
    this.ratio = 0;
    this.numPeers = 0;
    this.timeRemaining = 0;
    this.done = false;
    this.paused = false;
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }
  deselect() {}

  destroy(_opts, cb) {
    if (process.send) process.send({ type: "fake-destroy", infoHash: this.infoHash });
    if (typeof cb === "function") cb();
  }
}

export default class FakeWebTorrent extends EventEmitter {
  constructor() {
    super();
    this.torrents = [];
  }

  async get(hash) {
    return this.torrents.find((t) => t.infoHash === hash) || null;
  }

  add(magnetURI) {
    const t = new FakeTorrent(magnetURI);
    this.torrents.push(t);

    queueMicrotask(() => {
      // Complete after worker attaches listeners.
      t.done = true;
      t.progress = 1;
      t.downloadSpeed = 0;
      t.emit("done");
    });

    return t;
  }

  destroy(cb) {
    this.torrents = [];
    if (typeof cb === "function") cb();
  }
}
`;
  }

  async function withTempWorker(run) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peersky-bt-worker-test-"));
    const dl = fs.mkdtempSync(path.join(os.tmpdir(), "peersky-bt-worker-dl-"));

    const workerSrcPath = path.join(_testDir, "../../src/protocols/bt/worker.js");
    const workerOutPath = path.join(tmp, "worker.js");
    fs.writeFileSync(workerOutPath, fs.readFileSync(workerSrcPath, "utf8"), "utf8");

    const nm = path.join(tmp, "node_modules", "webtorrent");
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(
      path.join(nm, "package.json"),
      JSON.stringify({ name: "webtorrent", version: "0.0.0", type: "module", exports: "./index.js" }, null, 2),
      "utf8",
    );
    fs.writeFileSync(path.join(nm, "index.js"), fakeWebTorrentModuleSource(), "utf8");

    const child = forkProcess(workerOutPath, [dl], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      silent: true,
    });

    try {
      await run(child);
    } finally {
      try { child.disconnect(); } catch {}
      try { child.kill("SIGTERM"); } catch {}
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(dl, { recursive: true, force: true });
    }
  }

  function waitForMessage(child, predicate, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for worker message"));
      }, timeoutMs);
      function onMsg(msg) {
        if (predicate(msg)) {
          cleanup();
          resolve(msg);
        }
      }
      function cleanup() {
        clearTimeout(timer);
        child.off("message", onMsg);
      }
      child.on("message", onMsg);
    });
  }

  it("download completion emits done and destroys torrent (no seeding)", async () => {
    await withTempWorker(async (child) => {
      await waitForMessage(child, (m) => m && m.type === "ready");

      child.send({ id: 1, action: "start", magnetUri: MAGNET, announce: [] });

      const done = await waitForMessage(child, (m) => m && m.type === "done" && m.infoHash === HASH_HEX);
      expect(done.infoHash).to.equal(HASH_HEX);

      const destroyed = await waitForMessage(child, (m) => m && m.type === "fake-destroy" && m.infoHash === HASH_HEX);
      expect(destroyed.infoHash).to.equal(HASH_HEX);
    });
  });

  it("seed completion keeps seeding and does not emit done", async () => {
    await withTempWorker(async (child) => {
      await waitForMessage(child, (m) => m && m.type === "ready");

      child.send({ id: 1, action: "seed", magnetUri: MAGNET, announce: [] });

      const status = await waitForMessage(child, (m) => m && m.type === "status-update" && m.infoHash === HASH_HEX);
      expect(status.mode).to.equal("seed");
      expect(status.isSeeding).to.equal(true);

      let sawDone = false;
      let sawDestroy = false;
      const onMsg = (m) => {
        if (m && m.type === "done") sawDone = true;
        if (m && m.type === "fake-destroy") sawDestroy = true;
      };
      child.on("message", onMsg);
      await new Promise((r) => setTimeout(r, 200));
      child.off("message", onMsg);

      expect(sawDone).to.equal(false);
      expect(sawDestroy).to.equal(false);
    });
  });
});
