import { expect } from 'chai'
import crypto from 'crypto'
import http from 'http'
import { createRequire } from 'module'
import HyperDHTmDNS from '@p2plabs/hyperdht-mdns'
import { findNoteOnLan, hostNoteOnLan, noteKeys, openNoteOnLan, reachNoteOnLan, startNoteHost } from '../../src/protocols/p2pmd-lan.js'

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
    const base = 41000 + (process.pid % 2000)
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
    const base = 43000 + (process.pid % 2000)
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

  it('finds nothing when no host has the note, so the join goes to the internet', async function () {
    const base = 45000 + (process.pid % 2000)
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
    const base = 47000 + (process.pid % 2000)
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
