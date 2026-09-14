/**
 * AppImage delta updates (#222). electron-builder has no zsync support, and the
 * runtime's .upd_info section ships zero-filled so update tools find no pointer
 * to the .zsync. Writes that pointer, refreshes the sha512 it invalidates in
 * latest-linux.yml, then builds the .zsync from the final bytes. Only paths
 * returned from this hook get uploaded.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function appImageArtifacts (artifactPaths) {
  return (artifactPaths || []).filter((p) => typeof p === 'string' && p.endsWith('.AppImage'))
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

// Version wildcarded so one string serves every release. "latest" skips
// prereleases, so releases must be published as normal releases.
export function updateInformation ({ owner, repo, appImageName, version }) {
  if (!owner || !repo) throw new Error('[afterAllArtifactBuild] publish owner and repo are required')
  const zsyncName = `${path.basename(appImageName)}.zsync`
  const pattern = version ? zsyncName.split(version).join('*') : zsyncName
  return `gh-releases-zsync|${owner}|${repo}|latest|${pattern}`
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

// Matches the stale value rather than parsing, so the rest of the document is
// returned byte for byte and no YAML library is needed.
export function refreshedUpdateYml (text, appImageName, sha512) {
  const lines = text.split('\n')
  const entry = lines.findIndex((l) => l.includes(`url: ${appImageName}`))
  if (entry === -1) return text

  let stale = null
  for (let i = entry + 1; i < lines.length && !/^\s*-\s/.test(lines[i]); i++) {
    const found = lines[i].match(/^\s*sha512:\s*(\S+)\s*$/)
    if (found) { stale = found[1]; break }
  }
  if (!stale) return text

  return lines.map((line) => {
    const match = line.match(/^(\s*sha512:\s*)(\S+)\s*$/)
    return match && match[2] === stale ? `${match[1]}${sha512}` : line
  }).join('\n')
}

const defaultRun = (file, args, options) => execFileSync(file, args, { ...options, stdio: 'pipe' })

export function buildZsyncArtifacts (artifactPaths, { run = defaultRun } = {}) {
  const built = []
  for (const appImage of appImageArtifacts(artifactPaths)) {
    const { cwd, args } = zsyncArgs(appImage)
    try {
      run('zsyncmake', args, { cwd })
    } catch (error) {
      // A release silently missing the file it promises is worse than a red build.
      throw new Error(
        `[afterAllArtifactBuild] zsyncmake failed for ${path.basename(appImage)}: ` +
        `${error?.message || error}. Install the zsync package on the build host.`
      )
    }
    built.push(`${appImage}.zsync`)
  }
  return built
}

// Returns [] on the macOS and Windows runners, which build no AppImage.
export default async function afterAllArtifactBuild (buildResult) {
  const artifactPaths = buildResult?.artifactPaths || []
  const appImages = appImageArtifacts(artifactPaths)
  if (appImages.length === 0) return []

  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const publish = [].concat(pkg.build?.publish || [])[0] || {}

  for (const appImage of appImages) {
    writeUpdateInformation(appImage, updateInformation({
      owner: publish.owner,
      repo: publish.repo,
      appImageName: path.basename(appImage),
      version: pkg.version
    }))

    const hash = await sha512Base64(appImage)
    const ymlPath = path.join(path.dirname(appImage), 'latest-linux.yml')
    if (fs.existsSync(ymlPath)) {
      fs.writeFileSync(
        ymlPath,
        refreshedUpdateYml(fs.readFileSync(ymlPath, 'utf8'), path.basename(appImage), hash)
      )
    }
  }

  return buildZsyncArtifacts(appImages)
}
