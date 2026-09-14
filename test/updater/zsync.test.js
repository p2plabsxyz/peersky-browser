// Every Linux update downloaded the whole ~330 MB AppImage (#222). Three things
// have to hold: the .zsync exists, the AppImage points at it, and the published
// checksum still matches the patched bytes.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { expect } from 'chai'
import afterAllArtifactBuild, {
  appImageArtifacts,
  zsyncArgs,
  buildZsyncArtifacts,
  updateInformation,
  findElfSection,
  writeUpdateInformation,
  sha512Base64,
  refreshedUpdateYml
} from '../../scripts/afterAllArtifactBuild.js'

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

  describe('when zsyncmake is missing or fails', function () {
    it('fails the build rather than publishing a release without it', function () {
      const run = () => { throw new Error('spawn zsyncmake ENOENT') }
      expect(() => buildZsyncArtifacts([APPIMAGE], { run }))
        .to.throw(/zsyncmake failed for peersky-browser-1\.0\.0-beta\.28-linux-x86_64\.AppImage/)
    })

    it('says how to fix it', function () {
      const run = () => { throw new Error('spawn zsyncmake ENOENT') }
      expect(() => buildZsyncArtifacts([APPIMAGE], { run })).to.throw(/Install the zsync package/)
    })
  })
})

// Without this the .zsync is published but unreachable: update tools read the
// URL from inside the AppImage and find a blank section.
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

  // Patching changes bytes, so the checksum electron-builder already wrote
  // would describe a file nobody can download.
  describe('keeping latest-linux.yml true', function () {
    const doc = [
      'version: 1.0.0-beta.28',
      'files:',
      '  - url: peersky-browser-1.0.0-beta.28-linux-x86_64.AppImage',
      '    sha512: STALEHASH==',
      '    size: 341629610',
      '    blockMapSize: 355006',
      '  - url: peersky-browser-1.0.0-beta.28-linux-amd64.deb',
      '    sha512: DEBHASH==',
      '    size: 243468832',
      'path: peersky-browser-1.0.0-beta.28-linux-x86_64.AppImage',
      'sha512: STALEHASH==',
      "releaseDate: '2026-09-03T02:09:07.418Z'"
    ].join('\n')
    const NAME = 'peersky-browser-1.0.0-beta.28-linux-x86_64.AppImage'

    it('replaces the AppImage hash in both places it appears', function () {
      const out = refreshedUpdateYml(doc, NAME, 'FRESH==')
      expect(out.match(/sha512: FRESH==/g), 'the files entry and the top-level copy').to.have.lengthOf(2)
      expect(out).to.not.include('STALEHASH==')
    })

    it('leaves the other artifacts alone', function () {
      const out = refreshedUpdateYml(doc, NAME, 'FRESH==')
      expect(out, 'the deb was not patched, so its hash must stand').to.include('sha512: DEBHASH==')
      expect(out).to.include('size: 341629610')
      expect(out).to.include('blockMapSize: 355006')
      expect(out).to.include('version: 1.0.0-beta.28')
      expect(out).to.include("releaseDate: '2026-09-03T02:09:07.418Z'")
    })

    it('changes nothing but those two lines', function () {
      const out = refreshedUpdateYml(doc, NAME, 'FRESH==').split('\n')
      const before = doc.split('\n')
      const differing = before.filter((line, i) => line !== out[i])
      expect(differing).to.deep.equal(['    sha512: STALEHASH==', 'sha512: STALEHASH=='])
    })

    it('is a no-op when the AppImage is not listed', function () {
      expect(refreshedUpdateYml(doc, 'something-else.AppImage', 'FRESH==')).to.equal(doc)
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
    expect(build.afterAllArtifactBuild).to.equal('./scripts/afterAllArtifactBuild.js')
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
