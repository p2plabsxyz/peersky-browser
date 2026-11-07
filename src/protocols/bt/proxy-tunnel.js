// Torrent connections through the proxy a VPN extension sets in the browser.
// The browser's own requests follow that proxy, but torrents run in a Node
// process of their own, which knows nothing of it. Each connection here opens
// a tunnel through the proxy instead: HTTP CONNECT, over TLS for an HTTPS proxy,
// or SOCKS. A proxy that asks for a login (407) gets the one the extension
// gives, as the browser would. When every proxy fails, the connection fails
// too, and never goes out directly.

import net from 'node:net'
import tls from 'node:tls'
import { Duplex } from 'node:stream'

const SCHEMES = { PROXY: 'http', HTTP: 'http', HTTPS: 'https', SOCKS: 'socks4', SOCKS4: 'socks4', SOCKS5: 'socks5' }
const DEFAULT_PORTS = { http: 80, https: 443, socks4: 1080, socks5: 1080 }
const MAX_HEAD_BYTES = 16 * 1024
const DEFAULT_TIMEOUT_MS = 15000

/** host:port as a proxy list writes it, IPv6 in brackets. */
function parseHostPort (text, defaultPort) {
  const m = /^\[([0-9a-f:.]+)\](?::(\d+))?$/i.exec(text) || /^([^\s:[\]]+)(?::(\d+))?$/.exec(text)
  if (!m) return null
  const port = m[2] === undefined ? defaultPort : Number(m[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: m[1].toLowerCase(), port }
}

/**
 * The proxies in a list like the browser's resolveProxy() gives:
 * "HTTPS host:443; PROXY host:8080; SOCKS5 host:1080; DIRECT". DIRECT and
 * kinds this cannot speak (QUIC) are left out, so a list of only those means
 * no proxy.
 */
export function parseProxyList (text) {
  const proxies = []
  for (const part of String(text || '').split(';')) {
    const m = /^\s*([A-Za-z0-9]+)\s+(\S+)\s*$/.exec(part)
    if (!m) continue
    const scheme = SCHEMES[m[1].toUpperCase()]
    if (!scheme) continue
    const hostPort = parseHostPort(m[2], DEFAULT_PORTS[scheme])
    if (hostPort) proxies.push({ scheme, ...hostPort })
  }
  return proxies
}

/** A proxy list as the worker receives it: well formed, or nothing. */
export function validProxies (value) {
  if (!Array.isArray(value)) return []
  return value.filter((p) =>
    p && Object.hasOwn(DEFAULT_PORTS, p.scheme) &&
    typeof p.host === 'string' && /^[^\s/@]+$/.test(p.host) && p.host.length <= 253 &&
    Number.isInteger(p.port) && p.port >= 1 && p.port <= 65535
  ).map((p) => ({ scheme: p.scheme, host: p.host.toLowerCase(), port: p.port }))
}

export function proxyKey (proxy) {
  return `${proxy.scheme}://${proxy.host}:${proxy.port}`
}

function authority (host, port) {
  return `${net.isIPv6(host) ? `[${host}]` : host}:${port}`
}

export class ProxyError extends Error {
  constructor (message, code = 'EPROXY') {
    super(message)
    this.code = code
  }
}

// A tunnel that takes too long fails, and the sockets it opened to the proxy
// close with it rather than linger.
function withTimeout (promise, ms, deps) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        for (const socket of deps.sockets) socket.destroy()
        reject(new ProxyError('The VPN proxy did not answer in time', 'ETIMEDOUT'))
      }, ms)
      timer.unref?.()
    })
  ]).finally(() => clearTimeout(timer))
}

/** Connects to the proxy itself: TCP, or TLS checked against its name for an HTTPS proxy. */
function connectToProxy (proxy, deps) {
  return new Promise((resolve, reject) => {
    const socket = proxy.scheme === 'https'
      ? deps.tlsConnect({ host: proxy.host, port: proxy.port, servername: net.isIP(proxy.host) ? undefined : proxy.host, ALPNProtocols: ['http/1.1'], ...deps.tlsOptions })
      : deps.connect({ host: proxy.host, port: proxy.port })
    deps.sockets.add(socket)
    socket.once('close', () => deps.sockets.delete(socket))
    const ready = proxy.scheme === 'https' ? 'secureConnect' : 'connect'
    const onError = (err) => { socket.destroy(); reject(err) }
    socket.once('error', onError)
    socket.once(ready, () => {
      socket.removeListener('error', onError)
      resolve(socket)
    })
  })
}

