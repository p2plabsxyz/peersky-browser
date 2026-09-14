// AppImage update tools downloaded the whole ~330 MB file every time (#222).
// Three things have to hold: the .zsync exists, the AppImage points at it, and
// the published checksum still matches the patched bytes. Peersky's own updater
// is untouched and still does a full download.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { expect } from 'chai'
import {
  appImageArtifacts,
  updateInformation,
  findElfSection,
  writeUpdateInformation,
  sha512Base64,
  patchAppImage,
  artifactBuildCompleted,
  zsyncArgs,
  buildZsyncArtifacts,
  afterAllArtifactBuild
} from '../../scripts/appimage-updates.js'

const APPIMAGE = '/build/dist/peersky-browser-1.0.0-beta.28-linux-x86_64.AppImage'

function recordingRun () {
  const calls = []
  const run = (file, args, options) => { calls.push({ file, args, options }) }
  return { calls, run }
}

// Minimal ELF64 laid out like the real runtime: header, bodies, section table.
function fakeAppImage (updInfoSize = 1024) {
  const names = Buffer.from('\0.upd_info\0.shstrtab\0', 'utf8')
  const headerSize = 64
  const updOffset = headerSize
  const strOffset = updOffset + updInfoSize
  const shoff = strOffset + names.length
  const shentsize = 64
  const shnum = 3

  const buf = Buffer.alloc(shoff + shentsize * shnum)
  buf.write('\x7fELF', 0, 'binary')
  buf[4] = 2 // 64-bit
  buf[5] = 1 // little endian
  buf.writeBigUInt64LE(BigInt(shoff), 0x28)
  buf.writeUInt16LE(shentsize, 0x3a)
  buf.writeUInt16LE(shnum, 0x3c)
  buf.writeUInt16LE(2, 0x3e) // .shstrtab is index 2
  names.copy(buf, strOffset)

  const section = (i, nameOffset, offset, size) => {
    const at = shoff + i * shentsize
    buf.writeUInt32LE(nameOffset, at)
    buf.writeBigUInt64LE(BigInt(offset), at + 24)
    buf.writeBigUInt64LE(BigInt(size), at + 32)
  }
  section(0, 0, 0, 0)
  section(1, 1, updOffset, updInfoSize) // ".upd_info" starts at names[1]
  section(2, 11, strOffset, names.length) // ".shstrtab" starts at names[11]

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-zsync-')), 'x.AppImage')
  fs.writeFileSync(file, buf)
  return { file, updOffset, updInfoSize }
}

function readUpdInfo (file, offset, size) {
  const raw = fs.readFileSync(file).subarray(offset, offset + size)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8')
}

