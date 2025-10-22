// Prepare extension from directory

import path from 'path';
import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { ensureDir, atomicReplaceDir } from '../../util.js';
import { generateSecureExtensionId } from '../../utils/ids.js';
import { resolveManifestStrings } from '../../utils/strings.js';

const PREFERRED_MANIFEST_ALTS = [
  'manifest.chromium.json',
  'manifest.chrome.json',
  'manifest.chrome-mv3.json',
  'manifest.mv3.json',
  'manifest.v3.json',
  'manifest.firefox.json'
];

export async function prepareFromDirectory(manager, dirPath) {
  let manifestPath = path.join(dirPath, 'manifest.json');
  let stats = await fs.stat(manifestPath).catch(() => null);
  let manifestContent;
  let altManifestContent = null;
  if (!stats) {
    let foundAlt = null;
    for (const name of PREFERRED_MANIFEST_ALTS) {
      const p = path.join(dirPath, name);
      const st = await fs.stat(p).catch(() => null);
      if (st) { foundAlt = p; break; }
    }
    if (foundAlt) {
      if (foundAlt.endsWith('manifest.firefox.json')) {
        console.warn('[ExtensionManager] Falling back to manifest.firefox.json. Extension may be incompatible with Chromium/Electron.');
      }
      altManifestContent = await fs.readFile(foundAlt, 'utf8');
      manifestContent = altManifestContent;
    } else {
      throw new Error('No manifest.json found in extension directory');
    }
  } else {
    manifestContent = await fs.readFile(manifestPath, 'utf8');
  }
  const manifest = JSON.parse(manifestContent);

  const semverLike = (v) => typeof v === 'string' && /^\d+(\.\d+)*$/.test(v);
  if (!semverLike(manifest.version)) {
    manifest.version = '1.0.0';
  }

  const extensionId = generateSecureExtensionId(manifest);
  const version = String(manifest.version || '').trim() || '0.0.0';
  const versionDirName = `${version}_0`;

  const targetPath = path.join(manager.extensionsBaseDir, extensionId, versionDirName);
  await ensureDir(path.dirname(targetPath));
  const tempDir = path.join(manager.extensionsBaseDir, '_staging', `dir-${Date.now()}-${randomBytes(4).toString('hex')}`);
  await ensureDir(tempDir);
  await fs.cp(dirPath, tempDir, { recursive: true });
  try { await fs.writeFile(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8'); } catch (_) {}
  if (altManifestContent) {
    const destManifestPath = path.join(tempDir, 'manifest.json');
    try { await fs.access(destManifestPath); } catch (_) {
      await fs.writeFile(destManifestPath, altManifestContent, 'utf8');
    }
  }
  await ensureDir(path.dirname(targetPath));
  await atomicReplaceDir(tempDir, targetPath);

  const appLocale = (manager.app && typeof manager.app.getLocale === 'function') ? manager.app.getLocale() : 'en';
  const { name: displayName, description: displayDescription } = await resolveManifestStrings(targetPath, manifest, appLocale, 'en');

  const missing = [];
  const checkFile = async (rel) => {
    if (!rel) return;
    try { await fs.stat(path.join(targetPath, rel)); } catch (_) { missing.push(rel); }
  };
  try {
    const icons = manifest.icons || {};
    for (const rel of Object.values(icons)) await checkFile(rel);
    const bg = manifest.background && manifest.background.service_worker;
    await checkFile(bg);
    const cs = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
    for (const c of cs) {
      for (const rel of (c.js || [])) await checkFile(rel);
      for (const rel of (c.css || [])) await checkFile(rel);
    }
    const popup = manifest.action && manifest.action.default_popup;
    await checkFile(popup);
  } catch (_) {}

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
  };
  if (missing.length) {
    ext.warnings = (ext.warnings || []).concat(missing.slice(0, 20).map(m => `Missing file: ${m}`));
  }

  try {
    const icons = manifest.icons || {};
    const sizes = ['128', '64', '48', '32', '16'];
    for (const s of sizes) {
      if (icons[s]) {
        const v = ext.version ? `?v=${encodeURIComponent(String(ext.version))}` : '';
        ext.iconPath = `peersky://extension-icon/${ext.id}/${s}${v}`;
        break;
      }
    }
  } catch (_) {}

  return ext;
}

