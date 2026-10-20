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
    libNet.pipeTcpServer(connection, { port, host }, { isServer: true, compress: false }, {})
  })
  await lanServer.listen(keyPair)
  const topic = noteTopic(keyPair.publicKey)
  lan.join(topic, { server: true, client: false })
  let closed = false
  return {
    async close () {
      if (closed) return
      closed = true
      await Promise.resolve().then(() => lan.leave(topic)).catch(() => {})
      await lanServer.close().catch(() => {})
    }
  }
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
  return new Promise((resolve, reject) => {
    const connect = () => lan.dht.connect(publicKey, {
      ...(keyPair ? { keyPair } : {}),
      relayAddresses: [address],
      reusableSocket: true
    })
    let proxy = null
    const onError = (error) => reject(error)
    proxy = libNet.createTcpProxy({ port, host }, connect, { compress: false }, {}, () => {
      proxy.off('error', onError)
      proxy.on('error', () => {})
      const bound = proxy.address()
      resolve({
        lan: true,
        info: { type: 'client', port: bound?.port || port, host, lan: true },
        async close () {
          await new Promise((resolve) => proxy.close(() => resolve()))
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
