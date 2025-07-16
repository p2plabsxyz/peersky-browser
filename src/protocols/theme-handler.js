import path from "path";
import { fileURLToPath } from 'url';
import mime from "mime-types";
import { Readable } from 'stream';
import ScopedFS from 'scoped-fs';
import settingsManager from '../settings-manager.js';

const __dirname = fileURLToPath(new URL('./', import.meta.url));
const themePath = path.join(__dirname, '../pages/theme');
const pagesPath = path.join(__dirname, '../pages');
const themeFS = new ScopedFS(themePath);
const pagesFS = new ScopedFS(pagesPath);

const CHECK_PATHS = [
  (path) => path,
  (path) => path + 'index.html',
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
    themeFS.stat(filePath, (err, stat) => {
      if (err) {
        if (err.code === 'ENOENT') resolve(false);
        else reject(err);
      } else resolve(stat.isFile());
    });
  });
}

async function get404Response() {
  try {
    await new Promise((resolve, reject) => {
      pagesFS.stat('404.html', (err, stat) => {
        if (err) reject(err);
        else resolve(stat.isFile());
      });
    });
    return {
      statusCode: 404,
      headers: {
        'Content-Type': 'text/html',
        'Access-Control-Allow-Origin': '*',
        'Allow-CSP-From': '*',
        'Cache-Control': 'no-cache'
      },
      data: pagesFS.createReadStream('404.html')
    };
  } catch (e) {
    console.error('Failed to serve 404.html:', e);
    return {
      statusCode: 404,
      headers: {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*',
        'Allow-CSP-From': '*',
        'Cache-Control': 'no-cache'
      },
      data: Readable.from(['File not found'])
    };
  }
}

export async function createHandler() {
  return async function protocolHandler({ url }, sendResponse) {
    const parsedUrl = new URL(url);

    if (parsedUrl.hostname === 'theme') {
      const fileName = parsedUrl.pathname.slice(1);

      try {
        let resolvedPath;
        
        // Handle dynamic theme loading for vars.css
        if (fileName === 'vars.css') {
          try {
            // Use the unified themes.css file for all theme switching
            resolvedPath = await resolveFile('themes.css');
          } catch (themeError) {
            // Fallback to default vars.css if unified theme file not found
            console.warn('Unified themes.css file not found, falling back to vars.css');
            resolvedPath = await resolveFile(fileName);
          }
        } else {
          // For all other files, use normal resolution
          resolvedPath = await resolveFile(fileName);
        }

        const statusCode = 200;
        const data = themeFS.createReadStream(resolvedPath);
        const contentType = mime.lookup(resolvedPath) || 'text/plain';
        const headers = {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Allow-CSP-From': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
          'ETag': `"theme-${Date.now()}"`,
          'Last-Modified': new Date().toUTCString()
        };

        sendResponse({
          statusCode,
          headers,
          data
        });
      } catch (e) {
        console.log('File not found:', fileName);
        sendResponse(await get404Response());
      }
    } else {
      sendResponse(await get404Response());
    }
  };
}
