import { app, BrowserWindow, globalShortcut } from "electron";
import { createWindow } from "./main.js";

export function createActions() {
  const actions = {
    OpenDevTools: {
      label: "Open Dev Tools",
      accelerator: "CommandOrControl+Shift+I",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.webContents.openDevTools({ mode: "detach" });
        }
      },
    },
    NewWindow: {
      label: "New Window",
      accelerator: "CommandOrControl+N",
      click: () => {
        createWindow();
      },
    },
    Forward: {
      label: "Forward",
      accelerator: "CommandOrControl+]",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`{
            const webview = document.querySelector('webview');
            if (webview && webview.canGoForward()) {
              webview.goForward();
            }
          }`);
        }
      },
    },
    Back: {
      label: "Back",
      accelerator: "CommandOrControl+[",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`{
            const webview = document.querySelector('webview');
            if (webview && webview.canGoBack()) {
              webview.goBack();
            }
          }`);
        }
      },
    },
    FocusURLBar: {
      label: "Focus URL Bar",
      accelerator: "CommandOrControl+L",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`
            document.getElementById('url').focus();
          `);
        }
      },
    },
    Reload: {
      label: "Reload",
      accelerator: "CommandOrControl+R",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`{
              const webview = document.querySelector('webview');
              if (webview) {
                webview.reload();
              }
            }`);
        }
      },
    },
    Minimize: {
      label: "Minimize",
      accelerator: "CommandOrControl+M",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.minimize();
        }
      },
    },
    Close: {
      label: "Close",
      accelerator: "CommandOrControl+W",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.close();
        }
      },
    },
    FullScreen: {
      label: "Toggle Full Screen",
      accelerator: "F11",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.setFullScreen(!focusedWindow.isFullScreen());
        }
      },
    },
    FindInPage: {
      label: "Find in Page",
      accelerator: "CommandOrControl+F",
      click: (focusedWindow) => {
        if (focusedWindow) {
          focusedWindow.webContents.executeJavaScript(`
            var findMenu = document.querySelector('find-menu');
            if (findMenu) {
              findMenu.toggle();
              setTimeout(() => {
                var input = findMenu.querySelector('.find-menu-input');
                if (input) {
                  input.focus();
                }
              }, 100); // Timeout to ensure the menu is visible and ready to receive focus
            }
          `);
        }
      },
    },    
  };

  return actions;
}

export function registerShortcuts() {
  const actions = createActions();
  Object.keys(actions).forEach((key) => {
    const action = actions[key];
    globalShortcut.register(action.accelerator, () => {
      const focusedWindow = BrowserWindow.getFocusedWindow();
      action.click(focusedWindow);
    });
  });
}
