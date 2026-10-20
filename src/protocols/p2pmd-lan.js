import crypto from 'crypto'
import b4a from 'b4a'
import HyperDHT from 'hyperdht'
import libNet from '@holesail/hyper-cmd-lib-net'
import Holesail from 'holesail'
import z32 from 'z32'

// P2PMD notes over the local network, with no internet. Holesail finds a
// note's host on the public HyperDHT, which lives on the internet, so with the
// router's cable out a note did not open even with both devices on the same
// Wi-Fi. The host now also listens on the LAN DHT that hyperdht-mdns runs (the
// one Hyperdrive and PeerChat already find each other on over Wi-Fi), under
// the note's own key pair, and says over mDNS that it has a topic made from
// the note's key. A device joining looks there first. Found, it opens the
// same Noise-encrypted tunnel Holesail opens, straight to the host's Wi-Fi
// address, and the note is served on this device's loopback as always.
// Nobody who does not know the note's key can work out the topic, and in a
// private note the host still lets in only the key the link carries.

// How long a join looks on the local network before going to the internet.
export const LAN_FIND_MS = 2500
export const LAN_FIND_QUICK_MS = 800
// How long a join waits for the host found there to answer.
export const LAN_REACH_MS = 3000

export function noteTopic (publicKey) {
  return crypto.createHash('sha256').update('peersky-p2pmd-lan/1').update(publicKey).digest()
}

// How long a join waits for the host to say which port it keeps the note on.
export const LAN_PORT_MS = 1500

// A tunnel on the local network says it is alive this often, and is dropped
// after this long with nothing from the other end. A network change or a
// backup destroys a local network instance outright, and the other end of each
// of its tunnels was never told: they stayed open with nothing behind them,
// and the browser, which keeps at most six connections to one address, was
// left waiting on dead ones once six had piled up, so the note stopped
// syncing for good. Over the internet Holesail's own DHT never goes like that.
export const LAN_KEEP_ALIVE_MS = 5000
export const LAN_STREAM_TIMEOUT_MS = 15000
// A tunnel to a host that is not there, as while it closes and opens the note
// again, could wait for its handshake forever, and the timeout above only
// starts once it opens. The page's event stream was one of those, so it never
// failed and never reconnected: the note stopped syncing when its host came
// back. One that has not opened by then is dropped.
export const LAN_OPEN_MS = 8000

function keepTunnelAlive (socket) {
  socket.setKeepAlive?.(LAN_KEEP_ALIVE_MS)
  socket.setTimeout?.(LAN_STREAM_TIMEOUT_MS)
  return socket
}

function openWithin (socket, ms) {
  const timer = setTimeout(() => socket.destroy(new Error('The note did not answer on the local network')), ms)
  timer.unref?.()
  socket.once('open', () => clearTimeout(timer))
  socket.once('close', () => clearTimeout(timer))
  return socket
}

/**
 * The key pair a host answers "which port?" under on the LAN DHT. Over the
 * internet a joiner reads the port from the host's record and listens on the
 * same one, so a note has one address on every device; on the local network
 * there is no record, and each join took whatever port was free. Worked out
 * from the note's public key, so every device with the link works it out, the
 * phone too (backend/holesail/lan.mjs there).
 */
export function notePortKeyPair (publicKey) {
  return HyperDHT.keyPair(crypto.createHash('sha256').update('peersky-p2pmd-lan-port/1').update(publicKey).digest())
}

/**
 * The note's public key, and for a private note the key pair a joiner proves
 * it has, worked out from the link the way Holesail works them out.
 */
export function noteKeys (link, secureOption = null) {
  const parsed = Holesail.urlParser(link)
  const secure = parsed.secure === undefined ? secureOption === true : parsed.secure
  if (secure) {
    const keyPair = HyperDHT.keyPair(crypto.createHash('sha256').update(String(parsed.key)).digest())
    return { secure, publicKey: keyPair.publicKey, keyPair }
  }
  return { secure, publicKey: b4a.from(z32.decode(parsed.key)), keyPair: null }
}

