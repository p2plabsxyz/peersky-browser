// With the internet down PeerSky waited on the public DHT before it would read
// anything local: hyper-sdk's ready() waited for the swarm to listen, which
// waits for the first announce, and every hyper:// request, PeerChat's
// included, sat behind it for seconds. patches/hyper-sdk+6.2.2.patch starts
// listening without waiting for it.
import { expect } from 'chai'
import dgram from 'dgram'
import os from 'os'
import path from 'path'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { create } from 'hyper-sdk'

describe('starting with no internet', () => {
  it('opens and reads local drives at once when the public DHT never answers', async () => {
    // Takes every packet and answers none, like a bootstrap node behind a
    // dead internet link.
    const silent = dgram.createSocket('udp4')
    await new Promise((resolve) => silent.bind(0, '127.0.0.1', resolve))
    const storage = mkdtempSync(path.join(os.tmpdir(), 'peersky-offline-start-'))
    let sdk = null
    try {
      const started = Date.now()
      sdk = await create({ storage, swarmOpts: { bootstrap: [{ host: '127.0.0.1', port: silent.address().port }] } })
      expect(Date.now() - started).to.be.below(3000)
      const drive = await sdk.getDrive('notes')
      await drive.put('/hello.txt', Buffer.from('still here'))
      expect((await drive.get('/hello.txt')).toString()).to.equal('still here')
    } finally {
      await sdk?.close()
      silent.close()
      rmSync(storage, { recursive: true, force: true })
    }
  })

  it('comes from the patch every install applies', () => {
    const sdkSource = readFileSync(new URL('../../node_modules/hyper-sdk/index.js', import.meta.url), 'utf8')
    expect(sdkSource).to.contain('this.swarm.listen().catch(() => {})')
    expect(sdkSource).to.not.contain('await this.swarm.listen()')
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    expect(pkg.scripts.postinstall).to.contain('patch-package')
  })
})
