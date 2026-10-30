import compactEncoding from 'compact-encoding'
import Protomux from 'protomux'
import HyperDHTmDNS from '@p2plabs/hyperdht-mdns'
import {
  checkDeviceSyncProof,
  DEVICE_SYNC_PROTOCOL,
  deviceSyncProof,
  deviceSyncTopic,
  helloFrame,
  MAX_DEVICE_SYNC_FRAME_BYTES,
  parseDeviceSyncFrame,
  proofFrame
} from './device-sync-protocol.js'
import {
  MAX_LISTED_ITEMS,
  recordDeviceHello,
  recordDeviceSeen,
  recordDriveListing
} from './device-sync-state.js'

// A device that proved itself sends a few frames a minute at most: a hello when
// the connection opens and one when its drives or its network change.
const MAX_FRAMES_PER_MINUTE = 30
const LISTING_DELAY_MS = 1000
const LIST_TIME_MS = 15000
const PEER_WAIT_MS = 15000
// Two devices that join at the same moment each look before the other has
// announced, and the swarm only looks again some ten minutes later. While no
// device is connected, it looks again after these: from the start, from a
// network change, and from the last connection dropping. Never while one is
// connected: a fresh look then only opens a second connection, and two
// devices doing that at once close each other's, over and over.
const LOOK_AGAIN_MS = [15000, 60000, 300000]
// While a device is connected, when it was last seen moves on this often, so
// an app the system closed without a word still says about when that was.
const SEEN_EVERY_MS = 5 * 60 * 1000

const frameEncoding = {
  preencode (state, value) {
    compactEncoding.string.preencode(state, value)
  },
  encode (state, value) {
    compactEncoding.string.encode(state, value)
  },
  decode (state) {
    const length = compactEncoding.uint.decode(state)
    if (length > MAX_DEVICE_SYNC_FRAME_BYTES) throw new Error('Device sync frame is too large')
    if (state.end - state.start < length) throw new Error('Device sync frame is incomplete')
    const start = state.start
    state.start += length
    return Buffer.from(state.buffer.subarray(start, state.start)).toString('utf8')
  }
}

// The same as backend/hyper/device-sync.mjs in PeerSky Mobile: the phone and
// this desktop run one protocol, and both test it against the other.

/**
 * Meets this person's other devices on the private store's swarm and keeps
 * what they write in view: each device is recorded with what it is, each drive
 * it lists is opened from that store, which replicates, and its top folder is
 * listed again whenever it grows. With `mirror`, every file is copied here as
 * well, unless the device that wrote it says it is on a cellular connection.
 *
 * Returns null when there is no key to meet under.
 */