/** The host: the note served on the LAN DHT too, and its topic said over mDNS. */
export async function hostNoteOnLan (lan, holesailServer, { host = '127.0.0.1', port, udp = false } = {}) {
  const server = holesailServer?.dht
  if (!lan?.dht || lan.destroyed || !server?.keyPair || udp || !port) return null
  const keyPair = server.keyPair
  const firewall = server.secure ? (remotePublicKey) => !b4a.equals(remotePublicKey, keyPair.publicKey) : false
  const lanServer = lan.dht.createServer({ firewall, reusableSocket: true }, (connection) => {
    libNet.pipeTcpServer(keepTunnelAlive(connection), { port, host }, { isServer: true, compress: false }, {})
  })
  await lanServer.listen(keyPair)
  // Lets in the same keys as the note: a private note's port goes only to
  // someone with its link.
  let portServer = lan.dht.createServer({ firewall, reusableSocket: true }, (socket) => {
    socket.on('error', () => {})
    socket.end(b4a.from(JSON.stringify({ port })))
  })
  await portServer.listen(notePortKeyPair(keyPair.publicKey)).catch(async () => {
    await portServer.close().catch(() => {})
    portServer = null
  })
  const topic = noteTopic(keyPair.publicKey)
  lan.join(topic, { server: true, client: false })
  let closed = false
  return {
    // Which local network instance the note is on: a new one starts after a
    // network change or a backup, and the note has to be hosted there again.
    lan,
    async close () {
      if (closed) return
      closed = true
      await Promise.resolve().then(() => lan.leave(topic)).catch(() => {})
      await lanServer.close().catch(() => {})
      await portServer?.close().catch(() => {})
    }
  }
}

/**
 * The port the host found at address keeps the note on, or null from a host
 * that does not say, as an older PeerSky, or not in time.
 */
export function askNotePortOnLan (lan, { publicKey, keyPair = null, address, timeoutMs = LAN_PORT_MS }) {
  if (!lan?.dht || lan.destroyed) return Promise.resolve(null)
  return new Promise((resolve) => {
    let done = false
    let socket = null
    let text = ''
    const finish = (port) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket?.destroy()
      resolve(port)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    try {
      socket = lan.dht.connect(notePortKeyPair(publicKey).publicKey, {
        ...(keyPair ? { keyPair } : {}),
        relayAddresses: [address],
        reusableSocket: true
      })
    } catch {
      return finish(null)
    }
    socket.on('data', (chunk) => {
      text += b4a.toString(chunk)
      if (text.length > 64) finish(null)
    })
    socket.once('end', () => {
      let port = null
      try {
        port = JSON.parse(text).port
      } catch {}
      finish(Number.isInteger(port) && port > 0 && port < 65536 ? port : null)
    })
    socket.once('error', () => finish(null))
    socket.once('close', () => finish(null))
  })
}

