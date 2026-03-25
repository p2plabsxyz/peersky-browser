import { expect } from "chai";
import sinon from "sinon";
import esmock from "esmock";

describe("Hyper protocol handler", function () {
  afterEach(function () {
    sinon.restore();
  });

  async function loadHyperModule({ fetchImpl, chatResponse, chatReject, throwOnFetch } = {}) {
    const sdk = { id: "sdk-test" };
    const createSDK = sinon.stub().resolves(sdk);

    const fetchStub = sinon.stub().callsFake(async (url, options) => {
      if (throwOnFetch) {
        throw new Error("network failed");
      }
      if (fetchImpl) {
        return fetchImpl(url, options);
      }
      return new Response("hyper-ok", { status: 200, headers: { "Content-Type": "text/plain" } });
    });

    const initChat = sinon.spy();
    const handleChatRequest = sinon.stub();
    if (chatReject) {
      handleChatRequest.rejects(new Error(chatReject));
    } else {
      handleChatRequest.resolves(
        chatResponse || new Response("chat-ok", { status: 200, headers: { "Content-Type": "text/plain" } }),
      );
    }
    const hyperFetchFactory = sinon.stub().returns(fetchStub);

    const module = await esmock("../../src/protocols/hyper-handler.js", {
      "hyper-sdk": {
        create: createSDK,
      },
      "hypercore-fetch": {
        default: hyperFetchFactory,
      },
      "../../src/pages/p2p/chat/p2p.js": {
        initChat,
        handleChatRequest,
      },
    });

    return { module, createSDK, fetchStub, hyperFetchFactory, initChat, handleChatRequest, sdk };
  }

  it("routes chat namespace to chat handler", async function () {
    const { module, handleChatRequest, sdk } = await loadHyperModule({
      chatResponse: new Response("chat-routed", { status: 200, headers: { "Content-Type": "text/plain" } }),
    });
    const handler = await module.createHandler({ storage: "test-chat" });

    const response = await handler(new Request("hyper://chat/messages", { method: "GET" }));

    expect(response.status).to.equal(200);
    expect(await response.text()).to.equal("chat-routed");
    expect(handleChatRequest.callCount).to.equal(1);
    expect(handleChatRequest.firstCall.args[1]).to.equal(sdk);
  });

  it("returns 500 response when Hyper fetch fails", async function () {
    const { module } = await loadHyperModule({ throwOnFetch: true });
    sinon.stub(console, "error");
    const handler = await module.createHandler({ storage: "test-error" });

    const response = await handler(new Request("hyper://example.org/fail", { method: "GET" }));

    expect(response.status).to.equal(500);
    const text = await response.text();
    expect(text).to.contain("network failed");
  });

  it("returns 500 response when chat handler rejects", async function () {
    const { module } = await loadHyperModule({ chatReject: "chat-crash" });
    sinon.stub(console, "error");
    const handler = await module.createHandler({ storage: "test-chat-error" });

    const response = await handler(new Request("hyper://chat/messages", { method: "GET" }));

    expect(response.status).to.equal(500);
    const text = await response.text();
    expect(text).to.contain("chat-crash");
  });

  it("blocks extension-origin writes when no explicit write permission is granted", async function () {
    const { module, fetchStub } = await loadHyperModule();
    const handler = await module.createHandler(
      { storage: "test-write-deny" },
      { isExtensionWriteAllowed: () => false },
    );

    const response = await handler({
      url: "hyper://example.org/write.txt",
      method: "PUT",
      headers: new Headers({
        referer: "chrome-extension://ext-denied/probe.html",
      }),
      body: Buffer.from("write"),
    });

    expect(response.status).to.equal(403);
    expect(fetchStub.called).to.equal(false);
    expect(await response.text()).to.contain("not allowed");
  });

  it("allows extension-origin writes when explicit permission is granted", async function () {
    const { module, fetchStub } = await loadHyperModule();
    const permissionCheck = sinon.stub().resolves(true);
    const handler = await module.createHandler(
      { storage: "test-write-allow" },
      { isExtensionWriteAllowed: permissionCheck },
    );

    const response = await handler({
      url: "hyper://example.org/write.txt",
      method: "PUT",
      headers: new Headers({
        referer: "chrome-extension://ext-allowed/probe.html",
      }),
      body: Buffer.from("write"),
    });

    expect(response.status).to.equal(200);
    expect(fetchStub.calledOnce).to.equal(true);
    expect(permissionCheck.calledOnce).to.equal(true);
    expect(permissionCheck.firstCall.args[0]).to.include({
      extensionId: "ext-allowed",
      scheme: "hyper",
      method: "PUT",
    });
  });
});
