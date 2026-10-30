import { expect } from 'chai'
import crypto from 'crypto'
import http from 'http'
import { createRequire } from 'module'
import HyperDHTmDNS from '@p2plabs/hyperdht-mdns'
import { LAN_STREAM_TIMEOUT_MS, askNotePortOnLan, findNoteOnLan, hostNoteOnLan, noteKeys, notePortKeyPair, noteTopic, openNoteOnLan, reachNoteOnLan, startNoteHost } from '../../src/protocols/p2pmd-lan.js'

const require = createRequire(import.meta.url)

// With the router's cable out, a P2PMD note did not open, even with both
// devices on the same Wi-Fi: Holesail finds a host on the public HyperDHT,
// which is on the internet, and could not even start hosting. The host now
// also listens on the LAN DHT, and a joiner looks there first.

// A Wi-Fi with nothing else on it: mDNS goes between the two devices here.
class MemoryAdapter {
  constructor (bus) {
    this.bus = bus
    this.record = null
    this.handlers = null
  }

  browse (_query, handlers) {
    this.handlers = handlers
    return { stop: () => { this.handlers = null } }
  }

  advertise (record) {
    this.record = record
    for (const peer of this.bus) {
      setImmediate(() => {
        this.handlers?.onService(asService(peer.record))
        peer.handlers?.onService(asService(record))
      })
    }
    this.bus.add(this)
    return {
      stop: () => {
        if (this.record !== record) return
        this.bus.delete(this)
        for (const peer of this.bus) peer.handlers?.onServiceDown?.(asService(record))
      }
    }
  }
}

function asService (record) {
  return { ...record, name: record.name, txt: record.txt, port: record.port, addresses: ['127.0.0.1'], host: '127.0.0.1' }
}

