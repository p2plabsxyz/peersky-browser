/**
 * Image Context Menu Module
 * Provides download and copy functionality for images in context menus
 * Now with native notifications & download progress bar
 */

import { MenuItem, clipboard, dialog, nativeImage, Notification } from "electron";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { fileURLToPath } from "url";

// Emulate __filename and __dirname for better error logging 
const __filename = fileURLToPath(import.meta.url);
const MODULE_PATH = __filename; // full path to this file





// Simplified error logging helper for better debog for peer developers : coding style of adarshtech251
function logError(functionName, error, shortMessage = '') {
  let lineNumber = 'unknown';
  if (error && error.stack) {
    const stackLines = error.stack.split('\n');
    for (const line of stackLines) {
      if (line.includes(MODULE_PATH)) {
        const match = line.match(/:(\d+):\d+/);
        if (match) {
          lineNumber = match[1];
          break;
        }
      }
    }
  }
  const message = shortMessage || (error instanceof Error ? error.message : String(error));

  console.error('\n\n\n------------------------------------------------');
  console.error(`Section:[${functionName}] \n${message}`);
  console.error(`error at file --- ${MODULE_PATH}:${lineNumber}`);
  console.error('------------------------------------------------\n\n\n');

  //// file location , actual error , short custom mssg , also line that is causing this exception 


}





// Get filename from URL or generate default      ////// this function is used for giving a name to the image that we are going to download 
function getImageFileName(url, altText = '') {
  try {
    if (altText && altText.length > 2 && !altText.toLowerCase().includes('image')) {
      const sanitized = altText.replace(/[<>:"/\\|?*]/g, '').trim().substring(0, 50);
      if (sanitized) return sanitized + '.jpg';
    }
    try {
      const urlObj = new URL(url);
      const filename = path.basename(urlObj.pathname);
      if (filename && filename.includes('.') && filename !== 'iu') {
        return filename;
      }
    } catch (urlError) {
      logError('getImageFileName', urlError, `Failed to parse URL`);
    }
    return `image_${Date.now()}.jpg`;
  } catch (error) {
    logError('getImageFileName', error, `Filename generation error`);
    return `image_${Date.now()}.jpg`;
  }
}









// Download image with progress bar
function downloadImageWithProgress(url, filePath, browserWindow) {
  return new Promise((resolve, reject) => {
    try {
      const protocol = url.startsWith('https:') ? https : http;

      protocol.get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return downloadImageWithProgress(response.headers.location, filePath, browserWindow)
            .then(resolve).catch(reject);
        }
        if (response.statusCode !== 200) {
          const error = new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`);
          logError('downloadImageWithProgress', error, `Failed HTTP response`);
          return reject(error);
        }

        const total = parseInt(response.headers['content-length'], 10) || 0;
        let downloaded = 0;

        const fileStream = fs.createWriteStream(filePath);
        response.pipe(fileStream);

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total) {
            const progress = downloaded / total;
            browserWindow.setProgressBar(progress);
          }
        });

        fileStream.on('finish', () => {
          browserWindow.setProgressBar(-1); // remove progress bar
          fileStream.close();
          resolve();
        });

        fileStream.on('error', (streamError) => {
          browserWindow.setProgressBar(-1);
          fs.unlink(filePath, () => {});
          logError('downloadImageWithProgress', streamError, `File stream error`);
          reject(streamError);
        });

      }).on('error', (requestError) => {
        browserWindow.setProgressBar(-1);
        logError('downloadImageWithProgress', requestError, `HTTP request failed`);
        reject(requestError);
      });

    } catch (error) {
      logError('downloadImageWithProgress', error, `Unexpected error`);
      reject(error);
    }
  });
}





// Copy image to clipboard
function copyImageToClipboard(url) {
  return new Promise((resolve, reject) => {
    try {
      const protocol = url.startsWith('https:') ? https : http;
      protocol.get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return copyImageToClipboard(response.headers.location).then(resolve).catch(reject);
        }
        if (response.statusCode !== 200) {
          const error = new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`);
          logError('copyImageToClipboard', error, `Failed HTTP response`);
          return reject(error);
        }

        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));

        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const image = nativeImage.createFromBuffer(buffer);
          if (image.isEmpty()) {
            const error = new Error('Empty image buffer');
            logError('copyImageToClipboard', error, `Image creation failed`);
            return reject(error);
          }
          clipboard.writeImage(image);
          resolve();
        });

        response.on('error', (responseError) => {
          logError('copyImageToClipboard', responseError, `Response stream error`);
          reject(responseError);
        });

      }).on('error', (requestError) => {
        logError('copyImageToClipboard', requestError, `HTTP request failed`);
        reject(requestError);
      });

    } catch (error) {
      logError('copyImageToClipboard', error, `Unexpected error`);
      reject(error);
    }
  });
}

