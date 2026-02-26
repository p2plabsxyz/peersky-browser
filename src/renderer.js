import {
  IPFS_PREFIX,
  IPNS_PREFIX,
  HYPER_PREFIX,
  WEB3_PREFIX,
  handleURL,
} from "./utils.js";

const chromiumNetErrors = require('chromium-net-errors');

const { ipcRenderer } = require("electron");

const DEFAULT_PAGE = "peersky://home";
let webviewContainer = null; // Will be set dynamically for tabs
let tabBar; // Holds current tab bar component
const nav = document.querySelector("#navbox");
const findMenu = document.querySelector("#find");
const pageTitle = document.querySelector("title");

// Listen for IPC messages from main process to add tabs
ipcRenderer.on('add-tab-from-main', (event, url) => {
  if (tabBar && typeof tabBar.addTab === 'function') {
    tabBar.addTab(url);
  }
});

// Get initial URL from search params
const searchParams = new URL(window.location.href).searchParams;
const toNavigate = searchParams.has("url") ? searchParams.get("url") : DEFAULT_PAGE;

async function updateBookmarkIcon(currentUrl) {
  if (!currentUrl) return;
  try {
    const bookmarks = await ipcRenderer.invoke("get-bookmarks");
    const isBookmarked = bookmarks.some(
      (bookmark) => bookmark.url === currentUrl
    );
    nav?.setBookmarkState?.(isBookmarked);
  } catch (error) {
    console.error("Failed to update bookmark icon:", error);
  }
}

function setupWebviewErrorHandling(webview) {
  if (!webview || webview._errorHandlerInitialized) return;
  webview._errorHandlerInitialized = true;

  const state = {
    isShowingError: false,
    abortTimeout: null,
    lastFailedUrl: null
  };

  const handleFailLoad = (event) => {

    const { errorCode, errorDescription, validatedURL, isMainFrame } = event;
    
    if (!isMainFrame) return;
    
    // Prevent error page loop
    if (validatedURL?.includes('error.html')) {
      state.isShowingError = false;
      return;
    }
    
    if (state.isShowingError && state.lastFailedUrl === validatedURL) return;

    if (state.abortTimeout) {
      clearTimeout(state.abortTimeout);
      state.abortTimeout = null;
    }

    // Handle ERR_ABORTED - wait for real error
    if (errorCode === -3) {
      state.lastFailedUrl = validatedURL;
      state.abortTimeout = setTimeout(() => {
        if (!state.isShowingError) {
          showErrorPage({
            code: '-3',
            name: 'Request Aborted',
            msg: 'The connection was aborted',
            url: validatedURL || ''
          });
        }
      }, 300);
      return;
    }

    // Get Chromium error details
    let chromiumError = chromiumNetErrors.getErrorByCode(errorCode);
    showErrorPage({
      code: String(errorCode),
      name: chromiumError.name,
      msg: errorDescription,
      url: validatedURL,
    });
  };

  function showErrorPage(errorInfo) {
    if (state.isShowingError) return;

    state.isShowingError = true;
    state.lastFailedUrl = errorInfo.url;

    const params = new URLSearchParams({
      code: errorInfo.code,
      name: errorInfo.name,
      msg: errorInfo.msg,
      url: errorInfo.url,
      t: Date.now().toString()
    });

    const errorURL = `peersky://error.html?${params}`;

    try {
      webview.src = errorURL;
      setTimeout(() => { state.isShowingError = false; }, 1000);
    } catch (e) {
      state.isShowingError = false;
    }
  }

  const handleNavigate = (event) => {
    const url = event.url || '';
    if (!url.includes('error.html')) {
      state.isShowingError = false;
      state.lastFailedUrl = null;
      if (state.abortTimeout) {
        clearTimeout(state.abortTimeout);
        state.abortTimeout = null;
      }
    }
  };

  const handleStartLoading = () => {
    const currentSrc = webview.src;
    if (currentSrc && !currentSrc.includes('error.html') &&
        currentSrc !== state.lastFailedUrl) {
      state.isShowingError = false;
      if (state.abortTimeout) {
        clearTimeout(state.abortTimeout);
        state.abortTimeout = null;
      }
    }
  };

  webview.addEventListener('did-fail-load', handleFailLoad);
  webview.addEventListener('did-navigate', handleNavigate);
  webview.addEventListener('did-start-loading', handleStartLoading);
}


