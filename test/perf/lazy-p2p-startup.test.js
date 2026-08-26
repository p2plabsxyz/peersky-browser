/**
 * Startup cost of the p2p protocol backends.
 *
 * Registering ipfs://, hyper:// and bt:// used to boot Helia, hyper-sdk and the
 * WebTorrent worker first, and app.whenReady() awaited all three before the
 * first window was created — so the browser showed nothing until the swarm was
 * up. The handlers are now registered immediately and each backend starts on
 * its first request.
 *
 * These assert the shape rather than a duration: "the backend was not started"
 * is exactly what makes startup fast, and it does not vary by machine.
 */

import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'
import { EventEmitter } from 'events'

import { ensCache } from '../../src/protocols/config.js'

/** A Helia stand-in whose creation we can watch and stall. */
function fakeHeliaNode () {
  return {
    pins: { add: sinon.stub().callsFake(async function * (cid) { yield cid }) },
    libp2p: { getPeers: () => [], contentRouting: { provide: sinon.stub().resolves() } }
  }
}

async function loadIpfs ({ createNode }) {
  const decoder = { or () { return this } }
  class FakeCID {
    constructor (value) { this.value = String(value); this.version = 1 }
    toString () { return this.value }
    toV1 () { return this }
    static parse (value) { return new FakeCID(value) }
  }

  return esmock('../../src/protocols/ipfs-handler.js', {
    'mime-types': { default: { lookup: () => 'text/plain' } },
    '../../src/protocols/helia/helia.js': { createNode },
    '@helia/unixfs': { unixfs: () => ({ stat: sinon.stub().resolves({ type: 'file', size: 0 }), cat: sinon.stub(), ls: sinon.stub(), addAll: sinon.stub() }) },
    '@helia/ipns': { ipns: () => ({ resolve: sinon.stub() }) },
    '@helia/dnslink': { dnsLink: () => ({ resolve: sinon.stub() }) },
    'content-hash': { default: { getCodec: () => 'ipfs-ns', decode: () => 'bafy' } },
    'multiformats/cid': { CID: FakeCID },
    'multiformats/bases/base32': { base32: { decoder } },
    'multiformats/bases/base36': { base36: { decoder } },
    'multiformats/bases/base58': { base58btc: { decoder } },
    '@libp2p/peer-id': { peerIdFromString: () => ({}), peerIdFromCID: () => ({}) },
    '../../src/protocols/config.js': {
      ensCache,
      saveEnsCache: sinon.stub(),
      RPC_URL: 'http://localhost:8545',
      ipfsCache: [],
      saveIpfsCache: sinon.stub()
    },
    ethers: { JsonRpcProvider: class { async getResolver () { return null } } }
  })
}

async function loadHyper ({ createSDK }) {
  const lan = new EventEmitter()
  lan.host = '127.0.0.1'
  lan.port = 49799
  lan.destroy = sinon.stub().resolves()

  return esmock('../../src/protocols/hyper-handler.js', {
    electron: { app: { getPath: () => 'test-userdata' }, safeStorage: {} },
    'hyper-sdk': { create: createSDK },
    '@p2plabs/hyperdht-mdns': {
      default: { attachHyperSDK: sinon.stub().resolves(lan), selectLocalIPv4: () => '127.0.0.1' }
    },
    'hypercore-fetch': { default: sinon.stub().resolves(sinon.stub().resolves(new Response('ok'))) },
    '../../src/pages/p2p/peerchat/p2p.js': {
      initChat: sinon.spy(),
      handleChatRequest: sinon.stub().resolves(new Response('ok')),
      CHAT_STORAGE: 'test-chat-store'
    }
  })
}

describe('Startup: p2p backends do not block the first window', function () {
  afterEach(function () {
    sinon.restore()
  })

  it('registers the ipfs handler without starting a Helia node', async function () {
    const createNode = sinon.stub().resolves(fakeHeliaNode())
    const module = await loadIpfs({ createNode })

    const handler = await module.createHandler({ repo: 'perf-lazy' }, null, { lazy: true })

    expect(handler).to.be.a('function')
    expect(createNode.called, 'Helia was started while merely registering the handler').to.equal(false)
  })

  it('starts the Helia node once, on first request, even under a burst', async function () {
    let releaseNode
    const nodeGate = new Promise((resolve) => { releaseNode = resolve })
    const createNode = sinon.stub().callsFake(async () => {
      await nodeGate
      return fakeHeliaNode()
    })
    const module = await loadIpfs({ createNode })
    const handler = await module.createHandler({ repo: 'perf-lazy-burst' }, null, { lazy: true })

    // Ten requests arrive before the node finishes coming up.
    const inFlight = Array.from({ length: 10 }, () =>
      handler(new Request('ipfs://bafyburst/index.html')).catch(() => null)
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(createNode.callCount, 'each request started its own node').to.equal(1)

    releaseNode()
    await Promise.all(inFlight)
    expect(createNode.callCount).to.equal(1)
  })

  it('still starts the node up front when a caller asks for it', async function () {
    const createNode = sinon.stub().resolves(fakeHeliaNode())
    const module = await loadIpfs({ createNode })

    await module.createHandler({ repo: 'perf-eager' }, null, {})

    expect(createNode.calledOnce).to.equal(true)
  })

  it('registers the hyper handler without creating an SDK', async function () {
    const createSDK = sinon.stub().resolves({
      close: sinon.stub().resolves(),
      getDrive: sinon.stub().resolves({ core: {} }),
      joinCore: sinon.stub().resolves()
    })
    const module = await loadHyper({ createSDK })

    const handler = await module.createHandler({ storage: 'perf-lazy-hyper' }, { lazy: true })

    expect(handler).to.be.a('function')
    expect(createSDK.called, 'the Hyper SDK was created while registering the handler').to.equal(false)

    // The first request is what brings it up.
    await handler(new Request('hyper://example/'))
    expect(createSDK.calledOnce).to.equal(true)
  })

  it('registers the bittorrent handler without forking the worker', async function () {
    const fork = sinon.stub().returns(fakeWorker())
    const module = await esmock.strict('../../src/protocols/bittorrent-handler.js', {
      child_process: { fork },
      electron: {
        app: { getPath: (type) => (type === 'userData' ? '.test-perf-bt' : '.test-perf-bt-dl') },
        ipcMain: { handle: sinon.stub() }
      },
      '../../src/logger.js': { createLogger: () => ({ info () {}, warn () {}, error () {}, debug () {} }) },
      '../../src/settings-manager.js': { default: { settings: { theme: 'dark' } } }
    })

    const handler = await module.createHandler({ lazy: true })

    expect(handler).to.be.a('function')
    expect(fork.called, 'the WebTorrent worker was forked while registering the handler').to.equal(false)
  })
})

/** Minimal child_process.fork() stand-in that reports itself ready. */
function fakeWorker () {
  const worker = new EventEmitter()
  worker.stdout = new EventEmitter()
  worker.stderr = new EventEmitter()
  worker.send = sinon.stub()
  worker.kill = sinon.stub()
  setImmediate(() => worker.emit('message', { type: 'ready' }))
  return worker
}
