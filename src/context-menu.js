import { Menu, MenuItem, clipboard,nativeImage } from "electron";
import WindowManager from "./window-manager.js";

const isMac = process.platform === "darwin";

// Ensure a single instance of WindowManager is used
let windowManagerInstance = null;

export function setWindowManager(instance) {
  windowManagerInstance = instance;
}

export function attachContextMenus(browserWindow, windowManager) {
  // Assign the WindowManager instance if not already set
  if (!windowManagerInstance) {
    windowManagerInstance = windowManager;
  }

  const attachMenuToWebContents = (webContents) => {
    webContents.on("context-menu", (event, params) => {
      const menu = new Menu();

      // Undo / Redo for editable fields
      if (params.isEditable) {
        menu.append(
          new MenuItem({ label: "Undo", role: "undo", accelerator: "CommandOrControl+Z" })
        );
        menu.append(
          new MenuItem({
            label: "Redo",
            role: "redo",
            accelerator: isMac ? "Command+Shift+Z" : "Control+Y",
          })
        );
        menu.append(new MenuItem({ type: "separator" }));
      }

      // Cut, Copy, Paste, Delete, Select All
      if (params.isEditable || params.selectionText.trim().length > 0) {
        menu.append(
          new MenuItem({
            label: "Cut",
            role: "cut",
            accelerator: "CommandOrControl+X",
            enabled: params.editFlags.canCut,
          })
        );
        menu.append(
          new MenuItem({
            label: "Copy",
            role: "copy",
            accelerator: "CommandOrControl+C",
            enabled: params.editFlags.canCopy,
          })
        );
        menu.append(
          new MenuItem({
            label: "Paste",
            role: "paste",
            accelerator: "CommandOrControl+V",
            enabled: params.editFlags.canPaste,
          })
        );
        menu.append(new MenuItem({ label: "Delete", role: "delete" }));
        menu.append(
          new MenuItem({
            label: "Select All",
            role: "selectAll",
            accelerator: "CommandOrControl+A",
          })
        );
        menu.append(new MenuItem({ type: "separator" }));
      }

      // Navigation controls
      menu.append(
        new MenuItem({
          label: "Back",
          enabled: webContents.canGoBack(),
          click: () => {
            browserWindow.webContents
              .executeJavaScript(`
                const tabBar = document.querySelector('#tabbar');
                if (tabBar && typeof tabBar.goBackActiveTab === 'function') {
                  tabBar.goBackActiveTab();
                } else { 'fallback'; }
              `)
              .then((result) => {
                if (result === "fallback") webContents.goBack();
              })
              .catch(() => webContents.goBack());
          },
        })
      );

      menu.append(
        new MenuItem({
          label: "Forward",
          enabled: webContents.canGoForward(),
          click: () => {
            browserWindow.webContents
              .executeJavaScript(`
                const tabBar = document.querySelector('#tabbar');
                if (tabBar && typeof tabBar.goForwardActiveTab === 'function') {
                  tabBar.goForwardActiveTab();
                } else { 'fallback'; }
              `)
              .then((result) => {
                if (result === "fallback") webContents.goForward();
              })
              .catch(() => webContents.goForward());
          },
        })
      );

      menu.append(
        new MenuItem({
          label: "Reload",
          click: () => {
            browserWindow.webContents
              .executeJavaScript(`
                const tabBar = document.querySelector('#tabbar');
                if (tabBar && typeof tabBar.reloadActiveTab === 'function') {
                  tabBar.reloadActiveTab();
                } else { 'fallback'; }
              `)
              .then((result) => {
                if (result === "fallback") webContents.reload();
              })
              .catch(() => webContents.reload());
          },
        })
      );

      // Inspect element
      menu.append(
        new MenuItem({
          label: "Inspect",
          click: () => {
            if (!webContents.isDevToolsOpened()) {
              webContents.openDevTools({ mode: "detach" });
            }
            webContents.inspectElement(params.x, params.y);
          },
        })
      );

      // Links
      if (params.linkURL) {
        menu.append(
          new MenuItem({ label: "Copy Link Address", click: () => clipboard.writeText(params.linkURL) })
        );
        menu.append(
          new MenuItem({
            label: "Open Link in New Window",
            click: () => {
              if (windowManagerInstance) {
                windowManagerInstance.open({ url: params.linkURL, newWindow: true });
              }
            },
          })
        );
      }

      // ✅ Image-specific options
      if (params.mediaType === "image") {
        menu.append(
          new MenuItem({
            label: "Copy Image",
            click: () => {
              const img = nativeImage.createFromDataURL(params.srcURL);
              clipboard.writeImage(img);
            },
          })
        );

        menu.append(
          new MenuItem({
            label: "Download Image",
            click: async () => {
              const { dialog } = require("electron");
              const fs = require("fs");
              const path = require("path");
              const axios = require("axios");

              try {
                const savePath = dialog.showSaveDialogSync({
                  defaultPath: path.basename(params.srcURL.split("?")[0]),
                });

                if (!savePath) return;

                const response = await axios.get(params.srcURL, { responseType: "arraybuffer" });
                fs.writeFileSync(savePath, Buffer.from(response.data));
              } catch (err) {
                console.error("Error downloading image:", err);
              }
            },
          })
        );

        menu.append(new MenuItem({ type: "separator" }));
      }

      menu.popup();
    });
  };

  // Attach to main window
  attachMenuToWebContents(browserWindow.webContents);

  // Attach to webviews
  browserWindow.webContents.on("did-attach-webview", (event, webviewWebContents) => {
    attachMenuToWebContents(webviewWebContents);

    webviewWebContents.setWindowOpenHandler(({ url }) => {
      const escapedUrl = url.replace(/'/g, "\\'");
      browserWindow.webContents
        .executeJavaScript(`
          const tabBar = document.querySelector('#tabbar');
          if (tabBar && typeof tabBar.addTab === 'function') {
            tabBar.addTab('${escapedUrl}');
            true;
          } else { false; }
        `)
        .then((added) => {
          if (!added && windowManagerInstance) windowManagerInstance.open({ url });
        })
        .catch(() => {
          if (windowManagerInstance) windowManagerInstance.open({ url });
        });
      return { action: "deny" };
    });
  });
}
