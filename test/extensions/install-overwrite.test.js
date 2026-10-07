// A sideloaded package that copied an installed extension's manifest used to be
// written over that extension's folder before the duplicate check ran.

import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { createWriteStream } from 'fs'
import { cp, mkdtemp, readFile, writeFile } from 'fs/promises'
import archiver from 'archiver'
import { fileURLToPath } from 'url'

import { prepareFromArchive } from '../../src/extensions/services/installers/archive.js'
import { prepareFromDirectory } from '../../src/extensions/services/installers/directory.js'
import { chromeIdFromKey } from '../../src/extensions/utils/ids.js'

const fixture = fileURLToPath(new URL('../fixtures/extensions/mv3-p2p-probe/', import.meta.url))

// A throwaway key; Electron 43 assigned this extension the ID below.
const TEST_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoYgxV22Vmimb2Nn0QXeaB+1QNjqlmwj3pR6FlmesfQ0aaHHwOzHITzm1YN8PjVYX43M0vjDHiHSLRzQazy7scg/ejzsd7cTrI6nHuw4WhL0UWswDzdQ0HoezSA3x2mr3D5o/3w5B5SShdRz4xqGybiCscK5U3DcLJMfDlPYrYkVRPHyJ409hd7WVodAdVVY+XnMax14v09vmG4zBvjUetXQQT/X+jaw/r0c9cpxKVDUUSFVVXAQNHyU0DARRoxF0AmuKbYWYhyyuewn5c8lOkOLVc4tqZuLHlXOM8Gfcb8PWL1a+bOHZaFH9pl4jQQOyqXqlIgBlkZGk8S97JJmllwIDAQAB'
const TEST_KEY_ID = 'kipeapoknhgdbnpkoogkgpnhefiipihp'

async function zipOf (dir, into) {
  const out = path.join(into, `pkg-${Date.now()}.zip`)
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

async function lookalike (edit) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'peersky-evil-'))
  await cp(fixture, dir, { recursive: true })
  await writeFile(path.join(dir, 'sw.js'), 'self.stolen = true')
  if (edit) {
    const manifestPath = path.join(dir, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    await writeFile(manifestPath, JSON.stringify(edit(manifest)))
  }
  return dir
}

describe('installing over an existing extension', function () {
  it('derives the same ID from manifest.key as Chromium', function () {
    expect(chromeIdFromKey(TEST_KEY)).to.equal(TEST_KEY_ID)
    expect(chromeIdFromKey('')).to.equal(null)
    expect(chromeIdFromKey(undefined)).to.equal(null)
  })

  it('refuses a package copying the metadata of an extension stored under another ID', async function () {
    const manager = { extensionsBaseDir: await mkdtemp(path.join(os.tmpdir(), 'peersky-ext-')), app: null }
    const installed = await prepareFromDirectory(manager, fixture)
    // Preinstalled extensions are registered under their store ID but stored at the metadata hash.
    manager.loadedExtensions = new Map([['storeid', { ...installed, id: 'storeid', electronId: 'storeid' }]])
    const original = await readFile(path.join(installed.installedPath, 'sw.js'), 'utf8')

    for (const install of [
      async () => prepareFromArchive(manager, await zipOf(await lookalike(), manager.extensionsBaseDir)),
      async () => prepareFromDirectory(manager, await lookalike())
    ]) {
      let error
      await install().catch((e) => { error = e })
      expect(error?.code).to.equal('E_ALREADY_EXISTS')
      expect(await readFile(path.join(installed.installedPath, 'sw.js'), 'utf8')).to.equal(original)
    }
  })

  it("refuses a package whose manifest.key claims an installed extension's ID", async function () {
    const manager = { extensionsBaseDir: await mkdtemp(path.join(os.tmpdir(), 'peersky-ext-')), app: null }
    manager.loadedExtensions = new Map([['store', { id: 'store', electronId: TEST_KEY_ID, installedPath: '/elsewhere/store/1.0_0' }]])
    const dir = await lookalike((m) => ({ ...m, name: 'Totally Different', key: TEST_KEY }))
    let error
    await prepareFromDirectory(manager, dir).catch((e) => { error = e })
    expect(error?.code).to.equal('E_ALREADY_EXISTS')
  })

  it('still installs an unrelated extension', async function () {
    const manager = { extensionsBaseDir: await mkdtemp(path.join(os.tmpdir(), 'peersky-ext-')), app: null }
    manager.loadedExtensions = new Map([['other', { id: 'other', electronId: 'other', installedPath: '/elsewhere/other/1.0_0' }]])
    const ext = await prepareFromDirectory(manager, fixture)
    expect(ext.installedPath).to.contain(manager.extensionsBaseDir)
  })
})
