import {
  Menu,
  MenuItem,
  clipboard,
  BrowserWindow,
  webContents,
} from "electron";
import { createWindow } from "./main.js";
const isMac = process.platform === "darwin";

export function attachContextMenus(browserWindow) {
  const attachMenuToWebContents = (webContents) => {
    webContents.on("context-menu", (event, params) => {
      const menu = new Menu();

      // Add Undo, Redo for editable text fields with platform-specific accelerators
      if (params.isEditable) {
        menu.append(
          new MenuItem({
            label: "Undo",
            role: "undo",
            accelerator: "CommandOrControl+Z",
          })
        );
        menu.append(
          new MenuItem({
            label: "Redo",
            role: "redo",
            accelerator: isMac ? "Command+Shift+Z" : "Control+Y", // Use Cmd+Shift+Z on macOS, Ctrl+Y on other platforms
          })
        );
        menu.append(new MenuItem({ type: "separator" }));
      }

      // Cut, Copy, Paste, Delete, and Select All with accelerators
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
        menu.append(
          new MenuItem({
            label: "Delete",
            role: "delete",
          })
        );
        menu.append(
          new MenuItem({
            label: "Select All",
            role: "selectAll",
            accelerator: "CommandOrControl+A",
          })
        );
        menu.append(new MenuItem({ type: "separator" }));
      }

      // Navigation controls with no accelerators
      menu.append(
        new MenuItem({
          label: "Back",
          enabled: webContents.canGoBack(),
          click: () => webContents.goBack(),
        })
      );
      menu.append(
        new MenuItem({
          label: "Forward",
          enabled: webContents.canGoForward(),
          click: () => webContents.goForward(),
        })
      );
      menu.append(
        new MenuItem({
          label: "Reload",
          click: () => webContents.reload(),
        })
      );

      // Element inspection
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

      // Link handling
      if (params.linkURL) {
        menu.append(
          new MenuItem({
            label: "Copy Link Address",
            click: () => clipboard.writeText(params.linkURL),
          })
        );
        menu.append(
          new MenuItem({
            label: "Open Link in New Window",
            click: () => createWindow(params.linkURL),
          })
        );
      }

      menu.popup();
    });
  };

  // Attach to main window's webContents
  attachMenuToWebContents(browserWindow.webContents);

  // Attach to all existing webviews
  browserWindow.webContents.on(
    "did-attach-webview",
    (event, webviewWebContents) => {
      attachMenuToWebContents(webviewWebContents);

      webviewWebContents.setWindowOpenHandler(({ url }) => {
        createWindow(url);
        return { action: "deny" };
      });
    }
  );
}
