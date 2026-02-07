// Prepare extension from ZIP/CRX archive

import path from 'path';
import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { ensureDir, atomicReplaceDir } from '../../util.js';
import { extractZipFile, extractZipBuffer } from '../../zip.js';
import { isCrx, extractCrx, derToBase64 } from '../../crx.js';
import { generateSecureExtensionId } from '../../utils/ids.js';
import { resolveManifestStrings } from '../../utils/strings.js';
import { findExtensionManifest } from '../../utils/manifest-file.js';

export async function prepareFromArchive(manager, archivePath) {
  const lower = archivePath.toLowerCase();
  const isZip = lower.endsWith('.zip');
  const isCrxFile = lower.endsWith('.crx') || lower.endsWith('.crx3') || await isCrx(archivePath).catch(() => false);
  if (!isZip && !isCrxFile) {
    throw new Error('Unsupported archive type; expected .zip or .crx');
  }

  const stagingRoot = path.join(manager.extensionsBaseDir, '_staging');
  await ensureDir(stagingRoot);
  const stagingDir = path.join(stagingRoot, `arc-${Date.now()}-${randomBytes(4).toString('hex')}`);
  await ensureDir(stagingDir);

  let sourceType = 'file-zip';
  let publicKeyDer = null;

  if (isZip) {
    await extractZipFile(archivePath, stagingDir);
  } else {
    sourceType = 'file-crx';
    const buff = await fs.readFile(archivePath);
    const crx = await extractCrx(buff);
    publicKeyDer = crx.publicKeyDer || null;
    await extractZipBuffer(crx.zipBuffer, stagingDir);
  }

  // Read manifest from extracted dir (find manifest.json or dynamic equivalent relative to root)
  // Handle ZIP files where content is nested inside a folder
  let manifestFound = await findExtensionManifest(stagingDir);
  let actualStagingDir = stagingDir;

  if (!manifestFound) {
    const entries = await fs.readdir(stagingDir, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(name => name !== '__MACOSX' && !name.startsWith('.'))
      .sort();

    for (const dirName of dirs) {
      const nestedDir = path.join(stagingDir, dirName);
      try {
        const nestedFound = await findExtensionManifest(nestedDir);
        if (nestedFound) {
          manifestFound = nestedFound;
          actualStagingDir = nestedDir;
          break;
        }
      } catch (__) {}
    }
  }

  if (!manifestFound) {
    throw new Error('No valid manifest.json (or supported alternative) found in archive');
  }

  const { path: manifestPath, content: manifestRaw } = manifestFound;
  const manifest = JSON.parse(manifestRaw);

  const semverLike = (v) => typeof v === 'string' && /^\d+(\.\d+)*$/.test(v);
  if (!semverLike(manifest.version)) {
    manifest.version = '1.0.0';
  }

  const provisionalId = generateSecureExtensionId(manifest);
  const version = String(manifest.version || '').trim() || '0.0.0';
  const versionDirName = `${version}_0`;

  const root = path.join(manager.extensionsBaseDir, provisionalId);
  const finalDir = path.join(root, versionDirName);
  await ensureDir(path.dirname(finalDir));

  const tempDir = path.join(manager.extensionsBaseDir, '_staging', `pkg-${Date.now()}-${randomBytes(4).toString('hex')}`);
  await ensureDir(tempDir);
  await fs.cp(actualStagingDir, tempDir, { recursive: true });
  await ensureDir(path.dirname(finalDir));
  await atomicReplaceDir(tempDir, finalDir);

  const appLocale = (manager.app && typeof manager.app.getLocale === 'function') ? manager.app.getLocale() : 'en';
  const { name: displayName, description: displayDescription } = await resolveManifestStrings(finalDir, manifest, appLocale, 'en');

  // Verify referenced files exist; record warnings if missing
  const missing = [];
  const checkFile = async (rel) => {
    if (!rel) return;
    try { await fs.stat(path.join(finalDir, rel)); } catch (_) { missing.push(rel); }
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
  } catch (_) { }

  const ext = {
    id: provisionalId,
    name: manifest.name,
    displayName,
    version,
    description: manifest.description || '',
    displayDescription,
    manifest,
    installedPath: finalDir,
    enabled: true,
    source: sourceType,
    installDate: new Date().toISOString()
  };
  if (missing.length) {
    ext.warnings = (ext.warnings || []).concat(missing.slice(0, 20).map(m => `Missing file: ${m}`));
  }
  try {
    const icons = manifest.icons || {};
    const entries = Object.keys(icons);
    if (entries.length) {
      const numeric = entries
        .map(k => ({ key: k, n: parseInt(k, 10) }))
        .filter(x => Number.isFinite(x.n))
        .sort((a, b) => a.n - b.n);
      const chosen = (numeric[0] || { key: entries[0] }).key;
      const v = ext.version ? `?v=${encodeURIComponent(String(ext.version))}` : '';
      ext.iconPath = `peersky://extension-icon/${ext.id}/${chosen}${v}`;
    }
  } catch (_) { }

  return ext;
}
