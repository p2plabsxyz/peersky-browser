import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { mkdtemp, readFile, writeFile } from 'fs/promises'

import {
  PRIVATE_HYPERDRIVE_REGISTRY_FILE,
  listPrivateHyperdrives,
  rememberPrivateHyperdrive
} from '../../src/protocols/private-hyperdrive-registry.js'

describe('private Hyperdrive registry', function () {
  it('persists bounded metadata without exposing it through the shared cache', async function () {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'peersky-private-registry-'))
    const firstUrl = `hyper://${'a'.repeat(52)}/`
    const secondUrl = `hyper://${'b'.repeat(52)}/`

    await rememberPrivateHyperdrive(userData, { name: 'first.txt', url: firstUrl, timestamp: 1 })
    await rememberPrivateHyperdrive(userData, { name: 'renamed.txt', url: firstUrl, timestamp: 2 })
    await rememberPrivateHyperdrive(userData, { name: 'second.txt', url: secondUrl, timestamp: 3 })

    expect(await listPrivateHyperdrives(userData)).to.deep.equal([
      { name: 'second.txt', url: secondUrl, timestamp: 3 },
      { name: 'renamed.txt', url: firstUrl, timestamp: 2 }
    ])
    const persisted = JSON.parse(await readFile(
      path.join(userData, PRIVATE_HYPERDRIVE_REGISTRY_FILE),
      'utf8'
    ))
    expect(persisted).to.have.length(2)
  })

  it('rejects an invalid registry instead of silently hiding private uploads', async function () {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'peersky-private-registry-invalid-'))
    await writeFile(path.join(userData, PRIVATE_HYPERDRIVE_REGISTRY_FILE), '{}')

    let error
    try {
      await listPrivateHyperdrives(userData)
    } catch (caught) {
      error = caught
    }

    expect(error?.message).to.equal('Private Hyperdrive registry is invalid')
  })
})