/** The host's address on the local network, or null when no host says so in time. */
export function findNoteOnLan (lan, publicKey, { timeoutMs = LAN_FIND_MS } = {}) {
  if (!lan?.dht || lan.destroyed) return Promise.resolve(null)
  // No other PeerSky seen on this network yet: a short look, in case one is
  // only now being found, rather than the full wait on every join.
  if (typeof lan.dht.toArray === 'function' && lan.dht.toArray().length === 0) timeoutMs = Math.min(timeoutMs, LAN_FIND_QUICK_MS)
  const topic = noteTopic(publicKey)
  return new Promise((resolve) => {
    let done = false
    const finish = (address) => {
      if (done) return
      done = true
      clearTimeout(timer)
      lan.off('peer', onPeer)
      lan.off('peer-reachable', onPeer)
      Promise.resolve().then(() => lan.leave(topic)).catch(() => {})
      resolve(address)
    }
    const onPeer = (peer) => {
      if (!peer?.host || !peer?.port) return
      if (!(peer.topics || []).some((value) => b4a.equals(value, topic))) return
      finish({ host: peer.host, port: peer.port })
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    lan.on('peer', onPeer)
    lan.on('peer-reachable', onPeer)
    try {
      lan.join(topic, { server: false, client: true })
    } catch {
      finish(null)
    }
  })
}

/**
 * Whether a connection to the host found at address opens in time. Found but
 * not answering, as on a Wi-Fi that keeps devices apart, the join goes to the
 * internet instead.
 */
export function reachNoteOnLan (lan, { publicKey, keyPair = null, address, timeoutMs = LAN_REACH_MS }) {
  return new Promise((resolve) => {
    let done = false
    let socket = null
    const finish = (ok) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket?.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    try {
      socket = lan.dht.connect(publicKey, { ...(keyPair ? { keyPair } : {}), relayAddresses: [address], reusableSocket: true })
    } catch {
      return finish(false)
    }
    socket.once('open', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('close', () => finish(false))
  })
}

/**
 * The joining side: a proxy on this device's loopback whose every connection
 * goes over the LAN DHT to the host found at address. Shaped like a Holesail
 * client where the note's session uses one: info.port, close().
 */
export function openNoteOnLan (lan, { publicKey, keyPair = null, address, host = '127.0.0.1', port = 0 }) {
  // Where each connection goes: a local network instance and the host's
  // address on it. Both change while a note is open: a network change or a
  // backup starts a new instance here, and the host can come back at another
  // address. moveTo() points the next connections there (hs-handler keeps it
  // current). failedAt says a connection failed since the route last worked.
  const route = { lan, address, failedAt: 0 }
  return new Promise((resolve, reject) => {
    // Null drops the connection; a throw here would be the main process's.
    const connect = () => {
      if (!route.lan?.dht || route.lan.destroyed) {
        route.failedAt = Date.now()
        return null
      }
      try {
        const socket = openWithin(keepTunnelAlive(route.lan.dht.connect(publicKey, {
          ...(keyPair ? { keyPair } : {}),
          relayAddresses: [route.address],
          reusableSocket: true
        })), LAN_OPEN_MS)
        socket.once('open', () => { route.failedAt = 0 })
        socket.once('error', () => { route.failedAt = Date.now() })
        return socket
      } catch {
        route.failedAt = Date.now()
        return null
      }
    }
    let proxy = null
    // The browser keeps idle connections open, and closing waited on every one
    // of them: leaving a note took ten seconds, and joining it again before
    // then found its port still taken.
    const sockets = new Set()
    const onError = (error) => reject(error)
    proxy = libNet.createTcpProxy({ port, host }, connect, { compress: false }, {}, () => {
      proxy.off('error', onError)
      proxy.on('error', () => {})
      proxy.on('connection', (socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
      })
      const bound = proxy.address()
      resolve({
        lan: true,
        publicKey,
        route,
        info: { type: 'client', port: bound?.port || port, host, lan: true },
        moveTo (nextLan, nextAddress) {
          route.lan = nextLan
          route.address = nextAddress
          route.failedAt = 0
        },
        async close () {
          const closed = new Promise((resolve) => proxy.close(() => resolve()))
          for (const socket of sockets) socket.destroy()
          await closed
        }
      })
    })
    proxy.once('error', onError)
  })
}

// How long a host waits for Holesail's own start before going on with the
// note up on the local network only.
export const INTERNET_SETTLE_MS = 3000

/**
 * Starts a Holesail server and, as soon as it has made the note's key pair,
 * the same note on the local network. Holesail's start waits for a record on
 * the internet DHT and, with no internet, fails after about 12 seconds: a note
 * could not be hosted at all. Now one hosted on the local network is up at
 * once. Returns { lanHost, internet } once the internet answers or settleMs
 * passes: internet false means Holesail's start failed or is still going
 * (`ready` says which), and the note is on the local network alone for now, or
 * on this computer alone when there is no local network either, as with Wi-Fi
 * off. A note is made with no network at all, as any document is: Holesail
 * made its key before it tried the internet, so the note keeps that key and
 * goes up once a network answers. Only a Holesail that never made a key fails.
 */
export async function startNoteHost (holesailServer, { lan = null, port, udp = false, host = '127.0.0.1', settleMs = INTERNET_SETTLE_MS } = {}) {
  const ready = holesailServer.ready()
  ready.catch(() => {})
  let lanHost = null
  if (lan) {
    const until = Date.now() + 2000
    while (!holesailServer.dht?.keyPair && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10))
    if (holesailServer.dht?.keyPair) {
      lanHost = await hostNoteOnLan(lan, holesailServer, { host, port, udp }).catch(() => null)
    }
  }
  const outcome = await Promise.race([
    ready.then(() => 'ready', () => 'failed'),
    new Promise((resolve) => setTimeout(() => resolve('slow'), settleMs))
  ])
  if (outcome === 'ready') return { lanHost, internet: true, ready }
  if (!lanHost && !holesailServer.dht?.keyPair) {
    await ready
    return { lanHost, internet: true, ready }
  }
  return { lanHost, internet: false, ready }
}
