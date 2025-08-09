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