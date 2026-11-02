// When a VPN extension turns on, switches server or turns off, the torrent
// handler starts a new worker with the new proxies (bittorrent-handler.js
// setTorrentProxies). Running torrents carry on through a VPN; when it turns
// off they pause instead, and pick up again when it comes back. The worker
// gets the VPN's login only for the proxies the browser picked.

import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'

const HASH = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=The%20Skeleton%20Dance`
const VPN = [{ scheme: 'https', host: 'maasdam-1-nl.nexorcdn.com', port: 16858 }]
const OTHER_VPN = [{ scheme: 'https', host: 'other-1-us.nexorcdn.com', port: 443 }]

function tokenFor (mod, ipcMain) {
  mod.setupBittorrentIpc()
  const call = ipcMain.handle.getCalls().find((c) => c.args[0] === 'bt-api-token')
  return call.args[1]({ senderFrame: { url: `bt://${HASH}/` } })
}

// A stand-in for the forked worker that answers like worker.js and exits when
// disconnected, as the real one does.
function makeChild (children) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.sent = []
  child.connected = true
  child.send = (msg) => {
    child.sent.push(msg)
    queueMicrotask(() => {
      if (msg.action === 'start' || msg.action === 'seed') {
        child.emit('message', { id: msg.id, type: 'started', infoHash: HASH, magnetURI: msg.magnetUri, mode: msg.action === 'seed' ? 'seed' : 'download' })
        child.emit('message', { type: 'status-update-bulk', torrents: [running(msg.action === 'seed' ? 'seed' : 'download')] })
      } else if (msg.id) {
        child.emit('message', { id: msg.id, type: 'ok', infoHash: HASH })
      }
    })
  }
  child.disconnect = () => {
    child.connected = false
    queueMicrotask(() => child.emit('exit', 0))
  }
  child.kill = () => child.disconnect()
  const on = child.on.bind(child)
  let readied = false
  child.on = (ev, fn) => {
    const r = on(ev, fn)
    if (ev === 'message' && !readied) {
      readied = true
      queueMicrotask(() => child.emit('message', { type: 'ready' }))
    }
    return r
  }
  children.push(child)
  return child
}

function running (mode = 'download') {
  return { infoHash: HASH, name: 'The Skeleton Dance', mode, magnetURI: MAGNET, progress: 0.4, done: false, paused: false, numPeers: 3, isSeeding: false, files: [] }
}

