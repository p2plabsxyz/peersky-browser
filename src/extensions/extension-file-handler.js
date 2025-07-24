// Extension File Handler - CRX/ZIP conversion and file operations
// Handles file format conversion, extraction, and atomic file operations
// Supports Chrome .crx format conversion to standard ZIP

import { promises as fs } from 'fs';
import path from 'path';
import { app } from 'electron';
import crypto from 'crypto';

const EXTENSIONS_DIR = path.join(app.getPath("userData"), "extensions");
const TEMP_DIR = path.join(EXTENSIONS_DIR, "temp");

class ExtensionFileHandler {
  constructor() {
    this.tempDirectories = new Set(); // Track temp dirs for cleanup
  }

  async init() {
    // TODO: Initialize file handler
    // - Create necessary directories
    // - Set up temporary file management
    // - Initialize cleanup timers
    console.log('ExtensionFileHandler: Initializing...');
    
    try {
      await fs.mkdir(EXTENSIONS_DIR, { recursive: true });
      await fs.mkdir(TEMP_DIR, { recursive: true });
    } catch (error) {
      console.error('ExtensionFileHandler: Initialization failed:', error);
    }
  }

  async convertCrxToZip(crxPath) {
    // TODO: Extract ZIP data from CRX file
    // - Parse CRX header (magic number, version, key length, signature length)
    // - Skip CRX-specific headers and extract ZIP portion
    // - Validate CRX format and version
    // - Return path to extracted ZIP data
    // Reference: https://developer.chrome.com/docs/extensions/mv3/crx/
    console.log(`TODO: Convert CRX to ZIP: ${crxPath}`);
    
    try {
      // Read CRX file
      const crxData = await fs.readFile(crxPath);
      
      // Parse CRX header
      const crxHeader = this.parseCrxHeader(crxData);
      if (!crxHeader.valid) {
        throw new Error(`Invalid CRX file: ${crxHeader.error}`);
      }
      
      // Extract ZIP data (skip CRX headers)
      const zipData = crxData.slice(crxHeader.zipOffset);
      
      // Create temporary directory for extraction
      const tempDir = await this.createTempDirectory('crx-extract');
      const zipPath = path.join(tempDir, 'extension.zip');
      
      // Write ZIP data to temporary file
      await fs.writeFile(zipPath, zipData);
      
      // Extract ZIP to directory
      const extractedPath = await this.extractZipExtension(zipPath);
      
      // Clean up temporary ZIP file
      await fs.unlink(zipPath);
      
      return extractedPath;
    } catch (error) {
      console.error(`CRX conversion failed for ${crxPath}:`, error);
      throw new Error(`Failed to convert CRX: ${error.message}`);
    }
  }

  parseCrxHeader(crxData) {
    // TODO: Parse CRX file header
    // - Check magic number ('Cr24')
    // - Read version, key length, signature length
    // - Calculate ZIP data offset
    // - Return header information
    console.log('TODO: Parse CRX header');
    
    try {
      if (crxData.length < 16) {
        return { valid: false, error: 'File too small to be valid CRX' };
      }
      
      // Check magic number
      const magic = crxData.slice(0, 4).toString('ascii');
      if (magic !== 'Cr24') {
        return { valid: false, error: 'Invalid CRX magic number' };
      }
      
      // Read version (4 bytes, little endian)
      const version = crxData.readUInt32LE(4);
      if (version !== 2 && version !== 3) {
        return { valid: false, error: `Unsupported CRX version: ${version}` };
      }
      
      // Read key and signature lengths
      const keyLength = crxData.readUInt32LE(8);
      const signatureLength = crxData.readUInt32LE(12);
      
      // Calculate ZIP offset
      const zipOffset = 16 + keyLength + signatureLength;
      
      if (zipOffset >= crxData.length) {
        return { valid: false, error: 'Invalid CRX header lengths' };
      }
      
      return {
        valid: true,
        version,
        keyLength,
        signatureLength,
        zipOffset
      };
    } catch (error) {
      return { valid: false, error: `Header parsing failed: ${error.message}` };
    }
  }

