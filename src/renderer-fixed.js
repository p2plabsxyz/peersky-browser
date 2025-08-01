import {
  IPFS_PREFIX,
  IPNS_PREFIX,
  HYPER_PREFIX,
  WEB3_PREFIX,
  handleURL,
} from "./utils.js";
const { ipcRenderer } = require("electron");

const DEFAULT_PAGE = "peersky://home";
const webviewContainer = document.querySelector("#webview");
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
    console.log('Main window: Theme changed to:', newTheme);
    reloadThemeCSS();
    
    // Apply theme data attribute for unified theme system
    document.documentElement.setAttribute('data-theme', newTheme);
    
    // Dispatch event for nav-box component
    window.dispatchEvent(new CustomEvent('theme-reload', { 
      detail: { theme: newTheme } 
    }));
    
    if (tabBar && typeof tabBar.refreshGroupStyles === 'function') {
      tabBar.refreshGroupStyles();
    }
  });

  // Check if we have tab functionality
  const titleBar = document.querySelector("#titlebar");
  const tabBar = document.querySelector("#tabbar");
  
  if (tabBar) {
    // Tab-based browser setup
    setupTabBrowser(titleBar, tabBar, webviewContainer, nav);
  } else if (webviewContainer && nav) {
    // Single webview browser setup (main branch approach)
    setupSingleWebviewBrowser(webviewContainer, nav);
  } else {
    console.error("Neither tab bar nor webview container found");
  }
});