describe('zsync artifacts for the AppImage', function () {
  describe('which artifacts get one', function () {
    it('picks the AppImage out of a full release', function () {
      expect(appImageArtifacts([
        '/d/peersky-1.0.0-linux-x86_64.AppImage',
        '/d/peersky-1.0.0-linux-amd64.deb',
        '/d/peersky-1.0.0-linux-x64.apk',
        '/d/peersky-1.0.0-linux-x64.pacman',
        '/d/latest-linux.yml'
      ])).to.deep.equal(['/d/peersky-1.0.0-linux-x86_64.AppImage'])
    })

    it('produces nothing on the mac and windows runners', function () {
      const { calls, run } = recordingRun()
      const built = buildZsyncArtifacts([
        '/d/peersky-1.0.0-mac-arm64.dmg',
        '/d/peersky-1.0.0-mac-arm64.zip.blockmap',
        '/d/Peersky-Setup-1.0.0.exe'
      ], { run })
      expect(built).to.deep.equal([])
      expect(calls, 'zsyncmake must not be invoked where there is no AppImage').to.have.lengthOf(0)
    })

    it('survives a hook call with no artifacts at all', async function () {
      expect(await afterAllArtifactBuild({})).to.deep.equal([])
      expect(await afterAllArtifactBuild({ artifactPaths: [] })).to.deep.equal([])
    })
  })

  describe('the zsyncmake invocation', function () {
    // zsyncmake treats -u as an absolute URL and copies it into the header. The
    // release URL is unknown at build time, so leaving it out is what makes the
    // header name the AppImage sitting beside the .zsync.
    it('uses bare filenames and runs from the artifact directory', function () {
      const { cwd, args } = zsyncArgs(APPIMAGE)
      expect(cwd).to.equal('/build/dist')
      expect(args).to.deep.equal([
        '-o', 'peersky-browser-1.0.0-beta.28-linux-x86_64.AppImage.zsync',
        'peersky-browser-1.0.0-beta.28-linux-x86_64.AppImage'
      ])
      for (const arg of args) {
        expect(arg.includes(path.sep + 'build'), `"${arg}" must not carry a directory`).to.equal(false)
      }
    })

    it('never passes -u, which would bake in an absolute URL', function () {
      expect(zsyncArgs(APPIMAGE).args).to.not.include('-u')
    })

    it('names the output beside the AppImage it describes', function () {
      const { calls, run } = recordingRun()
      const built = buildZsyncArtifacts([APPIMAGE], { run })
      expect(built).to.deep.equal([`${APPIMAGE}.zsync`])
      expect(calls).to.have.lengthOf(1)
      expect(calls[0].file).to.equal('zsyncmake')
      expect(calls[0].options.cwd).to.equal('/build/dist')
    })
  })

  // ci is explicit throughout: it defaults to process.env.CI, which is set on
  // the runners and not on a laptop.
  describe('when zsyncmake is missing or fails', function () {
    it('fails the build rather than publishing a release without it', function () {
      const run = () => { throw new Error('spawn zsyncmake ENOENT') }
      expect(() => buildZsyncArtifacts([APPIMAGE], { run, ci: 'true' }))
        .to.throw(/zsyncmake failed for peersky-browser-1\.0\.0-beta\.28-linux-x86_64\.AppImage/)
    })

    it('says how to fix it', function () {
      const run = () => { throw new Error('spawn zsyncmake ENOENT') }
      expect(() => buildZsyncArtifacts([APPIMAGE], { run, ci: 'true' })).to.throw(/Install the zsync package/)
    })
  })
})

