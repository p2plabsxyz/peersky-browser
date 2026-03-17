import { expect } from "chai";
import sinon from "sinon";
import esmock from "esmock";
import path from "path";
import { fileURLToPath } from "url";

import { ensCache } from "../../src/protocols/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SITE_DIR = path.resolve(__dirname, "../fixtures/site");

async function readStreamBody(stream) {
  if (!stream) return "";
  if (typeof stream === "string") return stream;
  if (Buffer.isBuffer(stream)) return stream.toString();
  if (typeof stream.on !== "function") return String(stream);
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString()));
    stream.on("error", reject);
  });
}

async function callHandler(handler, request) {
  return new Promise((resolve, reject) => {
    Promise.resolve(handler(request, resolve)).catch(reject);
  });
}

function bufferStream(...chunks) {
  return (async function* () {
    for (const chunk of chunks) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
  })();
}

async function loadIpfsHandlerModule(overrides = {}) {
  const decoder = {
    or() {
      return this;
    },
  };

  class DefaultFakeCID {
    constructor(value, version = 1) {
      this.value = String(value);
      this.version = version;
    }

    toString() {
      return this.value;
    }

    toV1() {
      return new DefaultFakeCID(this.value, 1);
    }

    static parse(value) {
      return new DefaultFakeCID(value, 1);
    }
  }

  const CIDClass = overrides.CIDClass || DefaultFakeCID;

  const createNode = overrides.createNode || sinon.stub().resolves(overrides.node);
  const unixfsFactory = overrides.unixfsFactory || sinon.stub().returns(overrides.unixfs);
  const ipnsFactory = overrides.ipnsFactory || sinon.stub().returns(overrides.name);
  const dnsFactory = overrides.dnsFactory || sinon.stub().returns(overrides.dns);

  const peerIdFromString = overrides.peerIdFromString || sinon.stub().returns({});
  const peerIdFromCID = overrides.peerIdFromCID || sinon.stub().returns({});

  const contentHashApi = overrides.contentHashApi || {
    getCodec: sinon.stub().returns("ipfs-ns"),
    decode: sinon.stub().returns("bafy-default"),
  };

  const providerGetResolver = overrides.providerGetResolver || sinon.stub().resolves(null);
  const providerCtorSpy = sinon.spy();

  const module = await esmock("../../src/protocols/ipfs-handler.js", {
    "mime-types": {
      default: {
        lookup: overrides.mimeLookup || sinon.stub().returns("text/plain"),
      },
    },
    "../../src/protocols/helia/directoryListingTemplate.js": {
      directoryListingHtml: overrides.directoryListingHtml || ((p, files) => `<html>${p}:${files}</html>`),
    },
    "../../src/protocols/helia/helia.js": {
      createNode,
    },
    "@helia/unixfs": {
      unixfs: unixfsFactory,
    },
    "@helia/ipns": {
      ipns: ipnsFactory,
    },
    "@helia/dnslink": {
      dnsLink: dnsFactory,
    },
    "content-hash": {
      default: contentHashApi,
    },
    "multiformats/cid": {
      CID: CIDClass,
    },
    "multiformats/bases/base32": {
      base32: { decoder },
    },
    "multiformats/bases/base36": {
      base36: { decoder },
    },
    "multiformats/bases/base58": {
      base58btc: { decoder },
    },
    "@libp2p/peer-id": {
      peerIdFromString,
      peerIdFromCID,
    },
    "../../src/protocols/config.js": {
      ensCache,
      saveEnsCache: overrides.saveEnsCache || sinon.stub(),
      RPC_URL: overrides.rpcUrl || "http://localhost:8545",
      ipfsCache: overrides.ipfsCache || [],
      saveIpfsCache: overrides.saveIpfsCache || sinon.stub(),
    },
    ethers: {
      JsonRpcProvider: class FakeProvider {
        constructor(url) {
          providerCtorSpy(url);
        }

        async getResolver(name) {
          return providerGetResolver(name);
        }
      },
    },
  });

  return {
    module,
    createNode,
    unixfsFactory,
    ipnsFactory,
    dnsFactory,
    peerIdFromString,
    peerIdFromCID,
    contentHashApi,
    providerCtorSpy,
    providerGetResolver,
  };
}

