import { Menu, MenuItem, clipboard, dialog, screen } from 'electron'
import { isExternalScheme, openExternalScheme } from './external-scheme.js'
import path from 'path'
import extensionManager from './extensions/index.js'
import { openDockedDevTools } from './devtools-dock.js'
import { watchPageInput, takeInputGrant } from './page-input.js'
import { queueFirstLoad } from './navigation-restore.js'

const isMac = process.platform === 'darwin'

// Ensure a single instance of WindowManager is used
let windowManagerInstance = null

export function setWindowManager (instance) {
  windowManagerInstance = instance
}

const NAVIGABLE_SCHEMES = new Set([
  'http:', 'https:', 'peersky:', 'ipfs:', 'ipns:', 'pubsub:',
  'hyper:', 'hs:', 'web3:', 'bittorrent:', 'bt:', 'magnet:', 'webtorrent:'
])

// Text is navigable if it parses as a supported URL, or reads as a bare
// hostname we can reasonably treat as https. Anything else stays a selection.
function toNavigableUrl (text) {
  const trimmed = (text || '').trim()
  if (!trimmed || trimmed.length > 2048 || /\s/.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    return NAVIGABLE_SCHEMES.has(url.protocol) ? url.href : null
  } catch (_) {}
  if (!/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(trimmed)) return null
  try {
    return new URL(`https://${trimmed}`).href
  } catch (_) {
    return null
  }
}

// The size and place a page asks for in window.open, read as Chrome reads
// them: width and height are the page's own area, left and top where the
// window goes on the screen, and innerWidth, innerHeight, screenX and screenY
// mean the same. Chrome makes no popup smaller than 100 by 100.
const POPUP_FEATURES = {
  width: 'width',
  innerwidth: 'width',
  height: 'height',
  innerheight: 'height',
  left: 'x',
  screenx: 'x',
  top: 'y',
  screeny: 'y'
}
const MIN_POPUP_SIZE = 100

export function popupBoundsFromFeatures (features) {
  const bounds = {}
  for (const token of String(features || '').split(',')) {
    const [name, ...value] = token.split('=')
    const key = POPUP_FEATURES[name.trim().toLowerCase()]
    const number = parseInt(value.join('=').trim(), 10)
    if (key && Number.isFinite(number)) bounds[key] = number
  }
  if (bounds.width !== undefined) bounds.width = Math.max(MIN_POPUP_SIZE, bounds.width)
  if (bounds.height !== undefined) bounds.height = Math.max(MIN_POPUP_SIZE, bounds.height)
  return bounds
}

// A popup's window options: the size the page asked for, or 600 by 700, and
// where it asked to be, kept on the screen as Chrome keeps a popup in sight.
// A side it did not give comes from the window that opened it.
export function popupWindowBounds (bounds, { parentBounds, workArea } = {}) {
  const sized = bounds.width !== undefined || bounds.height !== undefined
  let width = bounds.width ?? 600
  let height = bounds.height ?? 700
  if (workArea) {
    width = Math.min(width, workArea.width)
    height = Math.min(height, workArea.height)
  }
  const options = { width, height, ...(sized && { useContentSize: true }) }
  if (bounds.x === undefined && bounds.y === undefined) return options
  let x = bounds.x ?? parentBounds?.x ?? 0
  let y = bounds.y ?? parentBounds?.y ?? 0
  if (workArea) {
    x = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width)
    y = Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height)
  }
  return { ...options, x, y }
}

// How a page asked for the page it opens: with its referrer, and a form's
// POST body and type, as Electron's own window.open loads them. A new tab's
// first load carries them (navigation-restore.js), so a POST form with
// target=_blank stays a POST and a link sends its referrer.
export function firstLoadOptions ({ referrer, postBody } = {}) {
  const options = {}
  if (referrer?.url) options.httpReferrer = referrer
  if (Array.isArray(postBody?.data) && postBody.data.length) {
    options.postData = postBody.data
    const type = postBody.contentType || 'application/x-www-form-urlencoded'
    options.extraHeaders = `content-type: ${type}${postBody.boundary ? `; boundary=${postBody.boundary}` : ''}`
  }
  return options
}

// Tabs a page opened under a name, so its next window.open or link with that
// target loads in the same tab, as in Chrome. By the page that opened them,
// as a name is only looked up among a page's own windows.
const namedTabs = new Map() // `${opener id}\n${name}` -> tab webContents

