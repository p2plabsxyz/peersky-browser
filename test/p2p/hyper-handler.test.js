import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import { mkdtempSync } from 'fs'
import z32 from 'z32'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { EventEmitter } from 'events'
import * as requestGate from '../../src/protocols/request-gate.js'

const TEST_USER_DATA = mkdtempSync(path.join(os.tmpdir(), 'peersky-test-userdata-'))

const driveStores = new Map()

class FakeHyperdrive {
  constructor (nameOrKey, key, opts = {}) {
    this.core = { key: key || Buffer.alloc(32), discoveryKey: Buffer.alloc(32), length: 0 }
    this.encryptionKey = opts.encryptionKey || null
    if (key) {
      this.url = `hyper://${z32.encode(key)}/`
    } else {
      const derived = crypto.createHash('sha256').update(String(nameOrKey.seed || nameOrKey || 'private-drive')).digest()
      this.url = `hyper://${z32.encode(derived)}/`
    }
    if (!driveStores.has(this.url)) driveStores.set(this.url, new Map())
    this.files = driveStores.get(this.url)
  }

  async ready () {}

  async stat (drivePath, opts = {}) {
    if (drivePath === '/' || this.files.has(drivePath)) {
      return { isDirectory: () => drivePath === '/', size: (this.files.get(drivePath) || Buffer.alloc(0)).length }
    }
    return opts.allowMissing ? null : null
  }

  async entry (drivePath) {
    if (drivePath === '/') throw new Error('Invalid filename: /')
    if (!this.files.has(drivePath)) return null
    const buffer = this.files.get(drivePath)
    return { value: { blob: buffer.length ? { byteLength: buffer.length } : null } }
  }

  async readdir (drivePath) {
    const children = [...this.files.keys()]
    return drivePath === '/' ? children : children.map((name) => ({ name: name.split('/').pop(), type: 'file' }))
  }

  async get (drivePath) {
    if (!this.files.has(drivePath)) return null
    return this.files.get(drivePath)
  }

  async put (drivePath, buffer) {
    this.files.set(drivePath, buffer)
  }

  async del (drivePath) {
    this.files.delete(drivePath)
  }

  async mkdir () {}
}