document.addEventListener("DOMContentLoaded", async () => {
  // Initialize theme on page load
  try {
    const currentTheme = await ipcRenderer.invoke('settings-get', 'theme');
    if (currentTheme) {
      document.documentElement.setAttribute('data-theme', currentTheme);
      
      // Enable transitions after initial theme is loaded
      setTimeout(() => {
        const urlDisplay = document.querySelector('#url');
        if (urlDisplay) {
          urlDisplay.classList.remove('transition-disabled');
        }
      }, 100);
    }
  } catch (error) {
    console.error('Error loading theme:', error);
  }
  
  ipcRenderer.on('group-properties-updated', (_, groupId, properties) => {
    console.log('Received group properties update:', groupId, properties);
    if (tabBar && typeof tabBar.updateGroupPropertiesFromExternal === 'function') {
      tabBar.updateGroupPropertiesFromExternal(groupId, properties);
    }
  });

  ipcRenderer.on('check-has-tab', (event, tabId) => {
    let hasTab = false;
    if (tabBar && typeof tabBar.hasTab === 'function') {
      hasTab = tabBar.hasTab(tabId);
    }
    event.returnValue = hasTab;
  });
  
  // Listen for theme changes from main process
  ipcRenderer.on('theme-changed', (event, newTheme) => {
    document.documentElement.setAttribute('data-theme', newTheme);

    reloadThemeCSS();

    // Refresh tab bar styles if available
    if (tabBar && typeof tabBar.refreshGroupStyles === 'function') {
      tabBar.refreshGroupStyles();
    }

    // Notify other components
    window.dispatchEvent(new CustomEvent('theme-reload', {
      detail: { theme: newTheme }
    }));
  });

  const titleBar = document.querySelector("#titlebar");
  const verticalTabsEnabled = await ipcRenderer.invoke('settings-get', 'verticalTabs');
  if (verticalTabsEnabled) {
    const { default: VerticalTabs } = await import('./pages/vertical-tabs.js');
    tabBar = document.querySelector('#tabbar') || new VerticalTabs();
    const keepExpanded = await ipcRenderer.invoke('settings-get', 'keepTabsExpanded');
    if (keepExpanded) {
      tabBar.updateKeepExpandedState(keepExpanded);
    }
    // IMPORTANT: append to body before creating / restoring tabs
    if (!tabBar.isConnected) {
      document.body.appendChild(tabBar);
    }
  } else {
    tabBar = document.querySelector('#tabbar') || new TabBar();
    if (titleBar && !tabBar.isConnected) {
      titleBar.connectTabBar(tabBar);
    } else if (!tabBar.isConnected) {
      document.body.appendChild(tabBar);
    }
  }

  // Create webview container AFTER tabBar is in DOM
  webviewContainer = document.createElement("div");
  webviewContainer.id = "webview-container";
  webviewContainer.className = "webview-container";
  document.body.appendChild(webviewContainer);
  
  // Mutation observer to catch webviews
  const webviewObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.tagName === 'WEBVIEW') {
          setTimeout(() => setupWebviewErrorHandling(node), 0);
        }
      });
    });
  });
  
  webviewObserver.observe(webviewContainer, { 
    childList: true, 
    subtree: true 
  });
  
  await tabBar.connectWebviewContainer(webviewContainer);
  
  // Setup error handling for all webviews
  tabBar.addEventListener("tab-created", (e) => {
    if (e.detail?.webview) {
      setupWebviewErrorHandling(e.detail.webview);
    }
  });
  
  if (tabBar.webviews?.size) {
    tabBar.webviews.forEach(wv => setupWebviewErrorHandling(wv));
  }
  
  ipcRenderer.on("remove-all-tempIcon", () => {
    const navBox = document.querySelector("nav-box");
    if (navBox && typeof navBox.renderBrowserActions === "function") {
      navBox.removeAllTempIcon();
    }
  });

  ipcRenderer.on("refresh-browser-actions", () => {
    const navBox = document.querySelector("nav-box");
    if (navBox && typeof navBox.renderBrowserActions === "function") {
      navBox.renderBrowserActions();
    }
  });

  ipcRenderer.on("create-new-tab", async (_event, url) => {
    if (tabBar && typeof tabBar.addTab === "function") {
      tabBar.addTab(url);
    } else {
      navigateTo(url);
    }
  });

  ipcRenderer.on('close-tab', (_, id) => {
    try {
      if (tabBar && typeof tabBar.closeTab === 'function') {
        tabBar.closeTab(id);
      }
    } catch (e) {
      console.error('Error closing tab via IPC:', e);
    }
  });

  ipcRenderer.on('activate-tab', (_, id) => {
    try {
      if (tabBar && typeof tabBar.selectTab === 'function') {
        tabBar.selectTab(id);
      }
    } catch (e) {
      console.error('Error activating tab via IPC:', e);
    }
  });
  ipcRenderer.on('group-action', (_, data) => {
    try {
      if (tabBar && typeof tabBar.handleGroupContextMenuAction === 'function') {
        const { action, groupId } = data || {};
        tabBar.handleGroupContextMenuAction(action, groupId);
      }
    } catch (e) {
      console.error('Error handling group action via IPC:', e);
    }
  });
  ipcRenderer.on('vertical-tabs-changed', async (_, enabled) => {
    const oldBar = tabBar;
    
    // Clean up old webviews before creating new tab bar
    if (oldBar && oldBar.webviews) {
      oldBar.webviews.forEach((webview) => {
        if (webview && webview.parentNode) {
          webview.remove();
        }
      });
      oldBar.webviews.clear();
    }
    
    // Clear existing webviews from container
    if (webviewContainer) {
      while (webviewContainer.firstChild) {
        webviewContainer.removeChild(webviewContainer.firstChild);
      }
    }
    
    // Remove old tab bar from DOM
    if (oldBar && oldBar.parentElement) {
      oldBar.remove();
    }
    
    if (enabled) {
      const { default: VerticalTabs } = await import('./pages/vertical-tabs.js');
      tabBar = new VerticalTabs();
      const keepExpanded = await ipcRenderer.invoke('settings-get', 'keepTabsExpanded');
      if (keepExpanded) {
        tabBar.updateKeepExpandedState(true);
      }
      document.body.appendChild(tabBar);
    } else {
      if (process.platform === 'darwin' && titleBar && typeof titleBar.toggleDarwinCollapse === 'function') {
        titleBar.toggleDarwinCollapse(false);
      }
      tabBar = new TabBar();
      if (titleBar) {
        titleBar.connectTabBar(tabBar);
      } else {
        document.body.appendChild(tabBar);
      }
    }
    
    // Connect webview container and wait for tab restoration
    await tabBar.connectWebviewContainer(webviewContainer);
    
    // RE-ATTACH event listeners for the new tab bar
    if (webviewContainer && nav && tabBar) {
      // Remove old event listeners first
      tabBar.removeEventListener("tab-selected", handleTabSelected);
      tabBar.removeEventListener("tab-navigated", handleTabNavigated);
      
      // Add fresh event listeners ( to prevent same url states in all tabs)
      tabBar.addEventListener("tab-selected", handleTabSelected);
      tabBar.addEventListener("tab-navigated", handleTabNavigated);
    }
    
    // Force update URL input field after restoration is complete
    setTimeout(() => {
      const activeTab = tabBar.getActiveTab();
      const urlInput = nav.querySelector("#url");
      if (activeTab && urlInput) {
        if (activeTab.url === "peersky://home") {
          urlInput.value = "";
        } else {
          urlInput.value = activeTab.url;
        }
        
        // Also update the nav display
        nav.setStyledUrl(activeTab.url === "peersky://home" ? "" : activeTab.url);
      }
    }, 300);
    
    // Force a layout update
    setTimeout(() => {
      if (tabBar.style) {
        tabBar.style.display = 'none';
        tabBar.offsetHeight; // Trigger reflow
        tabBar.style.display = '';
      }
    }, 100);
  });
  
  function handleTabSelected(e) {
    const { tabId, url } = e.detail;
    
    // Hide peersky://home URL, show all others
    if (url === "peersky://home") {
      nav.setStyledUrl("");
    } else {
      nav.setStyledUrl(url);
    }
    
    const tab = tabBar.tabs.find(t => t.id === tabId);
    if (tab) {
      pageTitle.innerText = `${tab.title} - Peersky Browser`;
    }
    
    updateNavigationButtons(tabBar);
    
    // Update bookmark icon for the selected tab
    if (url) {
      updateBookmarkIcon(url);
    }
  }
  
  function handleTabNavigated(e) {
    const { tabId, url } = e.detail;
    
    if (tabId === tabBar.activeTabId) {
      // Hide peersky://home URL, show all others
      if (url === "peersky://home") {
        nav.setStyledUrl("");
      } else {
        nav.setStyledUrl(url);
      }
      
      setTimeout(() => updateNavigationButtons(tabBar), 100);
      
      // Update bookmark icon when active tab navigates
      if (url) {
        updateBookmarkIcon(url);
      }
    }
    
    ipcRenderer.send("webview-did-navigate", url);
  }
  ipcRenderer.on('keep-tabs-expanded-changed', async (_, keepExpanded) => {
    const verticalTabsElement = document.querySelector('.tabbar.vertical-tabs');
    if (verticalTabsElement && typeof verticalTabsElement.updateKeepExpandedState === 'function') {
      verticalTabsElement.updateKeepExpandedState(keepExpanded);
    } else if (verticalTabsElement) {
      // Fallback for basic class toggle
      if (keepExpanded) {
        verticalTabsElement.classList.add('keep-expanded');
      } else {
        verticalTabsElement.classList.remove('keep-expanded');
      }
    }
  });

  ipcRenderer.on('hide-tab-components', () => {
    if (tabBar) {
      tabBar.style.display = 'none';
    }
  });

  ipcRenderer.on('load-tab-components', () => {
    if (tabBar) {
      tabBar.style.display = '';
    }
  });
  
  if (!verticalTabsEnabled && titleBar && tabBar.parentElement !== titleBar) {
    titleBar.connectTabBar(tabBar);
  }

  if (webviewContainer && nav && tabBar) {
    // Setup tab event handlers
    tabBar.addEventListener("tab-selected", handleTabSelected);
    tabBar.addEventListener("tab-navigated", handleTabNavigated);
    
    tabBar.addEventListener("tab-loading", (e) => {
      const { tabId, isLoading } = e.detail;
      
      if (tabId === tabBar.activeTabId) {
        nav.setLoading(isLoading);
        
        if (!isLoading) {
          setTimeout(() => updateNavigationButtons(tabBar), 100);
        }
      }
    });

    // Add with other event listeners
    tabBar.addEventListener("navigation-state-changed", () => {
      updateNavigationButtons(tabBar);
    });
    
    // Check if we need to navigate to a specific URL initially

    // Setup error handling
    tabBar.addEventListener("webview-created", (e) => {
      if (e.detail.webview) setupWebviewErrorHandling(e.detail.webview);
    });

    setTimeout(() => {
      tabBar.webviews?.forEach((webview) => setupWebviewErrorHandling(webview));
    }, 500);

    if (toNavigate !== DEFAULT_PAGE) {
      const firstTab = tabBar.tabs[0];
      if (firstTab) {
        tabBar.updateTab(firstTab.id, { url: toNavigate });
      }
    }
    
    // Update URL input with active tab's URL and bookmark icon
    const activeTab = tabBar.getActiveTab();
    if (activeTab && nav.querySelector("#url")) {
      nav.querySelector("#url").value = activeTab.url;
      // Update bookmark icon for initial tab
      if (activeTab.url) {
        updateBookmarkIcon(activeTab.url);
      }
    }

    // Navigation Button Event Listeners
    nav.addEventListener("back", () => tabBar.goBackActiveTab());
    nav.addEventListener("forward", () => tabBar.goForwardActiveTab());
    nav.addEventListener("reload", () => tabBar.reloadActiveTab());
    nav.addEventListener("stop", () => tabBar.stopActiveTab());
    nav.addEventListener("home", async () => {
      await navigateTo("peersky://home");
      nav.querySelector("#url").value = "peersky://home";
    });
    
    nav.addEventListener("navigate", async ({ detail }) => {
      const { url } = detail;
      await navigateTo(url);
    });
    
    nav.addEventListener("new-window", () => {
      ipcRenderer.send("new-window");
    });
    nav.addEventListener("toggle-bookmark", async () => {
      const activeTab = tabBar.getActiveTab();
      if (!activeTab || !activeTab.url || activeTab.url.trim() === '') {
        console.error("No active tab or URL available, cannot toggle bookmark.");
        return;
      }
      
      const url = activeTab.url;
      const bookmarks = await ipcRenderer.invoke("get-bookmarks");
      const existingBookmark = bookmarks.find((b) => b.url === url);

      if (existingBookmark) {
        ipcRenderer.invoke("delete-bookmark", { url });
      } else {
        const title = activeTab.title || pageTitle.innerText
          .replace(" - Peersky Browser", "")
          .trim();

        const parsedUrl = new URL(url);
        const favicon = await getFavicon(parsedUrl, activeTab);
        ipcRenderer.send("add-bookmark", { url, title, favicon });
      }

      setTimeout(() => updateBookmarkIcon(url), 100);
    });

    async function getFavicon(parsedUrl, activeTab) {
      const defaultFavicon = "peersky://static/assets/svg/globe.svg";

      if (parsedUrl.protocol === "peersky:") {
        return "peersky://static/assets/favicon.ico";
      }

      // Try to get favicon from the active tab's webview
      const activeWebview = tabBar.getActiveWebview();
      if (activeWebview) {
        try {
          const faviconFromWebview = await activeWebview.executeJavaScript(`
            (() => {
              const iconLink = document.querySelector(
                'link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'
              );
              return iconLink ? iconLink.href : null;
            })()
          `);
          
          if (faviconFromWebview) {
            try {
              const iconUrl = new URL(faviconFromWebview, parsedUrl.origin).href;
              console.log("Using favicon from webview:", iconUrl);
              const response = await fetch(iconUrl);
              
              if (
                response.ok &&
                response.headers.get("content-type")?.startsWith("image")
              ) {
                return iconUrl;
              }
            } catch (error) {
              console.warn("Error fetching favicon from webview:", error);
            }
          }
        } catch (error) {
          console.warn("Error executing script in webview for favicon:", error);
        }
      }

      // Fallback to standard favicon.ico
      try {
        const fallbackUrl = new URL("/favicon.ico", parsedUrl.origin).href;
        const response = await fetch(fallbackUrl);

        if (
          response.ok &&
          response.headers.get("content-type")?.startsWith("image")
        ) {
          return fallbackUrl;
        }
      } catch (error) {
        console.warn("Error fetching fallback favicon:", error);
      }

      return defaultFavicon;
    }

    // Handle webview loading events to toggle refresh/stop button
    if (webviewContainer.webviewElement) {
      webviewContainer.webviewElement.addEventListener(
        "did-start-loading",
        () => {
          nav.setLoading(true);
        }
      );

      webviewContainer.webviewElement.addEventListener(
        "did-stop-loading",
        () => {
          nav.setLoading(false);
          updateNavigationButtons();
        }
      );

      webviewContainer.webviewElement.addEventListener("did-fail-load", () => {
        nav.setLoading(false);
        updateNavigationButtons();
        const activeTab = tabBar.getActiveTab();
        if (activeTab && activeTab.url) {
          updateBookmarkIcon(activeTab.url);
        }
      });

      webviewContainer.webviewElement.addEventListener("did-navigate", () => {
        updateNavigationButtons();
      });
    } else {
      console.error("webviewElement not found in webviewContainer");
    }

    const urlInput = nav.querySelector("#url");
    if (urlInput) {
      urlInput.addEventListener("keypress", async (e) => {
        if (e.key === "Enter") {
          const rawURL = urlInput.value.trim();
          await navigateTo(rawURL);
        }
      });
    }

    // Update URL display and send navigation event
    webviewContainer.addEventListener("did-navigate", (e) => {
      if (nav) {
        // Hide peersky://home URL, show all others
        if (e.detail.url === "peersky://home") {
          nav.setStyledUrl("");
        } else {
          nav.setStyledUrl(e.detail.url);
        }
      }
      ipcRenderer.send("webview-did-navigate", e.detail.url);
      updateBookmarkIcon(e.detail.url);
    });

    // Update page title
    webviewContainer.addEventListener("page-title-updated", (e) => {
      pageTitle.innerText = e.detail.title
        ? `${e.detail.title} - Peersky Browser`
        : "Peersky Browser";
    });

    // Find Menu Event Listeners
    findMenu.addEventListener("next", ({ detail }) => {
      const webview = tabBar.getActiveWebview();
      if (webview) {
        webview.executeJavaScript(
          `window.find("${detail.value}", ${detail.findNext})`
        );
      }
    });

    findMenu.addEventListener("previous", ({ detail }) => {
      const webview = tabBar.getActiveWebview();
      if (webview) {
        webview.executeJavaScript(
          `window.find("${detail.value}", ${detail.findNext}, true)`
        );
      }
    });

    findMenu.addEventListener("hide", () => {
      const webview = tabBar.getActiveWebview();
      if (webview) {
        webview.focus();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "t" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        try {
          if (tabBar && typeof tabBar.addTab === 'function') {
            tabBar.addTab();
          }
        } catch (error) {
          console.error('Error adding tab:', error);
        }
      }
    });

    // Initial update of navigation buttons
    updateNavigationButtons(tabBar);
  }
});

