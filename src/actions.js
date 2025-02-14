import { app, BrowserWindow, globalShortcut } from "electron";
import WindowManager from './window-manager.js';

export function createActions(windowManager) {
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
        windowManager.open();
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

export function registerShortcuts(windowManager) {
  const actions = createActions(windowManager);

  const registerFindShortcut = (focusedWindow) => {
    if (focusedWindow) {
      globalShortcut.register("CommandOrControl+F", () => {
        actions.FindInPage.click(focusedWindow);
      });
    }
  };

  const unregisterFindShortcut = () => {
    globalShortcut.unregister("CommandOrControl+F");
  };

  // Register and unregister `Ctrl+F` based on focus
  app.on("browser-window-focus", (event, win) => {
    registerFindShortcut(win);
  });

  app.on("browser-window-blur", () => {
    unregisterFindShortcut();
  });

  // Register remaining shortcuts
  Object.keys(actions).forEach((key) => {
    const action = actions[key];
    if (key !== "FindInPage") {
      // Register other shortcuts except `Ctrl+F`
      globalShortcut.register(action.accelerator, () => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        if (focusedWindow) action.click(focusedWindow);
      });
    }
  });
}
