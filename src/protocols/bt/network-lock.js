// While a VPN extension is on, the torrent worker reaches the internet only
// through the VPN's proxy, and nothing can leave it any other way.
//
// - net.connect, tls.connect and http agents open their sockets through the
//   proxy (proxy-tunnel.js), so WebTorrent's peers, the trackers' requests,
//   web seeds and fetch() all go through it.
// - Any other TCP connection, made by code that gets around those, is refused
//   at net.Socket#connect: only the proxy itself and local IPC are allowed.
// - UDP is off: the DHT, uTP and UDP trackers would send this computer's own
//   address, and a proxy carries TCP only.
// - Servers listen on loopback only. Peers cannot reach this computer through
//   the proxy, and one that came straight to its own address would get around
//   the VPN.
// - Names are looked up by the proxy, never here, except the proxy's own name,
//   so this computer's DNS server does not learn what it downloads.
//
// It is set up once, when the worker starts, before WebTorrent loads. A change
// of VPN starts a new worker.

import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import dgram from 'node:dgram'
import dns from 'node:dns'
import { TunnelSocket, validProxies, proxyKey } from './proxy-tunnel.js'

const DNS_METHODS = ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveSrv', 'resolveTxt', 'resolveNs', 'resolveMx', 'resolvePtr', 'resolveNaptr', 'resolveSoa', 'resolveCaa', 'reverse']

// What WebTorrent must leave off while it goes through a proxy.
export const LOCKED_CLIENT_OPTIONS = Object.freeze({ dht: false, utp: false, lsd: false, natUpnp: false, natPmp: false })

/** Trackers that work over a proxy: HTTP and HTTPS. UDP and WebSocket trackers are left out. */
export function keepTracker (url) {
  return /^https?:\/\//i.test(String(url || ''))
}

/**
 * Where a net.connect or net.Socket#connect call goes: { path } for local
 * IPC, else { host, port }. Socket#connect gets the arguments net.connect
 * already normalized, as an array.
 */
