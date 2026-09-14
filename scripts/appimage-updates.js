/**
 * Publishes a .zsync beside each AppImage and points the AppImage at it, so
 * AppImage update tools fetch only changed blocks (#222). Peersky's own updater
 * still downloads the whole file.
 *
 * Both hooks live here because electron-builder resolves a hook to the named
 * export matching it. The pointer goes in artifactBuildCompleted, which is
 * awaited before the upload starts; writing it later would ship the original
 * bytes. Patching invalidates the sha512, so updateInfo is corrected with it,
 * and leaves the appended block map stale by one block, which nothing reads.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function appImageArtifacts (artifactPaths) {
  return (artifactPaths || []).filter((p) => typeof p === 'string' && p.endsWith('.AppImage'))
}

// Version wildcarded so one string serves every release. "latest" skips
// prereleases, so releases must be published as normal releases.
export function updateInformation ({ owner, repo, appImageName, version }) {
  if (!owner || !repo) throw new Error('[appimage-updates] publish owner and repo are required')
  // Without the wildcard the pattern matches only the release it shipped in.
  if (!version) throw new Error('[appimage-updates] a version is required to wildcard the zsync pattern')
  const zsyncName = `${path.basename(appImageName)}.zsync`
  return `gh-releases-zsync|${owner}|${repo}|latest|${zsyncName.split(version).join('*')}`
}

// Reads only the section table, not the whole 300 MB artifact.
export function findElfSection (fd, name) {
  const ident = Buffer.alloc(64)
  fs.readSync(fd, ident, 0, 64, 0)
  if (ident.subarray(0, 4).toString('binary') !== '\x7fELF') throw new Error('not an ELF file')
  if (ident[4] !== 2) throw new Error('only 64-bit AppImage runtimes are supported')
  const shoff = Number(ident.readBigUInt64LE(0x28))
  const shentsize = ident.readUInt16LE(0x3a)
  const shnum = ident.readUInt16LE(0x3c)
  const shstrndx = ident.readUInt16LE(0x3e)

  const table = Buffer.alloc(shentsize * shnum)
  fs.readSync(fd, table, 0, table.length, shoff)
  const entry = (i) => {
    const at = i * shentsize
    return {
      name: table.readUInt32LE(at),
      offset: Number(table.readBigUInt64LE(at + 24)),
      size: Number(table.readBigUInt64LE(at + 32))
    }
  }
  const strtab = entry(shstrndx)
  const names = Buffer.alloc(strtab.size)
  fs.readSync(fd, names, 0, strtab.size, strtab.offset)
  for (let i = 0; i < shnum; i++) {
    const section = entry(i)
    const end = names.indexOf(0, section.name)
    if (names.subarray(section.name, end).toString('utf8') === name) return section
  }
  return null
}

export function writeUpdateInformation (appImagePath, info) {
  const fd = fs.openSync(appImagePath, 'r+')
  try {
    const section = findElfSection(fd, '.upd_info')
    if (!section) {
      throw new Error('no .upd_info section in the AppImage runtime, so update tools cannot be pointed at the .zsync')
    }
    const payload = Buffer.from(info, 'utf8')
    if (payload.length >= section.size) {
      throw new Error(`update information is ${payload.length} bytes, larger than the ${section.size} byte .upd_info section`)
    }
    // Readers stop at the first NUL, so clear the slot before writing.
    fs.writeSync(fd, Buffer.alloc(section.size), 0, section.size, section.offset)
    fs.writeSync(fd, payload, 0, payload.length, section.offset)
    return section
  } finally {
    fs.closeSync(fd)
  }
}

export function sha512Base64 (filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')))
  })
}

export async function patchAppImage (event, pkg) {
  if (!event || typeof event.file !== 'string' || appImageArtifacts([event.file]).length === 0) return false
  const publish = [].concat(pkg.build?.publish || [])[0] || {}

  writeUpdateInformation(event.file, updateInformation({
    owner: publish.owner,
    repo: publish.repo,
    // GitHub uploads under safeArtifactName when it differs from the on-disk name.
    appImageName: event.safeArtifactName || path.basename(event.file),
    version: pkg.version
  }))

  // latest-linux.yml is written from this object, and the bytes just changed.
  if (event.updateInfo) event.updateInfo.sha512 = await sha512Base64(event.file)
  return true
}

export async function artifactBuildCompleted (event) {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  await patchAppImage(event, pkg)
}

// No -u: the release URL is unknown at build time, so zsyncmake writes a
// relative URL naming the AppImage beside the .zsync.
export function zsyncArgs (appImagePath) {
  const name = path.basename(appImagePath)
  return {
    cwd: path.dirname(appImagePath),
    args: ['-o', `${name}.zsync`, name]
  }
}

const defaultRun = (file, args, options) => execFileSync(file, args, { ...options, stdio: 'pipe' })

const isMissingCommand = (error) =>
  error?.code === 'ENOENT' || /ENOENT|not found/i.test(error?.message || '')

// Failures throw, since a release must not silently lack the file. The one
// exception is zsyncmake being absent off CI, where build-all builds Linux
// targets from machines that will not have it.
export function buildZsyncArtifacts (artifactPaths, { run = defaultRun, ci = process.env.CI } = {}) {
  const built = []
  for (const appImage of appImageArtifacts(artifactPaths)) {
    const { cwd, args } = zsyncArgs(appImage)
    try {
      run('zsyncmake', args, { cwd })
    } catch (error) {
      if (isMissingCommand(error) && !ci) {
        console.warn(
          `[appimage-updates] zsyncmake not installed, skipping ${path.basename(appImage)}.zsync. ` +
          'Install the zsync package to build a release locally.'
        )
        continue
      }
      throw new Error(
        `[appimage-updates] zsyncmake failed for ${path.basename(appImage)}: ` +
        `${error?.message || error}. Install the zsync package on the build host.`
      )
    }
    built.push(`${appImage}.zsync`)
  }
  return built
}

// Returns [] on the macOS and Windows runners, which build no AppImage.
export async function afterAllArtifactBuild (buildResult) {
  return buildZsyncArtifacts(buildResult?.artifactPaths)
}
