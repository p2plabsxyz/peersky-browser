// While a VPN extension is on, the torrent worker reaches the internet only
// through its proxy (src/protocols/bt/network-lock.js). The lock changes
// Node's own modules, so each check runs in a child process
// (helpers/lock-probe.mjs) and reports back.

import { expect } from 'chai'
import { execFile } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installNetworkLock, connectTarget, keepTracker, loopbackListenArgs } from '../../src/protocols/bt/network-lock.js'
import { startConnectProxy, startSocksProxy, startEchoServer, TEST_CERT, TEST_KEY, TEST_CERT_PATH } from './helpers/test-proxies.js'
import net from 'node:net'
import dgram from 'node:dgram'

const PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'lock-probe.mjs')

function listen (server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function runProbe (args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [PROBE, ...args], { env: { ...process.env, NODE_EXTRA_CA_CERTS: TEST_CERT_PATH }, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`probe failed: ${err.message}\n${stderr}`))
      resolve(JSON.parse(stdout.trim().split('\n').pop()))
    })
  })
}

describe('torrent network lock', function () {
  this.timeout(60000)
  const closers = []
  let echo, web, secure, seen

  beforeEach(async () => {
    seen = []
    echo = await startEchoServer()
    web = http.createServer((req, res) => { seen.push({ path: req.url, port: req.socket.remotePort }); res.end(`plain ${req.url}`) })
    secure = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => { seen.push({ path: req.url, port: req.socket.remotePort }); res.end(`secure ${req.url}`) })
    closers.push(echo.close, () => new Promise((resolve) => web.close(resolve)), () => new Promise((resolve) => secure.close(resolve)))
    web.port = await listen(web)
    secure.port = await listen(secure)
  })
  afterEach(async () => {
    web.closeAllConnections?.()
    secure.closeAllConnections?.()
    for (const close of closers.splice(0)) await close()
  })

  async function probeThrough (proxy, descriptor, login = null) {
    closers.push(proxy.close)
    const results = await runProbe([JSON.stringify(descriptor), String(echo.port), String(web.port), String(secure.port), JSON.stringify(login)])
    return results
  }

  function expectEverythingThroughProxy (results, proxy) {
    expect(results.locked).to.equal(true)
    expect(results.netConnect).to.deep.equal({ reply: 'echo: via net.connect' })
    expect(results.fetchHttp).to.deep.equal({ body: 'plain /plain' })
    expect(results.fetchHttps).to.deep.equal({ body: 'secure /secure' })
    expect(results.httpGet).to.deep.equal({ body: 'plain /module' })
    // Everything the servers saw came from the proxy's own connections.
    const fromProxy = (port) => proxy.outboundPorts.has(port)
    expect(echo.peers.length).to.be.greaterThan(0)
    expect(echo.peers.every(fromProxy), 'echo peers').to.equal(true)
    expect(seen.length).to.equal(3)
    expect(seen.every((s) => fromProxy(s.port)), 'web peers').to.equal(true)
  }

  function expectNothingElseGetsOut (results) {
    expect(results.rawSocket).to.deep.equal({ error: 'EPERM' })
    expect(results.udp).to.deep.equal({ error: 'EPERM' })
    expect(results.lookupName).to.deep.equal({ error: 'ENOTFOUND' })
    expect(results.lookupPromise).to.deep.equal({ error: 'ENOTFOUND' })
    expect(results.resolver).to.deep.equal({ error: 'ENOTFOUND' })
    expect(results.lookupLocalhost).to.deep.equal({ ok: true })
    // Nothing outside this computer can connect in around the proxy.
    expect(results.listen).to.deep.equal({ address: '127.0.0.1' })
    expect(results.listenOptions).to.deep.equal({ address: '127.0.0.1' })
    expect(results.clientOptions).to.deep.equal({ dht: false, utp: false, lsd: false, natUpnp: false, natPmp: false })
  }

  it('sends connections, fetch and http through an HTTP proxy, and nothing else gets out', async () => {
    const proxy = await startConnectProxy()
    const results = await probeThrough(proxy, { scheme: 'http', host: '127.0.0.1', port: proxy.port })
    expectEverythingThroughProxy(results, proxy)
    expectNothingElseGetsOut(results)
    // fetch's https:// name went to the proxy to look up, not to this computer's DNS.
    expect(proxy.requests.map((r) => r.target)).to.include(`localhost:${secure.port}`)
  })

  it('goes through an HTTPS proxy that wants a login, asking the extension once', async () => {
    const proxy = await startConnectProxy({ tls: true, username: 'vpn', password: 'token', realm: 'Redox Proxy' })
    const results = await probeThrough(proxy, { scheme: 'https', host: 'localhost', port: proxy.port }, { username: 'vpn', password: 'token' })
    expectEverythingThroughProxy(results, proxy)
    expectNothingElseGetsOut(results)
    expect(results.asked).to.deep.equal([{ realm: 'Redox Proxy', stale: false }])
  })

  it('goes through a SOCKS 5 proxy', async () => {
    const proxy = await startSocksProxy({ version: 5 })
    const results = await probeThrough(proxy, { scheme: 'socks5', host: '127.0.0.1', port: proxy.port })
    expectEverythingThroughProxy(results, proxy)
    expectNothingElseGetsOut(results)
  })

  it('fails rather than going direct when the proxy is down', async () => {
    const proxy = await startConnectProxy()
    const port = proxy.port
    await proxy.close()
    const results = await runProbe([JSON.stringify({ scheme: 'http', host: '127.0.0.1', port }), String(echo.port), String(web.port), String(secure.port), 'null'])
    expect(results.netConnect.error).to.be.a('string')
    expect(results.fetchHttp.error).to.be.a('string')
    expect(results.fetchHttps.error).to.be.a('string')
    expect(echo.peers).to.have.length(0)
    expect(seen).to.have.length(0)
  })

  it('fails rather than going direct when the extension gives no login', async () => {
    const proxy = await startConnectProxy({ username: 'u', password: 'p' })
    const results = await probeThrough(proxy, { scheme: 'http', host: '127.0.0.1', port: proxy.port }, null)
    expect(results.netConnect.error).to.be.a('string')
    expect(echo.peers).to.have.length(0)
    expect(seen).to.have.length(0)
  })

  it('changes nothing without a proxy', () => {
    const before = { connect: net.connect, socketConnect: net.Socket.prototype.connect, listen: net.Server.prototype.listen, createSocket: dgram.createSocket }
    expect(installNetworkLock({ proxies: [] })).to.equal(null)
    expect(installNetworkLock({ proxies: [{ scheme: 'ftp', host: 'x', port: 1 }] })).to.equal(null)
    expect(net.connect).to.equal(before.connect)
    expect(net.Socket.prototype.connect).to.equal(before.socketConnect)
    expect(net.Server.prototype.listen).to.equal(before.listen)
    expect(dgram.createSocket).to.equal(before.createSocket)
  })

  it('reads where each form of connect call goes', () => {
    expect(connectTarget([{ host: 'Example.com', port: 80 }])).to.deep.equal({ host: 'example.com', port: 80 })
    expect(connectTarget([[{ host: '1.2.3.4', port: 6881 }, () => {}]])).to.deep.equal({ host: '1.2.3.4', port: 6881 })
    expect(connectTarget([443, 'host.example'])).to.deep.equal({ host: 'host.example', port: 443 })
    expect(connectTarget([8080])).to.deep.equal({ host: 'localhost', port: 8080 })
    expect(connectTarget(['/tmp/peersky.sock'])).to.deep.equal({ path: '/tmp/peersky.sock' })
    expect(connectTarget([{ path: '\\\\.\\pipe\\peersky' }])).to.deep.equal({ path: '\\\\.\\pipe\\peersky' })
  })

  it('moves every way of listening on a port onto loopback, and leaves local IPC alone', () => {
    const cb = () => {}
    const host = '127.0.0.1'
    expect(loopbackListenArgs([6881])).to.deep.equal([{ port: 6881, host }])
    expect(loopbackListenArgs(['6881', cb])).to.deep.equal([{ port: 6881, host }, cb])
    expect(loopbackListenArgs([6881, '0.0.0.0', 511, cb])).to.deep.equal([{ port: 6881, backlog: 511, host }, cb])
    expect(loopbackListenArgs([0, 128])).to.deep.equal([{ port: 0, backlog: 128, host }])
    expect(loopbackListenArgs([{ port: 0, host: '::', ipv6Only: true }])).to.deep.equal([{ port: 0, host }])
    expect(loopbackListenArgs([])).to.deep.equal([{ port: 0, host }])
    expect(loopbackListenArgs([cb])).to.deep.equal([{ port: 0, host }, cb])
    for (const ipc of [['/tmp/peersky.sock'], [{ path: '\\\\.\\pipe\\peersky' }, cb], [{ fd: 3 }], [{ handle: {} }]]) {
      expect(loopbackListenArgs(ipc)).to.equal(ipc)
    }
  })

  it('keeps only trackers a proxy can carry', () => {
    expect(['http://bt1.archive.org:6969/announce', 'https://t.example/announce', 'udp://tracker.opentrackr.org:1337', 'wss://tracker.webtorrent.dev', 'ws://x'].filter(keepTracker))
      .to.deep.equal(['http://bt1.archive.org:6969/announce', 'https://t.example/announce'])
  })
})
