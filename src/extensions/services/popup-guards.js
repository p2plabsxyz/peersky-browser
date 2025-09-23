// Install global guards so that extension popups cannot directly navigate to external URLs

import { BrowserWindow } from 'electron';

const isExternalUrl = (url) => /^(https?:|ipfs:|ipns:|hyper:|web3:)/i.test(url);

export function installExtensionPopupGuards(manager) {
  if (!manager.app) return;

  const openInPeerskyTab = async (url) => {
    try {
      if (manager.electronChromeExtensions && manager.electronChromeExtensions.createTab) {
        await manager.electronChromeExtensions.createTab({ url, active: true });
        return true;
      }
    } catch (err) {
      console.warn('[ExtensionManager] createTab failed, falling back to UI script:', err);
    }

    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win || win.isDestroyed()) continue;
      try {
        const ok = await win.webContents.executeJavaScript(`
          (function () {
            const tabBar = document.getElementById('tabbar');
            if (tabBar && typeof tabBar.addTab === 'function') {
              tabBar.addTab(${JSON.stringify(url)}, 'New Tab');
              return true;
            }
            return false;
          })();
        `, true);
        if (ok) return true;
      } catch (_) {}
    }
    return false;
  };

  const attachGuards = (wc) => {
    if (wc.__peerskyPopupGuardsInstalled) return;
    wc.__peerskyPopupGuardsInstalled = true;

    let isExtensionPopup = false;
    wc.on('did-start-navigation', (_e, url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      if (url && url.startsWith('chrome-extension://')) {
        isExtensionPopup = true;
      }
    });

    wc.setWindowOpenHandler((details) => {
      if (isExtensionPopup && isExternalUrl(details.url)) {
        openInPeerskyTab(details.url);
        return { action: 'deny' };
      }
      return { action: 'allow' };
    });

    wc.on('will-navigate', (event, url) => {
      if (isExtensionPopup && isExternalUrl(url)) {
        event.preventDefault();
        openInPeerskyTab(url);
        const popupWin = BrowserWindow.fromWebContents(wc);
        if (popupWin && !popupWin.isDestroyed()) {
          try { popupWin.close(); } catch (_) {}
        }
      }
    });
  };

  manager.app.on('web-contents-created', (_e, wc) => {
    try { attachGuards(wc); } catch (_) {}
  });
}

