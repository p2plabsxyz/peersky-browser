// The local network side of the load test run with --lan, the desktop's own.
// Each editor is a device of its own on the Wi-Fi, with a local network
// instance as PeerSky runs one (hyperdht-mdns, found over real mDNS), and
// joins the note as hs-handler.js does with no internet (p2pmd-lan.js). In the
// host, hooks.mjs gives hs-handler.js this file in place of hyper-handler.js,
// so hs-handler.js itself hosts the note on the local network. Nothing goes to
// the internet.
import dgram from 'node:dgram'
import HyperDHTmDNS from '@p2plabs/hyperdht-mdns'
import { askNotePortOnLan, findNoteOnLan, noteKeys, openNoteOnLan, reachNoteOnLan } from '../../../src/protocols/p2pmd-lan.js'

// How long a device waits to see another PeerSky on the local network.
const SEE_OTHERS_MS = 20000

// A local network instance on a port of its own, so many fit on one machine.
// It takes no port 0, so a free one is found first, and another if that one
// is taken by the time it binds.
export async function startLan () {
  for (let attempt = 1; ; attempt++) {
    const lan = new HyperDHTmDNS({ port: await freeUdpPort(), allowLoopback: true })
    lan.on('error', (error) => console.error('[lan]', error?.message || error))
    // Devices that share a topic connect, and PeerSky hands those connections
    // to Hyperdrive and PeerChat. Nothing here uses them.
    lan.on('connection', (socket) => socket.on('error', () => {}))
    try {
      await lan.ready()
      return lan
    } catch (error) {
      await lan.destroy().catch(() => {})
      if (attempt === 5) throw error
    }
  }
}

// The host's local network instance, which hs-handler.js asks for when it
// hosts a note and every few seconds after, as it asks Hyper's.
let hostLan = null
export function getHyperLAN () {
  hostLan ||= startLan()
  return hostLan
}

// Someone with PeerSky on the same Wi-Fi, on it before they join, as a
// computer that has been on the Wi-Fi a while is: it has seen the others there.
export async function startDevice () {
  const lan = await startLan()
  const until = Date.now() + SEE_OTHERS_MS
  while (lan.dht.toArray().length === 0) {
    if (Date.now() > until) {
      await lan.destroy().catch(() => {})
      throw new Error('This device saw nobody else on the local network')
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const clients = new Set()
  return {
    // The note, joined as hs-handler.js joins one on the local network, on any
    // free port here: every device is on this one machine, and the host has
    // the note's own port.
    async open ({ address }) {
      const keys = noteKeys(address)
      const found = await findNoteOnLan(lan, keys.publicKey)
      if (!found) throw new Error('The note was not found on the local network')
      const route = { publicKey: keys.publicKey, keyPair: keys.keyPair, address: found }
      const [reached] = await Promise.all([reachNoteOnLan(lan, route), askNotePortOnLan(lan, route)])
      if (!reached) throw new Error('The note did not answer on the local network')
      const client = await openNoteOnLan(lan, { ...route, port: 0 })
      clients.add(client)
      return { url: `http://127.0.0.1:${client.info.port}` }
    },
    async close () {
      for (const client of clients) await client.close().catch(() => {})
      await lan.destroy().catch(() => {})
    }
  }
}

function freeUdpPort () {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    socket.once('error', reject)
    socket.bind(0, () => {
      const { port } = socket.address()
      socket.close(() => resolve(port))
    })
  })
}