/** Reads exactly n bytes without switching the socket to flowing mode. */
function readBytes (socket, n) {
  return new Promise((resolve, reject) => {
    const tryRead = () => {
      const chunk = socket.read(n)
      if (chunk === null) return
      cleanup()
      resolve(chunk)
    }
    const onEnd = () => { cleanup(); reject(new ProxyError('The VPN proxy closed the connection')) }
    const onError = (err) => { cleanup(); reject(err) }
    function cleanup () {
      socket.removeListener('readable', tryRead)
      socket.removeListener('end', onEnd)
      socket.removeListener('close', onEnd)
      socket.removeListener('error', onError)
    }
    socket.on('readable', tryRead)
    socket.once('end', onEnd)
    socket.once('close', onEnd)
    socket.once('error', onError)
    tryRead()
  })
}

/** The status and headers of an HTTP response; anything after them stays in the socket. */
function readResponseHead (socket) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const onReadable = () => {
      let chunk
      while ((chunk = socket.read()) !== null) {
        buffered = Buffer.concat([buffered, chunk])
        const end = buffered.indexOf('\r\n\r\n')
        if (end !== -1) {
          cleanup()
          const rest = buffered.subarray(end + 4)
          if (rest.length) socket.unshift(rest)
          const lines = buffered.subarray(0, end).toString('latin1').split('\r\n')
          const status = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0])
          if (!status) return reject(new ProxyError('The VPN proxy gave an answer that is not HTTP'))
          const headers = {}
          for (const line of lines.slice(1)) {
            const i = line.indexOf(':')
            if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
          }
          return resolve({ statusCode: Number(status[1]), headers })
        }
        if (buffered.length > MAX_HEAD_BYTES) {
          cleanup()
          return reject(new ProxyError('The VPN proxy sent too long an answer'))
        }
      }
    }
    const onEnd = () => { cleanup(); reject(new ProxyError('The VPN proxy closed the connection')) }
    const onError = (err) => { cleanup(); reject(err) }
    function cleanup () {
      socket.removeListener('readable', onReadable)
      socket.removeListener('end', onEnd)
      socket.removeListener('close', onEnd)
      socket.removeListener('error', onError)
    }
    socket.on('readable', onReadable)
    socket.once('end', onEnd)
    socket.once('close', onEnd)
    socket.once('error', onError)
    onReadable()
  })
}

function basicRealm (header) {
  if (!header || !/^\s*basic\b/i.test(header)) return null
  const m = /realm="([^"]*)"/i.exec(header)
  return m ? m[1] : ''
}

async function httpConnect (proxy, target, deps, credentials) {
  const socket = await connectToProxy(proxy, deps)
  try {
    const where = authority(target.host, target.port)
    let request = `CONNECT ${where} HTTP/1.1\r\nHost: ${where}\r\n`
    if (credentials) {
      const token = Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64')
      request += `Proxy-Authorization: Basic ${token}\r\n`
    }
    socket.write(`${request}\r\n`)
    const { statusCode, headers } = await readResponseHead(socket)
    if (statusCode >= 200 && statusCode < 300) return { socket }
    socket.destroy()
    if (statusCode === 407) {
      const realm = basicRealm(headers['proxy-authenticate'])
      if (realm === null) throw new ProxyError('The VPN proxy asks for a kind of login this cannot give', 'EPROXYAUTH')
      return { realm }
    }
    throw new ProxyError(`The VPN proxy would not connect to ${where} (${statusCode})`, 'EPROXYREFUSED')
  } catch (err) {
    socket.destroy()
    throw err
  }
}

function socksAddress (host) {
  if (net.isIPv4(host)) return Buffer.from([1, ...host.split('.').map(Number)])
  if (net.isIPv6(host)) {
    const parts = expandIPv6(host)
    const bytes = Buffer.alloc(16)
    parts.forEach((p, i) => bytes.writeUInt16BE(p, i * 2))
    return Buffer.concat([Buffer.from([4]), bytes])
  }
  const name = Buffer.from(host, 'utf8')
  if (name.length > 255) throw new ProxyError('That host name is too long for SOCKS')
  return Buffer.concat([Buffer.from([3, name.length]), name])
}

