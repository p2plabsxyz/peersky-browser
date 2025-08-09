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


