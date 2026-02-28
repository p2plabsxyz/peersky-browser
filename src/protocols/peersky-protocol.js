import path from "path";
import { fileURLToPath } from 'url';
import mime from "mime-types";
import { Readable } from 'stream';
import ScopedFS from 'scoped-fs';
import { app } from 'electron';
import { createReadStream } from 'fs';
import { promises as fsPromises } from 'fs';
import extensionManager from '../extensions/index.js';

const __dirname = fileURLToPath(new URL('./', import.meta.url));
const pagesPath = path.join(__dirname, '../pages');
const fs = new ScopedFS(pagesPath);

const CHECK_PATHS = [
  (path) => path,
  (path) => path + '/index.html',
  (path) => path + '.html'
];

async function resolveFile(filePath) {
  for (const toTry of CHECK_PATHS) {
    const tryPath = toTry(filePath);
    if (await exists(tryPath)) return tryPath;
  }
  throw new Error('File not found');
}

async function exists(filePath) {
  return new Promise((resolve, reject) => {
    fs.stat(filePath, (err, stat) => {
      if (err) {
        if (err.code === 'ENOENT') resolve(false);
        else reject(err);
      } else resolve(stat.isFile());
    });
  });
}

function findHistoryExtension() {
  const extensions = Array.from(extensionManager.loadedExtensions.values()).filter(ext => ext && ext.enabled);
  const normalize = (value) => (typeof value === 'string' ? value.toLowerCase() : '');
  const isExact = (ext) => {
    const name = normalize(ext.name);
    const displayName = normalize(ext.displayName);
    return name === 'peersky-history' || displayName === 'peersky-history' || name === 'peersky history' || displayName === 'peersky history';
  };
  const exact = extensions.find(isExact);
  if (exact) return exact;
  return extensions.find(ext => {
    const name = normalize(ext.name);
    const displayName = normalize(ext.displayName);
    return name.includes('history') || displayName.includes('history');
  }) || null;
}

async function handleHistory() {
  const historyExtension = findHistoryExtension();
  if (!historyExtension || !historyExtension.electronId) {
    return new Response('History extension not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' }
    });
  }
  const viewUrl = `chrome-extension://${historyExtension.electronId}/view.html`;
  return new Response(null, {
    status: 302,
    headers: {
      'Location': viewUrl,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Allow-CSP-From': '*'
    }
  });
}