  async extractZipExtension(zipPath, destDir = null) {
    // Extract ZIP safely to destination directory
    // - Create destination directory if not provided
    // - Validate ZIP structure before extraction
    // - Extract with path traversal protection
    // - Verify extracted manifest.json exists
    // - Return path to extracted extension
    console.log(`Extracting ZIP extension: ${zipPath}`);
    
    try {
      // Create destination directory
      const extractDir = destDir || await this.createTempDirectory('zip-extract');
      await fs.mkdir(extractDir, { recursive: true });
      
      // Read and validate ZIP file
      const zipData = await fs.readFile(zipPath);
      
      // Basic ZIP validation - check for ZIP signature
      if (zipData.length < 22 || zipData.readUInt32LE(0) !== 0x04034b50) {
        throw new Error('Invalid ZIP file format');
      }
      
      // Use Node.js built-in ZIP extraction (available in newer versions)
      // For compatibility, we'll implement a basic ZIP parser
      await this.extractZipData(zipData, extractDir);
      
      // Verify manifest.json exists
      const manifestPath = path.join(extractDir, 'manifest.json');
      try {
        await fs.access(manifestPath);
      } catch {
        throw new Error('Extracted extension is missing manifest.json');
      }
      
      // Validate manifest is readable JSON
      try {
        const manifestContent = await fs.readFile(manifestPath, 'utf8');
        JSON.parse(manifestContent);
      } catch (error) {
        throw new Error(`Invalid manifest.json: ${error.message}`);
      }
      
      console.log(`ZIP extracted successfully to: ${extractDir}`);
      return extractDir;
    } catch (error) {
      console.error(`ZIP extraction failed for ${zipPath}:`, error);
      throw new Error(`Failed to extract ZIP: ${error.message}`);
    }
  }

