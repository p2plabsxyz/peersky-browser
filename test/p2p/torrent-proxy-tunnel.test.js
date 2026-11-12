// Torrents go through a VPN extension's proxy (src/protocols/bt/proxy-tunnel.js):
// each connection opens a tunnel through it, logs in when it asks, and fails
// rather than going out directly.

import { expect } from 'chai'
import { parseProxyList, validProxies, openTunnel, TunnelSocket } from '../../src/protocols/bt/proxy-tunnel.js'
import { startConnectProxy, startSocksProxy, startEchoServer, TEST_CERT } from './helpers/test-proxies.js'

const tlsOptions = { ca: TEST_CERT }

function talk (socket, line) {
  return new Promise((resolve, reject) => {
    socket.once('data', (d) => resolve(d.toString()))
    socket.once('error', reject)
    socket.write(line)
  })
}

describe('torrent proxy tunnel', function () {
  const closers = []
  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
  })
  async function echo () {
    const e = await startEchoServer()
    closers.push(e.close)
    return e
  }
  async function connectProxy (opts) {
    const p = await startConnectProxy(opts)
    closers.push(p.close)
    return p
  }
  async function socksProxy (opts) {
    const p = await startSocksProxy(opts)
    closers.push(p.close)
    return p
  }

  describe('reading the browser proxy list', () => {
    it('reads each kind the browser gives, best first, and leaves DIRECT out', () => {
      expect(parseProxyList('HTTPS maasdam-1-nl.nexorcdn.com:16858; PROXY 10.0.0.1:8080; SOCKS5 [::1]:1080; SOCKS s4:1081; DIRECT')).to.deep.equal([
        { scheme: 'https', host: 'maasdam-1-nl.nexorcdn.com', port: 16858 },
        { scheme: 'http', host: '10.0.0.1', port: 8080 },
        { scheme: 'socks5', host: '::1', port: 1080 },
        { scheme: 'socks4', host: 's4', port: 1081 }
      ])
    })

    it('means no proxy for DIRECT alone, QUIC, nonsense and nothing', () => {
      for (const text of ['DIRECT', 'QUIC proxy:443', 'HTTPS host:99999', 'garbage', '', null]) {
        expect(parseProxyList(text), String(text)).to.deep.equal([])
      }
    })

    it('fills in each kind\'s usual port', () => {
      expect(parseProxyList('HTTPS a; PROXY b; SOCKS5 c')).to.deep.equal([
        { scheme: 'https', host: 'a', port: 443 },
        { scheme: 'http', host: 'b', port: 80 },
        { scheme: 'socks5', host: 'c', port: 1080 }
      ])
    })

    it('keeps only well-formed proxies from what the worker is handed', () => {
      expect(validProxies([
        { scheme: 'https', host: 'Good.Example', port: 443 },
        { scheme: 'ftp', host: 'x', port: 21 },
        { scheme: 'http', host: 'has space', port: 80 },
        { scheme: 'http', host: 'user@host', port: 80 },
        { scheme: 'socks5', host: 'h', port: 0 },
        null
      ])).to.deep.equal([{ scheme: 'https', host: 'good.example', port: 443 }])
      expect(validProxies('not a list')).to.deep.equal([])
    })
  })

  describe('opening a tunnel', () => {
    it('goes through an HTTP proxy with CONNECT', async () => {
      const e = await echo()
      const p = await connectProxy()
      const socket = await openTunnel({ scheme: 'http', host: '127.0.0.1', port: p.port }, { host: '127.0.0.1', port: e.port })
      expect(await talk(socket, 'hi')).to.equal('echo: hi')
      expect(p.requests.map((r) => r.target)).to.deep.equal([`127.0.0.1:${e.port}`])
      expect(e.peers.every((port) => p.outboundPorts.has(port))).to.equal(true)
      socket.destroy()
    })

    it('goes through an HTTPS proxy, its certificate checked', async () => {
      const e = await echo()
      const p = await connectProxy({ tls: true })
      const socket = await openTunnel({ scheme: 'https', host: '127.0.0.1', port: p.port }, { host: '127.0.0.1', port: e.port }, { tlsOptions })
      expect(await talk(socket, 'hello')).to.equal('echo: hello')
      socket.destroy()
    })

    it('refuses an HTTPS proxy whose certificate is not trusted', async () => {
      const e = await echo()
      const p = await connectProxy({ tls: true })
      let err = null
      try {
        await openTunnel({ scheme: 'https', host: '127.0.0.1', port: p.port }, { host: '127.0.0.1', port: e.port })
      } catch (error) {
        err = error
      }
      expect(err).to.be.an('error')
      expect(p.requests).to.have.length(0)
      expect(e.peers).to.have.length(0)
    })

    it('logs in with what the extension gives when the proxy answers 407', async () => {
      const e = await echo()
      const p = await connectProxy({ tls: true, username: 'vpn-user', password: 'vpn-pass', realm: 'Redox Proxy' })
      const asked = []
      const socket = await openTunnel({ scheme: 'https', host: '127.0.0.1', port: p.port }, { host: '127.0.0.1', port: e.port }, {
        tlsOptions,
        getCredentials: async (proxy, info) => {
          asked.push({ proxy, ...info })
          return { username: 'vpn-user', password: 'vpn-pass' }
        }
      })
      expect(await talk(socket, 'in')).to.equal('echo: in')
      expect(asked).to.have.length(1)
      expect(asked[0]).to.include({ realm: 'Redox Proxy', stale: false })
      expect(asked[0].proxy).to.deep.equal({ scheme: 'https', host: '127.0.0.1', port: p.port })
      expect(asked[0].target).to.deep.equal({ host: '127.0.0.1', port: e.port })
      socket.destroy()
    })

    it('sends a login it already has, and asks again only when the proxy turns it down', async () => {
      const e = await echo()
      const p = await connectProxy({ username: 'u', password: 'new' })
      const asked = []
      const socket = await openTunnel({ scheme: 'http', host: '127.0.0.1', port: p.port }, { host: '127.0.0.1', port: e.port }, {
        cachedCredentials: () => ({ username: 'u', password: 'old' }),
        getCredentials: async (proxy, info) => {
          asked.push(info.stale)
          return { username: 'u', password: 'new' }
        }
      })
      expect(await talk(socket, 'x')).to.equal('echo: x')
      expect(asked).to.deep.equal([true])
      expect(p.requests.map((r) => r.login)).to.deep.equal(['u:old', 'u:new'])
      socket.destroy()
    })

    it('fails when the extension gives no login, and reaches nothing', async () => {
      const e = await echo()
      const p = await connectProxy({ username: 'u', password: 'p' })
      let err = null
      try {
        await openTunnel({ scheme: 'http', host: '127.0.0.1', port: p.port }, { host: '127.0.0.1', port: e.port }, { getCredentials: async () => null })
      } catch (error) {
        err = error
      }
      expect(err).to.include({ code: 'EPROXYAUTH' })
      expect(e.peers).to.have.length(0)
    })

    it('fails when the login keeps being turned down, after a fresh try', async () => {
      const e = await echo()
      const p = await connectProxy({ username: 'u', password: 'right' })
      let asked = 0
      let err = null
      try {
        await openTunnel({ scheme: 'http', host: '127.0.0.1', port: p.port }, { host: '127.0.0.1', port: e.port }, {
          getCredentials: async () => { asked++; return { username: 'u', password: 'wrong' } }
        })
      } catch (error) {
        err = error
      }
      expect(err).to.include({ code: 'EPROXYAUTH' })
      expect(asked).to.equal(2)
      expect(e.peers).to.have.length(0)
    })

    it('fails when the proxy will not connect to that port', async () => {
      const e = await echo()
      const p = await connectProxy({ refusePorts: [e.port] })
      let err = null
      try {
        await openTunnel({ scheme: 'http', host: '127.0.0.1', port: p.port }, { host: '127.0.0.1', port: e.port })
      } catch (error) {
        err = error
      }
      expect(err).to.include({ code: 'EPROXYREFUSED' })
      expect(e.peers).to.have.length(0)
    })

    it('hands the proxy a name to look up, so this computer never does', async () => {
      const e = await echo()
      const p = await connectProxy()
      const socket = await openTunnel({ scheme: 'http', host: '127.0.0.1', port: p.port }, { host: 'localhost', port: e.port })
      expect(p.requests.map((r) => r.target)).to.deep.equal([`localhost:${e.port}`])
      socket.destroy()
    })

    it('goes through SOCKS 5, names left to the proxy', async () => {
      const e = await echo()
      const p = await socksProxy({ version: 5 })
      const byAddress = await openTunnel({ scheme: 'socks5', host: '127.0.0.1', port: p.port }, { host: '127.0.0.1', port: e.port })
      expect(await talk(byAddress, 'five')).to.equal('echo: five')
      const byName = await openTunnel({ scheme: 'socks5', host: '127.0.0.1', port: p.port }, { host: 'localhost', port: e.port })
      expect(await talk(byName, 'name')).to.equal('echo: name')
      expect(p.requests.map((r) => r.target)).to.deep.equal([`127.0.0.1:${e.port}`, `localhost:${e.port}`])
      byAddress.destroy()
      byName.destroy()
    })

    it('goes through SOCKS 4a', async () => {
      const e = await echo()
      const p = await socksProxy({ version: 4 })
      const socket = await openTunnel({ scheme: 'socks4', host: '127.0.0.1', port: p.port }, { host: 'localhost', port: e.port })
      expect(await talk(socket, 'four')).to.equal('echo: four')
      expect(p.requests.map((r) => r.target)).to.deep.equal([`localhost:${e.port}`])
      socket.destroy()
    })

    it('gives up on a proxy that does not answer', async () => {
      const silent = await startEchoServer()
      closers.push(silent.close)
      silent.server.removeAllListeners('connection')
      silent.server.on('connection', (s) => { silent.sockets.add(s); s.on('error', () => {}) })
      let err = null
      const started = Date.now()
      try {
        await openTunnel({ scheme: 'http', host: '127.0.0.1', port: silent.port }, { host: '127.0.0.1', port: 9 }, { timeout: 300 })
      } catch (error) {
        err = error
      }
      expect(err).to.include({ code: 'ETIMEDOUT' })
      expect(Date.now() - started).to.be.below(3000)
    })
  })

  describe('the socket a connection gets', () => {
    it('is returned at once, emits connect when the tunnel is open, and holds early writes', async () => {
      const e = await echo()
      const p = await connectProxy()
      const socket = new TunnelSocket({ host: '127.0.0.1', port: e.port, chain: [{ scheme: 'http', host: '127.0.0.1', port: p.port }] })
      expect(socket.connecting).to.equal(true)
      expect(socket.remoteAddress).to.equal('127.0.0.1')
      expect(socket.remotePort).to.equal(e.port)
      const reply = new Promise((resolve) => socket.once('data', (d) => resolve(d.toString())))
      socket.write('early')
      await new Promise((resolve) => socket.once('connect', resolve))
      expect(socket.connecting).to.equal(false)
      expect(await reply).to.equal('echo: early')
      socket.destroy()
    })

    it('tries the next proxy when one fails, and never connects directly', async () => {
      const e = await echo()
      const dead = await startEchoServer()
      const deadPort = dead.port
      await dead.close()
      const p = await connectProxy()
      const socket = new TunnelSocket({
        host: '127.0.0.1',
        port: e.port,
        chain: [{ scheme: 'http', host: '127.0.0.1', port: deadPort }, { scheme: 'http', host: '127.0.0.1', port: p.port }]
      })
      await new Promise((resolve) => socket.once('connect', resolve))
      expect(await talk(socket, 'second')).to.equal('echo: second')
      expect(e.peers.every((port) => p.outboundPorts.has(port))).to.equal(true)
      socket.destroy()
    })

    it('fails with the last error when no proxy works', async () => {
      const e = await echo()
      const dead = await startEchoServer()
      const deadPort = dead.port
      await dead.close()
      const socket = new TunnelSocket({ host: '127.0.0.1', port: e.port, chain: [{ scheme: 'http', host: '127.0.0.1', port: deadPort }] })
      const err = await new Promise((resolve) => socket.once('error', resolve))
      expect(err).to.be.an('error')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(e.peers).to.have.length(0)
    })

    it('carries TLS for an https request through the tunnel', async () => {
      // As fetch() does for an https:// address: TLS over the tunnel socket.
      const tls = await import('node:tls')
      const target = tls.createServer({ key: (await import('./helpers/test-proxies.js')).TEST_KEY, cert: TEST_CERT }, (s) => {
        s.on('data', (d) => s.write(`secure: ${d}`))
        s.on('error', () => {})
      })
      await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve))
      closers.push(() => new Promise((resolve) => target.close(() => resolve())))
      const p = await connectProxy({ tls: true })
      const tunnel = new TunnelSocket({ host: '127.0.0.1', port: target.address().port, chain: [{ scheme: 'https', host: '127.0.0.1', port: p.port }], tlsOptions })
      const secure = tls.connect({ socket: tunnel, ca: TEST_CERT, host: '127.0.0.1' })
      await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject) })
      expect(await talk(secure, 'inner')).to.equal('secure: inner')
      secure.destroy()
    })
  })
})