// Without this the .zsync is published but unreachable: update tools read the
// URL from inside the AppImage and find a blank section. It has to happen in
// artifactBuildCompleted, because electron-builder starts uploading an artifact
// as soon as it is created, before afterAllArtifactBuild ever runs.
describe('pointing the AppImage at its zsync', function () {
  describe('the update-information string', function () {
    it('names the zsync, not the AppImage', function () {
      const info = updateInformation({
        owner: 'p2plabsxyz',
        repo: 'peersky-browser',
        appImageName: 'peersky-browser-1.0.0-beta.28-linux-x86_64.AppImage',
        version: '1.0.0-beta.28'
      })
      expect(info).to.equal('gh-releases-zsync|p2plabsxyz|peersky-browser|latest|peersky-browser-*-linux-x86_64.AppImage.zsync')
    })

    // A literal version would only ever match the release it shipped in, so
    // every later update would find nothing.
    it('wildcards the version so it keeps matching future releases', function () {
      const info = updateInformation({
        owner: 'o',
        repo: 'r',
        appImageName: 'app-2.5.0-linux-x86_64.AppImage',
        version: '2.5.0'
      })
      expect(info).to.include('app-*-linux-x86_64.AppImage.zsync')
      expect(info).to.not.include('2.5.0')
    })

    it('refuses to build a string with no repository to point at', function () {
      expect(() => updateInformation({ appImageName: 'a.AppImage', version: '1' }))
        .to.throw(/owner and repo are required/)
    })
  })

  describe('writing it into the binary', function () {
    it('finds the .upd_info section and fills it', function () {
      const { file, updOffset, updInfoSize } = fakeAppImage()
      const before = fs.statSync(file).size
      writeUpdateInformation(file, 'gh-releases-zsync|o|r|latest|a-*.AppImage.zsync')
      expect(readUpdInfo(file, updOffset, updInfoSize)).to.equal('gh-releases-zsync|o|r|latest|a-*.AppImage.zsync')
      // The slot is fixed size, so patching must not move anything after it.
      expect(fs.statSync(file).size, 'file length must not change').to.equal(before)
    })

    // Readers stop at the first NUL, so a shorter string written over a longer
    // one would otherwise be read with the old tail still attached.
    it('clears the slot before writing a shorter string', function () {
      const { file, updOffset, updInfoSize } = fakeAppImage()
      writeUpdateInformation(file, 'gh-releases-zsync|o|r|latest|averylongoldname-*.AppImage.zsync')
      writeUpdateInformation(file, 'zsync|https://x/y.zsync')
      expect(readUpdInfo(file, updOffset, updInfoSize)).to.equal('zsync|https://x/y.zsync')
    })

    it('refuses a string too long for the slot instead of truncating it', function () {
      const { file } = fakeAppImage(32)
      expect(() => writeUpdateInformation(file, 'x'.repeat(64)))
        .to.throw(/larger than the 32 byte \.upd_info section/)
    })

    // Readers stop at the first NUL, so a payload filling the slot exactly
    // leaves nothing to terminate it.
    it('refuses a string that exactly fills the slot, leaving no terminator', function () {
      const { file } = fakeAppImage(32)
      expect(() => writeUpdateInformation(file, 'x'.repeat(32))).to.throw(/larger than the 32 byte/)
      const ok = fakeAppImage(32)
      writeUpdateInformation(ok.file, 'x'.repeat(31))
      expect(readUpdInfo(ok.file, ok.updOffset, ok.updInfoSize)).to.have.lengthOf(31)
    })

    it('fails loudly if a future runtime drops the section', function () {
      const { file } = fakeAppImage()
      const fd = fs.openSync(file, 'r+')
      try {
        // Rename .upd_info so the lookup misses, as a runtime change would.
        const buf = fs.readFileSync(file)
        const at = buf.indexOf(Buffer.from('.upd_info\0'))
        buf.write('.gone_inf', at)
        fs.writeFileSync(file, buf)
      } finally { fs.closeSync(fd) }
      expect(() => writeUpdateInformation(file, 'zsync|https://x')).to.throw(/no \.upd_info section/)
    })

    it('rejects something that is not an ELF binary', function () {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-zsync-')), 'not.AppImage')
      fs.writeFileSync(file, Buffer.alloc(4096, 0x41))
      expect(() => writeUpdateInformation(file, 'zsync|https://x')).to.throw(/not an ELF file/)
    })

    it('locates a section by name rather than by a fixed offset', function () {
      const { file, updOffset } = fakeAppImage()
      const fd = fs.openSync(file, 'r')
      try {
        expect(findElfSection(fd, '.upd_info').offset).to.equal(updOffset)
        expect(findElfSection(fd, '.nothing_here')).to.equal(null)
      } finally { fs.closeSync(fd) }
    })
  })

  // electron-builder starts uploading an artifact as soon as it is created, so
  // patching later would put the unpatched bytes on the release and leave the
  // published checksum describing a file nobody downloads.
  describe('patching before the upload', function () {
    function event (file) {
      return { file, updateInfo: { sha512: 'STALE==', blockMapSize: 355006 } }
    }
    const pkg = { version: '1.0.0-beta.28', build: { publish: [{ owner: 'p2plabsxyz', repo: 'peersky-browser' }] } }

    it('embeds the pointer and corrects the hash the yml is written from', async function () {
      const { file, updOffset, updInfoSize } = fakeAppImage()
      const e = event(file)
      expect(await patchAppImage(e, pkg)).to.equal(true)
      expect(readUpdInfo(file, updOffset, updInfoSize)).to.include('gh-releases-zsync|p2plabsxyz|peersky-browser|latest|')
      expect(e.updateInfo.sha512, 'a stale hash would describe bytes nobody downloads').to.equal(await sha512Base64(file))
      // Size and trailer untouched; contents are knowingly stale by one block.
      expect(e.updateInfo.blockMapSize, 'the blockmap trailer is not resized').to.equal(355006)
    })

    it('ignores every artifact that is not an AppImage', async function () {
      for (const name of ['x.dmg', 'x.deb', 'x.exe', 'latest-linux.yml']) {
        expect(await patchAppImage(event(name), pkg), name).to.equal(false)
      }
      expect(await patchAppImage(undefined, pkg)).to.equal(false)
      expect(await patchAppImage({}, pkg)).to.equal(false)
    })

    it('survives an event that carries no updateInfo', async function () {
      const { file } = fakeAppImage()
      const e = { file }
      expect(await patchAppImage(e, pkg)).to.equal(true)
      expect(e.updateInfo).to.equal(undefined)
    })

    it('runs as a hook on its own, reading the real package.json', async function () {
      const { file, updOffset, updInfoSize } = fakeAppImage()
      const e = event(file)
      await artifactBuildCompleted(e)
      expect(readUpdInfo(file, updOffset, updInfoSize)).to.include('gh-releases-zsync|')
    })
  })

  describe('the hash it publishes', function () {
    it('matches the file after patching, not before', async function () {
      const { file } = fakeAppImage()
      const before = await sha512Base64(file)
      writeUpdateInformation(file, 'gh-releases-zsync|o|r|latest|a-*.AppImage.zsync')
      const after = await sha512Base64(file)
      expect(after, 'patching must change the hash, or the order below does not matter').to.not.equal(before)
      expect(after).to.match(/^[A-Za-z0-9+/]+=*$/)
    })
  })
})

