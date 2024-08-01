import { app } from "electron";
import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import path from "path";
import fs from "fs";
import findProcess from 'find-process';

const feed = 'https://github.com/p2plabsxyz/peersky-test/releases/download/latest';
const BUNDLE_NAME = 'peersky.p2plabs.xyz';
const SHIP_IT_BINARY = 'ShipIt';

let yaml = '';

yaml += "provider: generic\n";
yaml += "url: " + feed + "\n";
yaml += "useMultipleRangeRequest: false\n";
yaml += "channel: latest\n";
yaml += "updaterCacheDirName: " + app.getName() + "\n";

let updateFile = [path.join(process.resourcesPath, 'app-update.yml'), yaml];
let devUpdateFile = [path.join(process.resourcesPath, 'dev-app-update.yml'), yaml];
let checkFiles = [updateFile, devUpdateFile];

for (let file of checkFiles) {
  if (!fs.existsSync(file[0])) {
    fs.writeFileSync(file[0], file[1], 'utf8');
  }
}

let shouldRestartBeforeLaunch = false;

async function makeSureAutoUpdateFinished() {
  const shipItProcesses = await findProcess('name', SHIP_IT_BINARY);
  if (shipItProcesses.some(f => f.cmd.includes(BUNDLE_NAME))) {
    // if we don't restart, the old app from memory will keep running
    shouldRestartBeforeLaunch = true;
    console.debug('Waiting for auto update to finish');
    setTimeout(makeSureAutoUpdateFinished, 1500);
  } else {
    if (shouldRestartBeforeLaunch) {
      try {
        const Electron = require('electron');
        Electron.app.relaunch();
        Electron.app.exit(0);
      } catch (error) {
        console.error('Failed to restart the app through electron', error);
        process.exit(1);
      }
    }
  }
}

function setupAutoUpdater() {
  console.log('Setting feed URL for auto-updater');
  autoUpdater.setFeedURL({
      provider: 'github',
      repo: 'peersky-test',
      owner: 'p2plabsxyz',
  });

  autoUpdater.on('checking-for-update', () => {
      console.log('Checking for update...');
  });

  autoUpdater.on('update-available', (info) => {
      console.log('Update available:', info);
  });

  autoUpdater.on('update-not-available', (info) => {
      console.log('Update not available:', info);
  });

  autoUpdater.on('error', (err) => {
      console.error('Error in auto-updater:', err);
  });

  autoUpdater.on('download-progress', (progressObj) => {
      let log_message = `Download speed: ${progressObj.bytesPerSecond} - Downloaded ${progressObj.percent}% (${progressObj.transferred}/${progressObj.total})`;
      console.log(log_message);
  });

  autoUpdater.on('update-downloaded', (event, releaseNotes, releaseName) => {
      console.log('Update downloaded; will install in 20 seconds');
      setTimeout(() => {
          makeSureAutoUpdateFinished().then(() => {
              autoUpdater.quitAndInstall();
          });
      }, 20000); // 20 seconds delay after update is downloaded
  });

  console.log('Initiating check for updates in 10 seconds');
  setTimeout(() => {
      autoUpdater.checkForUpdates();
  }, 10000); // 10 seconds delay after app launch
}

export { setupAutoUpdater };