export function connectTarget (args) {
  let a = args
  if (Array.isArray(a[0])) a = a[0]
  const first = a[0]
  if (first !== null && typeof first === 'object') {
    if (first.path) return { path: String(first.path) }
    return { host: String(first.host || 'localhost').toLowerCase(), port: Number(first.port) }
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { path: first }
  return { host: String(typeof a[1] === 'string' ? a[1] : 'localhost').toLowerCase(), port: Number(first) }
}

function lastFunction (args) {
  const a = Array.isArray(args[0]) ? args[0] : args
  const last = a[a.length - 1]
  return typeof last === 'function' ? last : null
}

/** tls.connect's arguments as { options, callback }: (options[, cb]) or (port[, host][, options][, cb]). */
function tlsArguments (args) {
  const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
  const rest = callback ? args.slice(0, -1) : args.slice()
  if (rest[0] !== null && typeof rest[0] === 'object') return { options: { ...rest[0] }, callback }
  const options = { port: rest[0] }
  if (typeof rest[1] === 'string') options.host = rest[1]
  const extra = rest.find((x, i) => i > 0 && x && typeof x === 'object')
  return { options: { ...extra, ...options }, callback }
}

/**
 * net.Server#listen's arguments, moved onto loopback when they listen on a
 * port. A path or handle (local IPC) is left as it is.
 */
export function loopbackListenArgs (args) {
  const rest = [...args]
  const callback = typeof rest[rest.length - 1] === 'function' ? rest.pop() : null
  const first = rest[0]
  let options
  if (first == null || typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    options = { port: first == null ? 0 : Number(first) }
    const backlog = rest.find((x, i) => i > 0 && typeof x === 'number')
    if (backlog !== undefined) options.backlog = backlog
  } else if (typeof first === 'object' && !('path' in first) && first.fd === undefined && !first.handle && !first._handle) {
    options = { ...first }
  } else {
    return args
  }
  options.host = '127.0.0.1'
  delete options.ipv6Only
  return callback ? [options, callback] : [options]
}

function blockedError (what) {
  const err = new Error(`${what} is off while torrents go through your VPN extension`)
  err.code = 'EPERM'
  return err
}

/**
 * Locks this process's network to the proxies (a list from the browser, best
 * first). requestCredentials(proxy, { realm, target, stale }) resolves to
 * { username, password } or null. Returns what WebTorrent needs to know, or
 * null when there is no proxy, and then nothing is changed.
 */
export function installNetworkLock ({ proxies, requestCredentials = async () => null, timeout } = {}) {
  const chain = validProxies(proxies)
  if (!chain.length) return null

  const original = {
    netConnect: net.connect,
    createConnection: net.createConnection,
    tlsConnect: tls.connect,
    socketConnect: net.Socket.prototype.connect,
    serverListen: net.Server.prototype.listen,
    agentCreateConnection: http.Agent.prototype.createConnection,
    createSocket: dgram.createSocket,
    dns: Object.fromEntries(DNS_METHODS.map((m) => [m, dns[m]])),
    dnsPromises: Object.fromEntries(DNS_METHODS.map((m) => [m, dns.promises[m]])),
    resolver: Object.fromEntries(DNS_METHODS.map((m) => [m, dns.Resolver.prototype[m]])),
    promisesResolver: Object.fromEntries(DNS_METHODS.map((m) => [m, dns.promises.Resolver.prototype[m]]))
  }

  const endpoints = new Set(chain.map((p) => `${p.host}:${p.port}`))
  const proxyNames = new Set(chain.map((p) => p.host))
  const isProxy = (target) => !!target.host && endpoints.has(`${target.host}:${target.port}`)
  const nameAllowed = (name) => {
    const host = String(name || '').toLowerCase().replace(/^\[|\]$/g, '')
    return net.isIP(host) !== 0 || proxyNames.has(host) || host === 'localhost'
  }

  // A login is asked of the extension once per proxy, and again only when the
  // proxy turns down the one it gave.
  const credentials = new Map()
  const asking = new Map()
  const tunnelOptions = {
    connect: original.netConnect,
    tlsConnect: original.tlsConnect,
    timeout,
    cachedCredentials: (proxy) => credentials.get(proxyKey(proxy)) || null,
    getCredentials: (proxy, info) => {
      const key = proxyKey(proxy)
      if (info.stale) credentials.delete(key)
      if (credentials.has(key)) return Promise.resolve(credentials.get(key))
      if (!asking.has(key)) {
        asking.set(key, Promise.resolve(requestCredentials(proxy, info))
          .catch(() => null)
          .then((given) => {
            asking.delete(key)
            const valid = given && typeof given.username === 'string' && typeof given.password === 'string' ? given : null
            if (valid) credentials.set(key, valid)
            return valid
          }))
      }
      return asking.get(key)
    }
  }

  const tunnel = (host, port) => new TunnelSocket({ host, port, chain, ...tunnelOptions })

  function lockedConnect (...args) {
    const target = connectTarget(args)
    if (target.path || isProxy(target)) return original.netConnect.apply(net, args)
    const socket = tunnel(target.host.replace(/^\[|\]$/g, ''), target.port)
    const onConnect = lastFunction(args)
    if (onConnect) socket.once('connect', onConnect)
    return socket
  }
  net.connect = lockedConnect
  net.createConnection = lockedConnect

  tls.connect = function lockedTlsConnect (...args) {
    const { options, callback } = tlsArguments(args)
    const target = { host: String(options.host || 'localhost').toLowerCase(), port: Number(options.port) }
    if (options.socket || options.path || isProxy(target)) return original.tlsConnect.apply(tls, args)
    const host = target.host.replace(/^\[|\]$/g, '')
    const servername = options.servername !== undefined ? options.servername : (net.isIP(host) ? undefined : host)
    // host stays in the options: with a socket given, TLS connects nowhere
    // itself, and still checks the certificate against that name.
    const wrapped = { ...options, host, socket: tunnel(host, target.port), servername }
    return callback ? original.tlsConnect.call(tls, wrapped, callback) : original.tlsConnect.call(tls, wrapped)
  }

  http.Agent.prototype.createConnection = function lockedAgentConnection (options, callback) {
    return lockedConnect(options, callback)
  }

  net.Socket.prototype.connect = function lockedSocketConnect (...args) {
    const target = connectTarget(args)
    if (target.path || isProxy(target)) return original.socketConnect.apply(this, args)
    const err = blockedError(`A direct connection to ${target.host}:${target.port}`)
    process.nextTick(() => this.destroy(err))
    return this
  }

  net.Server.prototype.listen = function lockedListen (...args) {
    return original.serverListen.apply(this, loopbackListenArgs(args))
  }

  dgram.createSocket = function lockedCreateSocket () {
    throw blockedError('UDP')
  }

  const refuseLookup = (name) => {
    const err = new Error(`Looking up ${name} is off while torrents go through your VPN extension`)
    err.code = 'ENOTFOUND'
    err.hostname = name
    return err
  }
  const guardCallback = (fn) => function guardedLookup (name, ...rest) {
    if (nameAllowed(name)) return fn.call(this, name, ...rest)
    const callback = rest[rest.length - 1]
    if (typeof callback === 'function') process.nextTick(() => callback(refuseLookup(name)))
    return undefined
  }
  const guardPromise = (fn) => function guardedLookup (name, ...rest) {
    if (nameAllowed(name)) return fn.call(this, name, ...rest)
    return Promise.reject(refuseLookup(name))
  }
  for (const m of DNS_METHODS) {
    if (typeof original.dns[m] === 'function') dns[m] = guardCallback(original.dns[m])
    if (typeof original.dnsPromises[m] === 'function') dns.promises[m] = guardPromise(original.dnsPromises[m])
    if (typeof original.resolver[m] === 'function') dns.Resolver.prototype[m] = guardCallback(original.resolver[m])
    if (typeof original.promisesResolver[m] === 'function') dns.promises.Resolver.prototype[m] = guardPromise(original.promisesResolver[m])
  }

  return {
    proxies: chain,
    clientOptions: LOCKED_CLIENT_OPTIONS,
    keepTracker,
    /** Puts everything back, for tests. A worker keeps its lock until it exits. */
    uninstall () {
      net.connect = original.netConnect
      net.createConnection = original.createConnection
      tls.connect = original.tlsConnect
      net.Socket.prototype.connect = original.socketConnect
      net.Server.prototype.listen = original.serverListen
      http.Agent.prototype.createConnection = original.agentCreateConnection
      dgram.createSocket = original.createSocket
      for (const m of DNS_METHODS) {
        if (original.dns[m]) dns[m] = original.dns[m]
        if (original.dnsPromises[m]) dns.promises[m] = original.dnsPromises[m]
        if (original.resolver[m]) dns.Resolver.prototype[m] = original.resolver[m]
        if (original.promisesResolver[m]) dns.promises.Resolver.prototype[m] = original.promisesResolver[m]
      }
    }
  }
}
