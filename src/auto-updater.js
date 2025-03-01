import { app, dialog } from 'electron';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import log from 'electron-log';

// Uncomment while locally testing the AutoUpdater
// Object.defineProperty(app, 'isPackaged', {
//   value: true
// });

function setupAutoUpdater() {
  autoUpdater.setFeedURL({
    provider: 'github',
    repo: 'peersky-browser',
    owner: 'p2plabsxyz',
  });

  // Allow pre-release updates
  autoUpdater.allowPrerelease = true;

  // Configure electron-log
  log.transports.file.level = 'info';
  log.transports.console.level = 'info';
  autoUpdater.logger = log;

  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for update...');
  });

  autoUpdater.on('update-available', (info) => {
    log.info('Update available:', info);
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info('Update not available:', info);
  });

  autoUpdater.on('download-progress', (progressObj) => {
    log.info(`Download speed: ${progressObj.bytesPerSecond} - Downloaded ${progressObj.percent}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    const message = `Version ${info.version} has been downloaded. Restart now to install it or select Later to postpone the update.`;
    const response = dialog.showMessageBoxSync({
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      title: 'Update Ready',
      message: message,
    });
    if (response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (error) => {
    log.error('Auto-update error:', error);
  });

  // Initiate update check after 10 seconds
  setTimeout(() => {
    autoUpdater.checkForUpdates();
  }, 10000);
}

export { setupAutoUpdater };
