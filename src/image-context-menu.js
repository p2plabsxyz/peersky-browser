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







//  Creates image-related context menu items
export function createImageMenuItems(params, browserWindow) {
  if (!params.srcURL) return [];

  return [
    new MenuItem({
      label: "Download Image",
      click: async () => {
        try {
          const suggestedFilename = getImageFileName(params.srcURL, params.altText);
          const result = await dialog.showSaveDialog(browserWindow, {
            title: 'Save Image',
            defaultPath: suggestedFilename,
            filters: [
              { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'] },
              { name: 'All Files', extensions: ['*'] }
            ]
          });

          if (!result.canceled && result.filePath) {
            try {
              await downloadImageWithProgress(params.srcURL, result.filePath, browserWindow);
              console.log(`[${MODULE_PATH}:Download Image] Success: ${result.filePath}`);
              showSuccessNotification('Download Complete', `Image saved to: ${result.filePath}`);
            } catch (downloadError) {
              logError('Download Image MenuItem', downloadError, `Download failed`);
            }
          }
        } catch (dialogError) {
          logError('Download Image MenuItem', dialogError, `Dialog error`);
        }
      },
    }),

    new MenuItem({
      label: "Copy Image",
      click: async () => {
        try {
          await copyImageToClipboard(params.srcURL);
          console.log(`[${MODULE_PATH}:Copy Image] Success: Image copied to clipboard`);
          showSuccessNotification('Image Copied', 'The image has been copied to the clipboard.');
        } catch (copyError) {
          logError('Copy Image MenuItem', copyError, `Failed to copy image`);
          try {
            clipboard.writeText(params.srcURL);
            console.log(`[${MODULE_PATH}:Copy Image] Fallback: Image URL copied to clipboard`);
            showSuccessNotification('Image URL Copied', 'The image URL has been copied.');
          } catch (fallbackError) {
            logError('Copy Image MenuItem Fallback', fallbackError, `Failed to copy URL`);
          }
        }
      },
    }),

    new MenuItem({
      label: "Copy Image Address",
      click: () => {
        try {
          clipboard.writeText(params.srcURL);
          showSuccessNotification('Image URL Copied', 'The image URL has been copied.');
        } catch (clipboardError) {
          logError('Copy Image Address MenuItem', clipboardError, `Failed to copy URL`);
        }
      },
    })
  ];
}




// Helper: Show  native success notification after copy and download of image 
function showSuccessNotification(title, body) {
  try {
    new Notification({
      title,
      body,
      silent: false
    }).show();
  } catch (error) {
    logError('showSuccessNotification', error, `Notification failed`);
  }
}




//  * Adds image menu items to an existing menu

export function addImageMenuItems(menu, params, browserWindow) {
  const imageMenuItems = createImageMenuItems(params, browserWindow);
  imageMenuItems.forEach(item => menu.append(item));
}
