import {
  IPFS_PREFIX,
  IPNS_PREFIX,
  HYPER_PREFIX,
  WEB3_PREFIX,
  handleURL,
} from "./utils.js";
const { ipcRenderer } = require("electron");

const DEFAULT_PAGE = "peersky://home";
const webviewContainer = document.querySelector("#webview-container");
const nav = document.querySelector("#navbox");
const findMenu = document.querySelector("#find");
const pageTitle = document.querySelector("title");

// Get initial URL from search params
const searchParams = new URL(window.location.href).searchParams;
const toNavigate = searchParams.has("url") ? searchParams.get("url") : DEFAULT_PAGE;

document.addEventListener("DOMContentLoaded", () => {
  const titleBar = document.querySelector("#titlebar");
  const tabBar = document.querySelector("#tabbar") || new TabBar();
  
  // This is our webview container where all tab webviews will live
  const webviewContainer = document.createElement("div");
  webviewContainer.id = "webview-container";
  webviewContainer.className = "webview-container";
  document.body.appendChild(webviewContainer);
  
  // Connect the tabBar with the webviewContainer
  tabBar.connectWebviewContainer(webviewContainer);
  
  if (titleBar && tabBar) {
    titleBar.connectTabBar(tabBar);
  }

  if (webviewContainer && nav && tabBar) {
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
    nav.addEventListener("home", () => {
      tabBar.navigateActiveTab("peersky://home");
      nav.querySelector("#url").value = "peersky://home";
    });
    
    nav.addEventListener("navigate", ({ detail }) => {
      const { url } = detail;
      const processedUrl = handleURL(url);
      tabBar.navigateActiveTab(processedUrl);
    });
    
    nav.addEventListener("new-window", () => {
      ipcRenderer.send("new-window");
    });

    // URL input handling
    const urlInput = nav.querySelector("#url");
    if (urlInput) {
      urlInput.addEventListener("keypress", async (e) => {
        if (e.key === "Enter") {
          const rawURL = urlInput.value.trim();
          const url = handleURL(rawURL);
          tabBar.navigateActiveTab(url);
        }
      });
    }

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