describe("IPFS protocol handler", function () {
  afterEach(function () {
    sinon.restore();
    ensCache.clear();
  });

  it("returns upload response before background DHT provide completes", async function () {
    this.timeout(30000);
    let resolveProvide;
    const providePromise = new Promise((resolve) => {
      resolveProvide = resolve;
    });

    const node = {
      pins: { add: sinon.stub().resolves() },
      libp2p: {
        getPeers: () => ["peer-a"],
        contentRouting: { provide: sinon.stub().returns(providePromise) },
      },
    };

    const addAll = sinon.stub().callsFake(async function* () {
      yield { path: "index.html", cid: { toString: () => "bafy-nonblocking-root" } };
    });

    const { module } = await loadIpfsHandlerModule({
      node,
      unixfs: {
        addAll,
        stat: sinon.stub(),
        cat: sinon.stub(),
        ls: sinon.stub(),
      },
      name: { resolve: sinon.stub() },
      dns: { resolve: sinon.stub() },
      mimeLookup: sinon.stub().returns("text/plain"),
    });

    const session = { getBlobData: sinon.stub().resolves(Buffer.from("non-blocking")) };
    const handler = await module.createHandler({ repo: "test-ipfs-nonblocking" }, session);
    let responseReady = false;
    const responsePromise = callHandler(handler, {
      url: "ipfs://bafyaabakaieac/",
      method: "PUT",
      headers: new Headers({ "content-type": "multipart/form-data" }),
      uploadData: [
        {
          type: "rawData",
          bytes: Buffer.from(`Content-Disposition: form-data; name="file"; filename="index.html"`),
        },
        { type: "blob", blobUUID: "blob-nonblocking" },
      ],
    }).then((resp) => {
      responseReady = true;
      return resp;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(responseReady).to.equal(true);
    expect(node.libp2p.contentRouting.provide.calledOnce).to.equal(true);

    resolveProvide();
    const response = await responsePromise;
    expect(response.statusCode).to.equal(200);
  });

  it("resolves ipns:// paths and serves content", async function () {
    const stat = sinon.stub().resolves({ type: "file" });
    const cat = sinon.stub().callsFake(() => bufferStream("ipns-content"));

    const nameResolve = sinon.stub().resolves({
      cid: {
        version: 1,
        toString: () => "bafy-ipns-root",
      },
      path: "",
    });

    const { module, peerIdFromCID } = await loadIpfsHandlerModule({
      node: {
        pins: { add: sinon.stub() },
        libp2p: {
          getPeers: () => [],
          contentRouting: { provide: sinon.stub().resolves() },
        },
      },
      unixfs: {
        addAll: sinon.stub(),
        stat,
        cat,
        ls: sinon.stub(),
      },
      name: { resolve: nameResolve },
      dns: { resolve: sinon.stub() },
      peerIdFromCID: sinon.stub().returns({ toBytes: () => new Uint8Array([1]) }),
      mimeLookup: sinon.stub().returns("text/plain"),
    });

    const handler = await module.createHandler({ repo: "test-ipns" }, { getBlobData: sinon.stub() });
    const response = await callHandler(handler, { url: "ipns://k51-test-peer/docs/readme.txt" });

    expect(response.statusCode).to.equal(200);
    expect(await readStreamBody(response.data)).to.equal("ipns-content");
    expect(peerIdFromCID.called).to.equal(true);
    expect(nameResolve.called).to.equal(true);
    expect(stat.called).to.equal(true);
    expect(cat.called).to.equal(true);
  });

  it("serves directory listing when path is a directory without index.html", async function () {
    const stat = sinon.stub().resolves({ type: "directory" });
    const cat = sinon.stub().rejects(new Error("index missing"));
    const ls = sinon.stub().callsFake(async function* () {
      yield { name: "index.js" };
      yield { name: "styles.css" };
    });
    const directoryListingHtml = sinon.stub().returns("<html>dir-listing</html>");

    const { module } = await loadIpfsHandlerModule({
      node: {
        pins: { add: sinon.stub() },
        libp2p: {
          getPeers: () => [],
          contentRouting: { provide: sinon.stub().resolves() },
        },
      },
      unixfs: {
        addAll: sinon.stub(),
        stat,
        cat,
        ls,
      },
      directoryListingHtml,
      name: { resolve: sinon.stub() },
      dns: { resolve: sinon.stub() },
      mimeLookup: sinon.stub().returns("text/plain"),
    });

    const handler = await module.createHandler({ repo: "test-ipfs-directory-listing" }, { getBlobData: sinon.stub() });
    const response = await callHandler(handler, { url: "ipfs://bafy-directory-root/docs" });

    expect(response.statusCode).to.equal(200);
    expect(response.headers["Content-Type"]).to.equal("text/html");
    expect(await readStreamBody(response.data)).to.contain("dir-listing");
    expect(directoryListingHtml.calledOnce).to.equal(true);
    expect(ls.calledOnce).to.equal(true);
  });

  it("sniffs octet-stream content and serves HTML when file bytes look like HTML", async function () {
    const stat = sinon.stub().resolves({ type: "file" });
    const cat = sinon.stub().callsFake(() => bufferStream("<!doctype html><html><body>ok</body></html>"));

    const { module } = await loadIpfsHandlerModule({
      node: {
        pins: { add: sinon.stub() },
        libp2p: {
          getPeers: () => [],
          contentRouting: { provide: sinon.stub().resolves() },
        },
      },
      unixfs: {
        addAll: sinon.stub(),
        stat,
        cat,
        ls: sinon.stub(),
      },
      name: { resolve: sinon.stub() },
      dns: { resolve: sinon.stub() },
      mimeLookup: sinon.stub().returns("application/octet-stream"),
    });

    const handler = await module.createHandler({ repo: "test-ipfs-mime-sniff" }, { getBlobData: sinon.stub() });
    const response = await callHandler(handler, { url: "ipfs://bafy-html-content/no-extension" });

    expect(response.statusCode).to.equal(200);
    expect(response.headers["Content-Type"]).to.equal("text/html; charset=utf-8");
    expect(await readStreamBody(response.data)).to.contain("<html>");
  });

  it("resolves .eth names and caches content hash for repeated requests", async function () {
    ensCache.clear();

    const getContentHash = sinon.stub().resolves("ipfs://bafy-ens-root");
    const getResolver = sinon.stub().resolves({ getContentHash });

    const stat = sinon.stub().resolves({ type: "file" });
    const cat = sinon.stub().callsFake(() => bufferStream("ens-index"));

    const { module, contentHashApi, providerGetResolver } = await loadIpfsHandlerModule({
      providerGetResolver: getResolver,
      contentHashApi: {
        getCodec: sinon.stub().returns("ipfs-ns"),
        decode: sinon.stub().returns("bafy-ens-root"),
      },
      node: {
        pins: { add: sinon.stub() },
        libp2p: {
          getPeers: () => [],
          contentRouting: { provide: sinon.stub().resolves() },
        },
      },
      unixfs: {
        addAll: sinon.stub(),
        stat,
        cat,
        ls: sinon.stub(),
      },
      name: { resolve: sinon.stub() },
      dns: { resolve: sinon.stub() },
      mimeLookup: sinon.stub().returns("text/html"),
    });

    const handler = await module.createHandler({ repo: "test-ens" }, { getBlobData: sinon.stub() });

    const first = await callHandler(handler, { url: "ipfs://vitalik.eth/index.html" });
    expect(first.statusCode).to.equal(200);
    expect(await readStreamBody(first.data)).to.equal("ens-index");

    const second = await callHandler(handler, { url: "ipfs://vitalik.eth/index.html" });
    expect(second.statusCode).to.equal(200);

    expect(providerGetResolver.calledWith("vitalik.eth")).to.equal(true);
    expect(getContentHash.callCount).to.equal(1);
    expect(contentHashApi.getCodec.called).to.equal(true);
    expect(contentHashApi.decode.called).to.equal(true);
  });

  it("resolves DNS-based ipns names via dnsLink resolver", async function () {
    const stat = sinon.stub().resolves({ type: "file" });
    const cat = sinon.stub().callsFake(() => bufferStream("dnslink-content"));
    const dnsResolve = sinon.stub().resolves([
      {
        namespace: "ipfs",
        cid: {
          version: 1,
          toString: () => "bafy-dnslink-root",
          toV1() {
            return this;
          },
        },
        path: "site",
        answer: { data: "/ipfs/bafy-dnslink-root/site" },
      },
    ]);

    const { module } = await loadIpfsHandlerModule({
      peerIdFromString: sinon.stub().throws(new Error("not-a-peerid")),
      node: {
        pins: { add: sinon.stub() },
        libp2p: {
          getPeers: () => [],
          contentRouting: { provide: sinon.stub().resolves() },
        },
      },
      unixfs: {
        addAll: sinon.stub(),
        stat,
        cat,
        ls: sinon.stub(),
      },
      name: { resolve: sinon.stub() },
      dns: { resolve: dnsResolve },
      mimeLookup: sinon.stub().returns("text/plain"),
    });

    const handler = await module.createHandler({ repo: "test-ipns-dnslink" }, { getBlobData: sinon.stub() });
    const response = await callHandler(handler, { url: "ipns://example.com/docs/readme.txt" });

    expect(response.statusCode).to.equal(200);
    expect(await readStreamBody(response.data)).to.equal("dnslink-content");
    expect(dnsResolve.calledOnce).to.equal(true);
    expect(stat.calledOnce).to.equal(true);
    expect(stat.firstCall.args[1]).to.deep.equal({ path: "site/docs/readme.txt" });
    expect(cat.calledOnce).to.equal(true);
    expect(cat.firstCall.args[1]).to.deep.equal({ path: "site/docs/readme.txt" });
  });


  it("normalizes CIDv0 to CIDv1 before serving content", async function () {
    class FakeCIDWithV0 {
      constructor(v, ver = 1) { this.value = v; this.version = ver; }
      toString() { return this.value; }
      toV1() { return new FakeCIDWithV0("bafy-normalized-v1", 1); }
      static parse(v) {
        return v === "k51v0testcid"
          ? new FakeCIDWithV0(v, 0)
          : new FakeCIDWithV0(v, 1);
      }
    }

    const stat = sinon.stub().resolves({ type: "file" });
    const cat = sinon.stub().callsFake(() => bufferStream("normalized-content"));

    const { module } = await loadIpfsHandlerModule({
      CIDClass: FakeCIDWithV0,
      node: {
        pins: { add: sinon.stub() },
        libp2p: { getPeers: () => [], contentRouting: { provide: sinon.stub().resolves() } },
      },
      unixfs: { addAll: sinon.stub(), stat, cat, ls: sinon.stub() },
      name: { resolve: sinon.stub() },
      dns: { resolve: sinon.stub() },
      mimeLookup: sinon.stub().returns("text/plain"),
    });

    const handler = await module.createHandler({ repo: "test-cid-v1" }, { getBlobData: sinon.stub() });
    const response = await callHandler(handler, { url: "ipfs://k51v0testcid/file.txt" });

    expect(response.statusCode).to.equal(200);
    expect(stat.firstCall.args[0].version).to.equal(1);
    expect(stat.firstCall.args[0].toString()).to.equal("bafy-normalized-v1");
  });


  it("dispatches Qmâ€¦ (base58btc) IPNS name to peerIdFromString via ENS ipns-ns", async function () {
    const peerIdFromStringSpy = sinon.stub().returns({
      bytes: new Uint8Array([1]),
      toBytes: () => new Uint8Array([1]),
    });
    const nameResolve = sinon.stub().resolves({
      cid: { version: 1, toString: () => "bafy-qm-resolved" },
      path: "",
    });
    const stat = sinon.stub().resolves({ type: "file" });
    const cat = sinon.stub().callsFake(() => bufferStream("qm-peerId-content"));

    const { module } = await loadIpfsHandlerModule({
      providerGetResolver: sinon.stub().resolves({
        getContentHash: sinon.stub().resolves("raw-content-hash"),
      }),
      contentHashApi: {
        getCodec: sinon.stub().returns("ipns-ns"),
        decode: sinon.stub().returns("QmPeerIdBase58abc123"),
      },
      peerIdFromString: peerIdFromStringSpy,
      peerIdFromCID: sinon.stub().throws(new Error("must not call peerIdFromCID for Qm names")),
      node: {
        pins: { add: sinon.stub() },
        libp2p: { getPeers: () => [], contentRouting: { provide: sinon.stub().resolves() } },
      },
      unixfs: { addAll: sinon.stub(), stat, cat, ls: sinon.stub() },
      name: { resolve: nameResolve },
      dns: { resolve: sinon.stub() },
      mimeLookup: sinon.stub().returns("text/plain"),
    });

    const handler = await module.createHandler({ repo: "test-qm-peerId" }, { getBlobData: sinon.stub() });
    const response = await callHandler(handler, { url: "ipfs://someens.eth/page.html" });

    expect(response.statusCode).to.equal(200);
    expect(peerIdFromStringSpy.calledOnce).to.equal(true);
    expect(peerIdFromStringSpy.firstCall.args[0]).to.equal("QmPeerIdBase58abc123");
    expect(nameResolve.calledOnce).to.equal(true);
  });

  it("dispatches bafz... (base32-encoded) CID-based PeerId to peerIdFromCID", async function () {
    const peerIdFromCIDSpy = sinon.stub().returns({
      bytes: new Uint8Array([2]),
      toBytes: () => new Uint8Array([2]),
    });
    const nameResolve = sinon.stub().resolves({
      cid: { version: 1, toString: () => "bafy-resolved-from-cid-peer" },
      path: "",
    });
    const stat = sinon.stub().resolves({ type: "file" });
    const cat = sinon.stub().callsFake(() => bufferStream("cid-encoded-peer-content"));

    const { module } = await loadIpfsHandlerModule({
      providerGetResolver: sinon.stub().resolves({
        getContentHash: sinon.stub().resolves("raw-encoded-peer-hash"),
      }),
      contentHashApi: {
        getCodec: sinon.stub().returns("ipns-ns"),
        decode: sinon.stub().returns("bafzaaciae5ae5ae5ae5ae5ae5ae5"), // base32-encoded CID PeerId
      },
      peerIdFromCID: peerIdFromCIDSpy,
      peerIdFromString: sinon.stub().throws(new Error("must not call peerIdFromString for CID")),
      node: {
        pins: { add: sinon.stub() },
        libp2p: { getPeers: () => [], contentRouting: { provide: sinon.stub().resolves() } },
      },
      unixfs: { addAll: sinon.stub(), stat, cat, ls: sinon.stub() },
      name: { resolve: nameResolve },
      dns: { resolve: sinon.stub() },
      mimeLookup: sinon.stub().returns("text/plain"),
    });

    const handler = await module.createHandler({ repo: "test-cid-peer" }, { getBlobData: sinon.stub() });
    const response = await callHandler(handler, { url: "ipfs://example.eth/page.txt" });

    expect(response.statusCode).to.equal(200);
    expect(peerIdFromCIDSpy.calledOnce).to.equal(true, "peerIdFromCID must be called for base32 CID PeerId");
    expect(nameResolve.calledOnce).to.equal(true);
  });


  it("routes ENS ipns-ns content hash to IPNS name resolution", async function () {
    const nameResolve = sinon.stub().resolves({
      cid: { version: 1, toString: () => "bafy-ipns-resolved" },
      path: "",
    });
    const stat = sinon.stub().resolves({ type: "file" });
    const cat = sinon.stub().callsFake(() => bufferStream("ipns-ens-content"));

    const { module } = await loadIpfsHandlerModule({
      providerGetResolver: sinon.stub().resolves({
        getContentHash: sinon.stub().resolves("raw-ipns-hash"),
      }),
      contentHashApi: {
        getCodec: sinon.stub().returns("ipns-ns"),
        decode: sinon.stub().returns("k51ipnsname"),
      },
      peerIdFromCID: sinon.stub().returns({
        bytes: new Uint8Array([2]),
        toBytes: () => new Uint8Array([2]),
      }),
      node: {
        pins: { add: sinon.stub() },
        libp2p: { getPeers: () => [], contentRouting: { provide: sinon.stub().resolves() } },
      },
      unixfs: { addAll: sinon.stub(), stat, cat, ls: sinon.stub() },
      name: { resolve: nameResolve },
      dns: { resolve: sinon.stub() },
      mimeLookup: sinon.stub().returns("text/html"),
    });

    const handler = await module.createHandler({ repo: "test-ens-ipns" }, { getBlobData: sinon.stub() });
    const response = await callHandler(handler, { url: "ipfs://example.eth/page.html" });

    expect(response.statusCode).to.equal(200);
    expect(nameResolve.calledOnce).to.equal(true, "ipns-ns must trigger name.resolve()");
    expect(await readStreamBody(response.data)).to.equal("ipns-ens-content");
  });

  it("falls back to URI-prefix detection when content-hash library throws", async function () {
    const stat = sinon.stub().resolves({ type: "file" });
    const cat = sinon.stub().callsFake(() => bufferStream("fallback-content"));

    const { module } = await loadIpfsHandlerModule({
      providerGetResolver: sinon.stub().resolves({
        getContentHash: sinon.stub().resolves("ipfs://bafy-uri-fallback/"),
      }),
      contentHashApi: {
        getCodec: sinon.stub().throws(new Error("unrecognized hash format")),
        decode: sinon.stub().throws(new Error("unrecognized hash format")),
      },
      node: {
        pins: { add: sinon.stub() },
        libp2p: { getPeers: () => [], contentRouting: { provide: sinon.stub().resolves() } },
      },
      unixfs: { addAll: sinon.stub(), stat, cat, ls: sinon.stub() },
      name: { resolve: sinon.stub() },
      dns: { resolve: sinon.stub() },
      mimeLookup: sinon.stub().returns("text/plain"),
    });

    const handler = await module.createHandler({ repo: "test-ens-fallback" }, { getBlobData: sinon.stub() });
    const response = await callHandler(handler, { url: "ipfs://fallback.eth/doc.txt" });

    expect(response.statusCode).to.equal(200);
    expect(stat.calledOnce).to.equal(true);
    expect(stat.firstCall.args[0].toString()).to.satisfy(
      (v) => v.startsWith("bafy-uri-fallback"),
      "stat() must receive the CID extracted from the ipfs:// URI"
    );
    expect(await readStreamBody(response.data)).to.equal("fallback-content");
  });


  it("labels a single-file upload with the filename", async function () {
    const ipfsCache = [];
    const saveIpfsCache = sinon.stub();

    const addAll = sinon.stub().callsFake(async function* () {
      yield { path: "report.pdf", cid: { toString: () => "bafy-single-file" } };
    });

    const { module } = await loadIpfsHandlerModule({
      ipfsCache,
      saveIpfsCache,
      node: {
        pins: { add: sinon.stub() },
        libp2p: { getPeers: () => [], contentRouting: { provide: sinon.stub().resolves() } },
      },
      unixfs: { addAll, stat: sinon.stub(), cat: sinon.stub(), ls: sinon.stub() },
      name: { resolve: sinon.stub() },
      dns: { resolve: sinon.stub() },
    });

    const session = { getBlobData: sinon.stub().resolves(Buffer.from("pdf-bytes")) };
    const handler = await module.createHandler({ repo: "test-naming-single" }, session);

    await callHandler(handler, {
      url: "ipfs://bafyaabakaieac/",
      method: "PUT",
      headers: new Headers({ "content-type": "multipart/form-data" }),
      uploadData: [
        {
          type: "rawData",
          bytes: Buffer.from('Content-Disposition: form-data; name="file"; filename="report.pdf"'),
        },
        { type: "blob", blobUUID: "blob-report" },
      ],
    });

    expect(ipfsCache.length).to.equal(1);
    expect(ipfsCache[0].name).to.equal("report.pdf");
    expect(saveIpfsCache.calledOnce).to.equal(true);
  });

  it("labels a directory upload with the folder name", async function () {
    const ipfsCache = [];
    const saveIpfsCache = sinon.stub();

    const addAll = sinon.stub().callsFake(async function* () {
      yield { path: "index.html", cid: { toString: () => "bafy-dir-index" } };
      yield { path: "",           cid: { toString: () => "bafy-dir-root"  } };
    });

    const { module } = await loadIpfsHandlerModule({
      ipfsCache,
      saveIpfsCache,
      node: {
        pins: { add: sinon.stub() },
        libp2p: { getPeers: () => [], contentRouting: { provide: sinon.stub().resolves() } },
      },
      unixfs: { addAll, stat: sinon.stub(), cat: sinon.stub(), ls: sinon.stub() },
      name: { resolve: sinon.stub() },
      dns: { resolve: sinon.stub() },
    });

    const handler = await module.createHandler({ repo: "test-naming-dir" }, { getBlobData: sinon.stub() });

    await callHandler(handler, {
      url: "ipfs://bafyaabakaieac/",
      method: "PUT",
      uploadData: [{ type: "file", file: FIXTURE_SITE_DIR }],
      headers: new Headers(),
    });

    expect(ipfsCache.length).to.equal(1);
    expect(ipfsCache[0].name).to.equal("site");
    expect(saveIpfsCache.calledOnce).to.equal(true);
  });
});