describe('the packaging config the delta depends on', function () {
  let build
  before(async function () {
    const { readFile } = await import('fs/promises')
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
    build = pkg.build
  })

  it('runs the hook that emits and uploads the zsync', function () {
    expect(build.afterAllArtifactBuild).to.equal('./scripts/appimage-updates.js')
  })

  // Dropping this one would put the unpatched AppImage on the release, because
  // the upload starts before afterAllArtifactBuild runs.
  it('patches the AppImage in the hook that runs before the upload', function () {
    expect(build.artifactBuildCompleted).to.equal('./scripts/appimage-updates.js')
  })

  it('still builds an AppImage for the zsync to describe', function () {
    expect(build.linux.target).to.include('AppImage')
  })

  it('knows which repository the update information should point at', function () {
    const publish = [].concat(build.publish)[0]
    expect(publish.owner).to.be.a('string')
    expect(publish.repo).to.be.a('string')
    expect(publish.owner.length, 'the update information needs a real owner').to.be.greaterThan(0)
    expect(publish.repo.length, 'the update information needs a real repo').to.be.greaterThan(0)
  })

  // Both of these change how mksquashfs packs blocks. Either one makes almost
  // every block differ between releases, which turns the delta back into a
  // full download without any visible failure.
  it('leaves compression and the appimage toolset at their defaults', function () {
    expect(build.compression, 'compression must stay unset for deltas to be small').to.equal(undefined)
    expect(build.toolsets?.appimage, 'a pinned appimage toolset switches the runtime and compressor').to.equal(undefined)
  })
})

describe('building without zsyncmake installed', function () {
  const APP = '/d/peersky-1.0.0-linux-x86_64.AppImage'
  const missing = () => { const e = new Error('spawn zsyncmake ENOENT'); e.code = 'ENOENT'; throw e }

  // build-all builds Linux targets from macOS and Windows, so a missing
  // packaging tool must not break a developer's local build.
  // null, not undefined: a default parameter still fires for undefined.
  it('skips the zsync locally rather than failing the build', function () {
    expect(buildZsyncArtifacts([APP], { run: missing, ci: null })).to.deep.equal([])
  })

  // A release that quietly lacks the file it promises is worse than a red build.
  it('still fails the build in CI', function () {
    expect(() => buildZsyncArtifacts([APP], { run: missing, ci: 'true' }))
      .to.throw(/zsyncmake failed/)
  })

  it('fails everywhere when zsyncmake is present but errors', function () {
    const broken = () => { throw new Error('zsyncmake: write error') }
    expect(() => buildZsyncArtifacts([APP], { run: broken, ci: null })).to.throw(/write error/)
    expect(() => buildZsyncArtifacts([APP], { run: broken, ci: 'true' })).to.throw(/write error/)
  })
})

describe('the pattern follows the name GitHub stores', function () {
  // GitHub uploads under safeArtifactName when it differs from the on-disk name.
  it('prefers safeArtifactName over the on-disk basename', async function () {
    const { file, updOffset, updInfoSize } = fakeAppImage()
    await patchAppImage(
      { file, safeArtifactName: 'peersky-browser-9.9.9-linux-x86_64.AppImage', updateInfo: {} },
      { version: '9.9.9', build: { publish: [{ owner: 'o', repo: 'r' }] } }
    )
    expect(readUpdInfo(file, updOffset, updInfoSize)).to.equal('gh-releases-zsync|o|r|latest|peersky-browser-*-linux-x86_64.AppImage.zsync')
  })

  it('refuses to build a pattern with no version to wildcard', function () {
    expect(() => updateInformation({ owner: 'o', repo: 'r', appImageName: 'a.AppImage', version: '' }))
      .to.throw(/version is required/)
  })
})