describe('Hyper protocol handler', function () {
  afterEach(function () {
    sinon.restore()
  })

  async function loadHyperModule ({ fetchImpl, chatResponse, chatReject, throwOnFetch, lanReject, lanReadyReject, lanAttachResults, currentIP = '127.0.0.1', driveLength = 0, peerchat = {} } = {}) {
    // Order matters for the peer-discovery regression: the drive must be given
    // a chance to replicate before the fetch that would 404 with no peers.
    const callOrder = []
    const releasePeers = sinon.stub()
    const createMockSdk = (id) => ({
      id,
      close: sinon.stub().resolves(),
      corestore: {
        storage: {
          hasCore: sinon.stub().resolves(false)
        },
        // A drive opened by name gets the address FakeHyperdrive gives it.
        namespace: sinon.stub().callsFake((name) => ({
          ns: Buffer.from('test'),
          seed: name,
          get: () => ({
            key: crypto.createHash('sha256').update(String(name)).digest(),
            ready: async () => {},
            close: async () => {}
          }),
          close: async () => {},
          storage: {
            getAlias: sinon.stub().resolves(null),
            hasCore: sinon.stub().resolves(false)
          }
        }))
      },
      getDrive: sinon.stub().callsFake(async (name) => ({
        writable: false,
        core: {
          length: driveLength,
          findingPeers: sinon.stub().callsFake(() => {
            callOrder.push('findingPeers')
            return releasePeers
          }),
          update: sinon.stub().callsFake(async () => {
            callOrder.push('update')
            return true
          })
        },
        url: `hyper://${String(name).replace(/[^a-z0-9]/gi, '').padEnd(52, 'a').slice(0, 52)}/`
      })),
      joinCore: sinon.stub().resolves(),
      swarm: { flush: sinon.stub().resolves(), keyPair: { publicKey: Buffer.alloc(32) } },
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

    // The LAN swarm the handler makes and readies before attaching it.
    const lanInstances = []
    const LANSwarm = sinon.spy(function (opts) {
      this.opts = opts
      this.destroy = sinon.stub().resolves()
      this.ready = lanReadyReject ? sinon.stub().rejects(lanReadyReject) : sinon.stub().resolves()
      lanInstances.push(this)
    })
    LANSwarm.attachHyperSDK = attachHyperSDK
    LANSwarm.selectLocalIPv4 = sinon.stub().returns(currentIP)

    const createFetchStub = () => sinon.stub().callsFake(async (url, options) => {
      callOrder.push('fetch')
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
    const rememberPrivateHyperdrive = sinon.stub().resolves()

    const module = await esmock('../../src/protocols/hyper-handler.js', {
      electron: {
        app: {
          getPath: () => TEST_USER_DATA
        },
        safeStorage: {}
      },
      'hyper-sdk': {
        create: createSDK
      },
      '@p2plabs/hyperdht-mdns': {
        default: LANSwarm
      },
      'hypercore-fetch': {
        default: hyperFetchFactory
      },
      '../../src/protocols/config.js': {
        hyperCache,
        saveHyperCache
      },
      '../../src/protocols/private-hyperdrive-registry.js': {
        rememberPrivateHyperdrive
      },
      // The instance the tests stamp requests with, so the stamps match.
      '../../src/protocols/request-gate.js': requestGate,
      // Tested on its own; here the stubbed SDKs are asked directly.
      '../../src/protocols/shared-drive-opens.js': {
        shareDriveOpens: (sdk) => sdk
      },
      '../../src/pages/p2p/peerchat/p2p.js': {
        initChat,
        handleChatRequest,
        CHAT_STORAGE: 'test-chat-store',
        ...peerchat
      }
    }, {
      hyperdrive: {
        default: FakeHyperdrive
      }
    })

    return {
      module,
      callOrder,
      releasePeers,
      createSDK,
      attachHyperSDK,
      LANSwarm,
      lanInstances,
      fetchStub,
      privateFetchStub,
      hyperFetchFactory,
      initChat,
      handleChatRequest,
      lanMock,
      sdk,
      privateSdk,
      hyperCache,
      saveHyperCache,
      rememberPrivateHyperdrive
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
    const { module, attachHyperSDK, lanInstances, initChat, sdk } = await loadHyperModule()

    await module.createHandler({ storage: 'test-lan' })

    expect(lanInstances).to.have.length(1)
    expect(lanInstances[0].opts.keyPair).to.equal(sdk.swarm.keyPair)
    expect(lanInstances[0].ready.calledBefore(attachHyperSDK)).to.equal(true)
    expect(attachHyperSDK.calledOnceWithExactly(sdk, { lan: lanInstances[0] })).to.equal(true)
    expect(attachHyperSDK.calledBefore(initChat)).to.equal(true)
  })

  // A second PeerSky on the same computer already holds the LAN port. The SDK
  // was patched before the bind failed, so every later join went to the dead
  // LAN swarm and creating a drive answered "address already in use".
  it('leaves the SDK alone when the LAN port is taken', async function () {
    const taken = new Error('LAN DHT port 49799 is already in use. Choose a different fixed port for another local instance.')
    const { module, attachHyperSDK, lanInstances, initChat } = await loadHyperModule({ lanReadyReject: taken })

    const handler = await module.createHandler({ storage: 'test-lan-taken' })

    expect(attachHyperSDK.called).to.equal(false)
    expect(lanInstances[0].destroy.calledOnce).to.equal(true)
    expect(initChat.calledOnce).to.equal(true)
    const response = await handler(new Request('hyper://localhost/?key=after-lan-failed', { method: 'POST' }))
    expect(response.status).to.equal(200)
  })

  describe('first load of a drive that has not replicated yet', function () {
    it('waits for peers before fetching, so the first read is not a 404', async function () {
      const { module, callOrder, releasePeers, fetchStub } = await loadHyperModule()
      const handler = await module.createHandler({ storage: 'test-peer-wait' })

      const response = await handler(new Request(`hyper://${'b'.repeat(52)}/index.html`, { method: 'GET' }))

      expect(response.status).to.equal(200)
      expect(fetchStub.calledOnce).to.equal(true)
      // The wait has to happen first; fetching before it is the regression.
      expect(callOrder.indexOf('update')).to.be.greaterThan(-1)
      expect(callOrder.indexOf('update')).to.be.lessThan(callOrder.indexOf('fetch'))
      // Peer discovery must be held open across the update, then released,
      // rather than the release callback being awaited and never invoked.
      expect(callOrder.indexOf('findingPeers')).to.be.lessThan(callOrder.indexOf('update'))
      expect(releasePeers.called).to.equal(true)
    })

    it('asks the core to wait rather than answering from an empty core', async function () {
      const { module, sdk } = await loadHyperModule()
      const handler = await module.createHandler({ storage: 'test-peer-wait-opts' })

      await handler(new Request(`hyper://${'c'.repeat(52)}/index.html`, { method: 'GET' }))

      const drive = await sdk.getDrive.returnValues[0]
      expect(drive.core.update.firstCall.args[0]).to.deep.equal({ wait: true })
    })

    it('skips the wait once the drive already has content', async function () {
      const { module, callOrder } = await loadHyperModule({ driveLength: 5 })
      const handler = await module.createHandler({ storage: 'test-peer-wait-warm' })

      await handler(new Request(`hyper://${'d'.repeat(52)}/index.html`, { method: 'GET' }))

      expect(callOrder).to.deep.equal(['fetch'])
    })

    it('does not delay a write, which creates content instead of reading it', async function () {
      const { module, callOrder } = await loadHyperModule()
      const handler = await module.createHandler({ storage: 'test-peer-wait-put' })

      await handler(new Request(`hyper://${'e'.repeat(52)}/note.txt`, { method: 'PUT', body: 'hi' }))

      expect(callOrder).to.deep.equal(['fetch'])
    })
  })

  it('advertises a per-peer mDNS host so macOS does not rename itself', async function () {
    const { module } = await loadHyperModule()
    const published = []
    const adapter = {
      advertise: sinon.stub().callsFake((record) => {
        published.push(record)
        return { stop: async () => {} }
      })
    }

    module.withPeerLocalHost(adapter)
    adapter.advertise({ name: 'hyperdht-mdns-0123456789ab', type: 'hyperdht-mdns', port: 49799 })

    // Never the machine's own hostname, which is what macOS defends.
    expect(published[0].host).to.equal('hyperdht-mdns-0123456789ab.local')
    expect(published[0].host).to.not.equal(`${os.hostname()}`)
    expect(published[0].port).to.equal(49799)
  })

  it('uses PEERSKY_LAN_PORT for additional local instances', async function () {
    const previousPort = process.env.PEERSKY_LAN_PORT
    process.env.PEERSKY_LAN_PORT = '49800'

    try {
      const { module, attachHyperSDK, lanInstances, sdk } = await loadHyperModule()
      await module.createHandler({ storage: 'test-lan-port' })

      expect(lanInstances[0].opts.port).to.equal(49800)
      expect(attachHyperSDK.calledOnceWithExactly(sdk, { lan: lanInstances[0] })).to.equal(true)
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

  it("serves a site's own /chat path from its drive, not the chat handler", async function () {
    const { module, handleChatRequest } = await loadHyperModule({
      fetchImpl: async () => new Response('site-page', { status: 200 })
    })
    const handler = await module.createHandler({ storage: 'test-chat-path' })

    const response = await handler(new Request('hyper://example.org/chat.html', { method: 'GET' }))

    expect(await response.text()).to.equal('site-page')
    expect(handleChatRequest.callCount).to.equal(0)
  })

  // hypercore-fetch says 200 to a Range request. PeerTunes read that as the
  // whole song, kept 128 KB of it, and drew only the top of the cover art.
  it('answers a ranged read as Partial Content', async function () {
    const { module, fetchStub } = await loadHyperModule({
      fetchImpl: async (url, options) => {
        const range = new Headers(options.headers).get('Range')
        if (!range) return new Response('whole file', { status: 200, headers: { 'Content-Length': '10' } })
        return new Response('part', { status: 200, headers: { 'Content-Range': 'bytes 0-3/10', 'Content-Length': '4' } })
      }
    })
    const handler = await module.createHandler({ storage: 'test-range' })

    const ranged = await handler(new Request(`hyper://${'d'.repeat(52)}/song.mp3`, { headers: { Range: 'bytes=0-3' } }))
    expect(ranged.status).to.equal(206)
    expect(ranged.headers.get('Content-Range')).to.equal('bytes 0-3/10')
    expect(await ranged.text()).to.equal('part')

    const whole = await handler(new Request(`hyper://${'d'.repeat(52)}/song.mp3`))
    expect(whole.status).to.equal(200)
    expect(await whole.text()).to.equal('whole file')
    expect(fetchStub.callCount).to.equal(2)
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
    expect(sdk.getDrive.calledWithExactly('public-file', { autoJoin: true })).to.equal(true)
    expect(sdk.getDrive.calledWith('private-file')).to.equal(false)
    expect(privateSdk.getDrive.called).to.equal(false)
    expect(privateSdk.corestore.namespace.calledWithExactly('private-file')).to.equal(true)
  })

  it('uses a distinct Hyperdrive for each upload name', async function () {
    const { module, sdk, privateSdk } = await loadHyperModule()
    const handler = await module.createHandler({ storage: 'test-per-upload-drives' })

    for (const name of ['first-file', 'second-file']) {
      await handler(new Request(
        `hyper://localhost/?key=${name}&visibility=public`,
        { method: 'POST' }
      ))
      await handler(new Request(
        `hyper://localhost/?key=${name}&visibility=private`,
        { method: 'POST' }
      ))
    }

    expect(sdk.getDrive.calledWithExactly('first-file', { autoJoin: true })).to.equal(true)
    expect(sdk.getDrive.calledWithExactly('second-file', { autoJoin: true })).to.equal(true)
    expect(privateSdk.getDrive.called).to.equal(false)
    expect(privateSdk.corestore.namespace.calledWithExactly('first-file')).to.equal(true)
    expect(privateSdk.corestore.namespace.calledWithExactly('second-file')).to.equal(true)
  })

  it('runs the private runtime announced and replicating under LAN isolation', async function () {
    const { module, createSDK, attachHyperSDK, lanInstances, sdk, privateSdk } = await loadHyperModule()

    await module.createHandler({ storage: path.join('profiles', 'hyper') })

    expect(createSDK.callCount).to.equal(2)
    expect(createSDK.secondCall.args[0]).to.include({
      storage: path.join('profiles', 'hyper-private'),
      autoJoin: true,
      doReplicate: true
    })
    expect(attachHyperSDK.calledOnceWithExactly(sdk, { lan: lanInstances[0] })).to.equal(true)
    expect(attachHyperSDK.calledWith(privateSdk)).to.equal(false)
  })

  it('routes private drive writes and reads through the encrypted runtime', async function () {
    const { module, fetchStub, privateFetchStub } = await loadHyperModule()
    const handler = await module.createHandler({ storage: 'test-private-routing' })
    const keyResponse = await handler(new Request(
      'hyper://localhost/?key=private-file&visibility=private',
      { method: 'POST' }
    ))
    expect(keyResponse.status).to.equal(200)
    const privateDriveUrl = await keyResponse.text()
    const privateFileUrl = new URL('/private-file.txt', privateDriveUrl).href

    const putResponse = await handler(new Request(privateFileUrl, { method: 'PUT', body: 'private' }))
    const getResponse = await handler(new Request(privateFileUrl))

    expect(putResponse.status).to.equal(200)
    expect(getResponse.status).to.equal(200)
    expect(await getResponse.text()).to.equal('private')
    expect(privateFetchStub.called).to.equal(false)
    expect(fetchStub.called).to.equal(false)
  })

  // A site that learned a private drive's address read it with this desktop's
  // keys, as Electron applies no CORS to hyper://. The phone already refused it.
  it('keeps a private drive from pages other than its own and the browser\'s', async function () {
    const { module } = await loadHyperModule()
    const handler = await module.createHandler({ storage: 'test-private-callers' })
    const keyResponse = await handler(new Request('hyper://localhost/?key=private-callers&visibility=private', { method: 'POST' }))
    const driveUrl = await keyResponse.text()
    const fileUrl = new URL('/note.txt', driveUrl).href
    expect((await handler(new Request(fileUrl, { method: 'PUT', body: 'private' }))).status).to.equal(200)

    const from = (initiatorOrigin, init = {}) => Object.assign(new Request(fileUrl, init), { initiatorOrigin })
    const opened = (initiatorOrigin) => from(initiatorOrigin, {
      headers: requestGate.stampVetted({ url: fileUrl, method: 'GET', resourceType: 'mainFrame', requestHeaders: {} })
    })

    expect((await handler(from('https://site.example'))).status, 'a website').to.equal(403)
    expect((await handler(from(`hyper://${'a'.repeat(52)}`))).status, 'another hyper site').to.equal(403)
    expect((await handler(from('null'))).status, 'an opaque origin').to.equal(403)
    expect((await handler(from('https://site.example', { method: 'PUT', body: 'x' }))).status, 'a website writing').to.equal(403)
    const forged = from('https://site.example', { headers: { 'x-peersky-navigation': 'guess' } })
    expect((await handler(forged)).status, 'a forged stamp').to.equal(403)

    expect((await handler(from('peersky://p2p'))).status, 'the browser\'s own page').to.equal(200)
    expect((await handler(from(`hyper://${new URL(driveUrl).hostname}`))).status, 'its own page').to.equal(200)
    expect((await handler(opened('https://site.example'))).status, 'a tab opening a link to it').to.equal(200)
    expect(await (await handler(new Request(fileUrl))).text(), 'a typed address').to.equal('private')
  })

  it('serves private drives from the encrypted runtime after restart', async function () {
    const { module, fetchStub, privateFetchStub, privateSdk } = await loadHyperModule()
    privateSdk.corestore.storage.hasCore.resolves(true)
    const handler = await module.createHandler({ storage: 'test-private-restore' })

    const response = await handler(new Request(
      `hyper://${'a'.repeat(52)}/`
    ))

    expect(response.status).to.equal(200)
    expect(privateFetchStub.called).to.equal(false)
    expect(fetchStub.called).to.equal(false)
  })

  it('does not persist private drive keys in the shared Hyper cache', async function () {
    const { module, hyperCache, saveHyperCache, rememberPrivateHyperdrive } = await loadHyperModule()
    const handler = await module.createHandler({ storage: 'test-private-cache' })

    const response = await handler(new Request(
      'hyper://localhost/?key=private-file&visibility=private',
      { method: 'POST' }
    ))

    expect(response.status).to.equal(200)
    expect(hyperCache).to.deep.equal([])
    expect(saveHyperCache.called).to.equal(false)
    expect(rememberPrivateHyperdrive.calledOnce).to.equal(true)
    expect(rememberPrivateHyperdrive.firstCall.args[1]).to.include({ name: 'private-file' })
  })

  it('creates the encryption key and announces new private drives', async function () {
    const { module, privateSdk, rememberPrivateHyperdrive } = await loadHyperModule()
    const handler = await module.createHandler({ storage: 'test-private-flag' })

    const response = await handler(new Request(
      'hyper://localhost/?key=new-private-flag&visibility=private',
      { method: 'POST' }
    ))

    expect(response.status).to.equal(200)
    expect(privateSdk.joinCore.calledOnce).to.equal(true)
    expect(rememberPrivateHyperdrive.calledOnce).to.equal(true)
    expect(rememberPrivateHyperdrive.firstCall.args[1]).to.include({ encrypted: true })

    const keyFile = path.join(TEST_USER_DATA, 'private-drive-key.json')
    const keyContents = JSON.parse(await readFile(keyFile, 'utf8'))
    expect(typeof keyContents.key).to.equal('string')
    expect(/^[a-f0-9]{64}$/i.test(keyContents.key)).to.equal(true)
  })

  it('serves pre-key private drives unencrypted and device-only', async function () {
    const { module, privateSdk, fetchStub, privateFetchStub } = await loadHyperModule()
    privateSdk.corestore.storage.hasCore.resolves(true)
    const legacyUrl = `hyper://${'a'.repeat(52)}/`
    await writeFile(
      path.join(TEST_USER_DATA, 'privateHyperdrives.json'),
      JSON.stringify([{ name: 'old-drive', url: legacyUrl, timestamp: 1, encrypted: false }])
    )
    const handler = await module.createHandler({ storage: 'test-legacy-private' })

    const response = await handler(new Request(legacyUrl))

    expect(response.status).to.equal(200)
    expect(privateSdk.joinCore.called).to.equal(false)
    expect(privateFetchStub.called).to.equal(false)
    expect(fetchStub.called).to.equal(false)
  })

  it('routes a registered private drive this desktop never opened, like a phone\'s, to the private store', async function () {
    const { module, privateSdk, fetchStub } = await loadHyperModule()
    const phoneUrl = `hyper://${'b'.repeat(52)}/`
    await writeFile(
      path.join(TEST_USER_DATA, 'privateHyperdrives.json'),
      JSON.stringify([{ name: 'Private files from your phone', url: phoneUrl, timestamp: 1, encrypted: true }])
    )
    const handler = await module.createHandler({ storage: 'test-phone-private' })

    const response = await handler(new Request(phoneUrl))

    expect(response.status).to.equal(200)
    expect(fetchStub.called).to.equal(false)
    expect(privateSdk.joinCore.calledOnce).to.equal(true)
  })

  it('routes an address trusted while running to the private store', async function () {
    const { module, fetchStub } = await loadHyperModule()
    await writeFile(path.join(TEST_USER_DATA, 'privateHyperdrives.json'), '[]')
    const handler = await module.createHandler({ storage: 'test-trusted-private' })
    const hostname = 'c'.repeat(52)

    await handler(new Request(`hyper://${hostname}/`))
    expect(fetchStub.calledOnce).to.equal(true)

    module.trustPrivateDriveHostname(hostname)
    const response = await handler(new Request(`hyper://${hostname}/`))
    expect(response.status).to.equal(200)
    expect(fetchStub.calledOnce).to.equal(true)
  })

  it('announces private drives that carry the encryption flag', async function () {
    const { module, privateSdk } = await loadHyperModule()
    privateSdk.corestore.storage.hasCore.resolves(true)
    const privateUrl = `hyper://${'a'.repeat(52)}/`
    await writeFile(
      path.join(TEST_USER_DATA, 'privateHyperdrives.json'),
      JSON.stringify([{ name: 'encrypted-drive', url: privateUrl, timestamp: 1, encrypted: true }])
    )
    const handler = await module.createHandler({ storage: 'test-encrypted-private' })

    const response = await handler(new Request(privateUrl))

    expect(response.status).to.equal(200)
    expect(privateSdk.joinCore.calledOnce).to.equal(true)
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

  describe('PeerChat in transfers', function () {
    it('loads with a PeerChat that has no transfers yet, and sends and takes none', async function () {
      const { module } = await loadHyperModule({ peerchat: { exportChatTransfer: undefined, importChatTransfer: undefined } })
      expect(module.chatTakesTransfers()).to.equal(false)
      expect(module.exportChatForTransfer('mobile')).to.equal(null)
      expect(await module.importChatFromPhone({ version: 1 })).to.deep.equal({ ok: false, added: 0 })
    })

    it('hands transfers to a PeerChat that takes them', async function () {
      const exportChatTransfer = sinon.stub().returns({ version: 1, label: 'desktop1' })
      const importChatTransfer = sinon.stub().resolves({ ok: true, added: 2, label: 'desktop' })
      const { module } = await loadHyperModule({ peerchat: { exportChatTransfer, importChatTransfer } })
      expect(module.chatTakesTransfers()).to.equal(true)
      expect(module.exportChatForTransfer('desktop')).to.deep.equal({ version: 1, label: 'desktop1' })
      expect(exportChatTransfer.calledOnceWith({ targetType: 'desktop' })).to.equal(true)
      expect(await module.importChatFromPhone({ version: 1 })).to.deep.equal({ ok: true, added: 2, label: 'desktop' })
    })

    it('never names the transfer functions in its import from PeerChat', async function () {
      // Installs follow PeerChat's newest commit. A named import of an export
      // it does not have yet stops the handler loading, and every hyper://
      // request with it.
      const source = await readFile(new URL('../../src/protocols/hyper-handler.js', import.meta.url), 'utf8')
      const named = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/pages\/p2p\/peerchat\/p2p\.js'/g)].map((match) => match[1]).join(',')
      expect(named).not.to.match(/exportChatTransfer|importChatTransfer/)
    })
  })

  it('wires up LAN error events correctly', async function () {
    const { module, attachHyperSDK } = await loadHyperModule()

    await module.createHandler({ storage: 'test-lan-events' })

    const lanMock = await attachHyperSDK.firstCall.returnValue
    expect(lanMock.listenerCount('error')).to.equal(1)
    expect(lanMock.listenerCount('warning')).to.equal(1)
  })
})