describe('torrents follow the VPN extension', function () {
  this.timeout(20000)
  const dirs = []
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

  async function load () {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-vpn-ud-'))
    const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-vpn-dl-'))
    dirs.push(ud, dd)
    const children = []
    const fork = sinon.stub().callsFake(() => makeChild(children))
    const ipcMain = { handle: sinon.stub() }
    const mod = await esmock.strict('../../src/protocols/bittorrent-handler.js', {
      child_process: { fork },
      electron: {
        app: { getPath: (t) => (t === 'downloads' ? dd : path.join(ud, t === 'userData' ? '' : t)) },
        ipcMain,
        net: { fetch: async () => { throw new Error('No network in this test') } }
      },
      '../../src/logger.js': { createLogger: () => ({ debug () {}, info () {}, warn () {}, error () {} }) },
      '../../src/settings-manager.js': { default: { settings: { theme: 'light' } } }
    })
    // Lazy, as in the app: the worker starts with the first torrent.
    const handler = await mod.createHandler({ lazy: true })
    const token = tokenFor(mod, ipcMain)
    const api = async (api, params = {}, method = 'GET') => {
      const url = `bt://api?${new URLSearchParams({ action: 'api', api, ...params })}`
      const res = await handler(new Request(url, { method, headers: { 'X-BT-Token': token } }))
      return res.json()
    }
    return { mod, fork, children, api, handler }
  }

  async function startTorrent (t) {
    const body = await t.api('start', { magnet: encodeURIComponent(MAGNET) }, 'POST')
    expect(body).to.include({ success: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  it('starts the worker with the VPN\'s proxies in its environment, and none without', async () => {
    const t = await load()
    await t.mod.setTorrentProxies(VPN)
    await startTorrent(t)
    expect(t.fork.callCount).to.equal(1)
    const env = t.fork.firstCall.args[2].env
    expect(JSON.parse(env.PEERSKY_BT_PROXIES)).to.deep.equal(VPN)
    expect(t.fork.firstCall.args[1].join(' ')).to.not.include('nexorcdn')

    const plain = await load()
    await startTorrent(plain)
    expect(plain.fork.firstCall.args[2].env).to.not.have.property('PEERSKY_BT_PROXIES')
  })

  it('moves a running torrent onto a new worker through the VPN when it turns on', async () => {
    const t = await load()
    await startTorrent(t)
    const [first] = t.children
    await t.mod.setTorrentProxies(VPN)
    expect(first.connected).to.equal(false)
    expect(t.fork.callCount).to.equal(2)
    expect(JSON.parse(t.fork.secondCall.args[2].env.PEERSKY_BT_PROXIES)).to.deep.equal(VPN)
    const second = t.children[1]
    expect(second.sent.filter((m) => m.action === 'start').map((m) => m.magnetUri)).to.deep.equal([MAGNET])
    const status = await t.api('status', { hash: HASH })
    expect(status).to.include({ throughVpn: true, paused: false })
  })

  it('keeps a torrent going when the VPN switches server', async () => {
    const t = await load()
    await t.mod.setTorrentProxies(VPN)
    await startTorrent(t)
    await t.mod.setTorrentProxies(OTHER_VPN)
    expect(t.fork.callCount).to.equal(2)
    expect(JSON.parse(t.fork.secondCall.args[2].env.PEERSKY_BT_PROXIES)).to.deep.equal(OTHER_VPN)
    expect(t.children[1].sent.some((m) => m.action === 'start')).to.equal(true)
  })

  it('pauses torrents when the VPN turns off, rather than going on without it', async () => {
    const t = await load()
    await t.mod.setTorrentProxies(VPN)
    await startTorrent(t)
    await t.mod.setTorrentProxies([])
    expect(t.children[0].connected).to.equal(false)
    // No worker starts again, so nothing connects directly.
    expect(t.fork.callCount).to.equal(1)
    const status = await t.api('status', { hash: HASH })
    expect(status).to.include({ paused: true, pausedForVpn: true, throughVpn: false, numPeers: 0 })
  })

  it('starts no worker without the VPN for a torrent page or its status checks', async () => {
    const t = await load()
    await t.mod.setTorrentProxies(VPN)
    await startTorrent(t)
    await t.mod.setTorrentProxies([])
    for (let i = 0; i < 3; i++) await t.api('status', { hash: HASH })
    await t.api('list')
    const page = await t.handler(new Request(`bt://${HASH}/`))
    expect(page.status).to.equal(200)
    await t.mod.warmupBittorrent()
    // Stopping or removing needs no worker either: nothing runs.
    expect(await t.api('stop', { hash: HASH }, 'POST')).to.include({ success: true })
    expect(t.fork.callCount).to.equal(1)
  })

  it('goes on without the VPN only when a torrent is resumed on purpose', async () => {
    const t = await load()
    await t.mod.setTorrentProxies(VPN)
    await startTorrent(t)
    await t.mod.setTorrentProxies([])
    expect(await t.api('resume', { hash: HASH }, 'POST')).to.include({ success: true })
    expect(t.fork.callCount).to.equal(2)
    expect(t.fork.secondCall.args[2].env).to.not.have.property('PEERSKY_BT_PROXIES')
    expect(t.children[1].sent.map((m) => m.action)).to.include('resume')
    // From then on the browser works as it does without a VPN.
    await t.api('status', { hash: HASH })
    expect(t.fork.callCount).to.equal(2)
  })

  it('picks torrents the VPN paused back up when it comes on again', async () => {
    const t = await load()
    await t.mod.setTorrentProxies(VPN)
    await startTorrent(t)
    await t.mod.setTorrentProxies([])
    await t.mod.setTorrentProxies(VPN)
    expect(t.fork.callCount).to.equal(2)
    expect(t.children[1].sent.some((m) => m.action === 'start')).to.equal(true)
    const status = await t.api('status', { hash: HASH })
    expect(status).to.include({ paused: false, throughVpn: true })
    expect(status).to.not.have.property('pausedForVpn')
  })

  it('leaves a paused torrent paused across a VPN change', async () => {
    const t = await load()
    await startTorrent(t)
    t.children[0].emit('message', { type: 'status-update-bulk', torrents: [{ ...running(), paused: true }] })
    await t.mod.setTorrentProxies(VPN)
    expect(t.fork.callCount).to.equal(1)
  })

  it('does nothing when the proxies stay the same', async () => {
    const t = await load()
    await t.mod.setTorrentProxies(VPN)
    await startTorrent(t)
    await t.mod.setTorrentProxies([{ ...VPN[0], host: VPN[0].host.toUpperCase() }])
    expect(t.fork.callCount).to.equal(1)
    expect(t.children[0].connected).to.equal(true)
  })

  it('gives the worker the extension\'s login only for a proxy the browser picked', async () => {
    const t = await load()
    const asked = []
    t.mod.setTorrentProxyCredentials(async (proxy, info) => { asked.push({ proxy, ...info }); return { username: 'u', password: 'p' } })
    await t.mod.setTorrentProxies(VPN)
    await startTorrent(t)
    const child = t.children[0]
    child.emit('message', { type: 'proxy-credentials-request', requestId: 7, proxy: VPN[0], realm: 'Redox Proxy', target: { host: '1.2.3.4', port: 6881 }, stale: false })
    child.emit('message', { type: 'proxy-credentials-request', requestId: 8, proxy: { scheme: 'https', host: 'evil.example', port: 443 }, realm: 'x', target: { host: '1.2.3.4', port: 6881 } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const replies = child.sent.filter((m) => m.type === 'proxy-credentials')
    expect(replies).to.deep.include({ type: 'proxy-credentials', requestId: 7, credentials: { username: 'u', password: 'p' } })
    expect(replies).to.deep.include({ type: 'proxy-credentials', requestId: 8, credentials: null })
    expect(asked).to.have.length(1)
    expect(asked[0]).to.deep.include({ realm: 'Redox Proxy', proxy: VPN[0] })
  })

  it('says in the torrent list whether torrents go through a VPN', async () => {
    const t = await load()
    await startTorrent(t)
    expect(await t.api('list')).to.include({ throughVpn: false })
    await t.mod.setTorrentProxies(VPN)
    expect(await t.api('list')).to.include({ throughVpn: true })
  })
})
