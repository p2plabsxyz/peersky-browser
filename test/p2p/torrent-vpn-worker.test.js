// The real torrent worker (src/protocols/bt/worker.js), started as the browser
// starts it with a VPN extension's proxy, downloads real torrents through it:
// from a peer found on an HTTP tracker, and from a web seed. A local tracker,
// seeder and web server record who connected to them, and every connection
// they saw came from the proxy. The proxy wants a login, which the worker
// asks of the "browser" (this test) over IPC.

import { expect } from 'chai'
import { fork } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import WebTorrent from 'webtorrent'
import TrackerServer from 'bittorrent-tracker/server'
import createTorrent from 'create-torrent'
import parseTorrent, { toMagnetURI } from 'parse-torrent'
import { startConnectProxy, TEST_CERT_PATH } from './helpers/test-proxies.js'

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'protocols', 'bt', 'worker.js')
const LOGIN = { username: 'vpn-user', password: 'vpn-token' }

function listen (server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function makeTorrent (file, opts) {
  return new Promise((resolve, reject) => createTorrent(file, opts, (err, buf) => (err ? reject(err) : resolve(buf))))
}

describe('torrent worker through a VPN proxy', function () {
  this.timeout(120000)
  const cleanups = []
  let dir

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-bt-vpn-'))
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  })
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) {
      try { await fn() } catch {}
    }
  })

  function writeContent (name, size) {
    const folder = path.join(dir, 'source')
    fs.mkdirSync(folder, { recursive: true })
    const file = path.join(folder, name)
    fs.writeFileSync(file, crypto.randomBytes(size))
    return file
  }

  async function startProxy () {
    const proxy = await startConnectProxy({ tls: true, ...LOGIN, realm: 'Test VPN' })
    cleanups.push(proxy.close)
    return proxy
  }

  // Starts worker.js as bittorrent-handler.js does, with the proxy in its
  // environment, and answers its login requests as the browser would.
  function startWorker (proxy) {
    const downloads = path.join(dir, 'downloads')
    const kept = path.join(dir, 'kept')
    const child = fork(WORKER, [downloads, kept], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'advanced',
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: TEST_CERT_PATH,
        PEERSKY_BT_PROXIES: JSON.stringify([{ scheme: 'https', host: 'localhost', port: proxy.port }])
      }
    })
    const log = []
    child.stdout.on('data', (d) => log.push(String(d)))
    child.stderr.on('data', (d) => log.push(String(d)))
    const worker = { child, log, downloads, loginRequests: [], statuses: [], done: new Set() }
    child.on('message', (msg) => {
      if (msg.type === 'proxy-credentials-request') {
        worker.loginRequests.push(msg)
        child.send({ type: 'proxy-credentials', requestId: msg.requestId, credentials: LOGIN })
      }
      if (msg.type === 'status-update-bulk') worker.statuses.push(...msg.torrents)
      if (msg.type === 'done') worker.done.add(msg.infoHash)
    })
    cleanups.push(() => new Promise((resolve) => {
      child.once('exit', resolve)
      try { child.disconnect() } catch { child.kill() }
      setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5000).unref()
    }))
    worker.ready = new Promise((resolve) => child.on('message', (msg) => { if (msg.type === 'ready') resolve() }))
    worker.untilDone = (infoHash, ms = 90000) => new Promise((resolve, reject) => {
      const started = Date.now()
      const check = setInterval(() => {
        if (worker.done.has(infoHash)) { clearInterval(check); resolve() }
        if (Date.now() - started > ms) { clearInterval(check); reject(new Error(`not done in time:\n${log.join('').slice(-3000)}`)) }
      }, 200)
    })
    return worker
  }

  async function startTracker () {
    const seen = []
    const tracker = new TrackerServer({ udp: false, ws: false, http: true, stats: false })
    await new Promise((resolve) => tracker.listen(0, '127.0.0.1', resolve))
    tracker.http.on('request', (req) => seen.push(req.socket.remotePort))
    cleanups.push(() => new Promise((resolve) => tracker.close(resolve)))
    return { url: `http://127.0.0.1:${tracker.http.address().port}/announce`, seen }
  }

  it('downloads from a peer it finds on a tracker, all through the proxy', async () => {
    const proxy = await startProxy()
    const tracker = await startTracker()
    const file = writeContent('skeleton-dance.bin', 3 * 1024 * 1024)
    const torrentFile = await makeTorrent(file, { announceList: [[tracker.url], ['udp://tracker.example:1337']], name: 'skeleton-dance.bin' })
    const parsed = await parseTorrent(torrentFile)

    // A seeder that never connects out, so every connection it sees is the worker coming in.
    const seeder = new WebTorrent({ dht: false, lsd: false, utp: false, natUpnp: false, natPmp: false, seedOutgoingConnections: false })
    cleanups.push(() => new Promise((resolve) => seeder.destroy(resolve)))
    const seederPeers = []
    await new Promise((resolve) => seeder.seed(file, { announce: [tracker.url], name: 'skeleton-dance.bin' }, (t) => {
      t.on('wire', (wire, addr) => seederPeers.push(Number(String(addr).split(':').pop())))
      resolve()
    }))

    const worker = startWorker(proxy)
    await worker.ready
    worker.child.send({ id: 1, action: 'start', magnetUri: toMagnetURI(parsed), announce: [tracker.url, 'udp://tracker.opentrackr.org:1337/announce'] })
    await worker.untilDone(parsed.infoHash)

    const got = fs.readFileSync(path.join(worker.downloads, 'skeleton-dance.bin'))
    expect(got.equals(fs.readFileSync(file))).to.equal(true)

    // The tracker and the seeder heard from the proxy only.
    const fromProxy = (port) => proxy.outboundPorts.has(port)
    const trackerFromWorker = tracker.seen.filter(fromProxy)
    expect(trackerFromWorker.length, 'tracker announces through the proxy').to.be.greaterThan(0)
    expect(seederPeers.length).to.be.greaterThan(0)
    expect(seederPeers.every(fromProxy), `seeder peers ${seederPeers} vs proxy ${[...proxy.outboundPorts]}`).to.equal(true)
    // The UDP tracker was dropped rather than tried.
    expect(proxy.requests.some((r) => /1337/.test(r.target))).to.equal(false)
    expect(worker.log.join('')).to.include('Torrents go through the VPN extension')
    // The login was asked of the browser once, for the proxy it picked.
    expect(worker.loginRequests).to.have.length(1)
    expect(worker.loginRequests[0]).to.deep.include({ realm: 'Test VPN', stale: false })
    expect(worker.loginRequests[0].proxy).to.deep.equal({ scheme: 'https', host: 'localhost', port: proxy.port })
  })

  it('downloads from a web seed through the proxy', async () => {
    const proxy = await startProxy()
    const file = writeContent('haunted-house.bin', 2 * 1024 * 1024)
    const webPeers = []
    const web = http.createServer((req, res) => {
      webPeers.push(req.socket.remotePort)
      const data = fs.readFileSync(file)
      const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '')
      if (range) {
        const start = Number(range[1])
        const end = Number(range[2])
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 })
        return res.end(data.subarray(start, end + 1))
      }
      res.end(data)
    })
    const webPort = await listen(web)
    cleanups.push(() => new Promise((resolve) => { web.closeAllConnections?.(); web.close(resolve) }))
    const torrentFile = await makeTorrent(file, { urlList: [`http://127.0.0.1:${webPort}/haunted-house.bin`], announceList: [], name: 'haunted-house.bin' })
    const parsed = await parseTorrent(torrentFile)
    fs.mkdirSync(path.join(dir, 'kept'), { recursive: true })
    // Kept as the worker keeps a torrent's file, so it starts from the full metadata.
    fs.writeFileSync(path.join(dir, 'kept', `${parsed.infoHash}.torrent`), torrentFile)

    const worker = startWorker(proxy)
    await worker.ready
    worker.child.send({ id: 1, action: 'start', magnetUri: toMagnetURI(parsed), announce: [] })
    await worker.untilDone(parsed.infoHash)

    expect(fs.readFileSync(path.join(worker.downloads, 'haunted-house.bin')).equals(fs.readFileSync(file))).to.equal(true)
    expect(webPeers.length).to.be.greaterThan(0)
    expect(webPeers.every((port) => proxy.outboundPorts.has(port)), 'web seed requests through the proxy').to.equal(true)
  })

  it('will not start at all when the VPN proxies it is handed cannot be read', async () => {
    for (const given of ['not json', '[{"scheme":"ftp","host":"x","port":21}]', '{}']) {
      const child = fork(WORKER, [path.join(dir, 'd'), path.join(dir, 'k')], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, PEERSKY_BT_PROXIES: given }
      })
      let ready = false
      child.on('message', (m) => { if (m.type === 'ready') ready = true })
      const code = await new Promise((resolve) => child.once('exit', resolve))
      expect(code, given).to.equal(1)
      expect(ready, given).to.equal(false)
    }
  })

  it('downloads nothing when the proxy will not let it log in', async () => {
    const proxy = await startConnectProxy({ tls: true, username: 'someone', password: 'else', realm: 'Test VPN' })
    cleanups.push(proxy.close)
    const tracker = await startTracker()
    const file = writeContent('blocked.bin', 512 * 1024)
    const torrentFile = await makeTorrent(file, { announceList: [[tracker.url]], name: 'blocked.bin' })
    const parsed = await parseTorrent(torrentFile)
    const seeder = new WebTorrent({ dht: false, lsd: false, utp: false, natUpnp: false, natPmp: false, seedOutgoingConnections: false })
    cleanups.push(() => new Promise((resolve) => seeder.destroy(resolve)))
    const seederPeers = []
    await new Promise((resolve) => seeder.seed(file, { announce: [tracker.url], name: 'blocked.bin' }, (t) => {
      t.on('wire', (wire, addr) => seederPeers.push(addr))
      resolve()
    }))

    const worker = startWorker(proxy)
    await worker.ready
    worker.child.send({ id: 1, action: 'start', magnetUri: toMagnetURI(parsed), announce: [tracker.url] })
    await new Promise((resolve) => setTimeout(resolve, 6000))
    expect(worker.done.size).to.equal(0)
    expect(seederPeers).to.have.length(0)
    // The tracker heard only the seeder, never the worker directly.
    expect(tracker.seen.every((port) => !proxy.outboundPorts.has(port))).to.equal(true)
    expect(proxy.challenges).to.be.greaterThan(0)
  })
})
