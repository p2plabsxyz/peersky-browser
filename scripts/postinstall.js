/**
 * Download preinstalled extensions from Chrome Web Store using chrome-extension-fetch
 * Reads extension definitions from preinstalled.json and fetches CRX/ZIP files
 * ESM version to match repo "type": "module".
 */

import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import process from 'node:process';

async function main() {
  try {
    const root = process.cwd();
    const preRoot = path.join(root, 'src', 'extensions', 'preinstalled-extensions');
    const preinstalledJsonPath = path.join(preRoot, 'preinstalled.json');

    // Check if preinstalled.json exists
    if (!fsSync.existsSync(preinstalledJsonPath)) {
      console.log('[postinstall] No preinstalled.json found, skipping extension downloads');
      return;
    }

    // Read preinstalled.json
    const preinstalledData = JSON.parse(await fs.readFile(preinstalledJsonPath, 'utf8'));
    const extensions = preinstalledData.extensions || [];

    if (extensions.length === 0) {
      console.log('[postinstall] No extensions defined in preinstalled.json');
      return;
    }

    console.log(`[postinstall] Found ${extensions.length} extensions to download`);

    // Dynamically import chrome-extension-fetch
    let fetchExtensionZip;
    try {
      const cefModule = await import('chrome-extension-fetch');
      fetchExtensionZip = cefModule.fetchExtensionZip;
    } catch (error) {
      console.warn('[postinstall] chrome-extension-fetch not installed, skipping downloads');
      console.warn('[postinstall] Run: npm install chrome-extension-fetch --save-dev');
      return;
    }

    // Download each extension
    for (const ext of extensions) {
      try {
        // Skip if extension has skipDownload flag (e.g., manually provided archives)
        // for certain extensions --> we may get status code 204 for automatic fetching, for these extension we need to install from local archive
        if (ext.skipDownload) {
          if (ext.archive) {
            const archivePath = path.join(preRoot, ext.archive);
            if (fsSync.existsSync(archivePath)) {
              console.log(`[postinstall] ⊘ Skipping ${ext.name} (using existing archive: ${ext.archive})`);
            } else {
              console.warn(`[postinstall] ⚠ Skipping ${ext.name} but archive not found: ${ext.archive}`);
            }
          } else {
            console.warn(`[postinstall] ⚠ Skipping ${ext.name} (no archive specified)`);
          }
          continue;
        }

        const url = ext.url || `https://chrome.google.com/webstore/detail/${ext.id}`;
        console.log(`[postinstall] Downloading ${ext.name} (${ext.id})...`);

        const { crxPath, zipPath } = await fetchExtensionZip(url, {
          chromeVersion: '114.0.5735.133', // Stable Chrome version
          outputDir: preRoot
        });

        console.log(`[postinstall] ✓ ${ext.name} saved:`);
        console.log(`  CRX: ${path.basename(crxPath)}`);
        console.log(`  ZIP: ${path.basename(zipPath)}`);

        // Update preinstalled.json with archive filename
        ext.archive = path.basename(zipPath);
      } catch (error) {
        console.error(`[postinstall] ✗ Failed to download ${ext.name}:`, error.message);
        // Continue with other extensions even if one fails
      }
    }

    // Save updated preinstalled.json with archive filenames
    await fs.writeFile(
      preinstalledJsonPath,
      JSON.stringify(preinstalledData, null, 2),
      'utf8'
    );

    console.log('[postinstall] Preinstalled extensions download completed');
  } catch (error) {
    console.error('[postinstall] Failed to download preinstalled extensions:', error.message);
    // Don't throw - allow npm install to continue even if downloads fail
  }
}

try { await main(); } catch (e) { console.error('[postinstall] Failed:', e?.message || e); }

