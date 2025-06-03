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
const tabBar = document.querySelector("#tabbar");

// Map to track which tab has which webview content
const tabContents = new Map();

const searchParams = new URL(window.location.href).searchParams;
const toNavigate = searchParams.has("url")
  ? searchParams.get("url")
  : DEFAULT_PAGE;

document.addEventListener("DOMContentLoaded", () => {
  const titleBar = document.querySelector("#titlebar");
  const tabBar = document.querySelector("#tabbar") || new TabBar();
  
  if (titleBar && tabBar) {
    titleBar.connectTabBar(tabBar);
  }

  if (webviewContainer && nav && tabBar) {
    tabBar.addEventListener("tab-selected", (e) => {
      const { tabId, url } = e.detail;
      
      // Store current webview state for active tab if switching tabs
      const activeTab = tabBar.getActiveTab();
      if (activeTab) {
        saveTabState(activeTab.id);
      }
      
      // Load the selected tab's URL
      webviewContainer.loadURL(url);
      nav.querySelector("#url").value = url;
    });
    
    tabBar.addEventListener("tab-closed", () => {

    });
    
    function saveTabState(tabId) {
      const currentUrl = webviewContainer.getURL();
      tabBar.updateTab(tabId, { url: currentUrl });
    }

    webviewContainer.loadURL(toNavigate);
    focusURLInput();

    nav.addEventListener("back", () => webviewContainer.goBack());
    nav.addEventListener("forward", () => webviewContainer.goForward());
    nav.addEventListener("reload", () => webviewContainer.reload());
    nav.addEventListener("stop", () => webviewContainer.stop());
    nav.addEventListener("home", () => {
      webviewContainer.loadURL("peersky://home");
      nav.querySelector("#url").value = "peersky://home";
      
      // Update current tab
      const activeTab = tabBar.getActiveTab();
      if (activeTab) {
        tabBar.updateTab(activeTab.id, { 
          url: "peersky://home",
          title: "Home" 
        });
      }
    });
    
    nav.addEventListener("navigate", ({ detail }) => {
      const { url } = detail;
      navigateTo(url);
    });
    nav.addEventListener("new-window", () => {
      ipcRenderer.send("new-window");
    });

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
          const url = handleURL(rawURL);
          try {
            webviewContainer.loadURL(url);
            
            // Update current tab
            const activeTab = tabBar.getActiveTab();
            if (activeTab) {
              tabBar.updateTab(activeTab.id, { url });
            }
          } catch (error) {
            console.error("Error loading URL:", error);
          }
        }
      });
    } else {
      console.error("URL input not found within nav-box.");
    }

    // Update URL input and send navigation event
    webviewContainer.addEventListener("did-navigate", (e) => {
      if (urlInput) {
        urlInput.value = e.detail.url;
      }
      ipcRenderer.send("webview-did-navigate", e.detail.url);
      
      // Update current tab URL
      const activeTab = tabBar.getActiveTab();
      if (activeTab) {
        tabBar.updateTab(activeTab.id, { url: e.detail.url });
      }
    });

    // Update page title and tab title
    webviewContainer.addEventListener("page-title-updated", (e) => {
      const newTitle = e.detail.title || "Peersky Browser";
      pageTitle.innerText = `${newTitle} - Peersky Browser`;
      
      // Update current tab title
      const activeTab = tabBar.getActiveTab();
      if (activeTab) {
        tabBar.updateTab(activeTab.id, { title: newTitle });
      }
    });

    // Find Menu Event Listeners
    findMenu.addEventListener("next", ({ detail }) => {
      webviewContainer.executeJavaScript(
        `window.find("${detail.value}", ${detail.findNext})`
      );
    });

    findMenu.addEventListener("previous", ({ detail }) => {
      webviewContainer.executeJavaScript(
        `window.find("${detail.value}", ${detail.findNext}, true)`
      );
    });

    findMenu.addEventListener("hide", () => {
      webviewContainer.focus();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "t" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        tabBar.addTab();
      }
    });

    // Initial update of navigation buttons
    updateNavigationButtons();
  } else {
    console.error("webviewContainer, nav, or tabBar not found");
  }
});

function updateNavigationButtons() {
  if (webviewContainer && nav && webviewContainer.webviewElement) {
    const canGoBack = webviewContainer.webviewElement.canGoBack();
    const canGoForward = webviewContainer.webviewElement.canGoForward();
    nav.setNavigationButtons(canGoBack, canGoForward);
  }
}

function navigateTo(url) {
  webviewContainer.loadURL(url);
  
  // Update current tab
  const activeTab = tabBar.getActiveTab();
  if (activeTab) {
    tabBar.updateTab(activeTab.id, { url });
  }
}

function focusURLInput() {
  const urlInput = nav.querySelector("#url");
  if (urlInput) {
    urlInput.focus();
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "f" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    findMenu.toggle();
  }
});