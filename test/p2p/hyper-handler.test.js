import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'
import os from 'os'
import path from 'path'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { EventEmitter } from 'events'

describe('Hyper protocol handler', function () {
  afterEach(function () {
    sinon.restore()
  })

  async function loadHyperModule ({ fetchImpl, chatResponse, chatReject, throwOnFetch, lanReject, lanAttachResults, currentIP = '127.0.0.1' } = {}) {
    const createMockSdk = (id) => ({
      id,
      close: sinon.stub().resolves(),
      getDrive: sinon.stub().callsFake(async (name) => ({
        core: {},
        url: `hyper://${String(name).replace(/[^a-z0-9]/gi, '').padEnd(52, 'a').slice(0, 52)}/`
      })),
      joinCore: sinon.stub().resolves(),
      namespace: sinon.stub().returns({
        ns: Buffer.from('test'),
        storage: {
          getAlias: sinon.stub().resolves(null),
          hasCore: sinon.stub().resolves(false)
        }
      }),
      swarm: { flush: sinon.stub().resolves() },
      suspend: sinon.stub().resolves(),
      resume: sinon.stub().resolves()
    })
    const sdk = createMockSdk('sdk-test')
    const privateSdk = createMockSdk('private-sdk-test')
    const createSDK = sinon.stub()
    createSDK.onFirstCall().resolves(sdk)
    createSDK.onSecondCall().resolves(privateSdk)

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

    const createFetchStub = () => sinon.stub().callsFake(async (url, options) => {
      if (throwOnFetch) {
        throw new Error('network failed')
      }
      if (fetchImpl) {
        return fetchImpl(url, options)
      }
      return new Response('hyper-ok', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    })
    const fetchStub = createFetchStub()
    const privateFetchStub = createFetchStub()

    const initChat = sinon.spy()
    const handleChatRequest = sinon.stub()
    if (chatReject) {
      handleChatRequest.rejects(new Error(chatReject))
    } else {
      handleChatRequest.resolves(
        chatResponse || new Response('chat-ok', { status: 200, headers: { 'Content-Type': 'text/plain' } })
      )
    }
    const hyperFetchFactory = sinon.stub().callsFake(async ({ sdk: targetSdk }) => {
      return targetSdk === privateSdk ? privateFetchStub : fetchStub
    })
    const hyperCache = []
    const saveHyperCache = sinon.stub()

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
      '@p2plabs/hyperdht-mdns': {
        default: {
          attachHyperSDK,
          selectLocalIPv4: sinon.stub().returns(currentIP)
        }
      },
      'hypercore-fetch': {
        default: hyperFetchFactory
      },
      '../../src/protocols/config.js': {
        hyperCache,
        saveHyperCache
      },
      '../../src/pages/p2p/peerchat/p2p.js': {
        initChat,
        handleChatRequest,
        CHAT_STORAGE: 'test-chat-store'
      }
    })

    return {
      module,
      createSDK,
      attachHyperSDK,
      fetchStub,
      privateFetchStub,
      hyperFetchFactory,
      initChat,
      handleChatRequest,
      lanMock,
      sdk,
      privateSdk,
      hyperCache,
      saveHyperCache
    }
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

  it('creates public and private upload drives with matching discovery settings', async function () {
    const { module, sdk, privateSdk } = await loadHyperModule()
    const handler = await module.createHandler({ storage: 'test-visibility' })

    const publicResponse = await handler(new Request(
      'hyper://localhost/?key=public-file&visibility=public',
      { method: 'POST' }
    ))
    const privateResponse = await handler(new Request(
      'hyper://localhost/?key=private-file&visibility=private',
      { method: 'POST' }
    ))

    expect(publicResponse.status).to.equal(200)
    expect(privateResponse.status).to.equal(200)
    expect(sdk.getDrive.calledWithExactly('hyperdrive-public', { autoJoin: true })).to.equal(true)
    expect(privateSdk.getDrive.calledWithExactly('hyperdrive-private', { autoJoin: false })).to.equal(true)
    expect(sdk.getDrive.calledWith('hyperdrive-private')).to.equal(false)
  })

  it('keeps the private runtime outside LAN discovery and Corestore replication', async function () {
    const { module, createSDK, attachHyperSDK, sdk, privateSdk } = await loadHyperModule()

    await module.createHandler({ storage: path.join('profiles', 'hyper') })

    expect(createSDK.callCount).to.equal(2)
    expect(createSDK.secondCall.args[0]).to.include({
      storage: path.join('profiles', 'hyper-private'),
      autoJoin: false,
      doReplicate: false
    })
    expect(attachHyperSDK.calledOnceWithExactly(sdk, {})).to.equal(true)
    expect(attachHyperSDK.calledWith(privateSdk)).to.equal(false)
  })

  it('routes private drive writes and reads only through the isolated runtime', async function () {
    const { module, fetchStub, privateFetchStub } = await loadHyperModule()
    const handler = await module.createHandler({ storage: 'test-private-routing' })
    const keyResponse = await handler(new Request(
      'hyper://localhost/?key=private-file&visibility=private',
      { method: 'POST' }
    ))
    const privateDriveUrl = await keyResponse.text()
    const privateFileUrl = new URL('/private-file.txt', privateDriveUrl).href

    await handler(new Request(privateFileUrl, { method: 'PUT', body: 'private' }))
    await handler(new Request(privateFileUrl))

    expect(privateFetchStub.callCount).to.equal(2)
    expect(fetchStub.called).to.equal(false)
  })

  it('does not persist private drive keys in the shared Hyper cache', async function () {
    const { module, hyperCache, saveHyperCache } = await loadHyperModule()
    const handler = await module.createHandler({ storage: 'test-private-cache' })

    const response = await handler(new Request(
      'hyper://localhost/?key=private-file&visibility=private',
      { method: 'POST' }
    ))

    expect(response.status).to.equal(200)
    expect(hyperCache).to.deep.equal([])
    expect(saveHyperCache.called).to.equal(false)
  })

  it('rejects unsupported upload visibility before opening a drive', async function () {
    const { module, sdk } = await loadHyperModule()
    const handler = await module.createHandler({ storage: 'test-invalid-visibility' })
    sdk.getDrive.resetHistory()

    const response = await handler(new Request(
      'hyper://localhost/?key=file&visibility=shared',
      { method: 'POST' }
    ))

    expect(response.status).to.equal(400)
    expect(sdk.getDrive.called).to.equal(false)
  })

  it('rejects unsafe or oversized upload names before opening a drive', async function () {
    const { module, sdk } = await loadHyperModule()
    const handler = await module.createHandler({ storage: 'test-invalid-name' })
    sdk.getDrive.resetHistory()

    for (const key of ['line\nbreak', `next${String.fromCharCode(0x85)}line`, 'a'.repeat(256)]) {
      const response = await handler(new Request(
        `hyper://localhost/?key=${encodeURIComponent(key)}&visibility=public`,
        { method: 'POST' }
      ))
      expect(response.status).to.equal(400)
    }

    expect(sdk.getDrive.called).to.equal(false)
  })

  it('recovers a runtime already closed when suspension partially fails', async function () {
    const { module, createSDK, sdk, privateSdk } = await loadHyperModule()
    await module.createHandler({ storage: 'test-suspend-recovery' })
    createSDK.onThirdCall().resolves(privateSdk)
    sdk.close.rejects(new Error('main close failed'))

    let failure
    try {
      await module.suspendHyper()
    } catch (error) {
      failure = error
    }

    expect(failure?.message).to.equal('main close failed')
    expect(privateSdk.close.calledOnce).to.equal(true)
    expect(sdk.close.calledOnce).to.equal(true)
    expect(createSDK.callCount).to.equal(3)
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

  it('awaits the fetch factory for ephemeral Hyper uploads', async function () {
    const key = 'a'.repeat(52)
    const { module, hyperFetchFactory } = await loadHyperModule({
      fetchImpl: async (url, options) => {
        if (options?.method === 'POST') return new Response(`hyper://${key}/`)
        return new Response('', { status: 200 })
      }
    })
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'peersky-hyper-upload-test-'))
    const filePath = path.join(tempDir, 'backup.zip')
    await writeFile(filePath, 'sealed backup')

    try {
      const result = await module.hyperPublishFile(filePath, 'backup.zip', {
        ephemeral: true,
        ttlMs: 1000
      })
      expect(result.address).to.equal(`hyper://${key}/backup.zip`)
      expect(hyperFetchFactory.calledOnce).to.equal(true)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
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