// Handle wallpaper requests cleanly
async function handleWallpaper(filename) {
  try {
    const wallpaperPath = path.join(app.getPath("userData"), "wallpapers", filename);
    await fsPromises.access(wallpaperPath);

    const data = createReadStream(wallpaperPath);
    const contentType = mime.lookup(wallpaperPath) || 'image/jpeg';

    return new Response(Readable.toWeb(data), {
      status: 200,
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' }
    });
  } catch {
    return new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// Handle extension icon requests
async function handleExtensionIcon(extensionId, size) {
  try {
    // Path to extension: userData/extensions/{extensionId}/{version}/
    let extensionsPath = path.join(app.getPath("userData"), "extensions", extensionId);
    
    // Find the latest extension version directory (format: "<version>_0")
    let versionDirs;
    try {
      versionDirs = await fsPromises.readdir(extensionsPath);
    } catch (e) {
      // Backward-compat: try legacy uppercase "Extensions" directory
      const legacyPath = path.join(app.getPath("userData"), "Extensions", extensionId);
      try {
        versionDirs = await fsPromises.readdir(legacyPath);
        extensionsPath = legacyPath;
      } catch (_) {
        throw e; // propagate original error if legacy also fails
      }
    }
    if (!versionDirs || versionDirs.length === 0) {
      throw new Error('No version directories');
    }
    const pickLatest = (dirs) => {
      const parseVer = (d) => {
        const base = String(d).split('_')[0];
        return base.split('.').map(n => parseInt(n, 10) || 0);
      };
      return dirs
        .filter(Boolean)
        .sort((a, b) => {
          const va = parseVer(a);
          const vb = parseVer(b);
          const len = Math.max(va.length, vb.length);
          for (let i = 0; i < len; i++) {
            const ai = va[i] || 0; const bi = vb[i] || 0;
            if (ai !== bi) return bi - ai;
          }
          return 0;
        })[0];
    };
    const versionDir = pickLatest(versionDirs);
    if (!versionDir) {
      throw new Error('Extension version directory not found');
    }
    const extensionRoot = path.join(extensionsPath, versionDir);
    
    // Read manifest to get actual icon path
    const manifestPath = path.join(extensionRoot, 'manifest.json');
    const manifestContent = await fsPromises.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestContent);
    
    // Get icon path from manifest for the requested size
    const icons = manifest.icons || {};
    let iconRelativePath = icons[size];

    if (!iconRelativePath) {
      const entries = Object.entries(icons);
      if (!entries.length) {
        throw new Error('No icon entries in manifest');
      }
      const parsed = entries
        .map(([k, v]) => {
          const n = parseInt(k, 10);
          return Number.isFinite(n) ? { size: n, path: v } : null;
        })
        .filter(Boolean);

      if (parsed.length) {
        const target = parseInt(size, 10);
        if (Number.isFinite(target)) {
          const sorted = parsed.sort((a, b) => a.size - b.size);
          let best = sorted.find(p => p.size >= target) || sorted[sorted.length - 1];
          iconRelativePath = best.path;
        } else {
          const largest = parsed.sort((a, b) => b.size - a.size)[0];
          iconRelativePath = largest.path;
        }
      } else {
        const any = entries[0];
        iconRelativePath = any && any[1];
      }
    }
    
    if (!iconRelativePath) {
      throw new Error('No icon found in manifest');
    }
    
    // Build full path to icon file
    const iconPath = path.join(extensionRoot, iconRelativePath);
    await fsPromises.access(iconPath);
    
    const data = createReadStream(iconPath);
    const contentType = mime.lookup(iconPath) || 'image/png';

    return new Response(Readable.toWeb(data), {
      status: 200,
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' }
    });
  } catch (error) {
    console.log(`Extension icon not found: ${extensionId}/${size} - ${error.message}`);
    try {
      const defaultIconPath = path.join(pagesPath, 'static/assets/svg/default-extension-icon.svg');
      const data = createReadStream(defaultIconPath);
      const contentType = mime.lookup(defaultIconPath) || 'image/svg+xml';

      return new Response(Readable.toWeb(data), {
        status: 200,
        headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' }
      });
    } catch (_) {
      return new Response('Extension icon not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  }
}

export async function createHandler() {
  return async function protocolHandler(request) {
    const url = request.url;
    const parsedUrl = new URL(url);
    let filePath = parsedUrl.hostname + parsedUrl.pathname;

    if (filePath === '/') filePath = 'home';
    if (filePath === 'history' || filePath.startsWith('history/')) return handleHistory();
    if (filePath.startsWith('wallpaper/')) return handleWallpaper(filePath.slice(10));
    if (filePath.startsWith('extension-icon/')) {
      const iconPath = filePath.slice(15); // Remove 'extension-icon/'
      const [extensionId, size] = iconPath.split('/');
      return handleExtensionIcon(extensionId, size || '64');
    }
    
    // Handle settings subpaths - map all /settings/* to settings.html
    if (filePath.startsWith('settings/')) {
      filePath = 'settings';
    }

    try {
      const resolvedPath = await resolveFile(filePath);
      const format = path.extname(resolvedPath);
      
      if (!['', '.html', '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico'].includes(format)) {
        throw new Error('Unsupported file type');
      }

      const data = fs.createReadStream(resolvedPath);
      const contentType = mime.lookup(resolvedPath) || 'text/plain';
      const headers = {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Allow-CSP-From': '*',
        'Cache-Control': 'no-cache'
      };

      return new Response(Readable.toWeb(data), {
        status: 200,
        headers
      });
    } catch (e) {
      // File not found - return a 404 error response
      return new Response(null, {
        status: 404,
        statusText: 'Not Found'
      });
    }
  };
}
