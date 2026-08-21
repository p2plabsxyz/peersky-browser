import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'
import { EventEmitter } from 'events'

describe('Hyper protocol handler', function () {
  afterEach(function () {
    sinon.restore()
  })

  async function loadHyperModule ({ fetchImpl, chatResponse, chatReject, throwOnFetch, lanReject, lanAttachResults, currentIP = '127.0.0.1' } = {}) {
    const sdk = { id: 'sdk-test', suspend: sinon.stub().resolves(), resume: sinon.stub().resolves() }
    const createSDK = sinon.stub().resolves(sdk)

    const lanMock = new EventEmitter()
    lanMock.id = 'lan-test'
    lanMock.host = '127.0.0.1'
    lanMock.port = 49799
    lanMock.destroyed = false
    lanMock.destroy = sinon.stub().callsFake(async () => {
      lanMock.destroyed = true
    })

    const attachHyperSDK = sinon.stub()
    if (lanAttachResults) {
      for (const [index, result] of lanAttachResults.entries()) {
        if (result instanceof Error) attachHyperSDK.onCall(index).rejects(result)
        else attachHyperSDK.onCall(index).resolves(result)
      }
    } else if (lanReject) {
      attachHyperSDK.rejects(new Error('LAN bind failed'))
    } else {
      attachHyperSDK.resolves(lanMock)
    }

    const fetchStub = sinon.stub().callsFake(async (url, options) => {
      if (throwOnFetch) {
        throw new Error('network failed')
      }
      if (fetchImpl) {
        return fetchImpl(url, options)
      }
      return new Response('hyper-ok', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    })

    const initChat = sinon.spy()
    const handleChatRequest = sinon.stub()
    if (chatReject) {
      handleChatRequest.rejects(new Error(chatReject))
    } else {
      handleChatRequest.resolves(
        chatResponse || new Response('chat-ok', { status: 200, headers: { 'Content-Type': 'text/plain' } })
      )
    }
    const hyperFetchFactory = sinon.stub().returns(fetchStub)

    const module = await esmock('../../src/protocols/hyper-handler.js', {
      electron: {
        app: {
          getPath: () => 'test-userdata'
        },
        safeStorage: {}
      },
      'hyper-sdk': {
        create: createSDK
      },
      'hyperdht-mdns': {
        default: {
          attachHyperSDK,
          selectLocalIPv4: sinon.stub().returns(currentIP)
        }
      },
      'hypercore-fetch': {
        default: hyperFetchFactory
      },
      '../../src/pages/p2p/peerchat/p2p.js': {
        initChat,
        handleChatRequest,
        CHAT_STORAGE: 'test-chat-store'
      }
    })

    return { module, createSDK, attachHyperSDK, fetchStub, hyperFetchFactory, initChat, handleChatRequest, lanMock, sdk }
  }

  function createLanMock (host) {
    const instance = new EventEmitter()
    instance.host = host
    instance.port = 49799
    instance.destroyed = false
    instance.destroy = sinon.stub().callsFake(async () => {
      instance.destroyed = true
    })
    return instance
  }

  it('attaches LAN discovery before initializing chat', async function () {
    const { module, attachHyperSDK, initChat, sdk } = await loadHyperModule()

    await module.createHandler({ storage: 'test-lan' })

    expect(attachHyperSDK.calledOnceWithExactly(sdk, {})).to.equal(true)
    expect(attachHyperSDK.calledBefore(initChat)).to.equal(true)
  })

  it('uses PEERSKY_LAN_PORT for additional local instances', async function () {
    const previousPort = process.env.PEERSKY_LAN_PORT
    process.env.PEERSKY_LAN_PORT = '49800'

    try {
      const { module, attachHyperSDK, sdk } = await loadHyperModule()
      await module.createHandler({ storage: 'test-lan-port' })

      expect(attachHyperSDK.calledOnceWithExactly(sdk, { port: 49800 })).to.equal(true)
    } finally {
      if (previousPort === undefined) delete process.env.PEERSKY_LAN_PORT
      else process.env.PEERSKY_LAN_PORT = previousPort
    }
  })

  it('re-registers LAN event listeners after a network change', async function () {
    const clock = sinon.useFakeTimers()
    const first = createLanMock('192.168.1.2')
    const second = createLanMock('192.168.2.2')
    const { module, attachHyperSDK } = await loadHyperModule({
      lanAttachResults: [first, second],
      currentIP: second.host
    })

    await module.createHandler({ storage: 'test-lan-recovery' })
    await clock.tickAsync(10_000)

    expect(attachHyperSDK.callCount).to.equal(2)
    expect(second.listenerCount('warning')).to.equal(1)
    expect(second.listenerCount('error')).to.equal(1)
    expect(() => second.emit('error', new Error('mDNS socket failed'))).not.to.throw()
  })

  it('retries LAN recovery after re-attach fails', async function () {
    const clock = sinon.useFakeTimers()
    const first = createLanMock('192.168.1.2')
    const recovered = createLanMock('192.168.2.2')
    const { module, attachHyperSDK } = await loadHyperModule({
      lanAttachResults: [first, new Error('LAN re-attach failed'), recovered],
      currentIP: recovered.host
    })

    await module.createHandler({ storage: 'test-lan-retry' })
    await clock.tickAsync(10_000)
    expect(attachHyperSDK.callCount).to.equal(2)

    await clock.tickAsync(10_000)
    expect(attachHyperSDK.callCount).to.equal(3)
    expect(recovered.listenerCount('error')).to.equal(1)
  })

  it('routes chat namespace to chat handler', async function () {
    const { module, handleChatRequest, sdk } = await loadHyperModule({
      chatResponse: new Response('chat-routed', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    })
    const handler = await module.createHandler({ storage: 'test-chat' })

    const response = await handler(new Request('hyper://chat/messages', { method: 'GET' }))

    expect(response.status).to.equal(200)
    expect(await response.text()).to.equal('chat-routed')
    expect(handleChatRequest.callCount).to.equal(1)
    expect(handleChatRequest.firstCall.args[1]).to.equal(sdk)
  })

  it('returns 500 response when Hyper fetch fails', async function () {
    const { module } = await loadHyperModule({ throwOnFetch: true })
    sinon.stub(console, 'error')
    const handler = await module.createHandler({ storage: 'test-error' })

    const response = await handler(new Request('hyper://example.org/fail', { method: 'GET' }))

    expect(response.status).to.equal(500)
    const text = await response.text()
    expect(text).to.contain('network failed')
  })

  it('returns 500 response when chat handler rejects', async function () {
    const { module } = await loadHyperModule({ chatReject: 'chat-crash' })
    sinon.stub(console, 'error')
    const handler = await module.createHandler({ storage: 'test-chat-error' })

    const response = await handler(new Request('hyper://chat/messages', { method: 'GET' }))

    expect(response.status).to.equal(500)
    const text = await response.text()
    expect(text).to.contain('chat-crash')
  })

  it('blocks extension-origin writes when no explicit write permission is granted', async function () {
    const { module, fetchStub } = await loadHyperModule()
    const handler = await module.createHandler(
      { storage: 'test-write-deny' },
      { isExtensionWriteAllowed: () => false }
    )

    const response = await handler({
      url: 'hyper://example.org/write.txt',
      method: 'PUT',
      headers: new Headers({
        referer: 'chrome-extension://ext-denied/probe.html'
      }),
      body: Buffer.from('write')
    })

    expect(response.status).to.equal(403)
    expect(fetchStub.called).to.equal(false)
    expect(await response.text()).to.contain('not allowed')
  })

  it('allows extension-origin writes when explicit permission is granted', async function () {
    const { module, fetchStub } = await loadHyperModule()
    const permissionCheck = sinon.stub().resolves(true)
    const handler = await module.createHandler(
      { storage: 'test-write-allow' },
      { isExtensionWriteAllowed: permissionCheck }
    )

    const response = await handler({
      url: 'hyper://example.org/write.txt',
      method: 'PUT',
      headers: new Headers({
        referer: 'chrome-extension://ext-allowed/probe.html'
      }),
      body: Buffer.from('write')
    })

    expect(response.status).to.equal(200)
    expect(fetchStub.calledOnce).to.equal(true)
    expect(permissionCheck.calledOnce).to.equal(true)
    expect(permissionCheck.firstCall.args[0]).to.include({
      extensionId: 'ext-allowed',
      scheme: 'hyper',
      method: 'PUT'
    })
  })

  it('continues initialization if LAN discovery fails to bind', async function () {
    const { module, initChat, sdk } = await loadHyperModule({ lanReject: true })

    await module.createHandler({ storage: 'test-lan-fail' })

    expect(initChat.calledOnce).to.equal(true)
    expect(initChat.firstCall.args[0]).to.equal(sdk)
  })

  it('wires up LAN error events correctly', async function () {
    const { module, attachHyperSDK } = await loadHyperModule()

    await module.createHandler({ storage: 'test-lan-events' })

    const lanMock = await attachHyperSDK.firstCall.returnValue
    expect(lanMock.listenerCount('error')).to.equal(1)
    expect(lanMock.listenerCount('warning')).to.equal(1)
  })
})
