// A new bundled version of a preinstalled extension came up as another
// extension: each version was imported into a folder of its own, Electron names
// an extension with no manifest key after its folder, and so uBlock Origin's
// own filters, trusted sites and settings stayed behind under the old name. A
// new version now takes the old one's folder and record, as Chrome keeps an
// extension's ID and data through an update.

import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { createWriteStream } from 'fs'
import { access, mkdtemp, mkdir, readFile, readdir, writeFile } from 'fs/promises'
import archiver from 'archiver'

import { prepareFromArchive } from '../../src/extensions/services/installers/archive.js'
import { moveIntoPlace } from '../../src/extensions/services/preinstalled-update.js'

const exists = (file) => access(file).then(() => true, () => false)

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

async function writeExtension (dir, version, file) {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Blocker',
    version,
    icons: { 16: 'icon.png' }
  }))
  await writeFile(path.join(dir, 'icon.png'), 'png')
  await writeFile(path.join(dir, file), version)
}

describe('preinstalled extension updates', function () {
  let root
  let manager
  let existing

  beforeEach(async function () {
    root = await mkdtemp(path.join(os.tmpdir(), 'peersky-preinstalled-update-'))
    manager = { extensionsBaseDir: path.join(root, 'extensions'), loadedExtensions: new Map(), app: null }
    const installedPath = path.join(manager.extensionsBaseDir, 'oldid', '1.0.0_0')
    await writeExtension(installedPath, '1.0.0', 'old.js')
    existing = {
      id: 'oldid',
      name: 'Blocker',
      displayName: 'uBlock Origin MV3',
      version: '1.0.0',
      manifest: { manifest_version: 3, name: 'Blocker', version: '1.0.0' },
      installedPath,
      electronId: 'annenclfklkbhkobajnoajjbommgpgnc',
      enabled: false,
      source: 'preinstalled',
      isSystem: true,
      removable: false,
      preinstallVersion: '1.0.0',
      installDate: '2026-08-20T00:00:00.000Z',
      iconPath: 'peersky://extension-icon/oldid/16?v=1.0.0'
    }
    manager.loadedExtensions.set(existing.id, existing)
  })

  it("puts the new version in the old one's folder, under the same record", async function () {
    const source = path.join(root, 'bundle')
    await writeExtension(source, '1.1.0', 'new.js')
    const fresh = await prepareFromArchive(manager, await zipOf(source, root))
    expect(fresh.installedPath).to.not.equal(existing.installedPath)

    const updated = await moveIntoPlace(existing, fresh)

    // The same folder, so Electron gives it the same ID and storage.
    expect(updated.installedPath).to.equal(existing.installedPath)
    expect(updated.id).to.equal('oldid')
    expect(updated.electronId).to.equal(existing.electronId)
    expect(updated.version).to.equal('1.1.0')
    expect(updated.manifest.version).to.equal('1.1.0')
    expect(updated.iconPath).to.equal('peersky://extension-icon/oldid/16?v=1.1.0')
    expect(await readFile(path.join(updated.installedPath, 'new.js'), 'utf8')).to.equal('1.1.0')
    expect(await exists(path.join(updated.installedPath, 'old.js'))).to.equal(false)
    // Left as the person and the bundle had it.
    expect(updated).to.include({ enabled: false, source: 'preinstalled', isSystem: true, removable: false, installDate: existing.installDate })
    // Nothing else is left in the extensions folder.
    expect((await readdir(manager.extensionsBaseDir)).filter((name) => name !== '_staging')).to.deep.equal(['oldid'])
    expect(await readdir(path.join(manager.extensionsBaseDir, 'oldid'))).to.deep.equal(['1.0.0_0'])
  })

  it('leaves the old version as it was when the new one cannot be moved in', async function () {
    const fresh = { id: 'newid', installedPath: path.join(manager.extensionsBaseDir, 'newid', '1.1.0_0'), version: '1.1.0', manifest: {} }
    let failed = false
    try {
      await moveIntoPlace(existing, fresh)
    } catch (_) {
      failed = true
    }
    expect(failed).to.equal(true)
    expect(await readFile(path.join(existing.installedPath, 'old.js'), 'utf8')).to.equal('1.0.0')
    expect((await readdir(path.join(manager.extensionsBaseDir, 'oldid')))).to.deep.equal(['1.0.0_0'])
  })

  it('is what a new bundled version gets, before it is imported again as before', async function () {
    const source = await readFile(new URL('../../src/extensions/index.js', import.meta.url), 'utf8')
    const start = source.indexOf('async _installBundledPreinstalled')
    const body = source.slice(start, source.indexOf('\n  }\n', start))
    const inPlace = body.indexOf('await this._updatePreinstalledInPlace(existing, entry, sourcePath, sourceStat)')
    expect(inPlace).to.be.greaterThan(-1)
    expect(body.indexOf('await removePreinstalledRecord(existing)', inPlace)).to.be.greaterThan(inPlace)
  })
})
