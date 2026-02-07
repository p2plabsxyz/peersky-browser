// Chrome Web Store install/update helpers

import path from 'path';
import { promises as fs } from 'fs';
import * as RegistryService from './registry.js';
import { resolveManifestStrings } from '../utils/strings.js';
import { ERR } from '../util.js';

export async function installFromWebStore(manager, urlOrId) {
  const extensionId = manager.manifestValidator.parseWebStoreUrl(urlOrId);
  if (!extensionId) {
    throw Object.assign(new Error('Invalid Chrome Web Store URL or extension ID format'), { code: ERR.E_INVALID_URL });
  }
  const existing = manager.loadedExtensions.get(extensionId);
  if (existing) {
    throw Object.assign(new Error(`Extension ${extensionId} is already installed`), { code: ERR.E_ALREADY_EXISTS });
  }
  if (!manager.chromeWebStore) {
    throw Object.assign(new Error('Chrome Web Store support not available - check startup logs for initialization errors'), { code: ERR.E_NOT_AVAILABLE });
  }
  const electronExtension = await manager.chromeWebStore.installById(extensionId);
  let displayName = electronExtension.name;
  let displayDescription = electronExtension.manifest?.description || '';
  try {
    const resolved = await resolveManifestStrings(electronExtension.path, electronExtension.manifest || {}, (manager.app?.getLocale?.() || 'en'), 'en');
    displayName = resolved.name || displayName;
    displayDescription = resolved.description || displayDescription;
  } catch (_) {}
  let iconPath = null;
  const icons = electronExtension.manifest?.icons || {};
  try {
    const entries = Object.keys(icons);
    if (entries.length) {
      const numeric = entries
        .map(k => ({ key: k, n: parseInt(k, 10) }))
        .filter(x => Number.isFinite(x.n))
        .sort((a, b) => a.n - b.n);
      const chosen = (numeric[0] || { key: entries[0] }).key;
      iconPath = `peersky://extension-icon/${extensionId}/${chosen}?v=${encodeURIComponent(electronExtension.version)}`;
    }
  } catch (_) {}
  const extensionData = {
    id: extensionId,
    name: electronExtension.name,
    displayName,
    version: electronExtension.version,
    description: electronExtension.manifest?.description || '',
    displayDescription,
    enabled: true,
    installedPath: electronExtension.path,
    iconPath: iconPath,
    source: 'webstore',
    webStoreUrl: manager.manifestValidator.buildWebStoreUrl(extensionId),
    electronId: electronExtension.id,
    permissions: electronExtension.manifest?.permissions || [],
    manifest: electronExtension.manifest,
    installDate: new Date().toISOString(),
    update: { lastChecked: Date.now(), lastResult: 'installed' }
  };
  manager.loadedExtensions.set(extensionId, extensionData);
  await RegistryService.writeRegistry(manager);
  console.log('ExtensionManager: Chrome Web Store installation successful:', extensionData.name);
  return { success: true, extension: extensionData };
}

export async function updateAllExtensions(manager) {
  if (!manager.chromeWebStore) {
    throw Object.assign(new Error('Chrome Web Store support not available'), { code: ERR.E_NOT_AVAILABLE });
  }
  const webStoreExtensions = Array.from(manager.loadedExtensions.values()).filter(ext => ext.source === 'webstore');
  const updated = [];
  const skipped = [];
  const errors = [];
  const beforeVersions = new Map();
  for (const ext of webStoreExtensions) beforeVersions.set(ext.id, String(ext.version || ''));

  await manager.chromeWebStore.updateAll();
  const userDataDir = manager.app.getPath('userData');

  for (const ext of webStoreExtensions) {
    try {
      const extRoot = path.join(userDataDir, 'extensions', ext.id);
      const entries = await fs.readdir(extRoot).catch(() => []);
      if (!entries || entries.length === 0) {
        skipped.push({ id: ext.id, reason: 'no-installation-dir' });
        continue;
      }
      const chooseLatest = (dirs) => {
        const parseVer = (d) => { const base = String(d).split('_')[0]; return base.split('.').map(n => parseInt(n, 10) || 0); };
        return dirs.filter(Boolean).sort((a, b) => {
          const va = parseVer(a); const vb = parseVer(b);
          const len = Math.max(va.length, vb.length);
          for (let i = 0; i < len; i++) { const ai = va[i] || 0; const bi = vb[i] || 0; if (ai !== bi) return bi - ai; }
          return 0;
        })[0];
      };
      const latestDir = chooseLatest(entries);
      if (!latestDir) { skipped.push({ id: ext.id, reason: 'no-version-dir' }); continue; }
      const latestPath = path.join(extRoot, latestDir);
      const manifestPath = path.join(latestPath, 'manifest.json');
      const manifestRaw = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestRaw);
      const newVersion = String(manifest.version || '').trim();
      const oldVersion = beforeVersions.get(ext.id) || '';
      const versionChanged = newVersion && newVersion !== oldVersion;
      let iconPath = ext.iconPath || null;
      const icons = manifest.icons || {};
      if (icons) {
        const sizes = ['64', '48', '32', '16'];
        for (const s of sizes) {
          if (icons[s]) { iconPath = `peersky://extension-icon/${ext.id}/${s}?v=${encodeURIComponent(newVersion || oldVersion)}`; break; }
        }
      }
      ext.installedPath = latestPath;
      ext.version = newVersion || ext.version;
      ext.manifest = manifest;
      if (iconPath) ext.iconPath = iconPath;
      if (ext.enabled && versionChanged) {
        try {
          if (ext.electronId) {
            await manager.session.removeExtension(ext.electronId);
          } else if (manager.session.getExtension && manager.session.getExtension(ext.id)) {
            await manager.session.removeExtension(ext.id);
          }
        } catch (rmErr) { console.warn(`ExtensionManager: removeExtension failed for ${ext.name}:`, rmErr); }
        try {
          const electronExtension = await manager.session.loadExtension(latestPath, { allowFileAccess: false });
          ext.electronId = electronExtension.id;
        } catch (ldErr) {
          throw Object.assign(new Error(`Reload failed for ${ext.name}`), { cause: ldErr, code: ERR.E_LOAD_FAILED });
        }
      }
      if (versionChanged) { updated.push({ id: ext.id, name: ext.name, from: oldVersion, to: newVersion }); }
      else { skipped.push({ id: ext.id, reason: 'already-latest' }); }
    } catch (e) {
      console.error('ExtensionManager: Update handling failed:', e);
      errors.push({ id: ext.id, message: e?.message || 'update failed' });
    }
  }
  for (const ext of manager.loadedExtensions.values()) {
    if (ext.source !== 'webstore') { skipped.push({ id: ext.id, reason: 'skipped-preinstalled' }); }
  }
  await RegistryService.writeRegistry(manager);
  console.log('ExtensionManager: Extension update check completed');
  return { updated, skipped, errors };
}
