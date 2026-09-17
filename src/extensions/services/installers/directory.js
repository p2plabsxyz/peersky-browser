// Prepare extension from directory

import path from 'path'
import { promises as fs } from 'fs'
import { randomBytes } from 'crypto'
import { ensureDir, atomicReplaceDir } from '../../util.js'
import { generateSecureExtensionId } from '../../utils/ids.js'
import { resolveManifestStrings } from '../../utils/strings.js'
import { findExtensionManifest } from '../../utils/manifest-file.js'

export async function prepareFromDirectory (manager, dirPath) {
  const { path: foundPath, content: manifestContent } = await findExtensionManifest(dirPath) || {}

  if (!manifestContent) {
    throw new Error('No valid manifest.json (or supported alternative) found in extension directory')
  }

  // Create a clean manifest.json file if we found an alternative one
  const isAltManifest = path.basename(foundPath) !== 'manifest.json'
  const altManifestContent = isAltManifest ? manifestContent : null
  const manifest = JSON.parse(manifestContent)

  const semverLike = (v) => typeof v === 'string' && /^\d+(\.\d+)*$/.test(v)
  if (!semverLike(manifest.version)) {
    manifest.version = '1.0.0'
  }

  const extensionId = generateSecureExtensionId(manifest)
  const version = String(manifest.version || '').trim() || '0.0.0'
  const versionDirName = `${version}_0`

  const targetPath = path.join(manager.extensionsBaseDir, extensionId, versionDirName)
  await ensureDir(path.dirname(targetPath))
  const tempDir = path.join(manager.extensionsBaseDir, '_staging', `dir-${Date.now()}-${randomBytes(4).toString('hex')}`)
  try {
    await ensureDir(tempDir)
    await fs.cp(dirPath, tempDir, { recursive: true })
    await fs.writeFile(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8').catch(() => {})
    await placeManifest(tempDir, foundPath, altManifestContent)
    await ensureDir(path.dirname(targetPath))
    await atomicReplaceDir(tempDir, targetPath)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }) // only survives a failure
  }

  const appLocale = (manager.app && typeof manager.app.getLocale === 'function') ? manager.app.getLocale() : 'en'
  const { name: displayName, description: displayDescription } = await resolveManifestStrings(targetPath, manifest, appLocale, 'en')

  const missing = []
  const checkFile = async (rel) => {
    if (!rel) return
    try { await fs.stat(path.join(targetPath, rel)) } catch (_) { missing.push(rel) }
  }
  try {
    const icons = manifest.icons || {}
    for (const rel of Object.values(icons)) await checkFile(rel)
    const bg = manifest.background && manifest.background.service_worker
    await checkFile(bg)
    const cs = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []
    for (const c of cs) {
      for (const rel of (c.js || [])) await checkFile(rel)
      for (const rel of (c.css || [])) await checkFile(rel)
    }
    const popup = manifest.action && manifest.action.default_popup
    await checkFile(popup)
  } catch (_) { }

  const ext = {
    id: extensionId,
    name: manifest.name,
    displayName,
    version,
    description: manifest.description,
    displayDescription,
    manifest,
    installedPath: targetPath,
    enabled: true,
    source: 'unpacked',
    installDate: new Date().toISOString()
  }
  if (missing.length) {
    ext.warnings = (ext.warnings || []).concat(missing.slice(0, 20).map(m => `Missing file: ${m}`))
  }

  try {
    const icons = manifest.icons || {}
    const sizes = ['128', '64', '48', '32', '16']
    for (const s of sizes) {
      if (icons[s]) {
        const v = ext.version ? `?v=${encodeURIComponent(String(ext.version))}` : ''
        ext.iconPath = `peersky://extension-icon/${ext.id}/${s}${v}`
        break
      }
    }
  } catch (_) { }

  return ext
}

// Electron needs a manifest.json; an alternative manifest file supplies it.
async function placeManifest (tempDir, foundPath, altManifestContent) {
  if (path.basename(foundPath) === 'manifest.json') return
  const dest = path.join(tempDir, 'manifest.json')
  try { await fs.access(dest) } catch (_) {
    await fs.writeFile(dest, altManifestContent, 'utf8')
  }
}
