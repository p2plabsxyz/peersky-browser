/**
 * electron-builder afterPack hook
 *
 * Two jobs once the app is packed:
 * 1. The nested webrtc-polyfill copy of node-datachannel still uses the old
 *    build/Release layout, so it holds whatever binary npm fetched for the
 *    build host. Its path is already in the asar index, so replacing the
 *    unpacked bytes with the target-arch prebuild works at this stage.
 * 2. Verify the result. Every packed node-datachannel copy must resolve a
 *    binary of the target architecture, scoped variants through the asar
 *    index. A miss is a guaranteed startup crash on the target machine, so
 *    fail the build instead of shipping it.
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import {
  ARCH_NAMES, scopedVariant, findDataChannelCopies, hasLocalBinary
} from './beforePack.js'

// Reads the executable header. Signing and prebuild-install exit codes can
// both lie about what is actually in the file.
export function binaryArch (file) {
  const b = fs.readFileSync(file)
  if (b.length < 0x40) return null
  const cpu = (t) => ({ 7: 'x64', 12: 'arm64' })[t & 0xff] || null
  if (b.readUInt32LE(0) === 0xfeedfacf) return cpu(b.readUInt32LE(4))
  const beMagic = b.readUInt32BE(0)
  if (beMagic === 0xcafebabe || beMagic === 0xcafebabf) {
    const slices = []
    for (let i = 0; i < b.readUInt32BE(4); i++) slices.push(cpu(b.readUInt32BE(8 + i * 20)))
    return slices
  }
  if (b.readUInt32BE(0) === 0x7f454c46) {
    return { 0x3e: 'x64', 0xb7: 'arm64', 0x03: 'ia32' }[b.readUInt16LE(0x12)] || null
  }
  if (b.readUInt16BE(0) === 0x4d5a) {
    const pe = b.readUInt32LE(0x3c)
    if (b.length > pe + 6 && b.readUInt32BE(pe) === 0x50450000) {
      return { 0x8664: 'x64', 0xaa64: 'arm64', 0x014c: 'ia32' }[b.readUInt16LE(pe + 4)] || null
    }
  }
  return null
}

function assertArch (file, arch, what) {
  const found = binaryArch(file)
  const ok = Array.isArray(found) ? found.includes(arch) : found === arch
  if (!ok) throw new Error(`[afterPack] ${what} is ${JSON.stringify(found)} instead of ${arch}: ${file}`)
}

async function asarEntries (asarPath) {
  if (!fs.existsSync(asarPath)) return null
  const asar = await import('@electron/asar')
  const list = (asar.listPackage || asar.default.listPackage)
  try {
    return list(asarPath, { isPack: false })
  } catch {
    return list(asarPath)
  }
}

export default async function afterPack (context) {
  const arch = ARCH_NAMES[context.arch] || 'x64'
  const platform = context.electronPlatformName
  const variant = scopedVariant(platform, arch)

  const resources = platform === 'darwin'
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app', 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  const root = ['app.asar.unpacked', 'app'].map(d => path.join(resources, d)).find(fs.existsSync)
  if (!root) throw new Error(`[afterPack] no packed app found under ${resources}`)
  const entries = await asarEntries(path.join(resources, 'app.asar'))

  const copies = findDataChannelCopies(path.join(root, 'node_modules'))
  if (copies.length === 0) throw new Error('[afterPack] no node-datachannel in the packed app, layout changed?')

  for (const modPath of copies) {
    const rel = path.relative(root, modPath)
    if (hasLocalBinary(modPath)) {
      const buildDir = path.join(modPath, 'build', 'Release')
      for (const f of fs.readdirSync(buildDir).filter(f => f.endsWith('.node'))) {
        fs.rmSync(path.join(buildDir, f))
      }
      try {
        execSync(`npx prebuild-install -r napi --platform ${platform} --arch ${arch}`,
          { cwd: modPath, stdio: 'pipe', timeout: 120000 })
      } catch (err) {
        throw new Error(`[afterPack] prebuild-install ${platform}-${arch} failed for ${rel}: ${err.message}`)
      }
      for (const f of fs.readdirSync(buildDir).filter(f => f.endsWith('.node'))) {
        assertArch(path.join(buildDir, f), arch, `${rel} prebuild`)
      }
      console.log(`[afterPack] ✓ ${rel} carries the ${platform}-${arch} prebuild`)
    } else {
      // Scoped layout: the loader requires @node-datachannel/<variant>, which
      // resolution finds next to this copy or at the tree root.
      const variantDir = [path.dirname(modPath), path.join(root, 'node_modules')]
        .map(d => path.join(d, '@node-datachannel', variant))
        .find(d => fs.existsSync(path.join(d, 'package.json')))
      if (!variantDir) {
        throw new Error(`[afterPack] @node-datachannel/${variant} is not in the packed app, ${rel} would crash on ${arch}. Is the beforePack hook wired up?`)
      }
      const nodeFile = fs.readdirSync(variantDir).find(f => f.endsWith('.node'))
      if (!nodeFile) throw new Error(`[afterPack] no .node binary inside ${variantDir}`)
      assertArch(path.join(variantDir, nodeFile), arch, `@node-datachannel/${variant}`)
      if (entries) {
        const indexPath = '/' + path.relative(root, path.join(variantDir, 'package.json')).split(path.sep).join('/')
        if (!entries.some(e => e.split(path.sep).join('/').replace(/^\/?/, '/') === indexPath)) {
          throw new Error(`[afterPack] ${indexPath} is missing from the asar index, require() cannot reach it. It must be installed before packing, not after.`)
        }
      }
      console.log(`[afterPack] ✓ ${rel} resolves @node-datachannel/${variant} through the asar index`)
    }
  }
}
