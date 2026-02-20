import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { get as httpsGet } from 'node:https';

function downloadFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const request = httpsGet(url, response => {
      const statusCode = response.statusCode || 0;
      const location = response.headers.location;
      if (statusCode >= 300 && statusCode < 400 && location) {
        if (redirectsLeft <= 0) {
          response.resume();
          reject(new Error('Too many redirects'));
          return;
        }
        const nextUrl = new URL(location, url).toString();
        response.resume();
        downloadFile(nextUrl, destPath, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (statusCode >= 400) {
        response.resume();
        reject(new Error(`HTTP ${statusCode}`));
        return;
      }
      const file = fsSync.createWriteStream(destPath);
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
      file.on('error', err => {
        fsSync.unlink(destPath, () => {});
        reject(err);
      });
    });
    request.on('error', err => {
      reject(err);
    });
  });
}

async function main() {
  try {
    const root = process.cwd();
    const preRoot = path.join(root, 'src', 'extensions', 'preinstalled-extensions');
    const preinstalledJsonPath = path.join(preRoot, 'preinstalled.json');

    if (!fsSync.existsSync(preinstalledJsonPath)) {
      console.log('[postinstall] No preinstalled.json found, skipping extension downloads');
      return;
    }

    const preinstalledData = JSON.parse(await fs.readFile(preinstalledJsonPath, 'utf8'));
    const extensions = preinstalledData.extensions || [];

    if (extensions.length === 0) {
      console.log('[postinstall] No extensions defined in preinstalled.json');
      return;
    }

    console.log(`[postinstall] Found ${extensions.length} extensions to download`);

    let fetchExtensionZip;
    try {
      const cefModule = await import('chrome-extension-fetch');
      fetchExtensionZip = cefModule.fetchExtensionZip;
    } catch (error) {
      console.warn('[postinstall] chrome-extension-fetch not installed, skipping Chrome Web Store downloads');
      console.warn('[postinstall] Run: npm install chrome-extension-fetch --save-dev');
    }

    for (const ext of extensions) {
      try {
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

        if (ext.version && typeof ext.url === 'string' && ext.url.includes('{version}')) {
          const resolvedUrl = ext.url.split('{version}').join(ext.version);
          console.log(`[postinstall] Downloading ${ext.name} from ${resolvedUrl}...`);
          let archiveName;
          try {
            const u = new URL(resolvedUrl);
            const base = path.basename(u.pathname);
            archiveName = base || `extension-${ext.name || 'archive'}.zip`;
          } catch {
            archiveName = `extension-${ext.name || 'archive'}.zip`;
          }
          const archivePath = path.join(preRoot, archiveName);
          await downloadFile(resolvedUrl, archivePath);
          console.log(`[postinstall] ✓ ${ext.name} saved:`);
          console.log(`  ZIP: ${archiveName}`);
          ext.archive = archiveName;
          continue;
        }

        if (!fetchExtensionZip) {
          console.warn(`[postinstall] Skipping Chrome Web Store download for ${ext.name} (chrome-extension-fetch not available)`);
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
