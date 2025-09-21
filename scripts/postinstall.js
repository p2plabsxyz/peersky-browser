/**
 * Generate preinstalled.json from folders in src/extensions/preinstalled-extensions
 * ESM version to match repo "type": "module". Offline only.
 */

import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';

function generateSecureExtensionId(manifest) {
  const payload = JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description || '',
    author: manifest.author || '',
    homepage_url: manifest.homepage_url || ''
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

async function main() {
  try {
    const root = process.cwd();
    const preRoot = path.join(root, 'src', 'extensions', 'preinstalled-extensions');
    if (!fsSync.existsSync(preRoot)) {
      console.log('[postinstall] No preinstalled extensions directory found, skipping');
      return;
    }

    const entries = [];
    const dirents = await fs.readdir(preRoot, { withFileTypes: true });
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const dir = path.join(preRoot, d.name);
      const manifestPath = path.join(dir, 'manifest.json');
      if (!fsSync.existsSync(manifestPath)) {
        console.warn(`[postinstall] No manifest.json found in ${d.name}, skipping`);
        continue;
      }
      try {
        const raw = await fs.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(raw);
        if (manifest.manifest_version !== 3) {
          console.warn(`[postinstall] ${d.name} is not manifest v3, skipping`);
          continue;
        }
        const id = generateSecureExtensionId(manifest);
        entries.push({ dir: d.name, id, name: manifest.name, version: String(manifest.version || '') });
        console.log(`[postinstall] Processed ${d.name} -> ${id}`);
      } catch (error) {
        console.warn(`[postinstall] Failed to process ${d.name}:`, error.message);
      }
    }

    const out = { extensions: entries };
    const outPath = path.join(preRoot, 'preinstalled.json');
    await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
    console.log(`[postinstall] Wrote ${entries.length} preinstalled entries to ${path.relative(root, outPath)}`);
  } catch (error) {
    console.error('[postinstall] Failed to generate preinstalled.json:', error.message);
    throw error;
  }
}

try { await main(); } catch (e) { console.error('[postinstall] Failed:', e?.message || e); }