function setupTabBrowser(titleBar, tabBar, webviewContainer, nav) {
  // Create webview container for tabs
  const tabWebviewContainer = document.createElement("div");
  tabWebviewContainer.id = "webview-container";
  tabWebviewContainer.className = "webview-container";
  document.body.appendChild(tabWebviewContainer);
  
  // Connect the tabBar with the webviewContainer
  tabBar.connectWebviewContainer(tabWebviewContainer);
  
  if (titleBar) {
    titleBar.connectTabBar(tabBar);
  }
  
  // Tab IPC handlers
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
  
  // Setup tab event handlers
  tabBar.addEventListener("tab-selected", (e) => {
    const { tabId, url } = e.detail;
    nav.querySelector("#url").value = url;
    
    const tab = tabBar.tabs.find(t => t.id === tabId);
    if (tab) {
      pageTitle.innerText = `${tab.title} - Peersky Browser`;
    }
    
    updateNavigationButtons(tabBar);
  });
  
  tabBar.addEventListener("tab-navigated", (e) => {
    const { tabId, url } = e.detail;
    
    if (tabId === tabBar.activeTabId) {
      nav.querySelector("#url").value = url;
      setTimeout(() => updateNavigationButtons(tabBar), 100);
    }
    
    ipcRenderer.send("webview-did-navigate", url);
  });
  
  // Tab loading state changes
  tabBar.addEventListener("tab-loading", (e) => {
    const { tabId, isLoading } = e.detail;
    
    if (tabId === tabBar.activeTabId) {
      nav.setLoading(isLoading);
      
      if (!isLoading) {
        setTimeout(() => updateNavigationButtons(tabBar), 100);
      }
    }
  });

  tabBar.addEventListener("navigation-state-changed", () => {
    updateNavigationButtons(tabBar);
  });
  
  // Navigation Button Event Listeners for tabs
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

  // Keyboard shortcut for new tab
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

function setupSingleWebviewBrowser(webviewContainer, nav) {
  // Load initial URL
  webviewContainer.loadURL(toNavigate);
  focusURLInput();

  // Navigation Button Event Listeners for single webview
  nav.addEventListener("back", () => webviewContainer.goBack());
  nav.addEventListener("forward", () => webviewContainer.goForward());
  nav.addEventListener("reload", () => webviewContainer.reload());
  nav.addEventListener("stop", () => webviewContainer.stop());
  nav.addEventListener("home", () => {
    webviewContainer.loadURL("peersky://home");
    nav.querySelector("#url").value = "peersky://home";
  });
  
  nav.addEventListener("navigate", async ({ detail }) => {
    const { url } = detail;
    await navigateTo(url);
  });

  // Handle webview loading events
  if (webviewContainer.webviewElement) {
    webviewContainer.webviewElement.addEventListener("did-start-loading", () => {
      nav.setLoading(true);
    });

    webviewContainer.webviewElement.addEventListener("did-stop-loading", () => {
      nav.setLoading(false);
      updateNavigationButtons();
    });

    webviewContainer.webviewElement.addEventListener("did-fail-load", () => {
      nav.setLoading(false);
      updateNavigationButtons();
    });

    webviewContainer.webviewElement.addEventListener("did-navigate", () => {
      updateNavigationButtons();
    });
  }

  // Update URL input and send navigation event
  webviewContainer.addEventListener("did-navigate", (e) => {
    const urlInput = nav.querySelector("#url");
    if (urlInput) {
      urlInput.value = e.detail.url;
    }
    ipcRenderer.send("webview-did-navigate", e.detail.url);
  });

  // Update page title
  webviewContainer.addEventListener("page-title-updated", (e) => {
    pageTitle.innerText = e.detail.title ? `${e.detail.title} - Peersky Browser` : "Peersky Browser";
  });

  // Initial update of navigation buttons
  updateNavigationButtons();
}

// Common event handlers
function setupCommonEventHandlers() {
  const urlInput = nav.querySelector("#url");
  
  // URL input handler
  if (urlInput) {
    urlInput.addEventListener("keypress", async (e) => {
      if (e.key === "Enter") {
        const rawURL = urlInput.value.trim();
        await navigateTo(rawURL);
      }
    });
  }

  // New window handler
  nav.addEventListener("new-window", () => {
    ipcRenderer.send("new-window");
  });

  // Find menu handlers
  if (findMenu) {
    findMenu.addEventListener("next", ({ detail }) => {
      const tabBar = document.querySelector("#tabbar");
      if (tabBar) {
        const webview = tabBar.getActiveWebview();
        if (webview) {
          webview.executeJavaScript(`window.find("${detail.value}", ${detail.findNext})`);
        }
      } else if (webviewContainer) {
        webviewContainer.executeJavaScript(`window.find("${detail.value}", ${detail.findNext})`);
      }
    });

    findMenu.addEventListener("previous", ({ detail }) => {
      const tabBar = document.querySelector("#tabbar");
      if (tabBar) {
        const webview = tabBar.getActiveWebview();
        if (webview) {
          webview.executeJavaScript(`window.find("${detail.value}", ${detail.findNext}, true)`);
        }
      } else if (webviewContainer) {
        webviewContainer.executeJavaScript(`window.find("${detail.value}", ${detail.findNext}, true)`);
      }
    });

    findMenu.addEventListener("hide", () => {
      const tabBar = document.querySelector("#tabbar");
      if (tabBar) {
        const webview = tabBar.getActiveWebview();
        if (webview) {
          webview.focus();
        }
      } else if (webviewContainer) {
        webviewContainer.focus();
      }
    });
  }

  // Find menu keyboard shortcut
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
}

// Call common event handlers setup
setTimeout(setupCommonEventHandlers, 100);

// Navigation functions
async function navigateTo(url) {
  try {
    const processedURL = await handleURL(url);
    
    const tabBar = document.querySelector("#tabbar");
    if (tabBar && typeof tabBar.navigateActiveTab === 'function') {
      // Use tab-based navigation
      tabBar.navigateActiveTab(processedURL);
    } else if (webviewContainer && typeof webviewContainer.loadURL === 'function') {
      // Use single webview navigation
      webviewContainer.loadURL(processedURL);
    } else {
      console.error('No navigation method available');
    }
  } catch (error) {
    console.error('Error processing URL:', error);
    // Final fallback
    if (webviewContainer && typeof webviewContainer.loadURL === 'function') {
      webviewContainer.loadURL(url);
    }
  }
}

function updateNavigationButtons(tabBar) {
  if (!nav) return;
  
  try {
    if (tabBar) {
      // Tab-based navigation buttons
      const webview = tabBar.getActiveWebview();
      if (webview) {
        const canGoBack = webview.canGoBack();
        const canGoForward = webview.canGoForward();
        nav.setNavigationButtons(canGoBack, canGoForward);
      } else {
        nav.setNavigationButtons(false, false);
      }
    } else if (webviewContainer && webviewContainer.webviewElement) {
      // Single webview navigation buttons
      const canGoBack = webviewContainer.webviewElement.canGoBack();
      const canGoForward = webviewContainer.webviewElement.canGoForward();
      nav.setNavigationButtons(canGoBack, canGoForward);
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