function expandIPv6 (host) {
  let [head, tail] = host.split('::')
  const toNums = (s) => (s ? s.split(':') : []).flatMap((part) => {
    if (part.includes('.')) {
      const [a, b, c, d] = part.split('.').map(Number)
      return [(a << 8) | b, (c << 8) | d]
    }
    return [parseInt(part, 16)]
  })
  head = toNums(head)
  tail = toNums(tail)
  return [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail]
}

const SOCKS5_REPLIES = {
  1: 'general failure',
  2: 'not allowed by its rules',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported'
}

async function socks5Connect (proxy, target, deps) {
  const socket = await connectToProxy(proxy, deps)
  try {
    socket.write(Buffer.from([5, 1, 0]))
    const greeting = await readBytes(socket, 2)
    if (greeting[0] !== 5 || greeting[1] !== 0) throw new ProxyError('The SOCKS proxy asks for a login, which the browser never gives one', 'EPROXYAUTH')
    const port = Buffer.alloc(2)
    port.writeUInt16BE(target.port)
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), socksAddress(target.host), port]))
    const head = await readBytes(socket, 4)
    if (head[0] !== 5) throw new ProxyError('The SOCKS proxy gave an answer that is not SOCKS 5')
    if (head[1] !== 0) throw new ProxyError(`The SOCKS proxy would not connect: ${SOCKS5_REPLIES[head[1]] || `code ${head[1]}`}`, 'EPROXYREFUSED')
    const addressLength = head[3] === 1 ? 4 : head[3] === 4 ? 16 : head[3] === 3 ? (await readBytes(socket, 1))[0] : -1
    if (addressLength < 0) throw new ProxyError('The SOCKS proxy gave an answer that is not SOCKS 5')
    await readBytes(socket, addressLength + 2)
    return socket
  } catch (err) {
    socket.destroy()
    throw err
  }
}

async function socks4Connect (proxy, target, deps) {
  if (net.isIPv6(target.host)) throw new ProxyError('A SOCKS 4 proxy cannot reach IPv6 addresses', 'EPROXYREFUSED')
  const socket = await connectToProxy(proxy, deps)
  try {
    const port = Buffer.alloc(2)
    port.writeUInt16BE(target.port)
    // SOCKS 4a: a name goes after the request and the proxy looks it up.
    const ip = net.isIPv4(target.host) ? Buffer.from(target.host.split('.').map(Number)) : Buffer.from([0, 0, 0, 1])
    const name = net.isIPv4(target.host) ? Buffer.alloc(0) : Buffer.concat([Buffer.from(target.host, 'utf8'), Buffer.from([0])])
    socket.write(Buffer.concat([Buffer.from([4, 1]), port, ip, Buffer.from([0]), name]))
    const reply = await readBytes(socket, 8)
    if (reply[1] !== 0x5a) throw new ProxyError(`The SOCKS proxy would not connect (code ${reply[1]})`, 'EPROXYREFUSED')
    return socket
  } catch (err) {
    socket.destroy()
    throw err
  }
}

/**
 * A socket that reaches target ({ host, port }) through proxy, the tunnel
 * already open. options.getCredentials(proxy, { realm, target, stale })
 * gives { username, password } for a proxy that asks for one, or null.
 */
export async function openTunnel (proxy, target, options = {}) {
  const deps = {
    connect: options.connect || net.connect,
    tlsConnect: options.tlsConnect || tls.connect,
    tlsOptions: options.tlsOptions || {},
    sockets: new Set()
  }
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS
  if (proxy.scheme === 'socks5') return withTimeout(socks5Connect(proxy, target, deps), timeout, deps)
  if (proxy.scheme === 'socks4') return withTimeout(socks4Connect(proxy, target, deps), timeout, deps)
  return withTimeout((async () => {
    // A login kept from before goes first. Turned down, the extension is asked
    // for a fresh one; a login it has just given is asked again once only.
    let credentials = options.cachedCredentials?.(proxy) || null
    let kept = !!credentials
    let askedAgain = false
    for (;;) {
      const result = await httpConnect(proxy, target, deps, credentials)
      if (result.socket) return result.socket
      if (!options.getCredentials) break
      if (credentials && !kept) {
        if (askedAgain) break
        askedAgain = true
      }
      credentials = await options.getCredentials(proxy, { realm: result.realm, target, stale: !!credentials })
      kept = false
      if (!credentials) break
    }
    throw new ProxyError('The VPN proxy needs a login its extension did not give', 'EPROXYAUTH')
  })(), timeout, deps)
}

