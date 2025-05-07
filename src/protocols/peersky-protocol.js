import path from "path";
import { fileURLToPath } from 'url';
import mime from "mime-types";
import { Readable } from 'stream';
import ScopedFS from 'scoped-fs';

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

export async function createHandler() {
  return async function protocolHandler({ url }, sendResponse) {
    const parsedUrl = new URL(url);
    let filePath = parsedUrl.hostname + parsedUrl.pathname;

    if (filePath === '/') filePath = 'home'; // default to home page

    try {
      const resolvedPath = await resolveFile(filePath);
      const format = path.extname(resolvedPath);
      if (!['', '.html', '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(format)) {
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