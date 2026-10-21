// Holesail without the network, for the load test. Hosting a note asks it for
// a room key and gets one made from a made-up seed. Nothing is announced or
// connected. A public note's address is its public key, as Holesail's is, so
// with --lan the editors can find it on the local network.
import HyperDHT from 'hyperdht'
import z32 from 'z32'

let rooms = 0

export default class Holesail {
  static urlParser () {
    return { secure: false, udp: false, port: 0 }
  }

  constructor (options = {}) {
    this.options = options
    this.info = null
    this.dht = null
    this.seed = null
  }

  async ready () {
    if (!this.options.server) throw new Error('The load test only hosts notes. It never joins one through Holesail.')
    rooms += 1
    const seed = Buffer.alloc(32, rooms)
    const keyPair = HyperDHT.keyPair(seed)
    const secure = Boolean(this.options.secure)
    this.info = {
      url: secure ? `hs://s000${seed.toString('hex')}` : `hs://0000${z32.encode(keyPair.publicKey)}`,
      secure,
      udp: Boolean(this.options.udp),
      port: this.options.port
    }
    this.dht = { seed, keyPair, secure }
  }

  async close () {}
}