async function navigateTo(url) {
  try {
    // Process URL through handleURL to ensure proper formatting
    const processedURL = await handleURL(url);
    
    // Check if we have tab functionality
    const tabBar = document.querySelector("#tabbar");
    if (tabBar && typeof tabBar.navigateActiveTab === 'function') {
      // Use tab-based navigation
      tabBar.navigateActiveTab(processedURL);
    } else if (webviewContainer && typeof webviewContainer.loadURL === 'function') {
      // Fallback to direct webview navigation
      webviewContainer.loadURL(processedURL);
    } else {
      console.error('No navigation method available');
    }
  } catch (error) {
    console.error('Error processing URL:', error);
    // Final fallback
    const tabBar = document.querySelector("#tabbar");
    if (tabBar && typeof tabBar.navigateActiveTab === 'function') {
      tabBar.navigateActiveTab(url);
    } else if (webviewContainer && typeof webviewContainer.loadURL === 'function') {
      webviewContainer.loadURL(url);
    }
  }
}

function updateNavigationButtons(tabBar) {
  if (!nav) return;
  
  try {
    const webview = tabBar.getActiveWebview();
    if (webview) {
      const canGoBack = webview.canGoBack();
      const canGoForward = webview.canGoForward();
      nav.setNavigationButtons(canGoBack, canGoForward);
    } else {
      nav.setNavigationButtons(false, false);
    }
  } catch (error) {
    console.error('Error updating navigation buttons:', error);
    nav.setNavigationButtons(false, false);
  }
}

function focusURLInput() {
  try {
    const urlInput = nav.querySelector("#url");
    if (urlInput) {
      urlInput.focus();
    }
  } catch (error) {
    console.error('Error focusing URL input:', error);
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "f" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    try {
      if (findMenu && typeof findMenu.toggle === 'function') {
        findMenu.toggle();
      }
    } catch (error) {
      console.error('Error toggling find menu:', error);
    }
  }
});

function reloadThemeCSS() {
  // Reload CSS imports for theme files
  const styleElements = document.querySelectorAll('style');
  styleElements.forEach(style => {
    const text = style.textContent || style.innerText;
    if (text && text.includes('browser://theme/')) {
      const newStyle = document.createElement('style');
      newStyle.textContent = text;
      style.parentNode.replaceChild(newStyle, style);
    }
  });
  
  // Reload CSS links with cache busting
  const linkElements = document.querySelectorAll('link[href*="browser://theme/"]');
  linkElements.forEach(link => {
    const href = link.href.split('?')[0];
    link.href = `${href}?t=${Date.now()}`;
  });
  
  console.log('Main window: Theme CSS reloaded');
}
