const { app, BrowserWindow } = require('electron');
const { HyperSDKManager } = require('./hypersdk');

const hyperSDKManager = new HyperSDKManager();

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html').catch(() => {
    // Fallback if index.html does not exist
    mainWindow.loadURL('data:text/html;charset=utf-8,<h1>Hyper SDK App</h1>');
  });
}

app.whenReady().then(async () => {
  try {
    await hyperSDKManager.initialize();
    console.log('Hyper SDK initialized successfully.');
  } catch (err) {
    console.error('Error during Hyper SDK initialization:', err);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
