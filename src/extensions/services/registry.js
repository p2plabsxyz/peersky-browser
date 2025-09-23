// Registry and pinning helpers

import path from 'path';
import { promises as fs } from 'fs';
import { readJsonSafe, writeJsonAtomic } from '../util.js';
import { resolveManifestStrings } from '../utils/strings.js';

/**
 * Load registry from disk and populate manager.loadedExtensions
 * Cleans stale entries and fixes legacy icon paths.
 * @param {any} manager - ExtensionManager instance
 */
export async function loadRegistry(manager) {
  try {
    const registry = await readJsonSafe(manager.extensionsRegistryFile, { extensions: [] });
    manager.loadedExtensions.clear();
    const validExtensions = [];

    for (const extensionData of registry.extensions || []) {
      try {
        if (extensionData.installedPath) {
          await fs.access(extensionData.installedPath);
        }

        // Resolve display strings if missing
        if ((!extensionData.displayName || !extensionData.displayDescription) && extensionData.installedPath && extensionData.manifest) {
          try {
            const appLocale = (manager.app && typeof manager.app.getLocale === 'function') ? manager.app.getLocale() : 'en';
            const resolved = await resolveManifestStrings(extensionData.installedPath, extensionData.manifest, appLocale, 'en');
            extensionData.displayName = extensionData.displayName || resolved.name;
            extensionData.displayDescription = extensionData.displayDescription || resolved.description;
          } catch (_) {}
        }

        // Fix legacy icon paths to peersky:// with cache-busting
        if (extensionData.iconPath && (extensionData.iconPath.startsWith('file://') || extensionData.iconPath.startsWith('chrome-extension://'))) {
          const icons = extensionData.manifest?.icons;
          if (icons) {
            const iconSizes = ['64', '48', '32', '16'];
            for (const size of iconSizes) {
              if (icons[size]) {
                const v = extensionData.version ? `?v=${encodeURIComponent(String(extensionData.version))}` : '';
                extensionData.iconPath = `peersky://extension-icon/${extensionData.id}/${size}${v}`;
                break;
              }
            }
          }
        }

        manager.loadedExtensions.set(extensionData.id, extensionData);
        validExtensions.push(extensionData);
      } catch (_) {
        console.log(`ExtensionManager: Removing stale registry entry for ${extensionData.name} (${extensionData.id}) - directory not found`);
      }
    }

    console.log(`ExtensionManager: Loaded ${manager.loadedExtensions.size} extensions from registry`);

    // Deduplicate by Chrome/Electron ID: prefer system/preinstalled entries
    try {
      const byElectronId = new Map();
      const toRemove = [];
      for (const ext of manager.loadedExtensions.values()) {
        const eid = ext.electronId || null;
        if (!eid) continue;
        const existing = byElectronId.get(eid);
        if (!existing) {
          byElectronId.set(eid, ext);
        } else {
          const preferExisting = existing.isSystem === true || existing.source === 'preinstalled';
          const preferNew = ext.isSystem === true || ext.source === 'preinstalled';
          if (preferNew && !preferExisting) {
            // Replace existing with system ext; remove old
            byElectronId.set(eid, ext);
            toRemove.push(existing);
          } else {
            // Keep existing, drop new
            toRemove.push(ext);
          }
        }
      }
      if (toRemove.length) {
        for (const ext of toRemove) {
          try {
            manager.loadedExtensions.delete(ext.id);
            if (ext.id) {
              const root = path.join(manager.extensionsBaseDir, ext.id);
              await fs.rm(root, { recursive: true, force: true }).catch(() => {});
            }
          } catch (_) {}
        }
        console.log(`ExtensionManager: Removed ${toRemove.length} duplicate extension entr${toRemove.length===1?'y':'ies'} by electronId (kept system/preinstalled)`);
        await writeRegistry(manager);
      }
    } catch (dedupeErr) {
      console.warn('ExtensionManager: Registry dedupe by electronId failed:', dedupeErr);
    }

    const originalCount = (registry.extensions || []).length;
    if (validExtensions.length !== originalCount) {
      console.log(`ExtensionManager: Cleaned ${originalCount - validExtensions.length} stale entries from registry`);
      await writeRegistry(manager);
    }
  } catch (error) {
    console.error('ExtensionManager: Failed to read registry:', error);
  }
}

/**
 * Persist registry from manager.loadedExtensions
 * @param {any} manager
 */
export async function writeRegistry(manager) {
  const registry = { extensions: Array.from(manager.loadedExtensions.values()) };
  await writeJsonAtomic(manager.extensionsRegistryFile, registry);
}

/**
 * Validate installed paths and remove stale registry entries, then save.
 * @param {any} manager
 */
export async function validateAndClean(manager) {
  try {
    const initialCount = manager.loadedExtensions.size;
    const removedExtensions = [];
    for (const [id, ext] of manager.loadedExtensions.entries()) {
      try {
        if (ext.installedPath) await fs.access(ext.installedPath);
      } catch (_) {
        console.log(`ExtensionManager: Removing stale entry: ${ext.name} (${id})`);
        removedExtensions.push({ id, name: ext.name, reason: 'Directory not found' });
        manager.loadedExtensions.delete(id);
      }
    }
    if (removedExtensions.length > 0) {
      await writeRegistry(manager);
    }
    return {
      initialCount,
      finalCount: manager.loadedExtensions.size,
      removedCount: removedExtensions.length,
      removedExtensions
    };
  } catch (error) {
    console.error('ExtensionManager: Failed to validate registry:', error);
    throw error;
  }
}

/**
 * Read pinned extensions list
 * @param {string} extensionsBaseDir
 * @returns {Promise<string[]>}
 */
export async function getPinned(extensionsBaseDir) {
  try {
    const pinnedData = await readJsonSafe(path.join(extensionsBaseDir, 'pinned.json'));
    return pinnedData?.pinnedExtensions || [];
  } catch (err) {
    console.warn('[Registry] Error reading pinned extensions:', err);
    return [];
  }
}

/**
 * Persist pinned extensions list
 * @param {string} extensionsBaseDir
 * @param {string[]} pinnedExtensions
 */
export async function setPinned(extensionsBaseDir, pinnedExtensions) {
  const pinnedFilePath = path.join(extensionsBaseDir, 'pinned.json');
  await writeJsonAtomic(pinnedFilePath, { pinnedExtensions });
}