// _blank, _self and any other name starting with _ are not names.
function nameKey (openerId, frameName) {
  if (typeof frameName !== 'string' || !frameName || frameName.startsWith('_')) return null
  return `${openerId}\n${frameName}`
}

function nameTab (key, tab) {
  namedTabs.set(key, tab)
  tab.once('destroyed', () => {
    if (namedTabs.get(key) === tab) namedTabs.delete(key)
  })
}

function namedTab (key) {
  const tab = key ? namedTabs.get(key) : null
  return tab && !tab.isDestroyed() ? tab : null
}

// Brings a tab to the front of its window.
function showTab (tab) {
  const host = tab.hostWebContents
  if (!host || host.isDestroyed()) return
  host.executeJavaScript(`(() => {
    const tabBar = document.querySelector('#tabbar')
    const found = tabBar?.findTabByWebContentsId?.(${Number(tab.id)})
    if (found) tabBar.selectTab(found.id)
  })()`).catch(() => {})
}

function shortenForLabel (url) {
  return url.length > 48 ? `${url.slice(0, 47)}\u2026` : url
}

export function attachContextMenus (browserWindow, windowManager) {
  // Assign the WindowManager instance if not already set
  if (!windowManagerInstance) {
    windowManagerInstance = windowManager
  }

  const goToUrl = (url) => {
    browserWindow.webContents
      .executeJavaScript(`
        (function () {
          const tabBar = document.querySelector('#tabbar') || document.querySelector('tab-bar');
          if (tabBar && typeof tabBar.navigateActiveTab === 'function') {
            tabBar.navigateActiveTab(${JSON.stringify(url)});
            return true;
          }
          return false;
        })()
      `)
      .then((navigated) => {
        if (!navigated) console.warn('Failed to find tab bar to navigate')
      })
      .catch((err) => {
        console.error('Failed to navigate from context menu:', err)
      })
  }

  const attachMenuToWebContents = (webContents) => {
    webContents.on('context-menu', (event, params) => {
      const menu = new Menu()

      // Add Undo, Redo for editable text fields with platform-specific accelerators
      if (params.isEditable) {
        menu.append(
          new MenuItem({
            label: 'Undo',
            role: 'undo',
            accelerator: 'CommandOrControl+Z'
          })
        )
        menu.append(
          new MenuItem({
            label: 'Redo',
            role: 'redo',
            accelerator: isMac ? 'Command+Shift+Z' : 'Control+Y'
          })
        )
        menu.append(new MenuItem({ type: 'separator' }))
      }

      // Cut, Copy, Paste, Delete, and Select All with accelerators
      if (params.isEditable || params.selectionText.trim().length > 0) {
        menu.append(
          new MenuItem({
            label: 'Cut',
            role: 'cut',
            accelerator: 'CommandOrControl+X',
            enabled: params.editFlags.canCut
          })
        )
        menu.append(
          new MenuItem({
            label: 'Copy',
            role: 'copy',
            accelerator: 'CommandOrControl+C',
            enabled: params.editFlags.canCopy
          })
        )
        menu.append(
          new MenuItem({
            label: 'Paste',
            role: 'paste',
            accelerator: 'CommandOrControl+V',
            enabled: params.editFlags.canPaste
          })
        )
        const pasteTarget = params.isEditable ? toNavigableUrl(clipboard.readText()) : null
        if (pasteTarget) {
          menu.append(
            new MenuItem({
              label: 'Paste and Go',
              enabled: params.editFlags.canPaste,
              click: () => goToUrl(pasteTarget)
            })
          )
        }
        menu.append(
          new MenuItem({
            label: 'Delete',
            role: 'delete'
          })
        )
        menu.append(
          new MenuItem({
            label: 'Select All',
            role: 'selectAll',
            accelerator: 'CommandOrControl+A'
          })
        )
        // Links already offer their own open items, so only bare text needs this.
        const selectionTarget = params.linkURL ? null : toNavigableUrl(params.selectionText)
        if (selectionTarget) {
          menu.append(
            new MenuItem({
              label: `Go to ${shortenForLabel(selectionTarget)}`,
              click: () => goToUrl(selectionTarget)
            })
          )
        }
        menu.append(new MenuItem({ type: 'separator' }))
      }

      // Navigation controls with no accelerators
      menu.append(
        new MenuItem({
          label: 'Back',
          enabled: webContents.navigationHistory?.canGoBack?.() ?? webContents.canGoBack?.(),
          click: () => {
            // Try tab-based navigation first, fallback to direct webContents
            browserWindow.webContents.executeJavaScript(`
              const tabBar = document.querySelector('#tabbar');
              if (tabBar && typeof tabBar.goBackActiveTab === 'function') {
                tabBar.goBackActiveTab();
              } else {
                // Direct webContents navigation for single webview
                return 'fallback';
              }
            `).then(result => {
              if (result === 'fallback') {
                webContents.goBack()
              }
            }).catch(() => webContents.goBack())
          }
        })
      )
      menu.append(
        new MenuItem({
          label: 'Forward',
          enabled: webContents.navigationHistory?.canGoForward?.() ?? webContents.canGoForward?.(),
          click: () => {
            browserWindow.webContents.executeJavaScript(`
              const tabBar = document.querySelector('#tabbar');
              if (tabBar && typeof tabBar.goForwardActiveTab === 'function') {
                tabBar.goForwardActiveTab();
              } else {
                return 'fallback';
              }
            `).then(result => {
              if (result === 'fallback') {
                webContents.goForward()
              }
            }).catch(() => webContents.goForward())
          }
        })
      )
      menu.append(
        new MenuItem({
          label: 'Reload',
          click: () => {
            browserWindow.webContents.executeJavaScript(`
              const tabBar = document.querySelector('#tabbar');
              if (tabBar && typeof tabBar.reloadActiveTab === 'function') {
                tabBar.reloadActiveTab();
              } else {
                return 'fallback';
              }
            `).then(result => {
              if (result === 'fallback') {
                webContents.reload()
              }
            }).catch(() => webContents.reload())
          }
        })
      )

      menu.append(new MenuItem({ type: 'separator' }))

      // Print
      menu.append(
        new MenuItem({
          label: 'Print...',
          accelerator: 'CommandOrControl+P',
          click: () => {
            webContents.print({ printBackground: true }, (success, failureReason) => {
              if (!success) {
                console.error('Print failed:', failureReason)
                // Fallback: try window.print in the page context
                webContents
                  .executeJavaScript('window.print()')
                  .catch((err) => console.error('window.print fallback failed:', err))
              }
            })
          }
        })
      )

      menu.append(new MenuItem({ type: 'separator' }))

      // Element inspection
      menu.append(
        new MenuItem({
          label: 'Inspect',
          click: () => {
            // A page opens its DevTools docked in the window, not in one of their own.
            if (webContents.getType() === 'webview') {
              openDockedDevTools(webContents, { inspect: { x: params.x, y: params.y } })
              return
            }
            if (!webContents.isDevToolsOpened()) {
              webContents.openDevTools({ mode: 'detach' })
            }
            webContents.inspectElement(params.x, params.y)
          }
        })
      )

      // Image handling features (copy, copy address, save as)
      if (params.mediaType === 'image' && params.srcURL) {
        menu.append(
          new MenuItem({
            label: 'Copy Image',
            click: () => {
              try {
                // Use copyImageAt for best quality
                const img = webContents.copyImageAt(params.x, params.y)
                if (img && !img.isEmpty()) {
                  clipboard.writeImage(img)
                }
              } catch (e) {
                console.error('Copy Image failed:', e)
              }
            }
          })
        )
        menu.append(
          new MenuItem({
            label: 'Copy Image Address',
            click: () => clipboard.writeText(params.srcURL)
          })
        )
        menu.append(
          new MenuItem({
            label: 'Save Image As...',
            click: async () => {
              try {
                // Search results serve images through a proxy that keeps the
                // real URL in a query parameter, so take the name from that.
                const src = new URL(params.srcURL)
                const nested = src.searchParams.get('u') || src.searchParams.get('url')
                const target = nested?.startsWith('http') ? new URL(nested) : src
                const defaultName = decodeURIComponent(path.basename(target.pathname)) || 'image.png'

                // Show save dialog
                const result = await dialog.showSaveDialog(browserWindow, {
                  title: 'Save Image',
                  defaultPath: defaultName,
                  filters: [
                    {
                      name: 'Image Files',
                      extensions: [
                        'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg',
                        'apng', 'avif', 'heic', 'heif', 'jxl',
                        'ico', 'cur', 'tif', 'tiff',
                        'xbm', 'pnm', 'ppm', 'pgm', 'pbm'
                      ]
                    },
                    { name: 'All Files', extensions: ['*'] }
                  ]
                })

                if (!result.canceled && result.filePath) {
                  // Validate URL scheme
                  try {
                    const u = new URL(params.srcURL)
                    const allowedSchemes = new Set(['http:', 'https:', 'ipfs:', 'hyper:'])

                    if (!allowedSchemes.has(u.protocol)) {
                      console.warn('Blocked download for unsupported scheme:', u.protocol)
                      return
                    }
                  } catch (err) {
                    console.error('Invalid URL:', params.srcURL)
                    return
                  }

                  // Listen for the download and move it to the chosen location
                  webContents.session.once('will-download', (event, item) => {
                    // Guard clause to ensure this download matches our intended file
                    if (item.getURL() !== params.srcURL) return
                    item.setSavePath(result.filePath)

                    item.on('updated', (event, state) => {
                      if (state === 'interrupted') {
                        console.error('Download interrupted')
                      }
                    })

                    item.once('done', (event, state) => {
                      if (state === 'completed') {
                        console.log('Image saved successfully to:', result.filePath)
                      } else {
                        console.error('Download failed:', state)
                      }
                    })
                  })

                  // Download the image using webContents session
                  webContents.session.downloadURL(params.srcURL)
                }
              } catch (e) {
                console.error('Save Image failed:', e)
              }
            }
          })
        )
        menu.append(new MenuItem({ type: 'separator' }))
      }

      // Link handling
      if (params.linkURL) {
        menu.append(
          new MenuItem({
            label: 'Copy Link Address',
            click: () => clipboard.writeText(params.linkURL)
          })
        )
        menu.append(
          new MenuItem({
            label: 'Open Link in New Tab',
            click: () => {
              // First, attempt to add the URL as a new tab in the current window

              browserWindow.webContents
                .executeJavaScript(`
                  (function() {
                    const tabBar = document.querySelector('tab-bar');
                    const url = ${JSON.stringify(params.linkURL)};
                    if (tabBar && typeof tabBar.addTabFromLink === 'function') {
                      tabBar.addTabFromLink(url, ${JSON.stringify(webContents.id)});
                      return true;
                    }
                    if (tabBar && typeof tabBar.addTab === 'function') {
                      tabBar.addTab(url);
                      return true;
                    }
                    const oldTabBar = document.querySelector('#tabbar');
                    if (oldTabBar && typeof oldTabBar.addTabFromLink === 'function') {
                      oldTabBar.addTabFromLink(url, ${JSON.stringify(webContents.id)});
                      return true;
                    }
                    if (oldTabBar && typeof oldTabBar.addTab === 'function') {
                      oldTabBar.addTab(url);
                      return true;
                    }
                    return false;
                  })()
                `)
                .then((added) => {
                  if (!added) {
                    console.warn('Failed to find tab bar for new tab')
                  }
                })
                .catch((err) => {
                  console.error('Failed to add tab from context menu:', err)
                })
            }
          })
        )
        menu.append(
          new MenuItem({
            label: 'Open Link in New Window',
            click: () => {
              if (windowManagerInstance) {
                // A link from an incognito window opens in another incognito one.
                const incognito = windowManagerInstance.findWindowByWebContentsId(browserWindow.webContents.id)?.incognito === true
                windowManagerInstance.open({ url: params.linkURL, newWindow: true, incognito })
              } else {
                console.error('WindowManager instance not set.')
              }
            }
          })
        )
      }

      // Extension context menu items (chrome.contextMenus API)
      try {
        const ext = extensionManager.electronChromeExtensions
        if (ext && typeof ext.getContextMenuItems === 'function') {
          const extItems = ext.getContextMenuItems(webContents, params) || []
          if (extItems.length > 0) {
            menu.append(new MenuItem({ type: 'separator' }))
            for (const item of extItems) {
              menu.append(item)
            }
          }
        }
      } catch (e) {
        console.warn('[Context menu] Extension menu items failed:', e?.message)
      }

      menu.popup()
    })
  }

  // Attach to main window's webContents
  attachMenuToWebContents(browserWindow.webContents)

  // Ensure window.open from overlays (e.g., extension popups rendered in this webContents) opens as a tab
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const urlLiteral = JSON.stringify(url)
      browserWindow.webContents
        .executeJavaScript(`
          const tabBar = document.querySelector('#tabbar');
          if (tabBar && typeof tabBar.addTab === 'function') {
            tabBar.addTab(${urlLiteral}, 'New Tab');
            return true;
          } else {
            return false;
          }
        `)
        .then((added) => {
          if (!added && windowManagerInstance) {
            windowManagerInstance.open({ url })
          }
        })
        .catch((err) => {
          console.error('Failed to add tab from main windowOpenHandler:', err)
          if (windowManagerInstance) {
            windowManagerInstance.open({ url })
          }
        })
    } catch (e) {
      console.warn('Error in main windowOpenHandler:', e)
      if (windowManagerInstance) {
        windowManagerInstance.open({ url })
      }
    }
    return { action: 'deny' }
  })

  // Track popup limits per webview to reduce abuse. They are for what a page
  // opens on its own: what a person opens with a click or a key is not
  // counted, as Chrome's popup blocker never stops it (page-input.js).
  const webviewPopupLimits = new Map() // wcId -> { recent: number[] }
  const MAX_POPUPS_PER_10S = 3
  const MAX_POPUPS_PER_MIN = 10

  const withinPopupLimits = (wcId) => {
    const now = Date.now()
    const state = webviewPopupLimits.get(wcId) || { recent: [] }
    // keep only last 60s
    state.recent = state.recent.filter((t) => now - t < 60_000)
    // sliding windows
    const last10s = state.recent.filter((t) => now - t < 10_000).length
    const last60s = state.recent.length
    if (last10s >= MAX_POPUPS_PER_10S || last60s >= MAX_POPUPS_PER_MIN) {
      webviewPopupLimits.set(wcId, state)
      return false
    }
    state.recent.push(now)
    webviewPopupLimits.set(wcId, state)
    return true
  }

  const isSafePopupUrl = (url) => {
    if (!url || url === 'about:blank') return true // common for OAuth bootstraps
    try {
      const u = new URL(url)
      return u.protocol === 'https:' || u.protocol === 'http:'
    } catch (_) {
      // Non-standard or invalid URL – treat as unsafe
      return false
    }
  }

  // Attach to all existing webviews
  browserWindow.webContents.on(
    'did-attach-webview',
    (event, webviewWebContents) => {
      attachMenuToWebContents(webviewWebContents)
      watchPageInput(webviewWebContents)

      webviewWebContents.on('will-navigate', (navEvent, url) => {
        if (!isExternalScheme(url)) return
        navEvent.preventDefault()
        openExternalScheme(browserWindow, url)
      })

      // A link opened in a new tab joins the strip beside its page. With
      // background it stays behind the page, as Cmd+click and a middle click
      // leave it in Chrome. Its first load keeps the referrer and POST body
      // the page sent, and a tab opened under a name is kept by that name.
      const openInTab = (url, { background = false, referrer = null, postBody = null, name = null } = {}) => {
        const urlLiteral = JSON.stringify(url || '')
        const load = firstLoadOptions({ referrer, postBody })
        const loadToken = name || Object.keys(load).length
          ? queueFirstLoad({ url, options: load, onAttach: name ? (tab) => nameTab(name, tab) : null })
          : null
        const options = JSON.stringify({ background, ...(loadToken && { loadToken }) })
        Promise.resolve()
          .then(() => browserWindow.webContents.executeJavaScript(`
            (function() {
              const tabBar = document.querySelector('#tabbar');
              if (tabBar && typeof tabBar.addTabFromLink === 'function') {
                tabBar.addTabFromLink(${urlLiteral}, ${JSON.stringify(webviewWebContents.id)}, ${options});
                return true;
              }
              if (tabBar && typeof tabBar.addTab === 'function') {
                tabBar.addTab(${urlLiteral});
                return true;
              }
              return false;
            })()
          `))
          .then((added) => {
            if (!added && windowManagerInstance) {
              windowManagerInstance.open({ url })
            }
          })
          .catch((err) => {
            console.error('Failed to add tab from webview windowOpenHandler:', err)
            if (windowManagerInstance) windowManagerInstance.open({ url })
          })
      }

      // Webview popups: allow native popups with opener for OAuth/extension flows
      webviewWebContents.setWindowOpenHandler((details) => {
        const { url, features = '', disposition, frameName, referrer, postBody } = details
        const featuresLower = String(features || '').toLowerCase()
        const hasNoOpener = /(?:^|,)(noopener|noreferrer)(?:=1)?(?:,|$)/.test(featuresLower)
        const wantsBackground = disposition === 'background-tab' || /(?:^|,)background(?:=1)?(?:,|$)/.test(featuresLower)
        const hasPopupFeatures = /(?:^|,|\s)(width|height|left|top)=/i.test(featuresLower)
        const isAboutBlank = url === 'about:blank'

        // If explicitly no opener requested, prefer tab UX instead of popup.
        // A name means nothing then, as in Chrome.
        if (hasNoOpener) {
          openInTab(url, { background: wantsBackground, referrer, postBody })
          return { action: 'deny' }
        }

        if (!isSafePopupUrl(url) && isExternalScheme(url)) {
          openExternalScheme(browserWindow, url)
          return { action: 'deny' }
        }

        // A name this page opened a tab under loads in that tab. The tab comes
        // to the front only for a click or key, as Chrome brings an existing
        // window forward only then: a page on its own cannot pull it up.
        const name = nameKey(webviewWebContents.id, frameName)
        const named = url && !isAboutBlank ? namedTab(name) : null
        if (named) {
          named.loadURL(url, firstLoadOptions({ referrer, postBody })).catch(() => {})
          if (takeInputGrant(webviewWebContents) && !wantsBackground) showTab(named)
          return { action: 'deny' }
        }

        // Only allow http/https or about:blank; block others
        if (!isSafePopupUrl(url)) {
          // Preserve previous behavior for unsafe schemes: re-route to tab/window
          openInTab(url, { background: wantsBackground, referrer, postBody, name })
          return { action: 'deny' }
        }

        // Enforce modest rate limits per webview to discourage abuse, on what
        // the page opens without the person's click or key just before.
        if (!takeInputGrant(webviewWebContents) && !withinPopupLimits(webviewWebContents.id)) {
          console.warn('Popup blocked: rate limit exceeded for webview', webviewWebContents.id)
          return { action: 'deny' }
        }

        if (!hasPopupFeatures && !isAboutBlank && disposition !== 'new-window') {
          openInTab(url, { background: wantsBackground, referrer, postBody, name })
          return { action: 'deny' }
        }

        // Shift+click asks for a window, which Chrome opens as a browser
        // window of its own, as Open Link in New Window does here. Only a
        // page's window.open names a size or popup, for a popup.
        if (disposition === 'new-window' && !featuresLower.trim() && !isAboutBlank) {
          if (windowManagerInstance) {
            const incognito = windowManagerInstance.findWindowByWebContentsId(browserWindow.webContents.id)?.incognito === true
            windowManagerInstance.open({ url, newWindow: true, incognito })
          }
          return { action: 'deny' }
        }

        // Build safe overrides but preserve important inherited prefs like partition
        const lastPrefs = (typeof webviewWebContents.getLastWebPreferences === 'function'
          ? webviewWebContents.getLastWebPreferences()
          : {}) || {}

        const overridePrefs = {
          // Keep Node disabled and isolation/sandbox on
          nodeIntegration: false,
          contextIsolation: lastPrefs.contextIsolation !== false,
          sandbox: lastPrefs.sandbox !== false,
          webSecurity: true,
          // Ensure native opener relationship
          nativeWindowOpen: true,
          // Preserve session/partition and affinity for cookie continuity
          partition: lastPrefs.partition,
          affinity: lastPrefs.affinity,
          // Never enable remote in popups
          enableRemoteModule: false
        }

        // The size and place the page asked for, where it asked for any.
        const asked = popupBoundsFromFeatures(features)
        let parentBounds, workArea
        try {
          parentBounds = browserWindow.getBounds()
          const at = { x: asked.x ?? parentBounds.x, y: asked.y ?? parentBounds.y, width: asked.width ?? 600, height: asked.height ?? 700 }
          workArea = screen.getDisplayMatching(at).workArea
        } catch (_) {}

        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            show: !wantsBackground,
            focusable: !wantsBackground,
            skipTaskbar: !!wantsBackground,
            parent: browserWindow,
            autoHideMenuBar: true,
            ...popupWindowBounds(asked, { parentBounds, workArea }),
            webPreferences: {
              ...overridePrefs,
              backgroundThrottling: !wantsBackground
            }
          }
        }
      })
    }
  )
}
