class TabBar extends HTMLElement {
  constructor() {
    super();
    this.tabs = [];
    this.activeTabId = null;
    this.tabCounter = 0;
    this.webviews = new Map(); 
    this.webviewContainer = null;
    this.buildTabBar();
    this.setupBrowserCloseHandler();
  }

  // Connect to the webview container where all webviews will live
  connectWebviewContainer(container) {
    this.webviewContainer = container;
    // After connecting container, restore or create initial tabs
    this.restoreOrCreateInitialTabs();
    
    setTimeout(() => this.forceActivateCurrentTab(), 300);
  }

  // Force activate the current tab's webview
  forceActivateCurrentTab() {
    if (!this.activeTabId) {
      // No active tab, select the first one
      if (this.tabs.length > 0) {
        this.selectTab(this.tabs[0].id);
      }
      return;
    }

    // Re-select the active tab to force webview initialization
    this.selectTab(this.activeTabId);
    
    // Get the active webview
    const activeWebview = this.webviews.get(this.activeTabId);
    if (!activeWebview) return;
    
    // Force display and focus
    activeWebview.style.display = "flex";
    activeWebview.focus();
    
    // Get current URL and reload if needed
    const tab = this.tabs.find(tab => tab.id === this.activeTabId);
    if (tab && tab.url) {
      // Force reload the current URL
      activeWebview.setAttribute("src", tab.url);
    }
    
    // Multiple focus attempts with increasing delay
    const focusTimes = [50, 200, 500];
    focusTimes.forEach(time => {
      setTimeout(() => {
        if (activeWebview && document.body.contains(activeWebview)) {
          activeWebview.style.display = "flex";
          activeWebview.focus();
        }
      }, time);
    });
  }

  buildTabBar() {
    this.id = "tabbar";
    this.className = "tabbar";

    // Create add tab button
    const addButton = document.createElement("button");
    addButton.id = "add-tab";
    addButton.className = "add-tab-button";
    addButton.innerHTML = "+";
    addButton.title = "New Tab";
    addButton.addEventListener("click", () => this.addTab());
    
    this.tabContainer = document.createElement("div");
    this.tabContainer.className = "tab-container";
    
    this.appendChild(this.tabContainer);
    this.appendChild(addButton);

    // enable mouse-wheel => horizontal scroll
    this.tabContainer.addEventListener('wheel', e => {
    // only intercept vertical scrolls
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      this.tabContainer.scrollLeft += e.deltaY;
    }
  });
    
