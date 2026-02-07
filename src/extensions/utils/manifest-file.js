import path from 'path';
import { promises as fs } from 'fs';

export const PREFERRED_MANIFEST_ALTS = [
    'manifest.json',
    'manifest.chromium.json',
    'manifest.chrome.json',
    'manifest.chrome-mv3.json',
    'manifest.mv3.json',
    'manifest.v3.json',
    'manifest.firefox.json'
];

/**
 * Finds the most appropriate manifest file in a directory.
 * Checks PREFERRED_MANIFEST_ALTS in order.
 */
export async function findExtensionManifest(dirPath) {
    for (const name of PREFERRED_MANIFEST_ALTS) {
        const p = path.join(dirPath, name);
        try {
            const content = await fs.readFile(p, 'utf8');
            //verify it's valid JSON before returning
            JSON.parse(content);

            if (name.endsWith('manifest.firefox.json')) {
                console.warn('[ExtensionManifest] Using manifest.firefox.json. Extension may be incompatible with Chromium/Electron.');
            }

            return { path: p, content };
        } catch (e) {
            // Continue if file doesn't exist or is invalid JSON
            if (e.code === 'ENOENT') continue;
            // we may find valid json in next iteration 
        }
    }
    return null;
}
