import path from "path";
import { createLogger } from '../logger.js';
import { fileURLToPath } from 'url';
import mime from "mime-types";
import ScopedFS from 'scoped-fs';
import { Readable } from 'stream';

const log = createLogger('protocols:theme');

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
      pagesFS.stat('error.html', (err, stat) => {
        if (err) reject(err);
        else resolve(stat.isFile());
      });
    });
    const html404Stream = Readable.toWeb(pagesFS.createReadStream('error.html'));
    return new Response(html404Stream, {
      status: 404,
      headers: {
        'Content-Type': 'text/html',
        'Access-Control-Allow-Origin': '*',
        'Allow-CSP-From': '*',
        'Cache-Control': 'no-cache'
      },
    });
  } catch (e) {
    log.error('Failed to serve error.html:', e);
    return new Response('File not found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*',
        'Allow-CSP-From': '*',
        'Cache-Control': 'no-cache'
      },
    });
  }
}

export async function createHandler() {
  return async function protocolHandler(request) {
    const { url } = request;
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
            log.warn('Unified themes.css file not found, falling back to vars.css');
            resolvedPath = await resolveFile(fileName);
          }
        } else {
          // For all other files, use normal resolution
          resolvedPath = await resolveFile(fileName);
        }

        const data = Readable.toWeb(themeFS.createReadStream(resolvedPath));
        const contentType = mime.lookup(resolvedPath) || 'text/plain';
        const statusCode = 200;
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

        return new Response(data, {
          status: statusCode,
          headers,
        });
      } catch (e) {
        log.info('File not found:', fileName);
        return get404Response();
      }
    } else {
      return get404Response();
    }
  };
}
