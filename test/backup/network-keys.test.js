import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { mkdtemp, stat, writeFile } from 'fs/promises'

import { NETWORK_KEYS_FILE, ensureOwnNetworkKeys, readNetworkKeys, withNetworkKey } from '../../src/backup/network-keys.js'

describe('network-keys', function () {
  it('gives a restored desktop keys of its own, once, readable only by the person', async function () {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'peersky-netkeys-'))
    expect(await readNetworkKeys(userData)).to.equal(null)

    expect(await ensureOwnNetworkKeys(userData)).to.equal(true)
    const keys = await readNetworkKeys(userData)
    expect(keys.main.publicKey).to.have.length(32)
    expect(keys.main.secretKey).to.have.length(64)
    expect(keys.private.publicKey.equals(keys.main.publicKey)).to.equal(false)
    if (process.platform !== 'win32') {
      expect((await stat(path.join(userData, NETWORK_KEYS_FILE))).mode & 0o777).to.equal(0o600)
    }

    // Restored again, it stays the member it already is.
    expect(await ensureOwnNetworkKeys(userData)).to.equal(false)
    expect((await readNetworkKeys(userData)).main.publicKey.equals(keys.main.publicKey)).to.equal(true)
  })

  it('replaces a broken file instead of starting on it', async function () {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'peersky-netkeys-bad-'))
    await writeFile(path.join(userData, NETWORK_KEYS_FILE), JSON.stringify({ main: { publicKey: 'nope' } }))
    expect(await readNetworkKeys(userData)).to.equal(null)
    expect(await ensureOwnNetworkKeys(userData)).to.equal(true)
    expect(await readNetworkKeys(userData)).not.to.equal(null)
  })

  it('connects with the key given, keeping the other options', function () {
    const keyPair = { publicKey: Buffer.alloc(32), secretKey: Buffer.alloc(64) }
    const options = { storage: '/tmp/x', swarmOpts: { maxPeers: 8 } }
    expect(withNetworkKey(options, keyPair)).to.deep.equal({ storage: '/tmp/x', swarmOpts: { maxPeers: 8, keyPair } })
    expect(withNetworkKey(options, null)).to.equal(options)
    expect(withNetworkKey({ storage: '/tmp/x' }, keyPair).swarmOpts).to.deep.equal({ keyPair })
  })
})
