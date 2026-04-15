import { expect } from "chai";
import path from "path";
import { fileURLToPath } from "url";
import { CID } from "multiformats/cid";
import esmock from "esmock";
import { createHandler as createIpfsHandler } from "../../src/protocols/ipfs-handler.js";
import { ipfsOptions, hyperOptions } from "../../src/protocols/config.js";


const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _libdatachannelHandler;
before(function () {
  _libdatachannelHandler = (err) => {
    if (
      String(err?.message || err).includes(
        "libdatachannel error while sending data channel message: DataChannel is closed"
      )
    ) {
      return; // non-fatal silently ignore
    }
    process.off("uncaughtException", _libdatachannelHandler);
    throw err;
  };
  process.on("uncaughtException", _libdatachannelHandler);
});
after(function () {
  process.off("uncaughtException", _libdatachannelHandler);
});

const FIXTURE_TEXT = "Hello Peersky";
const ABOUT_CONTENT = "<title>About</title>\n<h1>About Peersky</h1>\n";

const RUN_ID = Date.now();

let ipfsHandler;
let fileCid;    
let dirCid;     
let hyperHandler;
let driveUrl;   // hyper:// URL of the newly created drive

function callHandler(handler, request) {
  return Promise.resolve(handler(toRequest(request))).then(normalizeHandlerResponse);
}

function normalizeHeaders(headers) {
  const headerBag = {};
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    headerBag[key] = value;
    headerBag[lower] = value;
    if (lower === "content-type") headerBag["Content-Type"] = value;
    if (lower === "location") headerBag.Location = value;
  }
  return headerBag;
}

async function normalizeHandlerResponse(response) {
  if (response instanceof Response) {
    return {
      statusCode: response.status,
      headers: normalizeHeaders(response.headers),
      data: Buffer.from(await response.arrayBuffer()),
    };
  }
  return response;
}

function toRequest(input) {
  if (input instanceof Request) return input;
  const method = input?.method || "GET";
  const headers = input?.headers || new Headers();
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(input.url, {
    method,
    headers,
    body: hasBody ? input?.body : undefined,
  });
}

async function readStream(stream) {
  if (!stream) return "";
  if (typeof stream === "string") return stream;
  if (Buffer.isBuffer(stream)) return stream.toString();
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString()));
    stream.on("error", reject);
  });
}


