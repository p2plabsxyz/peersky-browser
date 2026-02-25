/**
 * electron-builder afterPack hook
 *
 * Re-downloads the correct architecture prebuild for native modules
 * that @electron/rebuild misses (cmake-js based modules like node-datachannel).
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// Electron-builder arch enum: 1 = x64, 3 = arm64
const ARCH_MAP = { 1: 'x64', 3: 'arm64', 0: 'ia32' };

// cmake-js modules that ship prebuilds but aren't detected by @electron/rebuild
const PREBUILD_MODULES = [
  'node_modules/node-datachannel',
  'node_modules/webrtc-polyfill/node_modules/node-datachannel'
];

export default async function afterPack(context) {
  const arch = ARCH_MAP[context.arch] || 'x64';
  const platform = context.electronPlatformName; // darwin, linux, win32
  
  // With asar: true, node_modules are in app.asar.unpacked/
  const appDirMac = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app',
    'Contents', 'Resources', 'app.asar.unpacked');
  const appDirMacNoAsar = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app',
    'Contents', 'Resources', 'app');
  const appDirLinux = path.join(context.appOutDir, 'resources', 'app.asar.unpacked');
  const appDirLinuxNoAsar = path.join(context.appOutDir, 'resources', 'app');
  
  // Try asar.unpacked first, then fall back to non-asar layout
  const root = fs.existsSync(appDirMac) ? appDirMac 
    : fs.existsSync(appDirLinux) ? appDirLinux
    : fs.existsSync(appDirMacNoAsar) ? appDirMacNoAsar
    : appDirLinuxNoAsar;

  console.log(`[afterPack] Fixing native prebuilds for ${platform}-${arch} in ${root}`);

  for (const modRel of PREBUILD_MODULES) {
    const modPath = path.join(root, modRel);
    if (!fs.existsSync(modPath)) continue;

    const buildDir = path.join(modPath, 'build', 'Release');
    const nodeFiles = fs.existsSync(buildDir)
      ? fs.readdirSync(buildDir).filter(f => f.endsWith('.node'))
      : [];

    if (nodeFiles.length === 0) continue;

    try {
      console.log(`[afterPack] Running prebuild-install for ${modRel} (${platform}-${arch})`);
      execSync(
        `npx prebuild-install -r napi --platform ${platform} --arch ${arch}`,
        { cwd: modPath, stdio: 'inherit', timeout: 60000 }
      );
      console.log(`[afterPack] ✓ ${modRel} prebuild installed for ${platform}-${arch}`);
    } catch (err) {
      console.warn(`[afterPack] ⚠ Failed to install prebuild for ${modRel}: ${err.message}`);
    }
  }
}