/**
 * A socket-like stream to host:port that goes through the first proxy in
 * chain that works. It is returned at once, like net.connect's socket: it
 * emits 'connect' once the tunnel is open, holds what is written until then,
 * and fails with the last error when no proxy works.
 */
export class TunnelSocket extends Duplex {
  constructor ({ host, port, chain, ...tunnelOptions }) {
    super({ allowHalfOpen: false })
    this.remoteAddress = host
    this.remotePort = port
    this.remoteFamily = net.isIPv6(host) ? 'IPv6' : 'IPv4'
    this.connecting = true
    this._inner = null
    this._held = []
    this._ending = null
    this._noDelay = null
    this._keepAlive = null
    this._timeoutMs = 0
    this._timer = null
    this._open(chain, { host, port }, tunnelOptions)
  }

  async _open (chain, target, tunnelOptions) {
    let lastError = new ProxyError('No VPN proxy to connect through')
    for (const proxy of chain) {
      if (this.destroyed) return
      try {
        const inner = await openTunnel(proxy, target, tunnelOptions)
        if (this.destroyed) return inner.destroy()
        return this._attach(inner)
      } catch (err) {
        lastError = err
      }
    }
    if (!this.destroyed) this.destroy(lastError)
  }

  _attach (inner) {
    this._inner = inner
    this.connecting = false
    if (this._noDelay !== null) inner.setNoDelay?.(this._noDelay)
    if (this._keepAlive) inner.setKeepAlive?.(...this._keepAlive)
    inner.on('data', (chunk) => {
      this._touch()
      if (!this.push(chunk)) inner.pause()
    })
    inner.on('end', () => this.push(null))
    inner.on('error', (err) => this.destroy(err))
    inner.on('close', () => { if (!this.destroyed) this.destroy() })
    inner.resume()
    for (const { chunk, encoding, callback } of this._held.splice(0)) inner.write(chunk, encoding, callback)
    if (this._ending) inner.end(this._ending)
    this._touch()
    this.emit('connect')
    this.emit('ready')
  }

  _read () {
    this._inner?.resume()
  }

  _write (chunk, encoding, callback) {
    this._touch()
    if (this._inner) return this._inner.write(chunk, encoding, callback)
    this._held.push({ chunk, encoding, callback })
  }

  _final (callback) {
    if (this._inner) return this._inner.end(callback)
    this._ending = callback
  }

  _destroy (err, callback) {
    clearTimeout(this._timer)
    this._inner?.destroy()
    this._inner = null
    for (const { callback: cb } of this._held.splice(0)) cb(err || new ProxyError('The connection closed'))
    callback(err)
  }

  _touch () {
    if (!this._timeoutMs) return
    clearTimeout(this._timer)
    this._timer = setTimeout(() => this.emit('timeout'), this._timeoutMs)
    this._timer.unref?.()
  }

  setTimeout (ms, callback) {
    this._timeoutMs = ms
    if (callback) this.once('timeout', callback)
    if (ms) this._touch()
    else clearTimeout(this._timer)
    return this
  }

  setNoDelay (noDelay = true) {
    this._noDelay = noDelay
    this._inner?.setNoDelay?.(noDelay)
    return this
  }

  setKeepAlive (enable = false, delay = 0) {
    this._keepAlive = [enable, delay]
    this._inner?.setKeepAlive?.(enable, delay)
    return this
  }

  ref () { this._inner?.ref?.(); return this }
  unref () { this._inner?.unref?.(); return this }
  address () { return this._inner?.address?.() || {} }
  get localAddress () { return this._inner?.localAddress }
  get localPort () { return this._inner?.localPort }
  get pending () { return this.connecting }
  get readyState () { return this.connecting ? 'opening' : this.destroyed ? 'closed' : 'open' }
}
