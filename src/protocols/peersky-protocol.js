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

export async function createHandler() {
  return async function protocolHandler({ url }, sendResponse) {
    const parsedUrl = new URL(url);
    let filePath = parsedUrl.hostname + parsedUrl.pathname;

    if (filePath === '/') filePath = 'home';
    if (filePath.startsWith('wallpaper/')) return handleWallpaper(filePath.slice(10), sendResponse);
    
    // Handle settings subpaths - map all /settings/* to settings.html
    if (filePath.startsWith('settings/')) {
      filePath = 'settings';
    }

    // Strip p2p/pages/ prefix for error pages
    if (filePath.startsWith('p2p/pages/')) {
      filePath = filePath.replace('p2p/pages/', '');
    }

    try {
      const resolvedPath = await resolveFile(filePath);
      const format = path.extname(resolvedPath);
      
      if (!['', '.html', '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico'].includes(format)) {
        throw new Error('Unsupported file type');
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
      // Return 404 - renderer.js will handle this
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