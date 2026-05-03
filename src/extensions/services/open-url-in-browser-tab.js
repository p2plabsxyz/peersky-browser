import { BrowserWindow } from "electron";

const MIN_W = 500;
const MIN_H = 400;

const HAS_TABBAR_JS =
  "!!(document.getElementById('tabbar') && typeof document.getElementById('tabbar').addTab === 'function')";

export async function findWindowWithTabBar() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    const b = w.getBounds();
    if (b.width < MIN_W || b.height < MIN_H) continue;
    try {
      if (await w.webContents.executeJavaScript(HAS_TABBAR_JS, true)) return w;
    } catch (_) {}
  }
  return null;
}

export async function addTabViaTabBar(win, url, title) {
  const js = `(function(){var t=document.getElementById('tabbar');if(!t||typeof t.addTab!=='function')return null;return t.addTab(${JSON.stringify(url)},${JSON.stringify(title)});})();`;
  try {
    return await win.webContents.executeJavaScript(js, true);
  } catch (_) {
    return null;
  }
}

export async function openUrlInPeerskyTab(url, title = "New Tab") {
  const browserWindow = await findWindowWithTabBar();
  if (!browserWindow) return null;
  const tabId = await addTabViaTabBar(browserWindow, url, title);
  if (!tabId) return null;
  return { browserWindow, tabId };
}
