/**
 * electron-builder beforePack hook
 *
 * node-datachannel ships its binary as per-arch optionalDependencies
 * (@node-datachannel/darwin-x64 and friends) and npm installs only the host
 * variant, so a cross-arch build packs an app that cannot load it. This must
 * be fixed before packing: require() inside the app resolves through the asar
 * index, which is sealed when the archive is written, so files dropped into
 * app.asar.unpacked afterwards are unreachable. beta.28 shipped exactly that.
 *
 * Installing the variants into the project tree here lets electron-builder
 * pack them like anything else. Extra variants are harmless, the loader picks
 * by process.arch.
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

export const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' }

export function scopedVariant (platform, arch) {
  if (platform === 'darwin') return `darwin-${arch}`
  if (platform === 'win32') return `win32-${arch}-msvc`
  if (platform === 'linux') return `linux-${arch}-gnu`
  return null
}

export function findDataChannelCopies (dir, depth = 0, found = []) {
  if (depth > 6 || !fs.existsSync(dir)) return found
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue
    const child = path.join(dir, name)
    if (!fs.statSync(child).isDirectory()) continue
    if (name === 'node-datachannel' && fs.existsSync(path.join(child, 'package.json'))) {
      found.push(child)
    } else if (name === 'node_modules' || fs.existsSync(path.join(child, 'node_modules'))) {
      findDataChannelCopies(name === 'node_modules' ? child : path.join(child, 'node_modules'), depth + 1, found)
    }
  }
  return found
}

export function hasLocalBinary (modPath) {
  const buildDir = path.join(modPath, 'build', 'Release')
  return fs.existsSync(buildDir) && fs.readdirSync(buildDir).some(f => f.endsWith('.node'))
}

export function installScopedVariant (modPath, variant) {
  const version = JSON.parse(fs.readFileSync(path.join(modPath, 'package.json'), 'utf8')).version
  const pkgName = `@node-datachannel/${variant}`
  const destDir = path.join(path.dirname(modPath), '@node-datachannel', variant)
  const destPkg = path.join(destDir, 'package.json')
  if (fs.existsSync(destPkg) && JSON.parse(fs.readFileSync(destPkg, 'utf8')).version === version) {
    return 'already present'
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-prebuild-'))
  try {
    execSync(`npm pack ${pkgName}@${version} --pack-destination "${tmp}"`, { stdio: 'pipe', timeout: 120000 })
    const tarball = fs.readdirSync(tmp).find(f => f.endsWith('.tgz'))
    if (!tarball) throw new Error('npm pack produced no tarball')
    fs.rmSync(destDir, { recursive: true, force: true })
    fs.mkdirSync(destDir, { recursive: true })
    execSync(`tar -xzf "${path.join(tmp, tarball)}" -C "${destDir}" --strip-components=1`, { stdio: 'pipe', timeout: 60000 })
    return `installed ${version}`
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export default async function beforePack (context) {
  const platform = context.electronPlatformName
  const arch = ARCH_NAMES[context.arch] || 'x64'
  const projectDir = context.packager.info.projectDir || process.cwd()
  // Both mac arches at once so nothing depends on which arch packs first.
  const arches = platform === 'darwin' ? ['x64', 'arm64'] : [arch]

  for (const modPath of findDataChannelCopies(path.join(projectDir, 'node_modules'))) {
    if (hasLocalBinary(modPath)) continue // old prebuild layout, afterPack refreshes its bytes in place
    for (const a of arches) {
      const variant = scopedVariant(platform, a)
      if (!variant) continue
      try {
        const result = installScopedVariant(modPath, variant)
        console.log(`[beforePack] @node-datachannel/${variant} ${result} for ${path.relative(projectDir, modPath)}`)
      } catch (err) {
        throw new Error(`[beforePack] @node-datachannel/${variant} could not be installed, the ${arch} app would crash on startup: ${err.message}`)
      }
    }
  }
}