    // Don't add first tab here
    // Will be handled in restoreOrCreateInitialTabs
  }

  // Restore persisted tabs or create initial home tab
  restoreOrCreateInitialTabs() {
    const persistedTabs = this.loadPersistedTabs();
    
    if (persistedTabs && persistedTabs.tabs.length > 0) {
      // Restore persisted tabs
      this.restoreTabs(persistedTabs);
    } else {
      // First time opening browser - create home tab and persist it
      const homeTabId = this.addTab("peersky://home", "Home");
      this.saveTabsState();
    }
  }

  // Load persisted tabs from localStorage
  loadPersistedTabs() {
    try {
      const stored = localStorage.getItem("peersky-browser-tabs");
      return stored ? JSON.parse(stored) : null;
    } catch (error) {
      console.error("Failed to load persisted tabs:", error);
      return null;
    }
  }

  // Save current tabs state to localStorage
  saveTabsState() {
    try {
      const tabsData = {
        tabs: this.tabs.map(tab => ({
          id: tab.id,
          url: tab.url,
          title: tab.title
        })),
        activeTabId: this.activeTabId,
        tabCounter: this.tabCounter
      };
      localStorage.setItem("peersky-browser-tabs", JSON.stringify(tabsData));
    } catch (error) {
      console.error("Failed to save tabs state:", error);
    }
  }

  // Restore tabs from persisted data
  restoreTabs(persistedData) {
    this.tabCounter = persistedData.tabCounter || 0;
    let restoredActiveTabId = null;

    // Restore each tab
    persistedData.tabs.forEach(tabData => {
      const tabId = this.addTabWithId(tabData.id, tabData.url, tabData.title);
      if (tabData.id === persistedData.activeTabId) {
        restoredActiveTabId = tabId;
      }
    });

    // Select the previously active tab
    if (restoredActiveTabId) {
      this.selectTab(restoredActiveTabId);
    } else if (this.tabs.length > 0) {
      // Fallback to first tab if active tab ID not found
      this.selectTab(this.tabs[0].id);
    }

    // Force activation after a delay
    setTimeout(() => this.forceActivateCurrentTab(), 200);
  }

  // Add tab with specific ID (for restoration)
  addTabWithId(tabId, url = "peersky://home", title = "Home") {
    // Create tab UI
    const tab = document.createElement("div");
    tab.className = "tab";
    tab.id = tabId;
    tab.dataset.url = url;
    
    const tabTitle = document.createElement("span");
    tabTitle.className = "tab-title";
    tabTitle.textContent = title;
    
    const closeButton = document.createElement("span");
    closeButton.className = "close-tab";
    closeButton.innerHTML = "×";
    closeButton.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTab(tabId);
    });
    
    tab.appendChild(tabTitle);
    tab.appendChild(closeButton);
    
    tab.addEventListener("click", () => this.selectTab(tabId));
    
    this.tabContainer.appendChild(tab);
    this.tabs.push({id: tabId, url, title});
    
    // Create webview for this tab if container exists
    if (this.webviewContainer) {
      this.createWebviewForTab(tabId, url);
    }
    
    return tabId;
  }

  addTab(url = "peersky://home", title = "Home") {
    const tabId = `tab-${this.tabCounter++}`;
    this.addTabWithId(tabId, url, title);
    this.selectTab(tabId);
    this.saveTabsState(); // Save state when new tab is added
    return tabId;
  }

  // Create a new webview for a tab
  createWebviewForTab(tabId, url) {
    // Create webview element
    const webview = document.createElement("webview");
    webview.id = `webview-${tabId}`;
    webview.className = "tab-webview";
    
    // Set important attributes
    webview.setAttribute("src", url);
    webview.setAttribute("allowpopups", "");
    webview.setAttribute("webpreferences", "backgroundThrottling=false");
    webview.setAttribute("nodeintegration", "");
    
    // Set explicit height and width to ensure it fills the container
    webview.style.width = "100%";
    webview.style.height = "100%";
    webview.style.display = "none"; // Hide by default
    
    // Add to container first, then set up events
    this.webviewContainer.appendChild(webview);
    
    // Add a load event to ensure webview is properly initialized
    webview.addEventListener('dom-ready', () => {
      // Ensure this webview is visible if it's the active tab
      if (this.activeTabId === tabId) {
        webview.style.display = "flex";
        webview.focus();
      }
    });
    
    // Set up event listeners for this webview
    this.setupWebviewEvents(webview, tabId);
    
    // Store reference
    this.webviews.set(tabId, webview);
    
    return webview;
  }

  // Set up all event handlers for a webview
  setupWebviewEvents(webview, tabId) {
    webview.addEventListener("did-start-loading", () => {
      // Update tab UI to show loading state
      const tabElement = document.getElementById(tabId);
      if (tabElement) tabElement.classList.add("loading");
      
      // Dispatch loading event
      this.dispatchEvent(new CustomEvent("tab-loading", { 
        detail: { tabId, isLoading: true } 
      }));
    });
    
    webview.addEventListener("did-stop-loading", () => {
      // Update tab UI to show loading complete
      const tabElement = document.getElementById(tabId);
      if (tabElement) tabElement.classList.remove("loading");
      
      // Dispatch loading complete event
      this.dispatchEvent(new CustomEvent("tab-loading", { 
        detail: { tabId, isLoading: false } 
      }));
    });
    
    webview.addEventListener("page-title-updated", (e) => {
      const newTitle = e.title || "Untitled";
      this.updateTab(tabId, { title: newTitle });
    });
    
    webview.addEventListener("did-navigate", (e) => {
      const newUrl = e.url;
      this.updateTab(tabId, { url: newUrl });
      
      // Dispatch navigation event
      this.dispatchEvent(new CustomEvent("tab-navigated", { 
        detail: { tabId, url: newUrl } 
      }));
    });
    
    webview.addEventListener("new-window", (e) => {
      // Create a new tab for target URL
      this.addTab(e.url, "New Tab");
    });
  }

  closeTab(tabId) {
    const tabElement = document.getElementById(tabId);
    if (!tabElement) return;
    
    // Get index of tab to close
    const tabIndex = this.tabs.findIndex(tab => tab.id === tabId);
    if (tabIndex === -1) return;
    
    // Prevent closing the last tab - always keep at least the home tab
    if (this.tabs.length === 1) {
      // Instead of closing, navigate to home
      this.updateTab(tabId, { url: "peersky://home", title: "Home" });
      this.navigateActiveTab("peersky://home");
      this.saveTabsState();
      return;
    }
    
    // Remove tab from DOM and array
    tabElement.remove();
    this.tabs.splice(tabIndex, 1);
    
    // Remove associated webview
    const webview = this.webviews.get(tabId);
    if (webview) {
      webview.remove();
      this.webviews.delete(tabId);
    }
    
    // If we closed the active tab, select another one
    if (this.activeTabId === tabId) {
      // Select the previous tab, or the next one if there is no previous
      const newTabIndex = Math.max(0, tabIndex - 1);
      if (this.tabs[newTabIndex]) {
        this.selectTab(this.tabs[newTabIndex].id);
      }
    }
    
    // Save state after closing tab
    this.saveTabsState();
    
    // Dispatch event that tab was closed
    this.dispatchEvent(new CustomEvent("tab-closed", { detail: { tabId } }));
  }

  // Update the selectTab method to handle display properly
  selectTab(tabId) {
    // Don't do anything if this tab is already active
    if (this.activeTabId === tabId) return;
    
    // Remove active class from current active tab
    if (this.activeTabId) {
      const currentActive = document.getElementById(this.activeTabId);
      if (currentActive) {
        currentActive.classList.remove("active");
      }
      
      // Hide the current active webview
      const currentWebview = this.webviews.get(this.activeTabId);
      if (currentWebview) {
        currentWebview.style.display = "none";
      }
    }
    
    // Add active class to new active tab
    const newActive = document.getElementById(tabId);
    if (newActive) {
      newActive.classList.add("active");
      this.activeTabId = tabId;
      
      // Show the newly active webview
      const newWebview = this.webviews.get(tabId);
      if (newWebview) {
        newWebview.style.display = "flex";
        
        // Focus the webview to ensure it gets activated
        newWebview.focus();
        
        // Force a more reliable layout refresh
        setTimeout(() => {
          if (newWebview && document.body.contains(newWebview)) {
            // Quick toggle to force redraw and ensure content is displayed
            newWebview.style.display = "none";
            requestAnimationFrame(() => {
              if (newWebview && document.body.contains(newWebview)) {
                newWebview.style.display = "flex";
                newWebview.focus();
              }
            });
          }
        }, 50);
      }
      
      // Find the URL for this tab
      const tab = this.tabs.find(t => t.id === tabId);
      if (tab) {
        // Dispatch event that tab was selected with the URL
        this.dispatchEvent(new CustomEvent("tab-selected", { 
          detail: { tabId, url: tab.url } 
        }));
      }
    }
    
    // Save state when tab is selected
    this.saveTabsState();
  }

  updateTab(tabId, { url, title }) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;
    
    if (url) {
      tab.url = url;
      // Update the webview if URL is updated externally
      const webview = this.webviews.get(tabId);
      if (webview && webview.getAttribute("src") !== url) {
        webview.setAttribute("src", url);
      }
    }
    
    if (title) {
      tab.title = title;
      const tabElement = document.getElementById(tabId);
      if (tabElement) {
        const titleElement = tabElement.querySelector(".tab-title");
        if (titleElement) {
          titleElement.textContent = title;
        }
      }
    }
    
    // Save state when tab is updated
    this.saveTabsState();
  }

  getActiveTab() {
    return this.tabs.find(tab => tab.id === this.activeTabId);
  }
  
  getActiveWebview() {
    if (!this.activeTabId) return null;
    return this.webviews.get(this.activeTabId);
  }
  
  getWebviewForTab(tabId) {
    return this.webviews.get(tabId);
  }
  
  navigateActiveTab(url) {
    if (!this.activeTabId) return;
    const webview = this.webviews.get(this.activeTabId);
    if (webview) {
      webview.setAttribute("src", url);
      this.updateTab(this.activeTabId, { url });
    }
  }
  
  goBackActiveTab() {
    const webview = this.getActiveWebview();
    if (webview && webview.canGoBack()) {
      webview.goBack();
    }
  }
  
  goForwardActiveTab() {
    const webview = this.getActiveWebview();
    if (webview && webview.canGoForward()) {
      webview.goForward();
    }
  }
  
  reloadActiveTab() {
    const webview = this.getActiveWebview();
    if (webview) {
      webview.reload();
    }
  }
  
  stopActiveTab() {
    const webview = this.getActiveWebview();
    if (webview) {
      webview.stop();
    }
  }

  // Setup handler to save tabs when browser closes
  setupBrowserCloseHandler() {
    // Save on window beforeunload
    window.addEventListener("beforeunload", () => {
      this.saveTabsState();
    });
    
    // Save on visibility change (when app loses focus)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        this.saveTabsState();
      }
    });
  }
}

customElements.define("tab-bar", TabBar);