  async extractZipData(zipData, extractDir) {
    // Basic ZIP extraction implementation
    // This is a simplified implementation - in production, consider using yauzl or node-stream-zip
    console.log('Extracting ZIP data using basic parser');
    
    // Find end of central directory record
    let eocdOffset = -1;
    for (let i = zipData.length - 22; i >= 0; i--) {
      if (zipData.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    
    if (eocdOffset === -1) {
      throw new Error('Invalid ZIP file: End of central directory not found');
    }
    
    // Read central directory info
    const centralDirOffset = zipData.readUInt32LE(eocdOffset + 16);
    const centralDirSize = zipData.readUInt32LE(eocdOffset + 12);
    const numEntries = zipData.readUInt16LE(eocdOffset + 10);
    
    // Extract each file
    let offset = centralDirOffset;
    for (let i = 0; i < numEntries; i++) {
      // Read central directory file header
      if (zipData.readUInt32LE(offset) !== 0x02014b50) {
        throw new Error('Invalid central directory entry');
      }
      
      const fileNameLength = zipData.readUInt16LE(offset + 28);
      const extraFieldLength = zipData.readUInt16LE(offset + 30);
      const commentLength = zipData.readUInt16LE(offset + 32);
      const localHeaderOffset = zipData.readUInt32LE(offset + 42);
      
      // Read filename
      const fileName = zipData.toString('utf8', offset + 46, offset + 46 + fileNameLength);
      
      // Validate filename for path traversal attacks
      if (fileName.includes('..') || fileName.startsWith('/') || fileName.includes('\\')) {
        console.warn(`Skipping unsafe file path: ${fileName}`);
        offset += 46 + fileNameLength + extraFieldLength + commentLength;
        continue;
      }
      
      // Read local file header
      if (zipData.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error('Invalid local file header');
      }
      
      const compressionMethod = zipData.readUInt16LE(localHeaderOffset + 8);
      const compressedSize = zipData.readUInt32LE(localHeaderOffset + 18);
      const uncompressedSize = zipData.readUInt32LE(localHeaderOffset + 22);
      const localFileNameLength = zipData.readUInt16LE(localHeaderOffset + 26);
      const localExtraFieldLength = zipData.readUInt16LE(localHeaderOffset + 28);
      
      // Calculate data offset
      const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength;
      
      // Skip directories
      if (fileName.endsWith('/')) {
        offset += 46 + fileNameLength + extraFieldLength + commentLength;
        continue;
      }
      
      // Extract file data
      let fileData;
      if (compressionMethod === 0) {
        // No compression
        fileData = zipData.subarray(dataOffset, dataOffset + compressedSize);
      } else {
        // For simplicity, we'll only support uncompressed files for now
        // In production, implement deflate decompression
        console.warn(`Skipping compressed file: ${fileName} (compression method: ${compressionMethod})`);
        offset += 46 + fileNameLength + extraFieldLength + commentLength;
        continue;
      }
      
      // Write file to destination
      const filePath = path.join(extractDir, fileName);
      const fileDir = path.dirname(filePath);
      await fs.mkdir(fileDir, { recursive: true });
      await fs.writeFile(filePath, fileData);
      
      console.log(`Extracted: ${fileName}`);
      
      // Move to next entry
      offset += 46 + fileNameLength + extraFieldLength + commentLength;
    }
  }

  async validateFileStructure(extensionDir) {
    // TODO: Check extension directory for required files
    // - Verify manifest.json exists and is readable
    // - Check for essential extension files
    // - Validate directory structure
    // - Return validation results with details
    console.log(`TODO: Validate file structure: ${extensionDir}`);
    
    const validation = {
      valid: true,
      errors: [],
      warnings: [],
      files: []
    };
    
    try {
      // Check if directory exists
      const stats = await fs.stat(extensionDir);
      if (!stats.isDirectory()) {
        validation.valid = false;
        validation.errors.push('Path is not a directory');
        return validation;
      }
      
      // Check for manifest.json
      const manifestPath = path.join(extensionDir, 'manifest.json');
      try {
        await fs.access(manifestPath);
        validation.files.push('manifest.json');
      } catch {
        validation.valid = false;
        validation.errors.push('manifest.json not found');
      }
      
      // TODO: Add more file structure validation
      // - Check for background scripts/service workers
      // - Validate content script files
      // - Check icon files
      // - Validate localization files
      
    } catch (error) {
      validation.valid = false;
      validation.errors.push(`Directory access failed: ${error.message}`);
    }
    
    return validation;
  }

  async copyExtensionFiles(srcDir, extensionId) {
    // TODO: Copy extension files to permanent location with atomic operations
    // - Create destination directory in extensions folder
    // - Copy all files preserving structure
    // - Use temporary directory + rename for atomicity
    // - Set appropriate file permissions
    // - Return final extension path
    console.log(`TODO: Copy extension files from ${srcDir} for ${extensionId}`);
    
    try {
      const destDir = path.join(EXTENSIONS_DIR, extensionId);
      const tempDestDir = destDir + '.tmp';
      
      // Remove temp directory if it exists
      await this.removeDirectory(tempDestDir);
      
      // Create temporary destination
      await fs.mkdir(tempDestDir, { recursive: true });
      
      // Copy files recursively
      await this.copyDirectoryRecursive(srcDir, tempDestDir);
      
      // Atomic rename to final location
      try {
        await this.removeDirectory(destDir); // Remove existing if present
      } catch {
        // Ignore if destination doesn't exist
      }
      
      await fs.rename(tempDestDir, destDir);
      
      console.log(`Extension files copied to: ${destDir}`);
      return destDir;
    } catch (error) {
      console.error(`Failed to copy extension files:`, error);
      throw new Error(`File copy failed: ${error.message}`);
    }
  }

  async copyDirectoryRecursive(src, dest) {
    // TODO: Recursively copy directory contents
    // - Handle subdirectories
    // - Preserve file permissions
    // - Handle symlinks safely
    // - Skip hidden files if needed
    console.log(`TODO: Copy directory recursive: ${src} -> ${dest}`);
    
    try {
      const entries = await fs.readdir(src, { withFileTypes: true });
      
      for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        
        if (entry.isDirectory()) {
          await fs.mkdir(destPath, { recursive: true });
          await this.copyDirectoryRecursive(srcPath, destPath);
        } else if (entry.isFile()) {
          await fs.copyFile(srcPath, destPath);
        }
        // Skip symlinks and other special files for security
      }
    } catch (error) {
      throw new Error(`Recursive copy failed: ${error.message}`);
    }
  }

  async removeDirectory(dirPath) {
    // TODO: Safely remove directory and all contents
    // - Handle nested directories
    // - Handle file permission issues
    // - Skip if directory doesn't exist
    console.log(`TODO: Remove directory: ${dirPath}`);
    
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async createTempDirectory(prefix = 'ext') {
    // TODO: Create temporary directory for operations
    // - Generate unique directory name
    // - Create in temp directory
    // - Track for cleanup
    // - Return full path
    console.log(`TODO: Create temp directory with prefix: ${prefix}`);
    
    const tempName = `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const tempPath = path.join(TEMP_DIR, tempName);
    
    await fs.mkdir(tempPath, { recursive: true });
    this.tempDirectories.add(tempPath);
    
    return tempPath;
  }

  async cleanupTempFiles(tempDir = null) {
    // TODO: Clean up temporary files and directories
    // - Remove specific temp directory if provided
    // - Clean all tracked temp directories if no path provided
    // - Handle cleanup errors gracefully
    console.log(`TODO: Cleanup temp files: ${tempDir || 'all'}`);
    
    if (tempDir) {
      // Clean specific directory
      try {
        await this.removeDirectory(tempDir);
        this.tempDirectories.delete(tempDir);
      } catch (error) {
        console.error(`Failed to cleanup ${tempDir}:`, error);
      }
    } else {
      // Clean all tracked temp directories
      for (const dir of this.tempDirectories) {
        try {
          await this.removeDirectory(dir);
        } catch (error) {
          console.error(`Failed to cleanup ${dir}:`, error);
        }
      }
      this.tempDirectories.clear();
    }
  }

  async computeFileHash(filePath, algorithm = 'sha256') {
    // TODO: Compute hash of file for integrity checking
    // - Support multiple hash algorithms
    // - Handle large files efficiently
    // - Return hex-encoded hash
    console.log(`TODO: Compute ${algorithm} hash for: ${filePath}`);
    
    try {
      const data = await fs.readFile(filePath);
      const hash = crypto.createHash(algorithm);
      hash.update(data);
      return hash.digest('hex');
    } catch (error) {
      throw new Error(`Hash computation failed: ${error.message}`);
    }
  }

  async validateFileIntegrity(filePath, expectedHash, algorithm = 'sha256') {
    // TODO: Validate file against expected hash
    // - Compute file hash
    // - Compare with expected value
    // - Return validation result
    console.log(`TODO: Validate file integrity: ${filePath}`);
    
    try {
      const actualHash = await this.computeFileHash(filePath, algorithm);
      const matches = actualHash.toLowerCase() === expectedHash.toLowerCase();
      
      return {
        valid: matches,
        actualHash,
        expectedHash,
        algorithm
      };
    } catch (error) {
      return {
        valid: false,
        error: error.message,
        expectedHash,
        algorithm
      };
    }
  }

  async getDirectorySize(dirPath) {
    // TODO: Calculate total size of directory
    // - Recursively scan all files
    // - Sum file sizes
    // - Return size in bytes
    console.log(`TODO: Get directory size: ${dirPath}`);
    
    try {
      let totalSize = 0;
      
      const calculateSize = async (dir) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isFile()) {
            const stats = await fs.stat(fullPath);
            totalSize += stats.size;
          } else if (entry.isDirectory()) {
            await calculateSize(fullPath);
          }
        }
      };
      
      await calculateSize(dirPath);
      return totalSize;
    } catch (error) {
      throw new Error(`Size calculation failed: ${error.message}`);
    }
  }
}

export default ExtensionFileHandler;