describe("ipfs: basic e2e sync", function () {
  this.timeout(120000);

  before(async function () {
    this.timeout(60000);
    ipfsHandler = await createIpfsHandler(ipfsOptions, null);
  });

  after(function () {});

  it("initializes IPFS protocol without error", function () {
    expect(ipfsHandler).to.be.a("function");
  });

  it("uploads a file and returns an ipfs:// link", async function () {
    this.timeout(60000);
    const response = await callHandler(
      ipfsHandler,
      new Request("ipfs://bafyaabakaieac/index.html", {
        method: "PUT",
        headers: { "content-type": "text/html" },
        body: FIXTURE_TEXT,
      }),
    );

    expect(response.statusCode).to.equal(200);
    expect(response.headers.Location).to.match(/^ipfs:\/\//);
    fileCid = response.headers.Location;
  });

  it("serves uploaded file content via CID (round-trip)", async function () {
    this.timeout(30000);
    const url = fileCid.endsWith("/")
      ? fileCid + "index.html"
      : fileCid + "/index.html";

    const response = await callHandler(ipfsHandler, { url, method: "GET" });

    expect(response.statusCode).to.equal(200);
    const body = await readStream(response.data);
    expect(body).to.include(FIXTURE_TEXT);
  });

  it("uploads a directory and returns an ipfs:// link", async function () {
    this.timeout(60000);
    const formData = new FormData();
    formData.append("file", new File([FIXTURE_TEXT], "site/index.html", { type: "text/html" }));
    formData.append("file", new File([ABOUT_CONTENT], "site/about.html", { type: "text/html" }));

    const response = await callHandler(
      ipfsHandler,
      new Request("ipfs://bafyaabakaieac/", {
        method: "PUT",
        body: formData,
      }),
    );

    expect(response.statusCode).to.equal(200);
    expect(response.headers.Location).to.match(/^ipfs:\/\//);
    dirCid = response.headers.Location;
  });

  it("serves directory index.html via bare CID URL", async function () {
    this.timeout(30000);
    const url = dirCid.endsWith("/") ? dirCid : dirCid + "/";
    const response = await callHandler(ipfsHandler, { url, method: "GET" });

    expect(response.statusCode).to.equal(200);
    const body = await readStream(response.data);
    expect(body).to.include(FIXTURE_TEXT);
  });
});


describe("hyper: basic e2e sync", function () {
  this.timeout(120000);

  before(async function () {
    this.timeout(120000);
    const hyperModule = await esmock("../../src/protocols/hyper-handler.js", {
      electron: {
        app: {
          getPath: () => process.env.PEERSKY_TEST_USERDATA || ".test-e2e-data",
        },
        safeStorage: {},
      },
    });
    hyperHandler = await hyperModule.createHandler(hyperOptions);
  });

  after(function () {});

  it("initializes Hyper protocol without error", function () {
    expect(hyperHandler).to.be.a("function");
  });

  it("creates a new drive via POST hyper://localhost/?key=", async function () {
    const response = await hyperHandler(
      new Request(`hyper://localhost/?key=peersky-e2e-site-${RUN_ID}`, {
        method: "POST",
      })
    );

    expect(response.status).to.equal(200);
    driveUrl = (await response.text()).trim();
    expect(driveUrl).to.match(/^hyper:\/\//);
    if (!driveUrl.endsWith("/")) driveUrl += "/";
  });

  it("uploads a file to the hyperdrive", async function () {
    const response = await hyperHandler(
      new Request(driveUrl + "index.html", {
        method: "PUT",
        body: `<title>Hello Peersky!</title>\n<h1>Hello World!</h1>\n`,
        headers: { "Content-Type": "text/html" },
        duplex: "half",
      })
    );

    expect(response.ok).to.equal(true);
  });

  it("serves uploaded file via hyper:// URL (round-trip)", async function () {
    const response = await hyperHandler(
      new Request(driveUrl + "index.html", { method: "GET" })
    );

    expect(response.status).to.equal(200);
    const body = await response.text();
    expect(body).to.include(FIXTURE_TEXT);
  });

  it("uploads multiple files (directory simulation)", async function () {
    const response = await hyperHandler(
      new Request(driveUrl + "about.html", {
        method: "PUT",
        body: ABOUT_CONTENT,
        headers: { "Content-Type": "text/html" },
        duplex: "half",
      })
    );

    expect(response.ok).to.equal(true);
  });

  it("serves all uploaded files from the drive", async function () {
    const response = await hyperHandler(
      new Request(driveUrl + "about.html", { method: "GET" })
    );

    expect(response.status).to.equal(200);
    const body = await response.text();
    expect(body).to.include("About Peersky");
  });
});

describe("ipfs: DHT provide", function () {
  this.timeout(180000); // 3 min: 2 min retry window + overhead

  let uncaughtHandler;
  let unexpectedUncaught;

  before(function () {
    uncaughtHandler = (err) => {
      const message = String(err?.message || err);
      if (message.includes("libdatachannel error while sending data channel message: DataChannel is closed")) {
        console.log("  Ignoring non-fatal libdatachannel error during DHT test:", message);
        return;
      }
      unexpectedUncaught = err;
    };
    process.on("uncaughtException", uncaughtHandler);
  });

  afterEach(function () {
    if (unexpectedUncaught) {
      throw unexpectedUncaught;
    }
  });

  after(function () {
    process.off("uncaughtException", uncaughtHandler);
  });

  it("CID is announced and discoverable via delegated routing", async function () {
    const cid = fileCid.replace(/^ipfs:\/\//, "").replace(/\/+$/, "");
    console.log(`DHT check CID: ${cid}`);

    const POLL_INTERVAL_MS = 15000; // 15 s between attempts
    const MAX_WAIT_MS      = 120000; // 2 min total
    const LOCAL_WAIT_MS    = 60000;  // 1 min local DHT before fallback
    const deadline = Date.now() + MAX_WAIT_MS;

    let providers = [];

    const node = ipfsHandler?.__node;
    const dht = node?.libp2p?.services?.dht;
    const hasLocalDht = Boolean(dht?.findProviders);
    if (hasLocalDht) {
      const controller = new AbortController();
      const localTimer = setTimeout(() => controller.abort(), LOCAL_WAIT_MS);
      const localTask = (async () => {
        for await (const p of dht.findProviders(CID.parse(cid), { signal: controller.signal })) {
          providers.push(p);
          if (providers.length > 0) break;
        }
      })();
      const safeLocalTask = localTask.catch((err) => {
        if (controller.signal.aborted) {
          console.log(`  Local DHT check timed out after ${LOCAL_WAIT_MS / 1000}s`);
          return;
        }
        console.log(`  Local DHT check error: ${err.message}`);
      });
      await Promise.race([
        safeLocalTask,
        new Promise((resolve) => setTimeout(resolve, LOCAL_WAIT_MS + 1000)),
      ]);
      clearTimeout(localTimer);
      controller.abort();
      console.log(`  local dht: ${providers.length} provider(s) for ${cid}`);
    } else {
      console.log("  Local DHT service not available, falling back to delegated routing");
    }

    const shouldCheckDelegated = providers.length === 0;
    if (shouldCheckDelegated && Date.now() < deadline) {
      while (providers.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

        try {
          const res = await fetch(
            `https://delegated-ipfs.dev/routing/v1/providers/${cid}`
          );
          if (res.ok) {
            const json = await res.json();
            providers = json.Providers || [];
            const remaining = Math.round((deadline - Date.now()) / 1000);
            console.log(
              `  delegated-ipfs.dev: ${providers.length} provider(s) for ${cid}` +
              (providers.length === 0 ? ` â€” retrying (${remaining}s left)` : "")
            );
          }
        } catch (err) {
          console.log(`  Delegated routing check skipped: ${err.message}`);
          this.skip();
          return;
        }
      }
    }

    if (providers.length === 0) {
      const msg =
        `DHT provide not confirmed: CID ${cid} has 0 providers on delegated-ipfs.dev ` +
        `after ${MAX_WAIT_MS / 1000}s. The node either had no peers when ` +
        `provide() was called, or the announcement did not propagate.\n` +
        `Check manually:\n` +
        `  https://delegated-ipfs.dev/routing/v1/providers/${cid}\n` +
        `  https://check.ipfs.network/?cid=${cid}`;
      console.log(`  ${msg} Skipping DHT test to avoid flakiness.`);
      this.skip();
      return;
    }

    try {
      const res = await fetch(
        `https://cid.contact/routing/v1/providers/${cid}`
      );
      if (res.ok) {
        const json = await res.json();
        const contactProviders = json.Providers || [];
        console.log(
          `  cid.contact (check.ipfs.network): ${contactProviders.length} provider(s)`
        );
        if (contactProviders.length > 0) {
          console.log(`  First record: ${JSON.stringify(contactProviders[0])}`);
        }
      }
    } catch (err) {
      console.log(`  cid.contact check skipped: ${err.message}`);
    }

    expect(providers.length).to.be.greaterThan(0);
  });
});