export function attachDeviceSync (runtime, {
  identityKey,
  stateDirectory,
  device,
  ownDrives = () => [],
  openDrive,
  rememberDrive = () => {},
  mirror = false,
  isMetered = () => false,
  onChange = () => {},
  now = () => Date.now(),
  lookAgainMs = LOOK_AGAIN_MS,
  seenEveryMs = SEEN_EVERY_MS,
  identityGate = HyperDHTmDNS.identityGate,
  logger = console
} = {}) {
  const topic = deviceSyncTopic(identityKey)
  const swarm = runtime?.swarm
  if (!topic || !swarm || typeof openDrive !== 'function') return null

  const sessions = new Map()
  const online = new Map()
  const watched = new Map()
  let closed = false
  let opening = Promise.resolve()

  const discovery = runtime.join(topic, { server: true, client: true })

  function lookAgain () {
    if (closed) return
    Promise.resolve().then(() => discovery?.refresh?.()).catch(() => {})
  }
  let lookTimers = []
  function lookAgainWhileAlone () {
    for (const timer of lookTimers) clearTimeout(timer)
    lookTimers = lookAgainMs.map((delay) => {
      const timer = setTimeout(() => { if (online.size === 0) lookAgain() }, delay)
      timer.unref?.()
      return timer
    })
  }
  lookAgainWhileAlone()

  function recordOnlineSeen () {
    for (const id of online.keys()) recordDeviceSeen(stateDirectory, id, now())
  }
  const seenTimer = setInterval(() => { if (!closed) recordOnlineSeen() }, seenEveryMs)
  seenTimer.unref?.()

  function changed () {
    try {
      onChange()
    } catch {}
  }

  function send (session, text) {
    if (closed || session.channel.closed || session.connection.destroyed) return false
    try {
      return session.message.send(text)
    } catch {
      return false
    }
  }

  function sendHello (session) {
    return send(session, helloFrame({ device, drives: ownDrives(), metered: isMetered() }))
  }

  function allowFrame (session) {
    const at = now()
    session.frames = session.frames.filter((time) => at - time < 60000)
    session.frames.push(at)
    return session.frames.length <= MAX_FRAMES_PER_MINUTE
  }

  // provenKey: the key a device on the local network proved inside the
  // channel, which stands for it there as the connection key does on the
  // internet.
  function attach (connection, provenKey = null) {
    if (closed || sessions.has(connection) || connection.destroyed) return
    const session = { connection, provenKey, verified: false, deviceId: null, type: null, metered: false, frames: [], drives: [] }
    const channel = Protomux.from(connection).createChannel({
      protocol: DEVICE_SYNC_PROTOCOL,
      onopen: () => {
        const proof = deviceSyncProof(identityKey, connection.handshakeHash, connection.publicKey)
        if (proof) send(session, proofFrame(proof))
      },
      onclose: () => end(session)
    })
    if (!channel) return
    session.channel = channel
    session.message = channel.addMessage({
      encoding: frameEncoding,
      onmessage: (text) => receive(session, text)
    })
    sessions.set(connection, session)
    connection.once('close', () => end(session))
    channel.open()
  }

  function receive (session, text) {
    if (closed) return
    if (!allowFrame(session)) {
      session.channel.close()
      return
    }
    const frame = parseDeviceSyncFrame(text)
    if (!frame) return

    if (frame.t === 'proof') {
      if (session.verified) return
      const { connection } = session
      // Never answered with a hello unless it holds the key: someone who found
      // this phone under a drive's topic learns nothing more here.
      if (!checkDeviceSyncProof(identityKey, connection.handshakeHash, connection.remotePublicKey, frame.proof)) {
        session.channel.close()
        return
      }
      session.verified = true
      session.deviceId = Buffer.from(session.provenKey || connection.remotePublicKey).toString('hex')
      online.set(session.deviceId, (online.get(session.deviceId) || 0) + 1)
      sendHello(session)
      changed()
      return
    }

    if (frame.t === 'hello' && session.verified) takeHello(session, frame)
  }

  function takeHello (session, frame) {
    const own = new Set(ownDrives().map((drive) => drive.id))
    session.type = frame.device
    session.metered = frame.metered
    session.drives = frame.drives.filter((drive) => !own.has(drive.id))
    recordDeviceHello(stateDirectory, {
      id: session.deviceId,
      type: frame.device,
      drives: session.drives.map((drive) => drive.id),
      now: now()
    })
    for (const drive of session.drives) {
      const key = drive.key ? Buffer.from(drive.key, 'hex') : identityKey
      try {
        rememberDrive(drive.id, key)
      } catch {}
      watch(drive.id, key, frame.device)
    }
    for (const id of watched.keys()) {
      if (!listedByAnyone(id)) unwatch(id)
    }
    for (const entry of watched.values()) startCopying(entry)
    changed()
  }

  function listedByAnyone (id) {
    for (const session of sessions.values()) {
      if (session.verified && session.drives.some((drive) => drive.id === id)) return true
    }
    return false
  }

  // Copied only while a device that lists the drive says it is not on a
  // cellular connection: a phone's videos are not pulled over its data plan.
  function mayCopy (id) {
    if (!mirror) return false
    for (const session of sessions.values()) {
      if (session.verified && !session.metered && session.drives.some((drive) => drive.id === id)) return true
    }
    return false
  }

  function watch (id, key, from) {
    if (watched.has(id)) return
    const entry = { id, drive: null, timer: null, listing: null, again: false, download: null, copyAgain: false, onAppend: null }
    watched.set(id, entry)
    // One drive opens at a time, so a device listing two hundred does not open
    // them all at once.
    opening = opening.then(async () => {
      if (closed || watched.get(id) !== entry) return
      try {
        entry.drive = await openDrive(id, key, { device: from })
      } catch (error) {
        logger.warn?.(`[device sync] Could not open a drive from a linked device: ${error?.message || error}`)
        return
      }
      if (closed || watched.get(id) !== entry || !entry.drive) return
      entry.onAppend = () => {
        scheduleListing(entry)
        if (entry.download) entry.copyAgain = true
        else startCopying(entry)
      }
      entry.drive.core.on('append', entry.onAppend)
      await catchUp(entry.drive)
      if (closed || watched.get(id) !== entry) return
      await refreshListing(entry)
      startCopying(entry)
    })
  }

  function unwatch (id) {
    const entry = watched.get(id)
    if (!entry) return
    watched.delete(id)
    clearTimeout(entry.timer)
    if (entry.onAppend) entry.drive?.core?.off('append', entry.onAppend)
    entry.download?.destroy()
  }

  async function catchUp (drive) {
    const core = drive?.core
    if (!core || typeof core.update !== 'function') return
    let timer = null
    try {
      await Promise.race([
        core.update({ wait: true }),
        new Promise((resolve) => { timer = setTimeout(resolve, PEER_WAIT_MS) })
      ])
    } catch {
    } finally {
      clearTimeout(timer)
    }
  }

  function scheduleListing (entry) {
    if (closed || entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      refreshListing(entry).catch(() => {})
    }, LISTING_DELAY_MS)
  }

  async function refreshListing (entry) {
    if (entry.listing) {
      entry.again = true
      return entry.listing
    }
    entry.listing = (async () => {
      try {
        const listed = await listDriveTop(entry.drive)
        if (closed || watched.get(entry.id) !== entry) return
        recordDriveListing(stateDirectory, entry.id, { ...listed, now: now() })
        changed()
      } catch (error) {
        logger.warn?.(`[device sync] Could not list a drive from a linked device: ${error?.message || error}`)
      }
    })().finally(() => {
      entry.listing = null
      if (entry.again && !closed) {
        entry.again = false
        refreshListing(entry).catch(() => {})
      }
    })
    return entry.listing
  }

  function startCopying (entry) {
    if (closed || !entry.drive || entry.download || !mayCopy(entry.id)) return
    let download
    try {
      download = entry.drive.download('/')
    } catch {
      return
    }
    entry.download = download
    download.done().catch(() => {}).finally(() => {
      if (entry.download !== download) return
      entry.download = null
      if (entry.copyAgain) {
        entry.copyAgain = false
        startCopying(entry)
      }
    })
  }

  function end (session) {
    if (!sessions.has(session.connection)) return
    sessions.delete(session.connection)
    if (!session.deviceId) return
    const count = (online.get(session.deviceId) || 1) - 1
    if (count > 0) {
      online.set(session.deviceId, count)
    } else {
      online.delete(session.deviceId)
      if (!closed) recordDeviceSeen(stateDirectory, session.deviceId, now())
      if (!closed && online.size === 0) lookAgainWhileAlone()
    }
    // A drive stays watched while it is open here: its device may come back,
    // and a read of it still finds its peers under the drive's own topic.
    if (!closed) changed()
  }

  // On the local network a connection's key is made up for that network and
  // says nothing about which device is on the other end. A device proves its
  // own key inside the channel first, and only to another of this person's
  // devices (identityGate from @p2plabs/hyperdht-mdns).
  const gateSecret = typeof identityKey === 'string' ? Buffer.from(identityKey, 'hex') : Buffer.from(identityKey)
  const onConnection = (connection, info = {}) => {
    if (info?.lan && info.ephemeral && typeof identityGate === 'function' && swarm.keyPair?.secretKey) {
      connection.on('error', () => {})
      // The other device may finish proving first and open sync before this
      // side has: held until this side's gate is done, as protomux would
      // refuse it.
      const mux = Protomux.from(connection)
      let release = null
      const released = new Promise((resolve) => { release = resolve })
      mux.pair({ protocol: DEVICE_SYNC_PROTOCOL }, () => released)
      identityGate(connection, { keyPair: swarm.keyPair, secrets: [gateSecret], context: 'peersky-device-sync' })
        .then((proven) => {
          if (proven && !closed && !connection.destroyed) attach(connection, proven.publicKey)
        })
        .catch(() => {})
        .finally(() => {
          mux.unpair({ protocol: DEVICE_SYNC_PROTOCOL })
          release()
        })
      return
    }
    attach(connection)
  }
  swarm.on('connection', onConnection)
  for (const connection of swarm.connections || []) attach(connection)

  return {
    get online () {
      return new Set(online.keys())
    },
    // This device's drives or network changed: everyone connected hears it,
    // and with nobody connected the devices are looked for now, so the next
    // connection brings the news.
    announce () {
      let told = 0
      for (const session of sessions.values()) {
        if (session.verified && sendHello(session)) told++
      }
      if (told === 0) lookAgain()
    },
    // Something worth bringing over now, such as a new private file: with no
    // device connected, look for them.
    nudge () {
      if (online.size === 0) lookAgain()
    },
    // On another network or back in front: with no device connected, look now
    // and again later; with one connected, the swarm keeps that connection.
    refresh () {
      if (online.size > 0) return
      lookAgain()
      lookAgainWhileAlone()
    },
    flushed () {
      return Promise.resolve(discovery?.flushed?.())
    },
    async close () {
      if (closed) return
      closed = true
      for (const timer of lookTimers) clearTimeout(timer)
      clearInterval(seenTimer)
      recordOnlineSeen()
      swarm.off('connection', onConnection)
      for (const session of sessions.values()) {
        try {
          session.channel.close()
        } catch {}
      }
      sessions.clear()
      online.clear()
      for (const id of [...watched.keys()]) unwatch(id)
      // Not waited on: leaving the topic tells the DHT, which with no internet
      // takes its time, and the swarm closes with the store right after.
      Promise.resolve().then(() => discovery?.destroy?.()).catch(() => {})
    }
  }
}

