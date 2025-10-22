/**
 * Extension Utilities - Core utilities for extension management
 * 
 * This module provides essential utilities for Chrome extension handling in Peersky Browser:
 * - Chrome Web Store ID/URL parsing and validation
 * - Atomic file system operations for safe extension management
 * - Concurrency control for extension operations
 * - Standardized error handling with error codes
 * 
 * All operations use Node.js built-ins only for maximum compatibility and security.
 */

import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { createHash } from 'crypto';

// Constants for Chrome Web Store validation
/**
 * Regex for validating Chrome Web Store extension IDs (32 chars, a-p only)
 * @type {RegExp}
 */
export const WEBSTORE_ID_RE = /^[a-p]{32}$/i;

/**
 * Regex for parsing Chrome Web Store URLs and extracting extension IDs
 * @type {RegExp}
 */
export const WEBSTORE_URL_RE = /^https?:\/\/chrome\.google\.com\/webstore\/detail\/[^/]+\/([a-p]{32})(?:\b|\/)?/i;

/**
 * Error codes for extension operations
 */
export const ERR = {
  E_INVALID_ID: 'E_INVALID_ID',
  E_FETCH_FAILED: 'E_FETCH_FAILED',
  E_VALIDATE_FAILED: 'E_VALIDATE_FAILED',
  E_INSTALL_FAILED: 'E_INSTALL_FAILED',
  E_LOAD_FAILED: 'E_LOAD_FAILED',
  E_REMOVE_FAILED: 'E_REMOVE_FAILED',
  E_UPDATE_FAILED: 'E_UPDATE_FAILED',
  E_INVALID_URL: 'E_INVALID_URL',
  E_ALREADY_EXISTS: 'E_ALREADY_EXISTS',
  E_NOT_AVAILABLE: 'E_NOT_AVAILABLE',
  E_PIN_LIMIT: 'E_PIN_LIMIT',
  E_INVALID_STATE: 'E_INVALID_STATE',
  E_INVALID_PATH: 'E_INVALID_PATH',
  E_PATH_TRAVERSAL: 'E_PATH_TRAVERSAL',
  E_RATE_LIMIT: 'E_RATE_LIMIT'
};

/**
 * Parse a Chrome Web Store URL or ID and return the 32-char id in lowercase, or null if invalid.
 * @param {string} input - Chrome Web Store URL or extension ID
 * @returns {string|null} Normalized extension ID or null if invalid
 */
export function parseUrlOrId(input) {
  if (typeof input !== 'string') {
    return null;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  // Try URL regex first (extract ID from capture group)
  const urlMatch = trimmed.match(WEBSTORE_URL_RE);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1].toLowerCase();
  }

  // Fallback to ID regex test
  if (WEBSTORE_ID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  return null;
}

/**
 * Validate and normalize extension ID, throwing on invalid input.
 * @param {string} id - Extension ID to validate
 * @returns {string} Normalized lowercase extension ID
 * @throws {Error} With code E_INVALID_ID if invalid
 */
export function sanitizeId(id) {
  if (typeof id !== 'string' || !WEBSTORE_ID_RE.test(id)) {
    throw Object.assign(new Error('Invalid extension id'), { code: ERR.E_INVALID_ID });
  }
  return id.toLowerCase();
}

/**
 * Parse and validate Chrome Web Store URL or ID, throwing on invalid input.
 * @param {string} urlOrId - Chrome Web Store URL or extension ID
 * @returns {string} Normalized extension ID
 * @throws {Error} With code E_INVALID_ID if invalid
 */
export function sanitizeUrlOrId(urlOrId) {
  const parsed = parseUrlOrId(urlOrId);
  if (!parsed) {
    throw Object.assign(new Error('Invalid Chrome Web Store URL or ID'), { code: ERR.E_INVALID_ID });
  }
  return parsed;
}

/**
 * Ensure directory exists, creating it recursively if needed.
 * @param {string} dir - Directory path to ensure
 * @returns {Promise<void>}
 */
export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Safely read and parse JSON file, returning fallback on any error.
 * Handles BOM, empty files, and invalid JSON gracefully.
 * @param {string} filePath - Path to JSON file
 * @param {*} fallback - Value to return on error (default: null)
 * @returns {Promise<*>} Parsed JSON data or fallback value
 */
export async function readJsonSafe(filePath, fallback = null) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    
    // Handle empty files
    if (!data.trim()) {
      return fallback;
    }
    
    // Remove BOM if present
    const cleanData = data.charCodeAt(0) === 0xFEFF ? data.slice(1) : data;
    
    return JSON.parse(cleanData);
  } catch (error) {
    return fallback;
  }
}

