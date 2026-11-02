// Local proxies for the torrent VPN tests, the kinds VPN extensions use:
// HTTP CONNECT, plain or over TLS, with or without a Basic login, and SOCKS
// 4a and 5. Each keeps what it was asked to reach and the local port of every
// connection it made onward, so a test can tell a connection that came
// through the proxy from one that did not.

import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'proxy-tls')
export const TEST_CERT = fs.readFileSync(path.join(FIXTURES, 'cert.pem'))
export const TEST_KEY = fs.readFileSync(path.join(FIXTURES, 'key.pem'))
export const TEST_CERT_PATH = path.join(FIXTURES, 'cert.pem')

function listen (server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function track (proxy, socket) {
  proxy.sockets.add(socket)
  socket.on('close', () => proxy.sockets.delete(socket))
  socket.on('error', () => {})
}

function pipeOnward (proxy, client, host, port, onOpen, onFail) {
  const upstream = net.connect({ host, port })
  track(proxy, upstream)
  upstream.once('connect', () => {
    proxy.outboundPorts.add(upstream.localPort)
    onOpen()
    upstream.pipe(client)
    client.pipe(upstream)
  })
  upstream.once('error', () => onFail())
  client.on('close', () => upstream.destroy())
  upstream.on('close', () => client.destroy())
}

/**
 * An HTTP CONNECT proxy. { tls: true } puts TLS in front, as an HTTPS proxy
 * has. { username, password } makes it answer 407 until it gets them, with
 * the realm given. { refusePorts } turns CONNECTs to those ports down (403).
 */
export async function startConnectProxy ({ tls: useTls = false, username = null, password = null, realm = 'Test Proxy', refusePorts = [] } = {}) {
  const proxy = { kind: useTls ? 'https' : 'http', requests: [], outboundPorts: new Set(), sockets: new Set(), challenges: 0 }
  const onConnection = (client) => {
    track(proxy, client)
    let head = Buffer.alloc(0)
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) return
      client.removeListener('data', onData)
      const rest = head.subarray(end + 4)
      const lines = head.subarray(0, end).toString('latin1').split('\r\n')
      const m = /^CONNECT (\S+) HTTP\/1\.[01]$/.exec(lines[0])
      if (!m) return client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n')
      const auth = lines.find((l) => /^proxy-authorization:/i.test(l))
      const given = auth ? Buffer.from(auth.split(/\s+/)[2] || '', 'base64').toString('utf8') : null
      proxy.requests.push({ target: m[1], login: given })
      if (username !== null && given !== `${username}:${password}`) {
        proxy.challenges++
        return client.end(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${realm}"\r\nContent-Length: 0\r\n\r\n`)
      }
      const at = m[1].lastIndexOf(':')
      const host = m[1].slice(0, at).replace(/^\[|\]$/g, '')
      const port = Number(m[1].slice(at + 1))
      if (refusePorts.includes(port)) return client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
      client.pause()
      pipeOnward(proxy, client, host, port, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (rest.length) client.unshift(rest)
        client.resume()
      }, () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
    }
    client.on('data', onData)
  }
  const server = useTls
    ? tls.createServer({ key: TEST_KEY, cert: TEST_CERT }, onConnection)
    : net.createServer(onConnection)
  proxy.server = server
  proxy.port = await listen(server)
  proxy.close = () => new Promise((resolve) => {
    for (const s of proxy.sockets) s.destroy()
    server.close(() => resolve())
  })
  return proxy
}

function readExactly (socket, n) {
  return new Promise((resolve, reject) => {
    const tryRead = () => {
      const chunk = socket.read(n)
      if (chunk === null) return
      socket.removeListener('readable', tryRead)
      socket.removeListener('error', onError)
      resolve(chunk)
    }
    const onError = (err) => {
      socket.removeListener('readable', tryRead)
      reject(err)
    }
    socket.on('readable', tryRead)
    socket.once('error', onError)
    tryRead()
  })
}

/** A SOCKS proxy, 5 or 4a, without login, as Chrome speaks it. */
export async function startSocksProxy ({ version = 5 } = {}) {
  const proxy = { kind: `socks${version}`, requests: [], outboundPorts: new Set(), sockets: new Set() }
  const server = net.createServer(async (client) => {
    track(proxy, client)
    try {
      let host, port
      if (version === 5) {
        const [ver, n] = await readExactly(client, 2)
        if (ver !== 5) return client.destroy()
        await readExactly(client, n)
        client.write(Buffer.from([5, 0]))
        const head = await readExactly(client, 4)
        if (head[3] === 1) host = [...await readExactly(client, 4)].join('.')
        else if (head[3] === 3) host = (await readExactly(client, (await readExactly(client, 1))[0])).toString('utf8')
        else if (head[3] === 4) {
          const b = await readExactly(client, 16)
          host = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(':')
        }
        port = (await readExactly(client, 2)).readUInt16BE(0)
      } else {
        const head = await readExactly(client, 8)
        port = head.readUInt16BE(2)
        const ip = [...head.subarray(4, 8)]
        // Skip the user id, which ends with a zero byte.
        let userIdByte = await readExactly(client, 1)
        while (userIdByte[0] !== 0) userIdByte = await readExactly(client, 1)
        if (ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0) {
          let name = ''
          for (let c = await readExactly(client, 1); c[0] !== 0; c = await readExactly(client, 1)) name += String.fromCharCode(c[0])
          host = name
        } else {
          host = ip.join('.')
        }
      }
      proxy.requests.push({ target: `${host}:${port}` })
      client.pause()
      const ok = version === 5 ? Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]) : Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0])
      const fail = version === 5 ? Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]) : Buffer.from([0, 0x5b, 0, 0, 0, 0, 0, 0])
      pipeOnward(proxy, client, host === 'localhost' ? '127.0.0.1' : host, port, () => {
        client.write(ok)
        client.resume()
      }, () => client.end(fail))
    } catch {
      client.destroy()
    }
  })
  proxy.server = server
  proxy.port = await listen(server)
  proxy.close = () => new Promise((resolve) => {
    for (const s of proxy.sockets) s.destroy()
    server.close(() => resolve())
  })
  return proxy
}

/** A TCP server that answers each line with "echo: line" and keeps who connected. */
export async function startEchoServer () {
  const echo = { peers: [], sockets: new Set() }
  const server = net.createServer((socket) => {
    echo.peers.push(socket.remotePort)
    echo.sockets.add(socket)
    socket.on('close', () => echo.sockets.delete(socket))
    socket.on('data', (d) => socket.write(`echo: ${d}`))
    socket.on('error', () => {})
  })
  echo.server = server
  echo.port = await listen(server)
  echo.close = () => new Promise((resolve) => {
    for (const s of echo.sockets) s.destroy()
    server.close(() => resolve())
  })
  return echo
}
