// Every install left its extraction directory under extensions/_staging, and
// nothing ever removed them: one profile held 1,163 of them.

import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { createWriteStream } from 'fs'
import { mkdtemp, mkdir, readdir, writeFile } from 'fs/promises'
import archiver from 'archiver'

import { prepareFromArchive } from '../../src/extensions/services/installers/archive.js'
import { prepareFromDirectory } from '../../src/extensions/services/installers/directory.js'

const fixture = new URL('../fixtures/extensions/mv3-p2p-probe/', import.meta.url).pathname

async function freshManager () {
  return { extensionsBaseDir: await mkdtemp(path.join(os.tmpdir(), 'peersky-ext-')), app: null }
}

async function staged (manager) {
  return readdir(path.join(manager.extensionsBaseDir, '_staging')).catch(() => [])
}

async function zipOf (dir, into) {
  const out = path.join(into, 'ext.zip')
  await new Promise((resolve, reject) => {
    const archive = archiver('zip')
    const stream = createWriteStream(out)
    stream.on('close', resolve)
    archive.on('error', reject)
    archive.pipe(stream)
    archive.directory(dir, false)
    archive.finalize()
  })
  return out
}

describe('installer staging directories', function () {
  it('are gone after a directory install', async function () {
    const manager = await freshManager()
    const ext = await prepareFromDirectory(manager, fixture)
    expect(ext.installedPath).to.contain(manager.extensionsBaseDir)
    expect(await staged(manager)).to.deep.equal([])
  })

  it('are gone after a directory install fails', async function () {
    const manager = await freshManager()
    const empty = await mkdtemp(path.join(os.tmpdir(), 'peersky-empty-'))
    let error
    await prepareFromDirectory(manager, empty).catch(e => { error = e })
    expect(error).to.be.an('error')
    expect(await staged(manager)).to.deep.equal([])
  })

  it('are gone after an archive install', async function () {
    const manager = await freshManager()
    const ext = await prepareFromArchive(manager, await zipOf(fixture, manager.extensionsBaseDir))
    expect(ext.installedPath).to.contain(manager.extensionsBaseDir)
    expect(await staged(manager)).to.deep.equal([])
  })

  it('are gone after an archive without a manifest is rejected', async function () {
    const manager = await freshManager()
    const junk = await mkdtemp(path.join(os.tmpdir(), 'peersky-junk-'))
    await mkdir(path.join(junk, 'nested'))
    await writeFile(path.join(junk, 'nested', 'readme.txt'), 'no manifest here')
    let error
    await prepareFromArchive(manager, await zipOf(junk, manager.extensionsBaseDir)).catch(e => { error = e })
    expect(error).to.be.an('error')
    expect(await staged(manager)).to.deep.equal([])
  })
})
