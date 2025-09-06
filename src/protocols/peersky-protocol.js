import path from "path";
import { fileURLToPath } from 'url';
import mime from "mime-types";
import { Readable } from 'stream';
import ScopedFS from 'scoped-fs';
import { app } from 'electron';
import { createReadStream } from 'fs';
import { promises as fsPromises } from 'fs';

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

// Handle wallpaper requests cleanly
async function handleWallpaper(filename, sendResponse) {
  try {
    const wallpaperPath = path.join(app.getPath("userData"), "wallpapers", filename);
    await fsPromises.access(wallpaperPath);
    
    const data = createReadStream(wallpaperPath);
    const contentType = mime.lookup(wallpaperPath) || 'image/jpeg';
    
    sendResponse({
      statusCode: 200,
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' },
      data
    });
  } catch {
    sendResponse({
      statusCode: 404,
      headers: { 'Content-Type': 'text/plain' },
      data: Readable.from(['Not found'])
    });
  }
}

// Handle extension icon requests
async function handleExtensionIcon(extensionId, size, sendResponse) {
  try {
    // Path to extension: userData/extensions/{extensionId}/{version}/
    const extensionsPath = path.join(app.getPath("userData"), "extensions", extensionId);
    
    // Find the latest extension version directory (format: "<version>_0")
    const versionDirs = await fsPromises.readdir(extensionsPath);
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
    
    // If exact size not found, try alternatives in order of preference
    if (!iconRelativePath) {
      const alternativeSizes = size === '64' ? ['48', '32', '16'] : 
                               size === '48' ? ['64', '32', '16'] :
                               size === '32' ? ['48', '64', '16'] : ['32', '48', '64'];
      
      for (const altSize of alternativeSizes) {
        if (icons[altSize]) {
          iconRelativePath = icons[altSize];
          break;
        }
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
    
    sendResponse({
      statusCode: 200,
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' },
      data
    });
  } catch (error) {
    console.log(`Extension icon not found: ${extensionId}/${size} - ${error.message}`);
    sendResponse({
      statusCode: 404,
      headers: { 'Content-Type': 'text/plain' },
      data: Readable.from(['Extension icon not found'])
    });
  }
}

export async function createHandler() {
  return async function protocolHandler({ url }, sendResponse) {
    const parsedUrl = new URL(url);
    let filePath = parsedUrl.hostname + parsedUrl.pathname;

    if (filePath === '/') filePath = 'home';
    if (filePath.startsWith('wallpaper/')) return handleWallpaper(filePath.slice(10), sendResponse);
    if (filePath.startsWith('extension-icon/')) {
      const iconPath = filePath.slice(15); // Remove 'extension-icon/'
      const [extensionId, size] = iconPath.split('/');
      return handleExtensionIcon(extensionId, size || '64', sendResponse);
    }
    
    // Handle settings subpaths - map all /settings/* to settings.html
    if (filePath.startsWith('settings/')) {
      filePath = 'settings';
    }

    try {
      const resolvedPath = await resolveFile(filePath);
      const format = path.extname(resolvedPath);
      if (!['', '.html', '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico'].includes(format)) {
        sendResponse({
          statusCode: 403,
          headers: {
            'Content-Type': 'text/plain',
            'Access-Control-Allow-Origin': '*',
            'Allow-CSP-From': '*',
            'Cache-Control': 'no-cache'
          },
          data: Readable.from(['Unsupported file type'])
        });
        return;
      }

      const statusCode = 200;
      const data = fs.createReadStream(resolvedPath);
      const contentType = mime.lookup(resolvedPath) || 'text/plain';
      const headers = {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Allow-CSP-From': '*',
        'Cache-Control': 'no-cache'
      };

      sendResponse({
        statusCode,
        headers,
        data
      });
    } catch (e) {
      sendResponse({
        statusCode: 404,
        headers: {
          'Content-Type': 'text/html',
          'Access-Control-Allow-Origin': '*',
          'Allow-CSP-From': '*',
          'Cache-Control': 'no-cache'
        },
        data: fs.createReadStream('404.html')
      });
    }
  };
}
