/**
 * electron-builder afterPack hook
 *
 * Re-downloads the correct architecture prebuild for native modules
 * that @electron/rebuild misses (cmake-js based modules like node-datachannel).
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

// Electron-builder arch enum: 1 = x64, 3 = arm64
const ARCH_MAP = { 1: 'x64', 3: 'arm64', 0: 'ia32' }

// cmake-js modules that ship prebuilds but aren't detected by @electron/rebuild
const PREBUILD_MODULES = [
  'node_modules/node-datachannel',
  'node_modules/webrtc-polyfill/node_modules/node-datachannel'
]

export default async function afterPack (context) {
  const arch = ARCH_MAP[context.arch] || 'x64'
  const platform = context.electronPlatformName // darwin, linux, win32

  // With asar: true, node_modules are in app.asar.unpacked/
  const appDirMac = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app',
    'Contents', 'Resources', 'app.asar.unpacked')
  const appDirMacNoAsar = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app',
    'Contents', 'Resources', 'app')
  const appDirLinux = path.join(context.appOutDir, 'resources', 'app.asar.unpacked')
  const appDirLinuxNoAsar = path.join(context.appOutDir, 'resources', 'app')

  // Try asar.unpacked first, then fall back to non-asar layout
  const root = fs.existsSync(appDirMac)
    ? appDirMac
    : fs.existsSync(appDirLinux)
      ? appDirLinux
      : fs.existsSync(appDirMacNoAsar)
        ? appDirMacNoAsar
        : appDirLinuxNoAsar

  console.log(`[afterPack] Fixing native prebuilds for ${platform}-${arch} in ${root}`)

  for (const modRel of PREBUILD_MODULES) {
    const modPath = path.join(root, modRel)
    if (!fs.existsSync(modPath)) continue

    const buildDir = path.join(modPath, 'build', 'Release')
    const nodeFiles = fs.existsSync(buildDir)
      ? fs.readdirSync(buildDir).filter(f => f.endsWith('.node'))
      : []

    if (nodeFiles.length === 0) continue

    try {
      console.log(`[afterPack] Running prebuild-install for ${modRel} (${platform}-${arch})`)
      execSync(
        `npx prebuild-install -r napi --platform ${platform} --arch ${arch}`,
        { cwd: modPath, stdio: 'inherit', timeout: 60000 }
      )
      console.log(`[afterPack] ✓ ${modRel} prebuild installed for ${platform}-${arch}`)
    } catch (err) {
      console.warn(`[afterPack] ⚠ Failed to install prebuild for ${modRel}: ${err.message}`)
    }
  }

  await installScopedBinaries(root, platform, arch)
}

// node-datachannel >= 0.33 ships binaries as per-arch optionalDependencies
// (@node-datachannel/darwin-x64 and friends). npm only installs the host's
// variant, so a cross-arch build packs the wrong one and the loader throws
// MODULE_NOT_FOUND on the target machine. Find every packed copy that uses the
// scoped model (no local build/Release binary) and fetch its exact version's
// variant next to it, so upgrades and nested copies need no list maintenance.
const SCOPE = '@node-datachannel'

function scopedVariant (platform, arch) {
  if (platform === 'darwin') return `darwin-${arch}`
  if (platform === 'win32') return `win32-${arch}-msvc`
  if (platform === 'linux') return `linux-${arch}-gnu`
  return null
}

function findDataChannelCopies (dir, depth = 0, found = []) {
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

async function installScopedBinaries (root, platform, arch) {
  const os = await import('node:os')
  const variant = scopedVariant(platform, arch)
  if (!variant) return

  for (const modPath of findDataChannelCopies(path.join(root, 'node_modules'))) {
    const buildDir = path.join(modPath, 'build', 'Release')
    const hasLocalBinary = fs.existsSync(buildDir) &&
      fs.readdirSync(buildDir).some(f => f.endsWith('.node'))
    if (hasLocalBinary) continue // old prebuild layout, handled above

    const version = JSON.parse(fs.readFileSync(path.join(modPath, 'package.json'), 'utf8')).version
    const pkgName = `${SCOPE}/${variant}`
    // Next to the copy, so require() resolves this one before any other version.
    const destDir = path.join(path.dirname(modPath), SCOPE, variant)
    if (fs.existsSync(path.join(destDir, 'package.json'))) {
      const have = JSON.parse(fs.readFileSync(path.join(destDir, 'package.json'), 'utf8')).version
      if (have === version) {
        console.log(`[afterPack] ✓ ${pkgName}@${version} already present at ${path.relative(root, destDir)}`)
        continue
      }
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-binary-'))
    try {
      console.log(`[afterPack] Fetching ${pkgName}@${version} for ${platform}-${arch}`)
      execSync(`npm pack ${pkgName}@${version} --pack-destination "${tmp}"`, { stdio: 'pipe', timeout: 120000 })
      const tarball = fs.readdirSync(tmp).find(f => f.endsWith('.tgz'))
      if (!tarball) throw new Error('npm pack produced no tarball')
      fs.mkdirSync(destDir, { recursive: true })
      execSync(`tar -xzf "${path.join(tmp, tarball)}" -C "${destDir}" --strip-components=1`, { stdio: 'pipe', timeout: 60000 })
      console.log(`[afterPack] ✓ ${pkgName}@${version} installed into packed app`)
    } catch (err) {
      // A missing binary is a guaranteed startup crash on the target arch, so
      // fail the build instead of shipping it.
      throw new Error(`[afterPack] Failed to install ${pkgName}@${version}: ${err.message}`)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
}
