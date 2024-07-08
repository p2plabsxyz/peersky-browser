import path from "path";
import { fileURLToPath } from 'url';
import fs from "fs";
import mime from "mime-types";

const __dirname = fileURLToPath(new URL('./', import.meta.url))

export async function createHandler() {
  return async function protocolHandler({ url }, sendResponse) {
    const parsedUrl = new URL(url);
    let filePath = parsedUrl.hostname + parsedUrl.pathname;

    if (filePath === '/') filePath = 'home'; // default to home page

    let absolutePath = path.join(__dirname, `../pages/${filePath}`);

    // Resolve file existence and format
    const format = path.extname(absolutePath);
    switch (format) {
      case '':
      case '.html':
        if (format === '') absolutePath += '.html';
        if (!fs.existsSync(absolutePath)) {
          sendResponse({
            statusCode: 404,
            headers: { "Content-Type": "text/html" },
            data: fs.createReadStream(path.join(__dirname, "../pages/404.html")),
          });
          return;
        }
        break;
      case '.js':
      case '.css':
      case '.png':
      case '.jpg':
      case '.jpeg':
      case '.gif':
      case '.svg':
        if (!fs.existsSync(absolutePath)) {
          sendResponse({
            statusCode: 404,
            headers: { "Content-Type": "text/plain" },
            data: "File not found",
          });
          return;
        }
        break;
      default:
        sendResponse({
          statusCode: 403,
          headers: { "Content-Type": "text/plain" },
          data: "Unsupported file type",
        });
        return;
    }

    const statusCode = 200;
    const data = fs.createReadStream(absolutePath);

    const contentType = mime.lookup(absolutePath) || "text/plain";

    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Allow-CSP-From": "*",
      "Cache-Control": "no-cache",
      "Content-Type": contentType,
    };

    sendResponse({
      statusCode,
      headers,
      data,
    });
  };
};
