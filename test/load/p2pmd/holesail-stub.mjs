// Holesail without the network, for the load test. Hosting a note asks it for
// a room key and gets a made-up one. Nothing is announced or connected.
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
    this.info = {
      url: `hs://0000${'loadtest'.repeat(6)}${String(rooms).padStart(4, '0')}`,
      secure: Boolean(this.options.secure),
      udp: Boolean(this.options.udp),
      port: this.options.port
    }
    this.dht = { seed: Buffer.alloc(32, rooms) }
  }

  async close () {}
}
