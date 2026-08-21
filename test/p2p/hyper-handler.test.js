import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'
import os from 'os'
import path from 'path'
import { mkdtemp, rm, writeFile } from 'fs/promises'

describe('Hyper protocol handler', function () {
  afterEach(function () {
    sinon.restore()
  })

  async function loadHyperModule ({ fetchImpl, chatResponse, chatReject, throwOnFetch } = {}) {
    const sdk = {
      id: 'sdk-test',
      close: sinon.stub().resolves(),
      getDrive: sinon.stub().resolves({ core: {} }),
      joinCore: sinon.stub().resolves(),
      swarm: { flush: sinon.stub().resolves() }
    }
    const createSDK = sinon.stub().resolves(sdk)

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
    const hyperFetchFactory = sinon.stub().resolves(fetchStub)

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
      'hypercore-fetch': {
        default: hyperFetchFactory
      },
      '../../src/pages/p2p/peerchat/p2p.js': {
        initChat,
        handleChatRequest,
        CHAT_STORAGE: 'test-chat-store'
      }
    })

    return { module, createSDK, fetchStub, hyperFetchFactory, initChat, handleChatRequest, sdk }
  }

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
})
