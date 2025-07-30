import {
  IPFS_PREFIX,
  IPNS_PREFIX,
  HYPER_PREFIX,
  WEB3_PREFIX,
  handleURL,
} from "./utils.js";
const { ipcRenderer } = require("electron");

const DEFAULT_PAGE = "peersky://home";
let webviewContainer = null; // Will be set dynamically for tabs
const nav = document.querySelector("#navbox");
const findMenu = document.querySelector("#find");
const pageTitle = document.querySelector("title");

// Get initial URL from search params
const searchParams = new URL(window.location.href).searchParams;
const toNavigate = searchParams.has("url") ? searchParams.get("url") : DEFAULT_PAGE;

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

  // Listen for theme changes from main process
  ipcRenderer.on('theme-changed', (event, newTheme) => {
    document.documentElement.setAttribute('data-theme', newTheme);
  });

  const titleBar = document.querySelector("#titlebar");
  const tabBar = document.querySelector("#tabbar") || new TabBar();
  
  // This is our webview container where all tab webviews will live
  webviewContainer = document.createElement("div");
  webviewContainer.id = "webview-container";
  webviewContainer.className = "webview-container";
  document.body.appendChild(webviewContainer);
  
  // Connect the tabBar with the webviewContainer
  tabBar.connectWebviewContainer(webviewContainer);
  
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
  
  if (titleBar && tabBar) {
    titleBar.connectTabBar(tabBar);
  }

  if (webviewContainer && nav && tabBar) {
    // Setup tab event handlers
    tabBar.addEventListener("tab-selected", (e) => {
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
    });
    
    tabBar.addEventListener("tab-navigated", (e) => {
      const { tabId, url } = e.detail;
      
      if (tabId === tabBar.activeTabId) {
        // Hide peersky://home URL, show all others
        if (url === "peersky://home") {
          nav.setStyledUrl("");
        } else {
          nav.setStyledUrl(url);
        }
        
        setTimeout(() => updateNavigationButtons(tabBar), 100);
      }
      
      ipcRenderer.send("webview-did-navigate", url);
    });
    
    // Handle tab loading state changes
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
    if (toNavigate !== DEFAULT_PAGE) {
      const firstTab = tabBar.tabs[0];
      if (firstTab) {
        tabBar.updateTab(firstTab.id, { url: toNavigate });
      }
    }
    
    // Update URL input with active tab's URL
    const activeTab = tabBar.getActiveTab();
    if (activeTab && nav.querySelector("#url")) {
      nav.querySelector("#url").value = activeTab.url;
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
      const url = webviewContainer.getURL();
      if (!url || url.trim() === '') {
        console.error("No current URL available, cannot toggle bookmark.");
        return;
      }
      const bookmarks = await ipcRenderer.invoke("get-bookmarks");
      const existingBookmark = bookmarks.find((b) => b.url === url);

      if (existingBookmark) {
        ipcRenderer.invoke("delete-bookmark", { url });
      } else {
        const title = pageTitle.innerText
          .replace(" - Peersky Browser", "")
          .trim();

        const parsedUrl = new URL(url);
        const favicon = await getFavicon(parsedUrl);
        ipcRenderer.send("add-bookmark", { url, title, favicon });
      }

      setTimeout(() => updateBookmarkIcon(url), 100);
    });

    async function getFavicon(parsedUrl) {
      const defaultFavicon = "peersky://static/assets/svg/globe.svg";

      if (parsedUrl.protocol === "peersky:") {
        return "peersky://static/assets/favicon.ico";
      }

      const iconLink = document.querySelector(
        'link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'
      );

      if (iconLink?.href) {
        try {
          const iconUrl = new URL(
            iconLink.getAttribute("href"),
            parsedUrl.origin
          ).href;
          console.log("Using favicon from link tag:", iconUrl);
          const response = await fetch(iconUrl);

          if (
            response.ok &&
            response.headers.get("content-type")?.startsWith("image")
          ) {
            return iconUrl;
          }
        } catch (error) {
          console.warn("Error fetching favicon from link tag:", error);
        }
      }

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

    async function updateBookmarkIcon(currentUrl) {
      if (!currentUrl) return;
      try {
        const bookmarks = await ipcRenderer.invoke("get-bookmarks");
        const isBookmarked = bookmarks.some(
          (bookmark) => bookmark.url === currentUrl
        );
        nav.setBookmarkState(isBookmarked);
      } catch (error) {
        console.error("Failed to update bookmark icon:", error);
      }
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
        updateBookmarkIcon(webviewContainer.getURL());
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