/**
 * The files and folders at the top of a drive, newest first, as far as can be
 * read in the time given.
 */
export async function listDriveTop (drive, { maxItems = MAX_LISTED_ITEMS, timeoutMs = LIST_TIME_MS } = {}) {
  const items = []
  let truncated = false
  const deadline = Date.now() + timeoutMs
  const iterator = drive.list('/', { recursive: false })[Symbol.asyncIterator]()
  try {
    while (true) {
      if (items.length >= maxItems) {
        truncated = true
        break
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        truncated = true
        break
      }
      let timer = null
      const result = await Promise.race([
        iterator.next(),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), remaining) })
      ]).finally(() => clearTimeout(timer))
      if (result === null) {
        truncated = true
        break
      }
      if (result.done) break
      const node = result.value
      if (typeof node?.key !== 'string') continue
      const relative = node.key.replace(/^\/+/, '')
      const slash = relative.indexOf('/')
      const name = slash === -1 ? relative : relative.slice(0, slash)
      if (!name) continue
      if (slash !== -1) {
        items.push({ type: 'directory', name, path: `/${name}/`, byteLength: 0, seq: node.seq || 0 })
      } else if (node.value?.blob) {
        const size = node.value.blob.byteLength
        items.push({ type: 'file', name, path: `/${name}`, byteLength: Number.isSafeInteger(size) ? size : 0, seq: node.seq || 0 })
      }
    }
  } finally {
    if (typeof iterator.return === 'function') await iterator.return().catch(() => {})
  }
  items.sort((left, right) => right.seq - left.seq)
  return { items: items.map(({ seq, ...item }) => item), truncated }
}