describe('P2PMD notes over the local network, with no internet', function () {
  this.timeout(30000)
  const bus = new Set()
  const lans = []
  const closers = []

  // Each test's ports are below 32768, which neither macOS nor Linux hands out
  // on its own. One already taken failed the test, and an instance that never
  // started is not freed by destroying it, so it held the run open.
  async function device (port) {
    const lan = new HyperDHTmDNS({ host: '127.0.0.1', port, allowLoopback: true, adapter: new MemoryAdapter(bus) })
    await lan.ready()
    lans.push(lan)
    return lan
  }

  async function noteServer (body) {
    const server = http.createServer((req, res) => res.end(body)).listen(0, '127.0.0.1')
    await new Promise((resolve) => server.on('listening', resolve))
    closers.push(() => new Promise((resolve) => server.close(resolve)))
    return server.address().port
  }

  function get (port) {
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        let text = ''
        res.on('data', (chunk) => { text += chunk })
        res.on('end', () => resolve(text))
      }).on('error', reject)
    })
  }

  // What a Holesail server holds that the LAN side needs: its key pair, and
  // whether only the link's key may come in.
  function holesailServer (secure, key = crypto.randomBytes(32).toString('hex')) {
    const HyperDHT = require('hyperdht')
    const seed = crypto.createHash('sha256').update(key).digest()
    return { link: `hs://${secure ? 's' : '0'}000${key}`, dht: { keyPair: HyperDHT.keyPair(seed), secure } }
  }

  afterEach(async function () {
    for (const close of closers.splice(0)) await close().catch(() => {})
    for (const lan of lans.splice(0)) await lan.destroy().catch(() => {})
    bus.clear()
  })

  it('works out the note\'s keys as Holesail does', function () {
    const key = 'ab'.repeat(32)
    const { publicKey, keyPair, secure } = noteKeys(`hs://s000${key}`)
    const HyperDHT = require('hyperdht')
    const expected = HyperDHT.keyPair(crypto.createHash('sha256').update(key).digest())
    expect(secure).to.equal(true)
    expect(publicKey.equals(expected.publicKey)).to.equal(true)
    expect(keyPair.secretKey.equals(expected.secretKey)).to.equal(true)
  })

  it('a private note opens over the Wi-Fi from its link alone', async function () {
    const base = 11000 + (process.pid % 2000)
    const host = await device(base)
    const joiner = await device(base + 1)
    const notePort = await noteServer('# Trip plan')
    const server = holesailServer(true)

    const hosted = await hostNoteOnLan(host, server, { port: notePort })
    closers.push(() => hosted.close())

    const keys = noteKeys(server.link)
    const address = await findNoteOnLan(joiner, keys.publicKey, { timeoutMs: 10000 })
    expect(address).to.include({ host: '127.0.0.1', port: base })
    expect(await reachNoteOnLan(joiner, { publicKey: keys.publicKey, keyPair: keys.keyPair, address })).to.equal(true)

    const client = await openNoteOnLan(joiner, { publicKey: keys.publicKey, keyPair: keys.keyPair, address })
    closers.push(() => client.close())
    expect(await get(client.info.port)).to.equal('# Trip plan')
  })

  it('a private note does not open for a key that is not the link\'s', async function () {
    const base = 13000 + (process.pid % 2000)
    const host = await device(base)
    const joiner = await device(base + 1)
    const notePort = await noteServer('secret')
    const server = holesailServer(true)
    const hosted = await hostNoteOnLan(host, server, { port: notePort })
    closers.push(() => hosted.close())

    const keys = noteKeys(server.link)
    const address = await findNoteOnLan(joiner, keys.publicKey, { timeoutMs: 10000 })
    const HyperDHT = require('hyperdht')
    // Turned away, so a join with it would go to the internet instead.
    expect(await reachNoteOnLan(joiner, { publicKey: keys.publicKey, keyPair: HyperDHT.keyPair(), address })).to.equal(false)
    const stranger = await openNoteOnLan(joiner, { publicKey: keys.publicKey, keyPair: HyperDHT.keyPair(), address })
    closers.push(() => stranger.close())
    let text = null
    try {
      text = await Promise.race([get(stranger.info.port), new Promise((resolve) => setTimeout(() => resolve(null), 4000))])
    } catch {}
    expect(text).to.not.equal('secret')
  })

  // Over the internet a joiner listens on the port in the host's record, so a
  // note has one address everywhere. On the local network each join took any
  // free port, a new one every time.
  describe('the port a note is on', function () {
    // A public note's link is its public key.
    function publicNote () {
      const HyperDHT = require('hyperdht')
      const z32 = require('z32')
      const keyPair = HyperDHT.keyPair()
      return { link: `hs://0000${z32.encode(keyPair.publicKey)}`, dht: { keyPair, secure: false } }
    }

    it('is worked out the same on the phone (backend/holesail/lan.mjs there)', function () {
      expect(notePortKeyPair(Buffer.alloc(32, 1)).publicKey.toString('hex'))
        .to.equal('34ae754ccc5daf1768b69dc12407461e7ecbdb5259a738f5883b458a95d745e3')
    })

    it('is told to a joiner, which then listens on the same port', async function () {
      const base = 18000 + (process.pid % 1000)
      const host = await device(base)
      const joiner = await device(base + 1)
      const notePort = await noteServer('# Same address')
      const server = publicNote()
      const hosted = await hostNoteOnLan(host, server, { port: notePort })
      closers.push(() => hosted.close())

      const keys = noteKeys(server.link)
      const address = await findNoteOnLan(joiner, keys.publicKey, { timeoutMs: 10000 })
      expect(await askNotePortOnLan(joiner, { publicKey: keys.publicKey, address })).to.equal(notePort)
    })

    it('of a private note is told only to the link\'s key', async function () {
      const base = 19000 + (process.pid % 1000)
      const host = await device(base)
      const joiner = await device(base + 1)
      const notePort = await noteServer('secret')
      const server = holesailServer(true)
      const hosted = await hostNoteOnLan(host, server, { port: notePort })
      closers.push(() => hosted.close())

      const keys = noteKeys(server.link)
      const address = await findNoteOnLan(joiner, keys.publicKey, { timeoutMs: 10000 })
      expect(await askNotePortOnLan(joiner, { publicKey: keys.publicKey, keyPair: keys.keyPair, address })).to.equal(notePort)
      const HyperDHT = require('hyperdht')
      expect(await askNotePortOnLan(joiner, { publicKey: keys.publicKey, keyPair: HyperDHT.keyPair(), address })).to.equal(null)
    })

    it('is not told by an older host, and the join takes any free port as before', async function () {
      const base = 20000 + (process.pid % 1000)
      const host = await device(base)
      const joiner = await device(base + 1)
      const server = publicNote()
      // As hosts did before: the note only, no answer about its port.
      const old = host.dht.createServer({ reusableSocket: true }, (socket) => socket.destroy())
      await old.listen(server.dht.keyPair)
      host.join(noteTopic(server.dht.keyPair.publicKey), { server: true, client: false })
      closers.push(() => old.close())

      const keys = noteKeys(server.link)
      const address = await findNoteOnLan(joiner, keys.publicKey, { timeoutMs: 10000 })
      const started = Date.now()
      expect(await askNotePortOnLan(joiner, { publicKey: keys.publicKey, address })).to.equal(null)
      expect(Date.now() - started).to.be.below(2000)
    })
  })

  // A network change or a backup starts the local network again as a new
  // instance. Offline a note stopped syncing once its host dropped off and came
  // back, while online it carried on.
  describe('when the local network starts again', function () {
    it('a guest finds its host again where the host came back, and the note opens', async function () {
      const base = 21000 + (process.pid % 1000)
      const first = await device(base)
      const guestLan = await device(base + 1)
      const notePort = await noteServer('# Still here')
      const server = holesailServer(true)
      const hosted = await hostNoteOnLan(first, server, { port: notePort })
      expect(hosted.lan).to.equal(first)

      const keys = noteKeys(server.link)
      const address = await findNoteOnLan(guestLan, keys.publicKey, { timeoutMs: 10000 })
      const guest = await openNoteOnLan(guestLan, { publicKey: keys.publicKey, keyPair: keys.keyPair, address })
      closers.push(() => guest.close())
      expect(await get(guest.info.port)).to.equal('# Still here')

      // The host's local network goes and comes back on another port.
      await hosted.close()
      await first.destroy()
      const again = await device(base + 2)
      const rehosted = await hostNoteOnLan(again, server, { port: notePort })
      closers.push(() => rehosted.close())
      // Either the old address fails and the route says so, so the browser
      // looks for the host again, or HyperDHT already found the host by the
      // note's key on the LAN DHT, as it looks there while it tries the old
      // address. Which one comes first is down to timing: on Windows it was
      // the second.
      const meanwhile = await get(guest.info.port).catch(() => null)
      expect(meanwhile === '# Still here' || guest.route.failedAt > 0).to.equal(true)

      const moved = await findNoteOnLan(guestLan, keys.publicKey, { timeoutMs: 10000 })
      expect(moved.port).to.equal(base + 2)
      guest.moveTo(guestLan, moved)
      expect(guest.route.failedAt).to.equal(0)
      expect(await get(guest.info.port)).to.equal('# Still here')
    })

    // An event stream stayed open with nothing behind it, and six of them left
    // the browser no connection to the note at all.
    it('drops a long request whose host\'s instance was destroyed outright, instead of keeping it open forever', async function () {
      this.timeout(40000)
      const base = 23000 + (process.pid % 1000)
      const hostLan = await device(base)
      const guestLan = await device(base + 1)
      // Like the note's event stream: headers, then nothing for a long while.
      const stream = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': open\n\n') }).listen(0, '127.0.0.1')
      await new Promise((resolve) => stream.on('listening', resolve))
      closers.push(() => new Promise((resolve) => { stream.closeAllConnections?.(); stream.close(resolve) }))
      const server = holesailServer(true)
      await hostNoteOnLan(hostLan, server, { port: stream.address().port })

      const keys = noteKeys(server.link)
      const address = await findNoteOnLan(guestLan, keys.publicKey, { timeoutMs: 10000 })
      const guest = await openNoteOnLan(guestLan, { publicKey: keys.publicKey, keyPair: keys.keyPair, address })
      closers.push(() => guest.close())
      const ended = new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port: guest.info.port, path: '/events' }, (res) => {
          res.once('data', () => {
            const started = Date.now()
            // The host's local network goes with no word to anyone.
            hostLan.destroy()
            res.on('error', () => {})
            res.once('close', () => resolve(Date.now() - started))
          })
        }).on('error', () => {})
      })
      expect(await ended).to.be.below(LAN_STREAM_TIMEOUT_MS + 5000)
    })

    // A connection to a host that had answered before, failing before it
    // opened, left HyperDHT with a promise nobody caught, about 4 s on
    // (patches/hyperdht+6.34.1.patch). The main process logs those; on the
    // phone they abort the app.
    it('a host whose computer left leaves no rejection unhandled', async function () {
      this.timeout(30000)
      const base = 24000 + (process.pid % 1000)
      const hostLan = await device(base)
      const guestLan = await device(base + 1)
      const notePort = await noteServer('# Left')
      const server = holesailServer(true)
      const hosted = await hostNoteOnLan(hostLan, server, { port: notePort })
      const keys = noteKeys(server.link)
      const address = await findNoteOnLan(guestLan, keys.publicKey, { timeoutMs: 10000 })
      const guest = await openNoteOnLan(guestLan, { publicKey: keys.publicKey, keyPair: keys.keyPair, address })
      closers.push(() => guest.close())
      // Each request on a connection of its own, closed once answered.
      const ask = () => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: guest.info.port, path: '/', agent: false }, (res) => {
          let text = ''
          res.on('data', (chunk) => { text += chunk })
          res.on('end', () => resolve(text))
        }).on('error', reject)
      })
      expect(await ask()).to.equal('# Left')
      // Once that connection has closed: one still closing when the host goes
      // fails, and HyperDHT forgets the way to the host instead of trying it.
      await new Promise((resolve) => setTimeout(resolve, 500))

      const unhandled = []
      const onUnhandled = (reason) => unhandled.push(reason?.code || reason?.message || String(reason))
      process.on('unhandledRejection', onUnhandled)
      try {
        await hosted.close()
        await hostLan.destroy()
        expect(await ask().catch(() => null)).to.equal(null)
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
      expect(unhandled).to.deep.equal([])
    })

    it('a guest whose own instance went drops each connection instead of throwing, and carries on on the new one', async function () {
      const base = 22000 + (process.pid % 1000)
      const hostLan = await device(base)
      let guestLan = await device(base + 1)
      const notePort = await noteServer('# On the new one')
      const server = holesailServer(true)
      const hosted = await hostNoteOnLan(hostLan, server, { port: notePort })
      closers.push(() => hosted.close())

      const keys = noteKeys(server.link)
      const address = await findNoteOnLan(guestLan, keys.publicKey, { timeoutMs: 10000 })
      const guest = await openNoteOnLan(guestLan, { publicKey: keys.publicKey, keyPair: keys.keyPair, address })
      closers.push(() => guest.close())

      await guestLan.destroy()
      expect(await get(guest.info.port).catch(() => null)).to.equal(null)
      expect(guest.route.failedAt).to.be.above(0)

      guestLan = await device(base + 2)
      guest.moveTo(guestLan, address)
      expect(await get(guest.info.port)).to.equal('# On the new one')
    })
  })

  it('finds nothing when no host has the note, so the join goes to the internet', async function () {
    const base = 15000 + (process.pid % 2000)
    await device(base)
    const joiner = await device(base + 1)
    expect(await findNoteOnLan(joiner, crypto.randomBytes(32), { timeoutMs: 800 })).to.equal(null)
  })

  // Holesail's own start waits on the internet DHT and fails with none: as it
  // does then, after a while, with no nodes answering.
  function offlineHolesail (secure = true) {
    const made = holesailServer(secure)
    return {
      link: made.link,
      dht: null,
      ready () {
        this.dht = made.dht
        return new Promise((resolve, reject) => setTimeout(() => reject(new Error('Too few nodes responded')), 300))
      }
    }
  }

  it('hosts a note on the local network while the internet does not answer, and it opens there', async function () {
    const base = 17000 + (process.pid % 2000)
    const host = await device(base)
    const joiner = await device(base + 1)
    const notePort = await noteServer('# Offline')
    const server = offlineHolesail()

    const started = await startNoteHost(server, { lan: host, port: notePort, settleMs: 1000 })
    closers.push(() => started.lanHost.close())
    expect(started.internet).to.equal(false)
    let failed = false
    await started.ready.catch(() => { failed = true })
    expect(failed).to.equal(true)

    const keys = noteKeys(server.link)
    const address = await findNoteOnLan(joiner, keys.publicKey, { timeoutMs: 10000 })
    const client = await openNoteOnLan(joiner, { publicKey: keys.publicKey, keyPair: keys.keyPair, address })
    closers.push(() => client.close())
    expect(await get(client.info.port)).to.equal('# Offline')
  })

  it('with no network at all, as with Wi-Fi off, the note is still made here and waits for one', async function () {
    // It failed with "Too few nodes responded", so a note could not even be
    // started offline. Holesail made the key first, so the note keeps it and
    // goes up once a network answers.
    const server = offlineHolesail()
    const started = await startNoteHost(server, { lan: null, port: 1 })
    expect(started).to.include({ lanHost: null, internet: false })
    expect(server.dht.keyPair).to.not.equal(undefined)
    let failed = false
    await started.ready.catch(() => { failed = true })
    expect(failed).to.equal(true)
  })

  it('fails only when Holesail never made the note\'s key', async function () {
    const broken = { dht: null, ready: () => Promise.reject(new Error('Too few nodes responded')) }
    let error = null
    try {
      await startNoteHost(broken, { lan: null, port: 1 })
    } catch (caught) {
      error = caught
    }
    expect(error?.message).to.equal('Too few nodes responded')
  })
})
