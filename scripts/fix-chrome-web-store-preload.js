#!/usr/bin/env node
/**
 * Chrome Web Store Preload Fix Script
 * 
 * Cross-platform script to fix the electron-chrome-web-store preload resolution bug.
 * Creates a symlink on Unix systems, falls back to file copy on Windows or when symlink fails.
 * 
 * Features:
 * - Idempotent: Safe to run multiple times
 * - Cross-platform: Works on macOS, Linux, Windows
 * - Fallback: Copy file if symlink fails
 * - Validation: Checks result and reports status
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(__dirname);

// Paths
const stubSource = path.join(projectRoot, 'src/extensions/chrome-web-store-preload-stub.js');
const targetDir = path.join(projectRoot, 'node_modules/@iamevan/electron-chrome-web-store');
const targetFile = path.join(targetDir, 'preload.js');

console.log('🔧 Chrome Web Store Preload Fix');
console.log('===============================');

/**
 * Check if target already exists and is valid
 */
function checkExistingTarget() {
  if (!fs.existsSync(targetFile)) {
    return { exists: false };
  }

  try {
    const stats = fs.lstatSync(targetFile);
    if (stats.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(targetFile);
      const resolvedTarget = path.resolve(targetDir, linkTarget);
      const isValid = resolvedTarget === stubSource && fs.existsSync(resolvedTarget);
      return { exists: true, type: 'symlink', valid: isValid, target: linkTarget };
    } else if (stats.isFile()) {
      // Check if it's our stub content
      const content = fs.readFileSync(targetFile, 'utf8');
      const isOurStub = content.includes('Chrome Web Store preload stub');
      return { exists: true, type: 'file', valid: isOurStub };
    }
  } catch (error) {
    return { exists: true, type: 'unknown', valid: false, error: error.message };
  }

  return { exists: true, type: 'unknown', valid: false };
}

/**
 * Create symlink with fallback to copy
 */
function createTarget() {
  // Ensure target directory exists
  fs.mkdirSync(targetDir, { recursive: true });

  const relativePath = path.relative(targetDir, stubSource);
  
  // Try symlink first (Unix systems)
  try {
    fs.symlinkSync(relativePath, targetFile);
    console.log('✓ Created symlink:', relativePath);
    return { success: true, method: 'symlink' };
  } catch (symlinkError) {
    console.log('⚠ Symlink failed, trying copy fallback...');
    
    // Fallback to copy
    try {
      fs.copyFileSync(stubSource, targetFile);
      console.log('✓ Created copy fallback');
      return { success: true, method: 'copy' };
    } catch (copyError) {
      console.error('✗ Both symlink and copy failed');
      console.error('Symlink error:', symlinkError.message);
      console.error('Copy error:', copyError.message);
      return { success: false, errors: [symlinkError.message, copyError.message] };
    }
  }
}

/**
 * Validate the fix works
 */
function validateFix() {
  try {
    // Test that the target file exists and is readable
    if (!fs.existsSync(targetFile)) {
      throw new Error('Target file does not exist');
    }

    const stats = fs.statSync(targetFile);
    if (!stats.isFile() && !stats.isSymbolicLink()) {
      throw new Error('Target is not a file or symlink');
    }

    // Test that we can read the content
    const content = fs.readFileSync(targetFile, 'utf8');
    if (!content.includes('Chrome Web Store preload stub')) {
      throw new Error('Target file does not contain expected stub content');
    }

    console.log('✓ Target file exists and contains stub content');
    console.log('✓ Module path:', path.relative(projectRoot, targetFile));
    
    return true;
  } catch (error) {
    console.error('✗ Validation failed:', error.message);
    return false;
  }
}

/**
 * Main execution
 */
function main() {
  try {
    // Check if source stub exists
    if (!fs.existsSync(stubSource)) {
      console.error('✗ Source stub not found:', stubSource);
      process.exit(1);
    }

    // Check existing target
    const existing = checkExistingTarget();
    
    if (existing.exists && existing.valid) {
      console.log(`✓ Target already exists and is valid (${existing.type})`);
      if (existing.type === 'symlink') {
        console.log(`  → ${existing.target}`);
      }
    } else {
      if (existing.exists) {
        console.log(`⚠ Target exists but is invalid (${existing.type}), replacing...`);
        fs.unlinkSync(targetFile);
      }

      // Create new target
      const result = createTarget();
      if (!result.success) {
        console.error('✗ Failed to create target file');
        process.exit(1);
      }
    }

    // Validate the fix
    const isValid = validateFix();
    
    if (isValid) {
      console.log('🎉 Chrome Web Store preload fix applied successfully!');
      process.exit(0);
    } else {
      console.error('✗ Fix validation failed');
      process.exit(1);
    }

  } catch (error) {
    console.error('💥 Unexpected error:', error.message);
    process.exit(1);
  }
}

// Only run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}