/**
 * Atomically write JSON data to file using temp file + rename pattern.
 * Writes temp file in same directory as target for cross-filesystem safety.
 * @param {string} filePath - Target file path
 * @param {*} data - Data to serialize as JSON
 * @returns {Promise<void>}
 */
export async function writeJsonAtomic(filePath, data) {
  const randomHex = randomBytes(4).toString('hex');
  const dir = path.dirname(filePath);
  const filename = path.basename(filePath);
  const tmpPath = path.join(dir, `${filename}.${randomHex}.tmp`);
  
  try {
    const json = JSON.stringify(data, null, 2);
    await fs.writeFile(tmpPath, json, 'utf8');
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    // Clean up temp file on failure
    try {
      await fs.unlink(tmpPath);
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Atomically replace directory by moving fromDir to toDir.
 * Ensures parent directory exists and handles Windows rename constraints.
 * @param {string} fromDir - Source directory to move
 * @param {string} toDir - Target directory path
 * @returns {Promise<void>}
 * @throws {Error} With code E_INSTALL_FAILED if fromDir doesn't exist
 */
export async function atomicReplaceDir(fromDir, toDir) {
  // Check if source directory exists
  if (!existsSync(fromDir)) {
    throw Object.assign(new Error(`Source directory does not exist: ${fromDir}`), { 
      code: ERR.E_INSTALL_FAILED 
    });
  }

  // Ensure parent directory exists
  await ensureDir(path.dirname(toDir));

  // Remove target directory if it exists (Windows compatibility)
  if (existsSync(toDir)) {
    await fs.rm(toDir, { recursive: true, force: true });
  }

  // Move source to target
  await fs.rename(fromDir, toDir);
}

/**
 * KeyedMutex - Serialize async operations by key to prevent race conditions
 */
export class KeyedMutex {
  constructor() {
    /** @type {Map<string, Promise<any>>} */
    this.locks = new Map();
  }

  /**
   * Serialize async operations by key.
   * @template T
   * @param {string} key - Unique key to serialize operations on
   * @param {() => Promise<T>} fn - Async function to execute
   * @returns {Promise<T>} Result of the async function
   */
  async run(key, fn) {
    // Get existing promise chain for this key, or create new resolved promise
    const existingPromise = this.locks.get(key) || Promise.resolve();
    
    // Chain new operation after existing operations
    const newPromise = existingPromise
      .then(() => fn())
      .catch((error) => {
        // Re-throw error to maintain promise chain integrity
        throw error;
      })
      .finally(() => {
        // Clean up lock if this is the last operation in the chain
        if (this.locks.get(key) === newPromise) {
          this.locks.delete(key);
        }
      });
    
    // Store the new promise as the current lock
    this.locks.set(key, newPromise);
    
    return newPromise;
  }
}

/**
 * Validate and sanitize a local source path for extension installation.
 * - Normalizes and resolves the path
 * - Rejects traversal patterns
 * - Ensures the path exists and is a directory
 * - Restricts to allowed user directories (Downloads, Desktop, Documents)
 * - Resolves symlinks and validates final realpath is within allowlist
 *
 * @param {string} sourcePath - User-provided source path
 * @returns {Promise<string>} Sanitized absolute path
 * @throws {Error} With codes E_INVALID_PATH or E_PATH_TRAVERSAL
 */
export async function validateSourcePath(sourcePath) {
  const osMod = await import('os');

  // Basic type/length checks
  if (!sourcePath || typeof sourcePath !== 'string') {
    throw Object.assign(new Error('Invalid source path'), { code: ERR.E_INVALID_PATH });
  }
  if (sourcePath.length > 4096) {
    throw Object.assign(new Error('Source path too long'), { code: ERR.E_INVALID_PATH });
  }

  // Pre-normalization traversal checks on raw input
  const raw = sourcePath.trim();
  const hasDotDot = raw.split(/[\\\/]+/).some(seg => seg === '..');
  const hasTildeAtStart = raw.startsWith('~');
  if (hasDotDot || hasTildeAtStart) {
    throw Object.assign(new Error('Path traversal detected'), { code: ERR.E_PATH_TRAVERSAL });
  }

  // Normalize and resolve
  const normalizedPath = path.normalize(sourcePath);
  const resolvedPath = path.resolve(normalizedPath);

  // Quick traversal pattern detection on the normalized path (segment-aware)
  const normHasDotDot = normalizedPath.split(path.sep).some(seg => seg === '..');
  if (normHasDotDot) {
    throw Object.assign(new Error('Path traversal detected'), { code: ERR.E_PATH_TRAVERSAL });
  }

  // Ensure exists and is directory
  let stats;
  try {
    stats = await fs.lstat(resolvedPath);
  } catch (e) {
    throw Object.assign(new Error('Source path does not exist'), { code: ERR.E_INVALID_PATH });
  }
  if (!stats.isDirectory()) {
    throw Object.assign(new Error('Source must be a directory'), { code: ERR.E_INVALID_PATH });
  }

  // Resolve symlinks to real path
  let realPath;
  try {
    realPath = await fs.realpath(resolvedPath);
  } catch (e) {
    throw Object.assign(new Error('Failed to resolve source path'), { code: ERR.E_INVALID_PATH });
  }

  // Restrict to allowlisted user directories
  // NOTE: The allowlist is fixed for now (Downloads/Desktop/Documents).
  // It can be made user-configurable via Settings in a future update.
  const home = osMod.homedir();
  const allowedDirectories = [
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents')
  ];

  const isAllowed = allowedDirectories.some((allowedDir) => {
    const allowed = path.resolve(allowedDir);
    return realPath === allowed || realPath.startsWith(allowed + path.sep);
  });

  if (!isAllowed) {
    throw Object.assign(new Error('Source path not in allowed directories'), { code: ERR.E_PATH_TRAVERSAL });
  }

  return realPath;
}

/**
 * Validate a local install source path that may be a directory or a file.
 * - Applies traversal checks and allowlist similar to validateSourcePath
 * - Allows files when allowFiles is true and extension is in allowedFileExtensions
 *
 * @param {string} sourcePath
 * @param {{ allowDirectories?: boolean, allowFiles?: boolean, allowedFileExtensions?: string[] }} [opts]
 * @returns {Promise<string>} real path
 */
export async function validateInstallSource(sourcePath, opts = {}) {
  const { allowDirectories = true, allowFiles = false, allowedFileExtensions = [] } = opts;
  const osMod = await import('os');

  if (!sourcePath || typeof sourcePath !== 'string') {
    throw Object.assign(new Error('Invalid source path'), { code: ERR.E_INVALID_PATH });
  }
  if (sourcePath.length > 4096) {
    throw Object.assign(new Error('Source path too long'), { code: ERR.E_INVALID_PATH });
  }
  {
    const raw = sourcePath.trim();
    const hasDotDot = raw.split(/[\\\/]+/).some(seg => seg === '..');
    const hasTildeAtStart = raw.startsWith('~');
    if (hasDotDot || hasTildeAtStart) {
      throw Object.assign(new Error('Path traversal detected'), { code: ERR.E_PATH_TRAVERSAL });
    }
  }

  const normalizedPath = path.normalize(sourcePath);
  const resolvedPath = path.resolve(normalizedPath);
  const normHasDotDot = normalizedPath.split(path.sep).some(seg => seg === '..');
  if (normHasDotDot) {
    throw Object.assign(new Error('Path traversal detected'), { code: ERR.E_PATH_TRAVERSAL });
  }

  let stats;
  try {
    stats = await fs.lstat(resolvedPath);
  } catch (_) {
    throw Object.assign(new Error('Source path does not exist'), { code: ERR.E_INVALID_PATH });
  }

  const isDir = stats.isDirectory();
  const isFile = stats.isFile();
  if (isDir && !allowDirectories) {
    throw Object.assign(new Error('Directories not allowed'), { code: ERR.E_INVALID_PATH });
  }
  if (isFile && !allowFiles) {
    throw Object.assign(new Error('Files not allowed for install'), { code: ERR.E_INVALID_PATH });
  }

  if (isFile && allowedFileExtensions.length > 0) {
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!allowedFileExtensions.includes(ext)) {
      throw Object.assign(new Error('Unsupported file type'), { code: ERR.E_INVALID_PATH });
    }
  }

  let realPath;
  try {
    realPath = await fs.realpath(resolvedPath);
  } catch (_) {
    throw Object.assign(new Error('Failed to resolve source path'), { code: ERR.E_INVALID_PATH });
  }

  // If a specific file was chosen (e.g., via native open dialog), allow it regardless of directory allowlist
  if (isFile) {
    return realPath;
  }

  const home = osMod.homedir();
  const allowedDirectories = [
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents')
  ];

  const isAllowed = allowedDirectories.some((allowedDir) => {
    const allowed = path.resolve(allowedDir);
    return realPath === allowed || realPath.startsWith(allowed + path.sep);
  });
  if (!isAllowed) {
    throw Object.assign(new Error('Source path not in allowed directories'), { code: ERR.E_PATH_TRAVERSAL });
  }

  return realPath;
}

/**
 * Compute SHA-256 hex digest of input string.
 * @param {string} input
 * @returns {string}
 */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}
