class TabBar extends HTMLElement {
  constructor() {
    super();
    this.tabs = [];
    this.activeTabId = null;
    this.tabCounter = 0;
    this.webviews = new Map(); // Store webviews by tab ID
    this.webviewContainer = null; // Will be set by connectWebviewContainer
    this.pinnedTabs = new Set(); // Track pinned tabs
    this.tabGroups = new Map(); // Store tab groups
    this.tabGroupAssignments = new Map(); // Track tab group assignments
    // const rootStyle = getComputedStyle(document.documentElement);
    this.groupColors = [
      'var(--browser-theme-primary-highlight)',
      'var(--browser-theme-secondary-highlight)',
      'var(--peersky-nav-button-active)',
      'var(--peersky-nav-button-hover)',
      'var(--peersky-nav-button-inactive)',
    ];
    this.draggedTabId = null;
    const params = new URLSearchParams(window.location.search);
    this.windowId = params.get('windowId') || 'main';
    this.buildTabBar();
    this.setupBrowserCloseHandler();
    this.setupTabContextMenu();
    this.splitPairs = [];
    this.pendingSplit = {
      isActive: false,
      leftTabId: null
    };
  }

  // Connect to the webview container where all webviews will live
  connectWebviewContainer(container) {
    this.webviewContainer = container;
    // After connecting container, restore or create initial tabs
    this.restoreOrCreateInitialTabs();
    
    // Force activation of the initial tab's webview after a delay
    setTimeout(() => this.forceActivateCurrentTab(), 300);
  }

  forceActivateCurrentTab() {
    if (!this.activeTabId) {
      if (this.tabs.length > 0) {
        const persistedTabs = this.loadPersistedTabs();
        let tabToSelect = null;
      
        if (persistedTabs && persistedTabs.activeTabId) {
          tabToSelect = this.tabs.find(tab => tab.id === persistedTabs.activeTabId);
        }
      
        if (!tabToSelect) {
          tabToSelect = this.tabs[this.tabs.length - 1];
        }
      
        this.selectTab(tabToSelect.id);
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
    if (activeWebview && tab) {
      const currentSrc = activeWebview.getAttribute('src');
      // Avoid aborting in-flight navigation with a duplicate src
      if (currentSrc !== tab.url && !activeWebview.isLoading?.()) {
        activeWebview.setAttribute('src', tab.url);
      }
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
    setTimeout(() => this.refreshGroupStyles(), 600);
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
    addButton.addEventListener("click", (e) => {
      e.currentTarget.blur();
      this.addTab();
    });
    
    this.tabContainer = document.createElement("div");
    this.tabContainer.className = "tab-container";
    
    this.appendChild(this.tabContainer);
    this.tabContainer.appendChild(addButton);

    // enable mouse-wheel => horizontal scroll
    this.tabContainer.addEventListener('wheel', e => {
      // only intercept vertical scrolls
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        this.tabContainer.scrollLeft += e.deltaY;
      }
    });
    
    this.tabContainer.addEventListener('pointerdown', this.handlePointerDown.bind(this));
    
    // Don't add first tab automatically here anymore
    // Will be handled in restoreOrCreateInitialTabs
  }

  // Restore persisted tabs or create initial home tab
  restoreOrCreateInitialTabs() {
    // Check if this is an isolated window
    const searchParams = new URL(window.location.href).searchParams;
    const isIsolated = searchParams.get('isolate') === 'true';
    const initialUrl = searchParams.get('url');
    const singleTabUrl = searchParams.get('singleTabUrl');
    const singleTabTitle = searchParams.get('singleTabTitle');
    
    const splitLeftUrl = searchParams.get('splitLeftUrl');
    const splitRightUrl = searchParams.get('splitRightUrl');

    if (isIsolated && splitLeftUrl && splitRightUrl) {
      const leftTitle = searchParams.get('splitLeftTitle') || "New Tab";
      const rightTitle = searchParams.get('splitRightTitle') || "New Tab";
      const ratio = parseInt(searchParams.get('splitRatio') || '50', 10);

      const leftTabId = this.addTab(splitLeftUrl, leftTitle);
      const rightTabId = this.addTab(splitRightUrl, rightTitle);

      this.splitPairs.push({ leftTabId: leftTabId, rightTabId: rightTabId, splitRatio: ratio });
      
      const leftTab = document.getElementById(leftTabId);
      const rightTab = document.getElementById(rightTabId);
      
      if (leftTab && rightTab && leftTab.parentNode) {
        leftTab.classList.add('split-left');
        rightTab.classList.add('split-right');
        
        if (leftTab.nextSibling !== rightTab) {
          leftTab.parentNode.insertBefore(rightTab, leftTab.nextSibling);
        }
      }
      
      this.selectTab(rightTabId);
      return;
    }

    if (isIsolated && (singleTabUrl || initialUrl)) {
      // For isolated windows, ONLY create the specified tab and don't load any persisted tabs
      const tabUrl = singleTabUrl || initialUrl;
      const tabTitle = singleTabTitle || searchParams.get('title') || "New Tab";
      const homeTabId = this.addTab(tabUrl, tabTitle);
      // Don't call saveTabsState() here to avoid overwriting the main window's tabs
      return;
    }
     // we should ALWAYS try to load from persisted data first
    const persistedTabs = this.loadPersistedTabs();
    if (persistedTabs && persistedTabs.tabs.length > 0) {
       this.restoreTabs(persistedTabs);
       return;
    }
    
    // if no persisted tab was there , then create new default tab
    const urlToLoad = initialUrl || "peersky://home";
    const title = initialUrl ? "New Tab" : "Home";
    this.addTab(urlToLoad, title);
    this.saveTabsState();
    return;

  }

  // Load persisted tabs from localStorage
  loadPersistedTabs() {
    try {
      const stored = localStorage.getItem("peersky-browser-tabs");
      if (!stored) return null;
      const allTabs = JSON.parse(stored);
      return allTabs[this.windowId] || null;
    } catch (error) {
      console.error("Failed to load persisted tabs:", error);
      return null;
    }
  }
  loadAllPersistedTabs() {
    try {
      const stored = localStorage.getItem("peersky-browser-tabs");
      if (!stored) return null;
      return JSON.parse(stored);
    } catch (error) {
      console.error("Failed to load persisted tabs:", error);
      return {};
    }
  }

  // Get all tab groups from all windows
getAllTabGroups() {
  const allTabsData = this.loadAllPersistedTabs();
  const allGroups = new Map();
  
  Object.entries(allTabsData).forEach(([windowId, windowData]) => {
    if (windowData.tabGroups && Array.isArray(windowData.tabGroups)) {
      windowData.tabGroups.forEach(group => {
        // Add window info to group
        allGroups.set(group.id, {
          ...group,
          windowId,
          windowName: windowId === 'main' ? 'Main Window' : `Window ${windowId}`
        });
      });
    }
  });
  
  return allGroups;
}

  //Serialize in-memory state for reliable saving during shutdown
  getTabsStateForSaving() {
    try {
      const tabsData = {
        tabs: this.tabs.map(tab => {
          const webview = this.webviews.get(tab.id);
          let navigation = null;

          try {
            if (webview && webview.getWebContentsId) {
              const { ipcRenderer } = require("electron");
              // Ask main process for nav history of this tab
              navigation = ipcRenderer.sendSync('get-tab-navigation', webview.getWebContentsId());
            }
          } catch (e) {
            console.warn("Failed to fetch nav history for tab", tab.id, e);
          }

          return {
            id: tab.id,
            url: tab.url,
            title: tab.title,
            protocol: tab.protocol,
            isPinned: this.pinnedTabs.has(tab.id),
            groupId: this.tabGroupAssignments.get(tab.id) || null,
            navigation 
          };
        }),
        activeTabId: this.activeTabId,
        tabCounter: this.tabCounter,
        splitPairs: this.splitPairs,
        tabGroups: Array.from(this.tabGroups.entries()).map(([id, group]) => ({
          id,
          name: group.name,
          color: group.color,
          expanded: group.expanded
        }))
      };
      return tabsData;
    } catch (error) {
      console.error("Failed to serialize tabs state for saving:", error);
      return null;
    }
  }

  // Save current tabs state to localStorage
  saveTabsState() {
    try {
      const tabsData = this.getTabsStateForSaving();
      if (!tabsData) {
        return; // Don't save if serialization failed
      }

      const stored = localStorage.getItem("peersky-browser-tabs");
      let allTabs = {};
      if (stored) {
        try {
          allTabs = JSON.parse(stored);
        } catch (e) {
          console.error("Failed to parse existing tabs state:", e);
        }
      }
      allTabs[this.windowId] = tabsData;
      localStorage.setItem("peersky-browser-tabs", JSON.stringify(allTabs));
      
      // Trigger main process to save complete state
      try {
        const { ipcRenderer } = require('electron');
        ipcRenderer.send('save-state');
      } catch (e) {
        console.error("Failed to send save-state event:", e);
      }
    } catch (error) {
      console.error("Failed to save tabs state:", error);
    }
  }

  // Restore tabs from persisted data
restoreTabs(persistedData) {
  this.tabCounter = persistedData.tabCounter || 0;

  // Restore tab groups first
  if (persistedData.tabGroups) {
    persistedData.tabGroups.forEach(groupData => {
      this.tabGroups.set(groupData.id, {
        id: groupData.id,
        name: groupData.name,
        color: groupData.color,
        expanded: groupData.expanded
      });
    });
  }

  // Restore each tab
  persistedData.tabs.forEach(tabData => {
    const tabId = this.addTabWithId(tabData.id, tabData.url, tabData.title);

    if (tabData.navigation && tabData.navigation.entries?.length) {
      const { entries, activeIndex } = tabData.navigation;
      const { ipcRenderer } = require("electron");
      const webview = this.webviews.get(tabId);

      setTimeout(() => {
        try {
          const webContentsId = webview.getWebContentsId();
          ipcRenderer.invoke("restore-navigation-history", { webContentsId, entries, activeIndex })
            .catch(err => console.warn("Failed to restore nav history:", err));
        } catch (e) {
          console.warn("Error sending restore-navigation-history:", e);
        }
      }, 150);
    }

    
    // Restore pinned state
    if (tabData.isPinned) {
      this.pinnedTabs.add(tabId);
      setTimeout(() => {
        const tabElement = document.getElementById(tabId);
        if (tabElement) {
          tabElement.classList.add('pinned');
        }
      }, 0);
    }
    
    // Restore group assignment
    if (tabData.groupId && this.tabGroups.has(tabData.groupId)) {
      this.tabGroupAssignments.set(tabId, tabData.groupId);
      
      // Apply group styles to tab element
      const tabElement = document.getElementById(tabId);
      const group = this.tabGroups.get(tabData.groupId);
      if (tabElement && group) {
        tabElement.dataset.groupId = tabData.groupId;
        if (group.expanded) {
          tabElement.style.borderTop = `2px solid ${group.color}`;
        }
      }
    }
  });

  if (persistedData.splitPairs && persistedData.splitPairs.length > 0) {
    this.splitPairs = persistedData.splitPairs;
    
    setTimeout(() => {
      this.splitPairs.forEach(split => {
        const leftTab = document.getElementById(split.leftTabId);
        const rightTab = document.getElementById(split.rightTabId);

        if (leftTab && rightTab) {
          leftTab.classList.add('split-left');
          rightTab.classList.add('split-right');
          
          if (leftTab.nextSibling !== rightTab) {
            leftTab.parentNode.insertBefore(rightTab, leftTab.nextSibling);
          }
        }
      });
    }, 0);
  }

  // Render all group headers
  for (const groupId of this.tabGroups.keys()) {
    this.renderGroupHeader(groupId);
  }
  
  // Update grouped tabs UI
  this.updateGroupedTabsUI();

  // Restore the last active tab
  if (this.tabs.length > 0) {
    const lastActiveTabId = persistedData.activeTabId;
    const tabExists = lastActiveTabId && this.tabs.find(t => t.id === lastActiveTabId);
    
    if (tabExists) {
      this.activeTabId = lastActiveTabId;
      this.selectTab(lastActiveTabId);
    } else {
      // Fallback to first tab if persisted active tab doesn't exist
      this.activeTabId = this.tabs[0].id;
      this.selectTab(this.tabs[0].id);
    }
  }

  // Force activation after a delay
  setTimeout(() => this.forceActivateCurrentTab(), 200);
  
  // Ensure group styles are applied after all DOM elements are ready
  setTimeout(() => this.refreshGroupStyles(), 300);
}

  // Add tab with specific ID (for restoration)
  addTabWithId(tabId, url = "peersky://home", title = "Home", tabData = {}) {    // Create tab UI
    const tab = document.createElement("div");
    tab.className = "tab opening";
    tab.id = tabId;
    tab.dataset.url = url;
    tab.draggable = true;
    
    const tabTitle = document.createElement("span");
    tabTitle.className = "tab-title";
    tabTitle.textContent = title;

    // favicon element
    const faviconElement = document.createElement("div");
    faviconElement.className = "tab-favicon";
    faviconElement.style.backgroundImage = "url(peersky://static/assets/icon16.png)"; 
    faviconElement.style.display = "block";
    
    const closeButton = document.createElement("span");
    closeButton.className = "close-tab";
    closeButton.innerHTML = "×";
    closeButton.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTab(tabId);
    });

    tab.appendChild(faviconElement);
    tab.appendChild(tabTitle);
    tab.appendChild(closeButton);
    
    tab.addEventListener("click", () => this.selectTab(tabId));

    tab.addEventListener("mousemove", (e) => {
      const rect = tab.getBoundingClientRect();
      tab.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
      tab.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
    });
    
    this.setupTabHoverCard(tab, tabId);
    
    const addButton = this.tabContainer.querySelector('#add-tab');
    if (addButton) {
      this.tabContainer.insertBefore(tab, addButton);
    } else {
      this.tabContainer.appendChild(tab);
    }
    const index = this.tabs.length;
    tab.style.transitionDelay = `${index * 15}ms`;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        tab.classList.remove('opening');
      });
    });
    const protocol = this._getProtocol(url);
    this.tabs.push({id: tabId, url, title, protocol});
    
    // Create webview for this tab if container exists
    if (this.webviewContainer) {
      const webview = this.createWebviewForTab(tabId, url);

      if (tabData.navigation && tabData.navigation.entries?.length) {
        const { entries, activeIndex } = tabData.navigation;
        try {
          const { ipcRenderer } = require("electron");
          const webContentsId = webview.getWebContentsId();
          ipcRenderer.invoke('restore-navigation-history', { webContentsId, entries, activeIndex })
            .catch(err => console.warn("Failed to restore nav history:", err));
        } catch (e) {
          console.warn("Error sending restore-navigation-history:", e);
        }
      }
    }
    
    this._updateP2PIndicator(tabId);
    
    return tabId;
  }

  setupTabHoverCard(tabElement, tabId) {
    let hoverCard = null;
    let hoverTimeout = null;
    
    const showHoverCard = (e) => {
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
      }
      
      // Delay showing the card
      hoverTimeout = setTimeout(async() => {
        const tab = this.tabs.find(t => t.id === tabId);
        if (!tab) return;
        
        // Remove existing hover card
        const existingCard = document.querySelector('.tab-hover-card');
        if (existingCard) {
          existingCard.remove();
        }
        
        // Create hover card
        hoverCard = document.createElement('div');
        hoverCard.className = 'tab-hover-card';
        hoverCard.dataset.tabId = tabId; // allow identification
        
        // Get webview to check memory usage (if available)
        const webview = this.webviews.get(tabId);
        let memoryInfo = 'Memory usage: Loading...';
        
        // Try to get memory usage (this is an approximation)
        if (webview) {
          try {
            const processId = webview.getWebContentsId();
            const { ipcRenderer } = require('electron');
            const memoryUsage = await ipcRenderer.invoke('get-tab-memory-usage', processId);
            
            if (memoryUsage && memoryUsage.workingSetSize) {
              // Convert bytes to MB
              const memoryMB = Math.round(memoryUsage.workingSetSize / 1024 / 1024);
              memoryInfo = `Memory usage: ${memoryMB} MB`;
            } else {
              memoryInfo = 'Memory usage: N/A';
            }
          } catch (e) {
            console.error("Failed to get memory usage:", e);
            memoryInfo = 'Memory usage: N/A';
          }
        }
        
        // Helper function to escape HTML
        function escapeHtml(text) {
          const div = document.createElement('div');
          div.textContent = text;
          return div.innerHTML;
        }

        hoverCard.innerHTML = `
          <div class="hover-card-title">${escapeHtml(tab.title)}</div>
          <div class="hover-card-url">${escapeHtml(tab.url)}</div>
          <div class="hover-card-separator"></div>
          <div class="hover-card-memory">${escapeHtml(memoryInfo)}</div>
        `;
        
        // Position the card
        const tabRect = tabElement.getBoundingClientRect();
        hoverCard.style.position = 'fixed';
        hoverCard.style.left = `${tabRect.left}px`;
        hoverCard.style.top = `${tabRect.bottom + 8}px`;
        hoverCard.style.zIndex = '10002';
        
        // Ensure card doesn't go off screen
        document.body.appendChild(hoverCard);
        const cardRect = hoverCard.getBoundingClientRect();
        if (cardRect.right > window.innerWidth) {
          hoverCard.style.left = `${window.innerWidth - cardRect.width - 10}px`;
        }
        if (cardRect.bottom > window.innerHeight) {
          hoverCard.style.top = `${tabRect.top - cardRect.height - 8}px`;
        }
      }, 800); // Show after 800ms hover
    };
    
    const hideHoverCard = () => {
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
        hoverTimeout = null;
      }
      
      if (hoverCard) {
        hoverCard.remove();
        hoverCard = null;
      }
    };
    
    tabElement.addEventListener('mouseenter', showHoverCard);
    tabElement.addEventListener('mouseleave', hideHoverCard);
  }

  // Helper to remove any visible hover card (used when tab removed)
  destroyHoverCard() {
    const card = document.querySelector('.tab-hover-card');
    if (card) card.remove();
  }

  addTab(url = "peersky://home", title = "Home") {
    const tabId = `tab-${this.tabCounter++}`;
    this.addTabWithId(tabId, url, title);
    this.selectTab(tabId, true);
    this.saveTabsState();
    
    // Focus address bar for new tabs
    setTimeout(() => {
      const urlInput = document.getElementById('url');
      if (urlInput) {
        if (url === "peersky://home") {
          urlInput.value = "";
        }
        urlInput.focus();
        urlInput.select();
      }
    }, 400);
    
    return tabId;
  }

  // Create a new webview for a tab
  createWebviewForTab(tabId, url) {
    // Create webview element
    const webview = document.createElement("webview");
    webview.id = `webview-${tabId}`;
    webview.className = "tab-webview";

    const path = require("path");
    const { pathToFileURL } = require("url");
    const preloadPath = path.join(__dirname, "unified-preload.js");
    const preloadURL = pathToFileURL(preloadPath).href;
    webview.setAttribute("preload", preloadURL);
    webview.setAttribute("webpreferences", "contextIsolation=yes,nativeWindowOpen=yes");
    // Set important attributes
    webview.setAttribute("src", url);
    webview.setAttribute("allowpopups", "");
    // webview.setAttribute("webpreferences", "backgroundThrottling=false");
    // webview.setAttribute("nodeintegration", "");
    
    // Set explicit height and width to ensure it fills the container
    webview.style.width = "100%";
    webview.style.height = "100%";
    webview.style.display = "none"; // Hide by default
    
    // Add to container first, then set up events
    this.webviewContainer.appendChild(webview);
    
    // Add a load event to ensure webview is properly initialized
    let extensionRegistered = false;
    webview.addEventListener('dom-ready', () => {
      // Ensure this webview is visible if it's the active tab
      if (this.activeTabId === tabId) {
        webview.style.display = "flex";
        webview.focus();
      }
      
      // Register webview with extension system only once.
      // electron-chrome-extensions.addTab() can trigger a navigation/reload on the
      // webContents, which fires dom-ready again — causing an infinite reload loop.
      if (extensionRegistered) return;
      extensionRegistered = true;
      setTimeout(() => {
        try {
          const webContentsId = webview.getWebContentsId();
          const { ipcRenderer } = require('electron');
          ipcRenderer.invoke('extensions-register-webview', webContentsId).then(result => {
            if (!result.success) {
              console.warn(`[TabBar] Failed to register webview ${webContentsId}:`, result.error);
            }
          }).catch(error => {
            console.error(`[TabBar] Error registering webview:`, error);
          });
        } catch (error) {
          console.warn(`[TabBar] Could not register webview with extension system:`, error);
        }
      }, 100); // Small delay to ensure webview is fully ready
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
      const tabElement = document.getElementById(tabId);
      if (tabElement) {
        tabElement.classList.add("loading");
        
        const faviconElement = tabElement.querySelector('.tab-favicon');
        if (faviconElement) {
          faviconElement.style.display = "none";
        }
      }
      
      this.dispatchEvent(new CustomEvent("tab-loading", { 
        detail: { tabId, isLoading: true } 
      }));
    });
  
    webview.addEventListener("did-stop-loading", () => {
      const tabElement = document.getElementById(tabId);
      if (tabElement) {
        tabElement.classList.remove("loading");
        
        const faviconElement = tabElement.querySelector('.tab-favicon');
        if (faviconElement) {
          // Always show favicon after loading, but only set default if no custom favicon exists
          if (faviconElement.style.display === "none") {
            faviconElement.style.display = "block";
          }
          // Only set default icon if no background image is set
          if (!faviconElement.style.backgroundImage || faviconElement.style.backgroundImage === 'none') {
            faviconElement.style.backgroundImage = "url(peersky://static/assets/icon16.png)";
          }
        }
      }
      
      this.dispatchEvent(new CustomEvent("tab-loading", { 
        detail: { tabId, isLoading: false } 
      }));
      
      this.dispatchEvent(new CustomEvent("navigation-state-changed", {
        detail: { tabId }
      }));
    });
    
    webview.addEventListener("page-title-updated", (e) => {
      const newTitle = e.title || "Untitled";
      this.updateTab(tabId, { title: newTitle });
    });
  
    webview.addEventListener("did-navigate", (e) => {
      const newUrl = e.url;
      this.updateTab(tabId, { url: newUrl });
      
      this.dispatchEvent(new CustomEvent("tab-navigated", { 
        detail: { tabId, url: newUrl } 
      }));
      
      setTimeout(() => {
        this.dispatchEvent(new CustomEvent("navigation-state-changed", {
          detail: { tabId }
        }));
      }, 100);
    });

    webview.addEventListener("did-navigate", () => {
      this.saveTabsState();
    });

    webview.addEventListener("did-stop-loading", () => {
      this.saveTabsState();
    });
    
    // Handle in-page navigation 
    webview.addEventListener("did-navigate-in-page", (e) => {
      const newUrl = e.url;
      this.updateTab(tabId, { url: newUrl });
      
      this.dispatchEvent(new CustomEvent("tab-navigated", { 
        detail: { tabId, url: newUrl } 
      }));
      
      setTimeout(() => {
        this.dispatchEvent(new CustomEvent("navigation-state-changed", {
          detail: { tabId }
        }));
      }, 100);
    });
  
    // Handle audio state changes
    webview.addEventListener("media-started-playing", () => {
      this.updateTabMuteState(tabId);
    });
  
    webview.addEventListener("media-paused", () => {
      this.updateTabMuteState(tabId);
    });
  
    webview.addEventListener("new-window", (e) => {
      e.preventDefault();
      this.addTab(e.url, "New Tab");
    });

    webview.addEventListener("page-favicon-updated", (e) => {
      const tabElement = document.getElementById(tabId);
      if (!tabElement) return;
      
      // Get the first favicon URL from the event
      const faviconUrl = e.favicons && e.favicons.length > 0 ? e.favicons[0] : null;
      
      // Find or create favicon element
      let faviconElement = tabElement.querySelector('.tab-favicon');
      if (!faviconElement) {
        faviconElement = document.createElement('div');
        faviconElement.className = 'tab-favicon';
        
        // Insert favicon before the title
        const titleElement = tabElement.querySelector('.tab-title');
        if (titleElement) {
          tabElement.insertBefore(faviconElement, titleElement);
        } else {
          tabElement.prepend(faviconElement);
        }
      }
      
      // Update favicon image
      if (faviconUrl) {
        faviconElement.style.backgroundImage = `url(${faviconUrl})`;
        faviconElement.style.display = 'block';
      } else {
        // Use default icon if no favicon is available
        faviconElement.style.backgroundImage = 'url(peersky://static/assets/icon16.png)';
        faviconElement.style.display = 'block';
      }
    });

    webview.addEventListener("focus", () => {
      if (this.activeTabId !== tabId) {
        this.selectTab(tabId);
      }
    });
  }

  closeTab(tabId) {
    this.destroyHoverCard(); // remove lingering hover card
    const tabElement = document.getElementById(tabId);
    if (!tabElement) return;
    this.breakSplitView(tabId);

    // Get index of tab to close
    const tabIndex = this.tabs.findIndex(tab => tab.id === tabId);
    if (tabIndex === -1) return;

    // If this is the last tab, close the entire window instead of
    // forcing a "home" tab. This matches normal browser behaviour.
    if (this.tabs.length === 1) {
      try {
        const { ipcRenderer } = require('electron');
        ipcRenderer.send('close-window');
      } catch (error) {
        console.error('Failed to close window on last-tab close:', error);
      }
      return;
    }

    // Remove tab from DOM and array
    tabElement.classList.add('closing');
    this.tabs.splice(tabIndex, 1);

    setTimeout(() => {
      if (tabElement.parentNode) {
        tabElement.remove();
      }
    }, 220);

    // Remove associated webview
    const webview = this.webviews.get(tabId);
    if (webview) {
      // Unregister webview from extension system before removing
      try {
        const webContentsId = webview.getWebContentsId();
        const { ipcRenderer } = require('electron');
        ipcRenderer.invoke('extensions-unregister-webview', webContentsId).catch(error => {
          console.warn(`[TabBar] Error unregistering webview:`, error);
        });
      } catch (error) {
        // Webview might already be destroyed, which is fine
      }
      
      webview.remove();
      this.webviews.delete(tabId);
    }

    // Remove tab from group
    this.removeTabFromGroup(tabId);

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

  getSplitForTab(tabId) {
    return this.splitPairs.find(split => split.leftTabId === tabId || split.rightTabId === tabId);
  }

  initiateSplitView(tabId) {
    // Prevent splitting a tab that is already in a split
    if (this.getSplitForTab(tabId)) return;

    this.pendingSplit = {
      isActive: true,
      leftTabId: tabId
    };

    const leftTab = document.getElementById(tabId);
    if (leftTab) leftTab.classList.add('split-pending');

    if (this.webviewContainer) {
      this.webviewContainer.style.display = 'flex';
      this.webviewContainer.style.flexDirection = 'row';
    }

    this.selectTab(tabId);
  }

  assignRightSplitTab(tabId) {
    if (!this.pendingSplit.isActive) return;

    const leftId = this.pendingSplit.leftTabId;
    const rightId = tabId;

    this.splitPairs.push({ leftTabId: leftId, rightTabId: rightId, splitRatio: 50 });
    this.pendingSplit = { isActive: false, leftTabId: null };

    const leftTab = document.getElementById(leftId);
    const rightTab = document.getElementById(rightId);

    if (leftTab && rightTab && leftTab.parentNode) {
      leftTab.classList.remove('split-pending');
      leftTab.classList.add('split-left');

      rightTab.classList.add('split-right');

      leftTab.parentNode.insertBefore(rightTab, leftTab.nextSibling);
    }

    this.selectTab(rightId); 
  }

  breakSplitView(tabId) {
    const splitIndex = this.splitPairs.findIndex(s => s.leftTabId === tabId || s.rightTabId === tabId);

    if (splitIndex !== -1) {
      const split = this.splitPairs[splitIndex];
      const leftTab = document.getElementById(split.leftTabId);
      const rightTab = document.getElementById(split.rightTabId);

      if (leftTab) leftTab.classList.remove('split-left');
      if (rightTab) rightTab.classList.remove('split-right');

      this.splitPairs.splice(splitIndex, 1);

      const survivingTabId = split.leftTabId === tabId ? split.rightTabId : split.leftTabId;
      this.selectTab(survivingTabId);
      return;
    }

    if (this.pendingSplit.isActive && this.pendingSplit.leftTabId === tabId) {
      const leftTab = document.getElementById(this.pendingSplit.leftTabId);
      if (leftTab) leftTab.classList.remove('split-pending');

      this.pendingSplit = { isActive: false, leftTabId: null };
      this.renderWebviews();
    }
  }

  // Update the selectTab method to handle display properly
  selectTab(tabId, isNewTab = false) {
    if (this.activeTabId) {
      const currentActive = document.getElementById(this.activeTabId);
      if (currentActive) currentActive.classList.remove("active");
    }

    const newActive = document.getElementById(tabId);
    if (newActive) {
      newActive.classList.add("active");
      this.activeTabId = tabId;
      
      // Close all extension popups when switching tabs
      try {
        const { ipcRenderer } = require('electron');
        ipcRenderer.invoke('extensions-close-all-popups').catch(error => {
          console.warn('[TabBar] Failed to close extension popups on tab switch:', error);
        });
      } catch (error) {
        console.warn('[TabBar] Error closing extension popups:', error);
      }

      const tab = this.tabs.find(t => t.id === tabId);
      if (tab) {
        this.dispatchEvent(new CustomEvent("tab-selected", { detail: { tabId, url: tab.url } }));
      }
    }

    this.renderWebviews();

    if (!isNewTab) {
      setTimeout(() => {
        const activeWv = this.webviews.get(tabId);
        if (activeWv && document.body.contains(activeWv)) activeWv.focus();
      }, 10);
    }

    this.saveTabsState();
  }

  renderWebviews() {
    if (!this.webviewContainer) return;

    let divider = document.getElementById('split-view-divider');
    if (!divider) {
      divider = document.createElement('div');
      divider.id = 'split-view-divider';
      divider.className = 'split-view-divider';
      divider.addEventListener('pointerdown', this.handleDividerPointerDown.bind(this));
      this.webviewContainer.appendChild(divider);
    }

    divider.style.display = 'none';
    this.webviews.forEach((webview) => {
      webview.style.display = "none";
      webview.style.flex = "none";
      webview.style.width = "100%";
      webview.style.borderRight = "none";
      webview.style.order = "";
    });

    const existingOverlay = document.getElementById('split-view-selector-overlay');
    if (existingOverlay) existingOverlay.style.display = 'none';

    const activeSplit = this.getSplitForTab(this.activeTabId);

    if (activeSplit) {
      const leftWv = this.webviews.get(activeSplit.leftTabId);
      const rightWv = this.webviews.get(activeSplit.rightTabId);

      if (leftWv && rightWv) {
        leftWv.style.display = "flex";
        leftWv.style.flex = `0 0 ${activeSplit.splitRatio || 50}%`;
        leftWv.style.order = "1";
        
        divider.style.display = "block";
        divider.style.order = "2";

        rightWv.style.display = "flex";
        rightWv.style.flex = `0 0 ${100 - (activeSplit.splitRatio || 50)}%`;
        rightWv.style.order = "3";
      }
    } else if (this.pendingSplit.isActive && this.activeTabId === this.pendingSplit.leftTabId) {
      const leftWv = this.webviews.get(this.pendingSplit.leftTabId);
      if (leftWv) {
        leftWv.style.display = "flex";
        leftWv.style.flex = "0 0 50%";
        leftWv.style.borderRight = "1px solid var(--settings-border)";
      }
      this.drawSplitSelectorOverlay();
    } else {
      const activeWv = this.webviews.get(this.activeTabId);
      if (activeWv) {
        activeWv.style.display = "flex";
        activeWv.style.flex = "1";
      }
    }
  }

  drawSplitSelectorOverlay() {
    let selector = document.getElementById('split-view-selector-overlay');

    if (!selector) {
      selector = document.createElement('div');
      selector.id = 'split-view-selector-overlay';
      this.webviewContainer.appendChild(selector);
    }

    selector.style.display = 'flex';
    Object.assign(selector.style, {
      flex: '0 0 50%',
      backgroundColor: 'var(--browser-theme-background)',
      display: 'flex',
      flexDirection: 'column',
      padding: '30px',
      boxSizing: 'border-box',
      overflowY: 'auto',
      color: 'var(--browser-theme-text-color)'
    });

    selector.innerHTML = `
      <h2 style="margin-top: 0; font-weight: normal; font-size: 1.5rem;">Select a tab to split</h2>
      <p style="color: var(--settings-text-secondary); margin-bottom: 20px;">Choose a tab to open in the right panel.</p>
    `;

    const newTabBtn = document.createElement('button');
    Object.assign(newTabBtn.style, {
      padding: '12px 16px',
      marginBottom: '16px',
      backgroundColor: 'var(--browser-theme-primary-highlight)',
      color: '#fff',
      border: 'none',
      borderRadius: '8px',
      cursor: 'pointer',
      fontSize: '14px',
      fontWeight: 'bold',
      textAlign: 'left',
      display: 'flex',
      alignItems: 'center',
      gap: '8px'
    });
    newTabBtn.innerHTML = `<span style="font-size:18px;">+</span> Open New Tab`;
    newTabBtn.onclick = () => {
      const newTabId = this.addTab();
      this.assignRightSplitTab(newTabId);
    };
    selector.appendChild(newTabBtn);

    const tabsList = document.createElement('div');
    tabsList.style.display = 'flex';
    tabsList.style.flexDirection = 'column';
    tabsList.style.gap = '8px';

    this.tabs.forEach(tab => {
      // Don't show tabs that are already in ANY split view, or the currently pending tab
      if (tab.id !== this.pendingSplit.leftTabId && !this.getSplitForTab(tab.id)) {
        const tabBtn = document.createElement('button');
        Object.assign(tabBtn.style, {
          padding: '12px 16px',
          backgroundColor: 'var(--settings-card-bg)',
          color: 'var(--browser-theme-text-color)',
          border: '1px solid var(--settings-border)',
          borderRadius: '8px',
          cursor: 'pointer',
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          fontSize: '14px'
        });

        tabBtn.innerHTML = `<img src="peersky://static/assets/icon16.png" style="width:16px; height:16px;"> ${tab.title}`;
        tabBtn.onclick = () => this.assignRightSplitTab(tab.id);
        tabsList.appendChild(tabBtn);
      }
    });

    selector.appendChild(tabsList);
  }

  updateTab(tabId, { url, title }) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;
    
    if (url) {
      tab.url = url;
      tab.protocol = this._getProtocol(url);
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
    
    this._updateP2PIndicator(tabId);
    
    // Save state when tab is updated
    this.saveTabsState();
  }

  getActiveTab() {
    return this.tabs.find(tab => tab.id === this.activeTabId);
  }
  hasTab(tabId) {
    return this.tabs.some(tab => tab.id === tabId);
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

  // Setup context menu for tabs
  setupTabContextMenu() {
    this.addEventListener('contextmenu', (e) => {
      // Check if right-click was on a tab
      const tab = e.target.closest('.tab');
      if (tab) {
        e.preventDefault();
        this.showTabContextMenu(e, tab.id);
      }
    });
  }

  // Show context menu for a tab
  showTabContextMenu(event, tabId) {
    // Remove existing context menu if any
    const existingMenu = document.querySelector('.tab-context-menu');
    if (existingMenu) {
      existingMenu.remove();
    }
  
    const menu = document.createElement('div');
    menu.className = 'tab-context-menu';
    menu.style.position = 'fixed';
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    menu.style.zIndex = '10000';

    const tab = this.tabs.find(t => t.id === tabId);
    const webview = this.webviews.get(tabId);
    const isPinned = this.pinnedTabs.has(tabId);
    const isMuted = webview?.isAudioMuted() || false;
    const isSplit = this.getSplitForTab(tabId) || (this.pendingSplit.isActive && this.pendingSplit.leftTabId === tabId);

    const iconPath = 'peersky://static/assets/svg';

    menu.innerHTML = `
      <div class="context-menu-item" data-action="reload">
        <img class="menu-icon" src="${iconPath}/reload.svg" />
        Reload page
      </div>
      <div class="context-menu-item" data-action="duplicate">
        <img class="menu-icon" src="${iconPath}/copy.svg" />
        Duplicate tab
      </div>
      ${isSplit ? `
        <div class="context-menu-item" data-action="separate-split">
          <img class="menu-icon" src="${iconPath}/layout-split.svg" style="transform: rotate(90deg);" />
          Separate split view
        </div>
        ` : `
        <div class="context-menu-item" data-action="split-view">
          <img class="menu-icon" src="${iconPath}/layout-split.svg" />
          Split view
        </div>
      `}
      <div class="context-menu-item" data-action="mute">
        <img class="menu-icon" src="${iconPath}/${isMuted ? 'volume-up.svg' : 'volume-mute.svg'}" />
        ${isMuted ? 'Unmute site' : 'Mute site'}
      </div>
      <div class="context-menu-item" data-action="new-tab-right">
        <img class="menu-icon" src="${iconPath}/tab-right.svg" />
        New tab to the right
      </div>
      <div class="context-menu-item" data-action="move-to-new-window">
        <img class="menu-icon" src="${iconPath}/arrow-bar-right.svg" />
        Move to new window
      </div>
      <div class="context-menu-separator"></div>
      <div class="context-menu-item" data-action="pin">
        <img class="menu-icon" src="${iconPath}/pin-angle.svg" />
        ${isPinned ? 'Unpin tab' : 'Pin tab'}
      </div>
      <div class="context-menu-separator"></div>
      <div class="context-menu-item" data-action="close-others">
        <img class="menu-icon" src="${iconPath}/close.svg" />
        Close other tabs
      </div>
      <div class="context-menu-item" data-action="close">
        <img class="menu-icon" src="${iconPath}/close.svg" />
        Close tab
      </div>
    `;

    const tabGroupId = this.tabGroupAssignments.get(tabId);
    const isGrouped = !!tabGroupId;
    
    // Get all groups from all windows to check if any exist
    const allGroups = this.getAllTabGroups();
    const hasAnyGroups = allGroups.size > 0;
    
    // Add group-related menu items before the last separator
    const groupMenuItems = `
      <div class="context-menu-separator"></div>
      ${isGrouped ? `
        <div class="context-menu-item" data-action="remove-from-group">
          <img class="menu-icon" src="${iconPath}/folder-minus.svg" />
          Remove from group
        </div>
      ` : `
        <div class="context-menu-item" data-action="add-to-new-group">
          <img class="menu-icon" src="${iconPath}/folder.svg" />
          Add to new group
        </div>
      `}
      ${hasAnyGroups && !isGrouped ? `
        <div class="context-menu-item has-submenu" data-action="add-to-existing-group">
          <img class="menu-icon" src="${iconPath}/folder.svg" />
          Add to group
          <span class="submenu-arrow">▸</span>
        </div>
      ` : ''}
    `;
    
    // Insert group menu items before pin option
    const menuHtml = menu.innerHTML;
    const pinIndex = menuHtml.indexOf('<div class="context-menu-item" data-action="pin">');
    if (pinIndex !== -1) {
      menu.innerHTML = 
        menuHtml.substring(0, pinIndex) + 
        groupMenuItems + 
        menuHtml.substring(pinIndex);
    }

    const cleanup = () => {
      if (menu.parentNode) menu.remove();
      document.removeEventListener('click', closeMenuOnClickOutside);
      window.removeEventListener('blur', cleanup);
    };

    // Add event listeners to menu items
    menu.addEventListener('click', (e) => {
      const action = e.target.closest('.context-menu-item')?.dataset.action;
      if (action) {
        this.handleTabContextMenuAction(action, tabId);
        cleanup();
      }
    });

    // Close menu when clicking outside
    const closeMenuOnClickOutside = (e) => {
      if (!menu.contains(e.target)) {
        cleanup();
      }
    };
    
    setTimeout(() => {
      document.addEventListener('click', closeMenuOnClickOutside);
      window.addEventListener('blur', cleanup);
    }, 0);

    document.body.appendChild(menu);
  }

  // Handle context menu actions
  handleTabContextMenuAction(action, tabId) {
    const webview = this.webviews.get(tabId);
    
    switch (action) {
      case 'reload':
        if (webview) {
          webview.reload();
        }
        break;
        
      case 'duplicate':
        this.duplicateTab(tabId);
        break;
        
      case 'split-view':
        this.initiateSplitView(tabId);
        break;

      case 'separate-split':
        this.breakSplitView(tabId);
        break;

      case 'mute':
        if (webview) {
          if (webview.isAudioMuted()) {
            webview.setAudioMuted(false);
          } else {
            webview.setAudioMuted(true);
          }
          this.updateTabMuteState(tabId);
        }
        break;
        
      case 'new-tab-right':
        this.addTabToTheRight(tabId);
        break;
        
      case 'move-to-new-window':
        this.moveTabToNewWindow(tabId);
        break;
        
      case 'pin':
        this.togglePinTab(tabId);
        break;
        
      case 'close-others':
        this.closeOtherTabs(tabId);
        break;
        
      case 'close':
        this.closeTab(tabId);
        break;

      case 'add-to-new-group':
        this.createTabGroup([tabId], {}, true); // Pass true to show edit dialog
        break;
        
      case 'remove-from-group':
        this.removeTabFromGroup(tabId);
        break;
        
      case 'add-to-existing-group':
        this.showAddToGroupSubmenu(tabId);
        break;
    }
  }

  // Duplicate a tab - creates new tab with same URL
  duplicateTab(tabId) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;
    
    const newTitle = tab.title === 'Home' ? 'Home' : `${tab.title} (Copy)`;
    
    // Find the position where we want to insert the duplicate tab
    const originalTabIndex = this.tabs.findIndex(t => t.id === tabId);
    const insertPosition = originalTabIndex + 1;
    
    // Create the new tab
    const newTabId = `tab-${this.tabCounter++}`;
    this.addTabWithId(newTabId, tab.url, newTitle);
    
    // Move it to the correct position immediately
    this.moveTabToPosition(newTabId, insertPosition);
    
    // Select the new tab and save state
    this.selectTab(newTabId, true);
    this.saveTabsState();
    
    // Focus address bar for new tabs
    setTimeout(() => {
      const urlInput = document.getElementById('url');
      if (urlInput) {
        urlInput.focus();
        urlInput.select();
      }
    }, 100);
    
    return newTabId;
  }

  // Add new tab to the right of specified tab
  addTabToTheRight(tabId) {
    const newTabId = this.addTab("peersky://home", "Home");
    
    const referenceIndex = this.tabs.findIndex(t => t.id === tabId);
    if (referenceIndex !== -1) {
      this.moveTabToPosition(newTabId, referenceIndex + 1);
    }
    
    return newTabId;
  }

  moveSplitGroupToNewWindow(tabIds) {
    const [leftId, rightId] = tabIds;
    
    const leftTab = this.tabs.find(t => t.id === leftId);
    const rightTab = this.tabs.find(t => t.id === rightId);
    const splitPair = this.splitPairs.find(s => s.leftTabId === leftId && s.rightTabId === rightId);
    const splitRatio = splitPair ? splitPair.splitRatio : 50;

    if (!leftTab || !rightTab) return;

    tabIds.forEach(tabId => {
      this.destroyHoverCard();
      const tabElement = document.getElementById(tabId);
      if (tabElement) tabElement.remove();

      const tabIndex = this.tabs.findIndex(t => t.id === tabId);
      if (tabIndex !== -1) this.tabs.splice(tabIndex, 1);

      const webview = this.webviews.get(tabId);
      if (webview) {
        webview.remove();
        this.webviews.delete(tabId);
      }

      this.pinnedTabs.delete(tabId);
      this.removeTabFromGroup(tabId);
    });

    const splitIndex = this.splitPairs.findIndex(s => s.leftTabId === leftId && s.rightTabId === rightId);
    if (splitIndex !== -1) this.splitPairs.splice(splitIndex, 1);

    if (tabIds.includes(this.activeTabId)) {
      if (this.tabs.length > 0) {
        this.selectTab(this.tabs[this.tabs.length - 1].id);
      }
    }

    this.saveTabsState();

    const { ipcRenderer } = require('electron');
    ipcRenderer.send('new-window-with-split-tabs', {
      leftUrl: leftTab.url,
      leftTitle: leftTab.title,
      rightUrl: rightTab.url,
      rightTitle: rightTab.title,
      splitRatio: splitRatio,
      isolate: true 
    });
  }

  moveTabToNewWindow(tabId) {
    this.destroyHoverCard(); // ensure card removed if this tab had it
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;
    
    // Prevent moving the last tab
    if (this.tabs.length === 1) {
      console.log('Cannot move the last tab to a new window');
      return;
    }
    
    const tabElement = document.getElementById(tabId);
    if (tabElement) {
      tabElement.remove();
    }
    
    // Remove from tabs array
    const tabIndex = this.tabs.findIndex(t => t.id === tabId);
    if (tabIndex !== -1) {
      this.tabs.splice(tabIndex, 1);
    }
    
    // Remove associated webview
    const webview = this.webviews.get(tabId);
    if (webview) {
      webview.remove();
      this.webviews.delete(tabId);
    }
    
    // Remove from pinned tabs if it was pinned
    this.pinnedTabs.delete(tabId);
    
    // Remove from group if it was grouped
    this.removeTabFromGroup(tabId);
    
    // If we moved the active tab, select another one
    if (this.activeTabId === tabId) {
      const newTabIndex = Math.max(0, tabIndex - 1);
      if (this.tabs[newTabIndex]) {
        this.selectTab(this.tabs[newTabIndex].id);
      }
    }
    
    // Save the current state (without the moved tab)
    this.saveTabsState();
    
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('new-window-with-tab', { 
      url: tab.url, 
      title: tab.title,
      isolate: true  // Remove tabId to prevent conflicts
    });
    
    // Dispatch event that tab was moved
    this.dispatchEvent(new CustomEvent("tab-moved-to-new-window", { 
      detail: { tabId, url: tab.url, title: tab.title } 
    }));
  }

  // Toggle pin state of a tab
  togglePinTab(tabId) {
    const tabElement = document.getElementById(tabId);
    if (!tabElement) return;

    if (this.pinnedTabs.has(tabId)) {
      // Unpin tab
      this.pinnedTabs.delete(tabId);
      tabElement.classList.remove('pinned');
    } else {
      // Pin tab
      this.pinnedTabs.add(tabId);
      tabElement.classList.add('pinned');
      
      // Move to leftmost position
      this.moveTabToPosition(tabId, 0);
    }
    
    this.saveTabsState();
  }

  // Move tab to specific position
  moveTabToPosition(tabId, position) {
    const tabIndex = this.tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;

    const maxPosition = this.tabs.length - 1;
    position = Math.max(0, Math.min(position, maxPosition));
    
    if (tabIndex === position) return;

    const [tab] = this.tabs.splice(tabIndex, 1);
    
    // Insert at new position in array
    this.tabs.splice(position, 0, tab);
    
    // Update DOM order safely
    const tabElement = document.getElementById(tabId);
    if (tabElement && this.tabContainer) {
      this.tabContainer.removeChild(tabElement);
      const addButton = this.tabContainer.querySelector('#add-tab');
      
      if (position === 0) {
        // Insert at beginning
        this.tabContainer.insertBefore(tabElement, this.tabContainer.firstChild);
      } else if (position >= this.tabs.length - 1) {
        // Insert at end
        if (addButton) {
          this.tabContainer.insertBefore(tabElement, addButton);
        } else {
          this.tabContainer.appendChild(tabElement);
        }
      } else {
        // Insert at specific position
        const nextTabId = this.tabs[position + 1].id;
        const nextTabElement = document.getElementById(nextTabId);
        if (nextTabElement) {
          this.tabContainer.insertBefore(tabElement, nextTabElement);
        } else {
          // Fallback to inserting before add button
          if (addButton) {
            this.tabContainer.insertBefore(tabElement, addButton);
          } else {
            this.tabContainer.appendChild(tabElement);
          }
        }
      }
    }
    
    this.saveTabsState();
  }

  // Close all tabs except the specified one
  closeOtherTabs(keepTabId) {
    const tabsToClose = this.tabs
      .filter(tab => tab.id !== keepTabId && !this.pinnedTabs.has(tab.id))
      .map(tab => tab.id);
    
    tabsToClose.forEach(tabId => {
      this.closeTab(tabId);
    });
  }

  // Update tab visual state based on mute status
  updateTabMuteState(tabId) {
    const tabElement = document.getElementById(tabId);
    const webview = this.webviews.get(tabId);
    
    if (tabElement && webview) {
      const titleElement = tabElement.querySelector('.tab-title');
      if (titleElement) {
        if (webview.isAudioMuted()) {
          tabElement.classList.add('muted');
          if (!titleElement.querySelector('.mute-indicator')) {
            const muteIndicator = document.createElement('span');
            muteIndicator.className = 'mute-indicator';
            muteIndicator.textContent = '🔇';
            muteIndicator.style.marginLeft = '4px';
            titleElement.appendChild(muteIndicator);
          }
        } else {
          tabElement.classList.remove('muted');
          const muteIndicator = titleElement.querySelector('.mute-indicator');
          if (muteIndicator) {
            muteIndicator.remove();
          }
        }
      }
    }
  }

  // Create a new tab group with the given tabs
  createTabGroup(tabIds, options = {}, showEditDialog = false) {
    const groupId = `group-${Date.now()}`;
    const colorIndex = Math.floor(Math.random() * this.groupColors.length);
    
    // Create the group metadata
    this.tabGroups.set(groupId, {
      id: groupId,
      name: options.name || '',
      color: options.color || this.groupColors[colorIndex],
      expanded: options.expanded !== undefined ? options.expanded : true
    });
    
    // Assign tabs to this group
    tabIds.forEach(tabId => {
      this.addTabToGroup(tabId, groupId);
    });
    
    // Create or update the group header
    this.renderGroupHeader(groupId);
    this.updateGroupedTabsUI();
    
    // Save the state
    this.saveTabsState();
    
    // Show the edit dialog immediately if requested
    if (showEditDialog) {
      setTimeout(() => this.showGroupEditDialog(groupId), 50);
    }
    
    return groupId;
  }

  // Add a tab to an existing group
  addTabToGroup(tabId, groupId) {
    // If tab is already in a group, remove it first
    if (this.tabGroupAssignments.has(tabId)) {
      this.removeTabFromGroup(tabId);
    }
    
    // Assign tab to new group
    this.tabGroupAssignments.set(tabId, groupId);
    
    // Update UI
    const tabElement = document.getElementById(tabId);
    if (tabElement) {
      tabElement.dataset.groupId = groupId;
      const group = this.tabGroups.get(groupId);
      if (group) {
        tabElement.style.borderTop = group.expanded ? '2px solid ' + group.color : 'none';
      }
    }
  }

  // Remove a tab from its group
  removeTabFromGroup(tabId) {
    const groupId = this.tabGroupAssignments.get(tabId);
    if (!groupId) return;
    
    // Remove assignment
    this.tabGroupAssignments.delete(tabId);
    
    // Update tab UI
    const tabElement = document.getElementById(tabId);
    if (tabElement) {
      delete tabElement.dataset.groupId;
      tabElement.style.borderTop = 'none';
    }
    
    // Check if group is now empty
    const groupHasTabs = Array.from(this.tabGroupAssignments.values()).some(gId => gId === groupId);
    if (!groupHasTabs) {
      this.deleteGroup(groupId);
    } else {
      this.renderGroupHeader(groupId);
    }
  }

  // Delete a group but keep its tabs
  deleteGroup(groupId) {
    if (!this.tabGroups.has(groupId)) return;
    
    // Remove all tabs from this group
    for (const [tabId, gId] of this.tabGroupAssignments.entries()) {
      if (gId === groupId) {
        const tabElement = document.getElementById(tabId);
        if (tabElement) {
          delete tabElement.dataset.groupId;
          tabElement.style.borderTop = 'none';
        }
        this.tabGroupAssignments.delete(tabId);
      }
    }
    
    // Remove the group header
    const header = document.getElementById(`group-header-${groupId}`);
    if (header) header.remove();
    
    // Delete group data
    this.tabGroups.delete(groupId);
    
    // Save state
    this.saveTabsState();
  }

  // Update only the toggle button without recreating the header
  updateGroupToggleButton(groupId) {
    const group = this.tabGroups.get(groupId);
    if (!group) return;
    
    const header = document.getElementById(`group-header-${groupId}`);
    if (!header) return;
    
    const toggleButton = header.querySelector('.tab-group-toggle');
    if (toggleButton) {
      toggleButton.textContent = group.expanded ? '▾' : '▸';
      toggleButton.title = group.expanded ? 'Collapse group' : 'Expand group';
    }
  }

  // Toggle group collapse state
  toggleGroupCollapse(groupId) {
    const group = this.tabGroups.get(groupId);
    if (!group) {
      console.log(`Group ${groupId} not found`);
      return;
    }
    
    console.log(`Toggling group ${groupId} from ${group.expanded} to ${!group.expanded}`);
    
    // Toggle the expanded state
    group.expanded = !group.expanded;
    
    // Update the UI immediately
    this.updateGroupedTabsUI();
    
    // UPDATE: Only update the toggle button text, don't re-render the entire header
    this.updateGroupToggleButton(groupId);
    
    // Save state
    this.saveTabsState();
    
    console.log(`Group ${groupId} is now ${group.expanded ? 'expanded' : 'collapsed'}`);
  }

  // Update group properties
  updateGroupProperties(groupId, properties) {
    const group = this.tabGroups.get(groupId);
    if (!group) return;
    
    if (properties.name !== undefined) group.name = properties.name;
    if (properties.color !== undefined) group.color = properties.color;
    if (properties.expanded !== undefined) group.expanded = properties.expanded;
    
    // Update local UI
    this.renderGroupHeader(groupId);
    this.updateGroupedTabsUI();
    
    // Update all tab borders for this group
    if (properties.color !== undefined) {
      for (const [tabId, gId] of this.tabGroupAssignments.entries()) {
        if (gId === groupId) {
          const tabElement = document.getElementById(tabId);
          if (tabElement && group.expanded) {
            tabElement.style.borderTop = '2px solid ' + properties.color;
          }
        }
      }
    }
    
    // Broadcast changes to all other windows
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('update-group-properties', groupId, properties);
    
    // Save state
    this.saveTabsState();
  }

  // TODO: There are two handleGroupContextMenuAction() implementations. This one is overwritten by the later definition — decide which one to keep.
  // Enhanced handleGroupContextMenuAction to work with groups from any window
  handleGroupContextMenuAction(action, groupId) {
    console.log(`Handling group action: ${action} for group: ${groupId}`);
    
    switch (action) {
      case 'add-tab':
        const newTabId = this.addTab("peersky://home", "Home");
        this.addTabToGroupAcrossWindows(newTabId, groupId);
        break;
        
      case 'edit':
        this.showGroupEditDialogAcrossWindows(groupId);
        break;
        
      case 'toggle':
        this.toggleGroupCollapseAcrossWindows(groupId);
        break;
        
      case 'ungroup':
        this.deleteGroupAcrossWindows(groupId);
        break;
        
      case 'close-group':
        this.closeTabsInGroupAcrossWindows(groupId);
        break;
    }
  }

  // Show group edit dialog for groups that might exist in other windows
  showGroupEditDialogAcrossWindows(groupId) {
    let group = this.tabGroups.get(groupId);
    
    // If group doesn't exist locally, get it from all windows data
    if (!group) {
      const allGroups = this.getAllTabGroups();
      group = allGroups.get(groupId);
      
      if (!group) {
        console.error(`Group ${groupId} not found in any window`);
        return;
      }
      
      // Create the group locally with same properties
      this.tabGroups.set(groupId, {
        id: groupId,
        name: group.name,
        color: group.color,
        expanded: group.expanded !== undefined ? group.expanded : true
      });
    }
    
    // Show the edit dialog
    this.showGroupEditDialog(groupId);
  }

  // Toggle group collapse across all windows
  toggleGroupCollapseAcrossWindows(groupId) {
    let group = this.tabGroups.get(groupId);
    
    if (!group) {
      // Group doesn't exist locally, get from all windows
      const allGroups = this.getAllTabGroups();
      const sourceGroup = allGroups.get(groupId);
      
      if (!sourceGroup) {
        console.error(`Group ${groupId} not found`);
        return;
      }
      
      // Create local group
      group = {
        id: groupId,
        name: sourceGroup.name,
        color: sourceGroup.color,
        expanded: sourceGroup.expanded !== undefined ? sourceGroup.expanded : true
      };
      this.tabGroups.set(groupId, group);
    }
    
    // Toggle the state
    group.expanded = !group.expanded;
    
    // Broadcast the change to all windows
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('update-group-properties', groupId, { expanded: group.expanded });
    
    // Update local UI
    this.updateGroupedTabsUI();
    this.updateGroupToggleButton(groupId);
    this.saveTabsState();
  }

  // Delete group across all windows
  deleteGroupAcrossWindows(groupId) {
    // Remove local group if it exists
    if (this.tabGroups.has(groupId)) {
      this.deleteGroup(groupId);
    }
    
    // Broadcast deletion to all windows
    const { ipcRenderer } = require('electron');
    ipcRenderer.send('update-group-properties', groupId, { delete: true });
  }

  // Close tabs in group across all windows
  closeTabsInGroupAcrossWindows(groupId) {
    // Close local tabs in this group
    const tabIds = Array.from(this.tabGroupAssignments.entries())
      .filter(([_, gId]) => gId === groupId)
      .map(([tabId, _]) => tabId);
    
    [...tabIds].forEach(tabId => {
      this.closeTab(tabId);
    });
    
    // The group deletion will be handled by deleteGroupAcrossWindows if empty
    if (tabIds.length > 0) {
      this.deleteGroupAcrossWindows(groupId);
    }
  }

  // Method to handle external group property updates
  updateGroupPropertiesFromExternal(groupId, properties) {
    console.log(`External update for group ${groupId}:`, properties);
    
    // Handle group deletion
    if (properties.delete) {
      if (this.tabGroups.has(groupId)) {
        this.deleteGroup(groupId);
      }
      return;
    }
    
    let group = this.tabGroups.get(groupId);
    
    // Create group locally if it doesn't exist
    if (!group) {
      group = {
        id: groupId,
        name: properties.name || '',
        color: properties.color || this.groupColors[0],
        expanded: properties.expanded !== undefined ? properties.expanded : true
      };
      this.tabGroups.set(groupId, group);
    } else {
      // Update existing group
      if (properties.name !== undefined) group.name = properties.name;
      if (properties.color !== undefined) group.color = properties.color;
      if (properties.expanded !== undefined) group.expanded = properties.expanded;
    }
    
    // Update UI
    this.renderGroupHeader(groupId);
    this.updateGroupedTabsUI();
    
    // Update tab borders for this group
    if (properties.color !== undefined) {
      for (const [tabId, gId] of this.tabGroupAssignments.entries()) {
        if (gId === groupId) {
          const tabElement = document.getElementById(tabId);
          if (tabElement && group.expanded) {
            tabElement.style.borderTop = '2px solid ' + properties.color;
          }
        }
      }
    }
    
    // Save state
    this.saveTabsState();
  }

  // Create/update the group header element
  renderGroupHeader(groupId) {
    const group = this.tabGroups.get(groupId);
    if (!group) return;
    
    // Find all tabs in this group
    const groupTabIds = Array.from(this.tabGroupAssignments.entries())
      .filter(([_, gId]) => gId === groupId)
      .map(([tabId, _]) => tabId);
    
    if (groupTabIds.length === 0) return;
    
    // Find the first tab element in this group to position the header
    const firstTabId = groupTabIds[0];
    const firstTabElement = document.getElementById(firstTabId);
    
    if (!firstTabElement) return;
    
    // Check if header already exists
    let header = document.getElementById(`group-header-${groupId}`);
    const headerExists = !!header;
    
    if (!header) {
      header = document.createElement('div');
      header.id = `group-header-${groupId}`;
      header.className = 'tab-group-header';
      
      // Insert before the first tab in the group
      this.tabContainer.insertBefore(header, firstTabElement);
    }
    
    // Update header style
    header.style.backgroundColor = group.color;
    
    // Only recreate content if header is new
    if (!headerExists) {
      // Clear any existing content
      header.innerHTML = '';
      
      // Create toggle button
      const toggleButton = document.createElement('div');
      toggleButton.className = 'tab-group-toggle';
      toggleButton.title = group.expanded ? 'Collapse group' : 'Expand group';
      toggleButton.textContent = group.expanded ? '▾' : '▸';
      
      // Create title element
      const titleElement = document.createElement('div');
      titleElement.className = 'tab-group-title';
      titleElement.title = group.name || 'Unnamed group';
      titleElement.textContent = group.name || 'Unnamed group';
      
      // Create controls container
      const controlsContainer = document.createElement('div');
      controlsContainer.className = 'tab-group-controls';
      
      // Create edit button
      const editButton = document.createElement('span');
      editButton.className = 'tab-group-edit';
      editButton.title = 'Edit group';
      editButton.textContent = '✎';
      
      // Create close button
      const closeButton = document.createElement('span');
      closeButton.className = 'tab-group-close';
      closeButton.title = 'Close group';
      closeButton.textContent = '×';
      
      // Append controls
      controlsContainer.appendChild(editButton);
      controlsContainer.appendChild(closeButton);
      
      // Append all elements to header
      header.appendChild(toggleButton);
      header.appendChild(titleElement);
      header.appendChild(controlsContainer);
      
      // Add event listeners ONLY when creating new header
      toggleButton.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        
        console.log(`Toggle button clicked for group ${groupId}`);
        
        // Toggle the group state
        this.toggleGroupCollapse(groupId);
        
        return false; // Prevent any event bubbling
      });
      
      editButton.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showGroupEditDialog(groupId);
      });
      
      closeButton.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeTabsInGroup(groupId);
      });
      
      // Add right-click context menu for the header
      header.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showGroupContextMenu(e, groupId);
      });
    } else {
      // If header exists, just update the content without recreating event listeners
      const titleElement = header.querySelector('.tab-group-title');
      if (titleElement) {
        titleElement.title = group.name || 'Unnamed group';
        titleElement.textContent = group.name || 'Unnamed group';
      }
      
      // Update toggle button
      this.updateGroupToggleButton(groupId);
    }
  }

  // Update visibility of tabs based on group collapse state
  updateGroupedTabsUI() {
    console.log('Updating grouped tabs UI');
    
    // First reset all tabs to default state
    this.tabs.forEach(tab => {
      const tabElement = document.getElementById(tab.id);
      if (tabElement) {
        tabElement.style.display = '';
      }
    });
    
    // Then hide tabs in collapsed groups
    for (const [groupId, group] of this.tabGroups.entries()) {
      console.log(`Group ${groupId}: expanded=${group.expanded}`);
      
      if (!group.expanded) {
        for (const [tabId, gId] of this.tabGroupAssignments.entries()) {
          if (gId === groupId) {
            const tabElement = document.getElementById(tabId);
            if (tabElement) {
              console.log(`Hiding tab ${tabId} in collapsed group ${groupId}`);
              tabElement.style.display = 'none';
              
              // If this is the active tab, activate another visible tab
              if (tabId === this.activeTabId) {
                const visibleTabs = this.tabs.filter(t => 
                  !this.tabGroupAssignments.has(t.id) || 
                  this.tabGroups.get(this.tabGroupAssignments.get(t.id))?.expanded
                );
                if (visibleTabs.length > 0) {
                  console.log(`Switching active tab from ${tabId} to ${visibleTabs[0].id}`);
                  this.selectTab(visibleTabs[0].id);
                }
              }
            }
          }
        }
      } else {
        // Make sure tabs in expanded groups are visible
        for (const [tabId, gId] of this.tabGroupAssignments.entries()) {
          if (gId === groupId) {
            const tabElement = document.getElementById(tabId);
            if (tabElement) {
              console.log(`Showing tab ${tabId} in expanded group ${groupId}`);
              tabElement.style.display = '';
            }
          }
        }
      }
    }
  }

  refreshGroupStyles() {
    // First, ensure all tabs in groups have the correct styling
    for (const [tabId, groupId] of this.tabGroupAssignments.entries()) {
      const tabElement = document.getElementById(tabId);
      const group = this.tabGroups.get(groupId);
      
      if (tabElement && group) {
        tabElement.dataset.groupId = groupId;
        if (group.expanded) {
          tabElement.style.borderTop = `2px solid ${group.color}`;
        } else {
          tabElement.style.borderTop = 'none';
        }
      }
    }
  
    // Ensure all group headers are positioned correctly and have correct colors
    for (const groupId of this.tabGroups.keys()) {
      this.renderGroupHeader(groupId);
    }
    
    // Make sure collapsed groups stay collapsed
    this.updateGroupedTabsUI();
  }

  // Show dialog to edit group name and color
  showGroupEditDialog(groupId) {
    const group = this.tabGroups.get(groupId);
    if (!group) return;
    
    // Create overlay background for modal effect
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.right = '0';
    overlay.style.bottom = '0';
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    overlay.style.zIndex = '10000';
    document.body.appendChild(overlay);
    
    // Create dialog if it doesn't exist
    let dialog = document.getElementById('tab-group-edit-dialog');
    if (!dialog) {
      dialog = document.createElement('div');
      dialog.id = 'tab-group-edit-dialog';
      dialog.className = 'tab-group-dialog';
      document.body.appendChild(dialog);
    }
    
    // Set title based on whether this is a new or existing group
    const isNewGroup = !group.name;
    const dialogTitle = isNewGroup ? 'Create new tab group' : 'Edit group';
    
    // Populate dialog
    dialog.innerHTML = `
      <h1>${dialogTitle}</h1>
      <div class="dialog-row">
        <input type="text" id="group-name" value="${group.name || ''}" placeholder="Enter group name">
      </div>
      <div class="dialog-row">
        <div class="color-options">
          ${this.groupColors.map(color => 
            `<div class="color-option ${color === group.color ? 'selected' : ''}" 
                  style="background-color: ${color}" data-color="${color}"></div>`
          ).join('')}
        </div>
      </div>
      <div class="dialog-buttons">
        <button id="group-edit-cancel">Cancel</button>
        <button id="group-edit-save">Save</button>
      </div>
    `;
    
    // Center the dialog in the viewport
    dialog.style.position = 'fixed';
    dialog.style.top = '50%';
    dialog.style.left = '50%';
    dialog.style.transform = 'translate(-50%, -50%)';
    dialog.style.zIndex = '10001';
    
    // Add event listeners
    dialog.querySelectorAll('.color-option').forEach(option => {
      option.addEventListener('click', (e) => {
        dialog.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
        e.target.classList.add('selected');
      });
    });
    
    document.getElementById('group-edit-cancel').addEventListener('click', () => {
      dialog.remove();
      overlay.remove();
      
      // If canceling a new group creation, delete the empty group
      if (isNewGroup) {
        this.deleteGroup(groupId);
      }
    });
    
    document.getElementById('group-edit-save').addEventListener('click', () => {
      const name = document.getElementById('group-name').value;
      const color = dialog.querySelector('.color-option.selected')?.dataset.color || group.color;
      
      this.updateGroupProperties(groupId, { name, color });
      dialog.remove();
      overlay.remove();
    });
    
    // Auto-focus the name input
    setTimeout(() => {
      const nameInput = document.getElementById('group-name');
      if (nameInput) {
        nameInput.focus();
        nameInput.select();
      }
    }, 50);
    
    // Show dialog
    dialog.style.display = 'block';
  }

  // Show context menu for a group header
  showGroupContextMenu(event, groupId) {
    const group = this.tabGroups.get(groupId);
    if (!group) return;
    
    // Remove existing context menu if any
    const existingMenu = document.querySelector('.tab-context-menu');
    if (existingMenu) {
      existingMenu.remove();
    }
    
    const menu = document.createElement('div');
    menu.className = 'tab-context-menu';
    menu.style.position = 'fixed';
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    menu.style.zIndex = '10000';
    
    const iconPath = 'peersky://static/assets/svg';

    menu.innerHTML = `
      <div class="context-menu-item" data-action="add-tab">
        <img class="menu-icon" src="${iconPath}/add.svg" />
        Add new tab to group
      </div>
      <div class="context-menu-item" data-action="edit">
        <img class="menu-icon" src="${iconPath}/pencil-square.svg" />
        Edit group
      </div>
      <div class="context-menu-item" data-action="toggle">
        <img class="menu-icon" src="${iconPath}/collapse.svg" />
        ${group.expanded ? 'Collapse group' : 'Expand group'}
      </div>
      <div class="context-menu-separator"></div>
      <div class="context-menu-item" data-action="ungroup">
        <img class="menu-icon" src="${iconPath}/folder-minus.svg" />
        Ungroup tabs
      </div>
      <div class="context-menu-item" data-action="close-group">
        <img class="menu-icon" src="${iconPath}/close.svg" />
        Close group
      </div>
    `;
    
    // Add event listeners to menu items
    menu.addEventListener('click', (e) => {
      const action = e.target.closest('.context-menu-item')?.dataset.action;
      if (action) {
        this.handleGroupContextMenuAction(action, groupId);
        menu.remove();
      }
    });
    
    // Close menu when clicking outside
    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    
    setTimeout(() => {
      document.addEventListener('click', closeMenu);
    }, 0);
    
    document.body.appendChild(menu);
  }

  // TODO: This overrides the earlier enhanced version — remove or merge the logic.
  // Handle group context menu actions
  handleGroupContextMenuAction(action, groupId) {
    switch (action) {
      case 'add-tab':
        const newTabId = this.addTab("peersky://home", "Home");
        this.addTabToGroup(newTabId, groupId);
        break;
        
      case 'edit':
        this.showGroupEditDialog(groupId);
        break;
        
      case 'toggle':
        this.toggleGroupCollapse(groupId);
        break;
        
      case 'ungroup':
        this.deleteGroup(groupId);
        break;
        
      case 'close-group':
        this.closeTabsInGroup(groupId);
        break;
    }
  }

  // Close all tabs in a group
  closeTabsInGroup(groupId) {
    const tabIds = Array.from(this.tabGroupAssignments.entries())
      .filter(([_, gId]) => gId === groupId)
      .map(([tabId, _]) => tabId);
    
    // Make a copy since closeTab modifies the collection
    [...tabIds].forEach(tabId => {
      this.closeTab(tabId);
    });
    
    // The group should be automatically deleted when empty
  }

  // Show submenu to select which group to add the tab to
  showAddToGroupSubmenu(tabId) {
    const tabElement = document.getElementById(tabId);
    if (!tabElement) return;
    
    const submenu = document.createElement('div');
    submenu.className = 'tab-context-submenu';
    
    // Get all groups from all windows
    const allGroups = this.getAllTabGroups();
    
    let submenuHtml = '';
    
    if (allGroups.size > 0) {
      for (const [groupId, group] of allGroups) {
        submenuHtml += `
          <div class="context-menu-item" data-group-id="${groupId}">
            <span class="menu-icon" style="background-color: ${group.color}; width: 10px; height: 10px; border-radius: 50%;"></span>
            ${group.name || 'Unnamed group'}
          </div>
        `;
      }
    } else {
      submenuHtml = '<div class="context-menu-item disabled">No groups available</div>';
    }
    
    submenu.innerHTML = submenuHtml;
    
    // Position submenu next to the "Add to group" menu item
    const menuItem = document.querySelector('.context-menu-item[data-action="add-to-existing-group"]');
    if (menuItem) {
      const rect = menuItem.getBoundingClientRect();
      submenu.style.position = 'fixed';
      submenu.style.left = `${rect.right}px`;
      submenu.style.top = `${rect.top}px`;
      submenu.style.zIndex = '10001';
    }
    
    // Add event listeners
    submenu.addEventListener('click', (e) => {
      const groupId = e.target.closest('.context-menu-item')?.dataset.groupId;
      if (groupId && !e.target.closest('.context-menu-item').classList.contains('disabled')) {
        this.addTabToGroupAcrossWindows(tabId, groupId);
        document.querySelector('.tab-context-menu')?.remove();
        submenu.remove();
      }
    });
    
    // Ensure submenu doesn't go off screen
    document.body.appendChild(submenu);
    const submenuRect = submenu.getBoundingClientRect();
    if (submenuRect.right > window.innerWidth) {
      submenu.style.left = `${window.innerWidth - submenuRect.width - 10}px`;
    }
    if (submenuRect.bottom > window.innerHeight) {
      submenu.style.top = `${window.innerHeight - submenuRect.height - 10}px`;
    }
  }

  // Add a tab to a group that might be in another window
  addTabToGroupAcrossWindows(tabId, groupId) {
    // Check if group exists in current window
    if (this.tabGroups.has(groupId)) {
      // Local group - use existing method
      this.addTabToGroup(tabId, groupId);
      return;
    }
    
    // Group is in another window - need to create it locally first
    const allGroups = this.getAllTabGroups();
    const targetGroup = allGroups.get(groupId);
    
    if (!targetGroup) {
      console.error(`Group ${groupId} not found`);
      return;
    }
    
    // Create the group in current window with same properties
    this.tabGroups.set(groupId, {
      id: groupId,
      name: targetGroup.name,
      color: targetGroup.color,
      expanded: targetGroup.expanded !== undefined ? targetGroup.expanded : true
    });
    
    // Add tab to the group
    this.addTabToGroup(tabId, groupId);
    
    // Render group header and update UI
    this.renderGroupHeader(groupId);
    this.updateGroupedTabsUI();
    
    // Save state
    this.saveTabsState();
  }

  animateTabReorder() {
    const isVert = this.isVertical;
    const elements = [...this.tabContainer.querySelectorAll('.tab:not(.dragging), #add-tab')];

    const firstRects = new Map();
    
    elements.forEach(el => {
      firstRects.set(el, el.getBoundingClientRect());
      el.style.transition = 'none';
    });

    requestAnimationFrame(() => {
      elements.forEach(el => {
        const last = el.getBoundingClientRect();
        const first = firstRects.get(el);
        if (!first) return;

        const dx = first.left - last.left;
        const dy = first.top - last.top;

        if (isVert && dy !== 0) {
          el.style.transform = `translateY(${dy}px)`;
          requestAnimationFrame(() => {
            el.style.transition = 'transform 0.15s cubic-bezier(0.25, 0.8, 0.25, 1)';
            el.style.transform = '';
          });
          el.addEventListener('transitionend', () => { el.style.transition = ''; }, { once: true });
        } else if (!isVert && dx !== 0) {
          el.style.transform = `translateX(${dx}px)`;

          requestAnimationFrame(() => {
            el.style.transition = 'transform 0.15s cubic-bezier(0.25, 0.8, 0.25, 1)';
            el.style.transform = '';
          });
          el.addEventListener('transitionend', () => { el.style.transition = ''; }, { once: true });
        } else {
          el.style.transition = ''; 
        }
      });
    });
  }

  get isVertical() {
    return document.body.classList.contains('vertical-tabs-layout') || getComputedStyle(this.tabContainer).flexDirection === 'column';
  }

  // Drag and Drop Handlers
  handlePointerDown(e) {
    // Only accept left-clicks. Ignore clicks on close buttons or the add tab button.
    if (e.button !== 0 || e.target.closest('.close-tab') || e.target.closest('.add-tab-button')) return;

    const tab = e.target.closest('.tab');
    if (!tab) return;

    const split = this.getSplitForTab(tab.id);
    if (split) {
      const leftTab = document.getElementById(split.leftTabId);
      const rightTab = document.getElementById(split.rightTabId);
      this.draggedElements = [leftTab, rightTab].filter(Boolean);
    } else {
      this.draggedElements = [tab];
    }

    this.primaryDragTarget = tab;
    
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    this.isDragging = false;
    this.isOutsideContainer = false;

    this.onPointerMove = this.handlePointerMove.bind(this);
    this.onPointerUp = this.handlePointerUp.bind(this);

    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp); // Catch system interruptions
  }

  handlePointerMove(e) {
    if (!this.draggedElements || this.draggedElements.length === 0) return;

    const isVert = this.isVertical;
    const dx = e.clientX - this.dragStartX;
    const dy = e.clientY - this.dragStartY;

    if (!this.isDragging && Math.hypot(dx, dy) > 3) {
      this.isDragging = true;
      this.destroyHoverCard();

      // Collect bounding rects
      const rects = this.draggedElements.map(el => el.getBoundingClientRect());

      // Calculate total width and height dynamically based on layout mode
      let totalWidth = 0;
      let totalHeight = 0;

      if (isVert) {
        // Vertical mode: stack heights, use max width
        totalWidth = Math.max(...rects.map(r => r.width));
        totalHeight = rects.reduce((sum, r) => sum + r.height, 0);
      } else {
        // Horizontal mode: stack widths, use max height
        totalWidth = rects.reduce((sum, r) => sum + r.width, 0);
        totalHeight = Math.max(...rects.map(r => r.height));
      }

      this.dragOffsetLeft = e.clientX - rects[0].left;
      this.dragOffsetTop = e.clientY - rects[0].top;

      this.placeholder = document.createElement('div');
      this.placeholder.className = 'tab-placeholder';
      this.placeholder.style.width = `${totalWidth}px`;
      this.placeholder.style.height = `${totalHeight}px`;

      this.draggedElements[0].parentNode.insertBefore(this.placeholder, this.draggedElements[0]);

      if (this.webviewContainer) {
        this.webviewContainer.style.pointerEvents = 'none';
      }

      this.isMovingDOM = true;
      this.draggedElements.forEach(el => document.body.appendChild(el));
      this.isMovingDOM = false;

      try { this.primaryDragTarget.setPointerCapture(e.pointerId); } catch(err) {}

      // Apply drag styles to all involved elements and capture BOTH offsets
      this.draggedElements.forEach((el, index) => {
        el.classList.add('dragging');
        el.style.setProperty('position', 'fixed', 'important');
        el.style.zIndex = '9999';
        el.style.width = `${rects[index].width}px`;
        el.style.height = `${rects[index].height}px`;
        
        el.dataset.dragOffsetX = index === 0 ? 0 : (rects[index].left - rects[0].left);
        el.dataset.dragOffsetY = index === 0 ? 0 : (rects[index].top - rects[0].top);
      });

      this.dragTotalWidth = totalWidth;
      this.dragTotalHeight = totalHeight;
    }

    if (this.isDragging) {
      if (isVert) {
        this.isOutsideContainer = Math.abs(dx) > 40; 
      } else {
        this.isOutsideContainer = Math.abs(dy) > 30; 
      }

      const floatLeft = e.clientX - this.dragOffsetLeft;
      const floatTop = e.clientY - this.dragOffsetTop;

      if (this.isOutsideContainer) {
        this.draggedElements.forEach(el => {
          const offsetX = parseFloat(el.dataset.dragOffsetX || 0);
          const offsetY = parseFloat(el.dataset.dragOffsetY || 0);
          el.style.left = `${floatLeft + offsetX}px`;
          el.style.top = `${floatTop + offsetY}px`;
        });
        if (this.placeholder) this.placeholder.style.display = 'none';
      } else {
        const placeholderRect = this.placeholder.getBoundingClientRect();
        
        this.draggedElements.forEach(el => {
          const offsetX = parseFloat(el.dataset.dragOffsetX || 0);
          const offsetY = parseFloat(el.dataset.dragOffsetY || 0);
          if (isVert) {
            el.style.left = `${placeholderRect.left + offsetX}px`;
            el.style.top = `${floatTop + offsetY}px`;
          } else {
            el.style.top = `${placeholderRect.top + offsetY}px`;
            el.style.left = `${floatLeft + offsetX}px`;
          }
        });
        
        if (this.placeholder) this.placeholder.style.display = '';

        const draggedCenterRelative = isVert ? 
              (floatTop + this.dragTotalHeight / 2) : 
              (floatLeft + this.dragTotalWidth / 2);
        
        const tabs = Array.from(this.tabContainer.querySelectorAll('.tab:not(.dragging)'));
        
        const logicalTargets = [];
        for (let i = 0; i < tabs.length; i++) {
          const tab = tabs[i];
          
          if (tab.classList.contains('split-left')) {
            const nextTab = tabs[i + 1];
            if (nextTab && nextTab.classList.contains('split-right')) {
              const r1 = tab.getBoundingClientRect();
              const r2 = nextTab.getBoundingClientRect();
              
              logicalTargets.push({
                elementToInsertBefore: tab,
                rect: {
                  top: Math.min(r1.top, r2.top),
                  left: Math.min(r1.left, r2.left),
                  width: isVert ? Math.max(r1.width, r2.width) : (r1.width + r2.width),
                  height: isVert ? (r1.height + r2.height) : Math.max(r1.height, r2.height)
                }
              });
              
              i++; 
              continue;
            }
          }
          
          logicalTargets.push({
            elementToInsertBefore: tab,
            rect: tab.getBoundingClientRect()
          });
        }

        let insertBeforeTab = null;

        for (let target of logicalTargets) {
          const tabCenterRelative = isVert ? 
                (target.rect.top + target.rect.height / 2) : 
                (target.rect.left + target.rect.width / 2);
          
          if (draggedCenterRelative < tabCenterRelative) {
            insertBeforeTab = target.elementToInsertBefore;
            break;
          }
        }

        const targetNode = insertBeforeTab || this.tabContainer.querySelector('#add-tab');
        if (this.placeholder.nextElementSibling !== targetNode) {
          this.animateTabReorder(); 
          this.tabContainer.insertBefore(this.placeholder, targetNode);
        }
      }
    }
  }

  handlePointerUp(e) {
    if (e.type === 'pointercancel' && this.isMovingDOM) return;

    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp); 

    // Re-enable webview mouse events!
    if (this.webviewContainer) {
      this.webviewContainer.style.pointerEvents = '';
    }

    if (!this.isDragging || !this.draggedElements) {
      if (this.primaryDragTarget) {
        try { this.primaryDragTarget.releasePointerCapture(e.pointerId); } catch(err) {}
      }
      this.draggedElements = null;
      this.primaryDragTarget = null;
      return;
    }

    try { this.primaryDragTarget.releasePointerCapture(e.pointerId); } catch(err) {}
    this.isDragging = false;
    
    const idsToMove = this.draggedElements.map(el => el.id);

    if (this.isOutsideContainer && this.tabs.length > this.draggedElements.length) {
      this.draggedElements.forEach(el => {
        el.classList.remove('dragging');
        el.remove();
      });
      
      if (this.placeholder && this.placeholder.parentNode) {
        this.placeholder.remove();
      }
      
      this.placeholder = null;
      this.draggedElements = null;
      this.primaryDragTarget = null;
      this.isOutsideContainer = false;

      if (idsToMove.length === 1) {
        this.moveTabToNewWindow(idsToMove[0]);
      } else if (idsToMove.length === 2) {
        this.moveSplitGroupToNewWindow(idsToMove);
      }
      return;
    }

    if (this.placeholder) this.placeholder.style.display = '';
    const placeholderRect = this.placeholder ? this.placeholder.getBoundingClientRect() : { left: 0, top: 0 };

    this.draggedElements.forEach(el => {
      el.classList.remove('dragging');
      el.style.transition = 'all 0.2s cubic-bezier(0.25, 0.8, 0.25, 1)';
      const offsetX = parseFloat(el.dataset.dragOffsetX || 0);
      const offsetY = parseFloat(el.dataset.dragOffsetY || 0);

      if (this.placeholder) {
        el.style.left = `${placeholderRect.left + offsetX}px`;
        el.style.top = `${placeholderRect.top + offsetY}px`;
      }
    });

    const elementsToCleanup = this.draggedElements;
    this.draggedElements = null;
    this.primaryDragTarget = null;

    setTimeout(() => {
      elementsToCleanup.forEach(el => {
        el.style.position = '';
        el.style.left = '';
        el.style.top = '';
        el.style.width = '';
        el.style.height = '';
        el.style.transition = '';
        el.style.zIndex = '';
        delete el.dataset.dragOffsetX;
        delete el.dataset.dragOffsetY;

        if (this.placeholder && this.placeholder.parentNode) {
          this.tabContainer.insertBefore(el, this.placeholder);
        } else {
          this.tabContainer.appendChild(el);
        }
      });

      if (this.placeholder) {
        this.placeholder.remove();
        this.placeholder = null;
      }

      const newTabOrderIds = Array.from(this.tabContainer.querySelectorAll('.tab')).map(el => el.id);
      this.tabs.sort((a, b) => newTabOrderIds.indexOf(a.id) - newTabOrderIds.indexOf(b.id));

      this.saveTabsState();
      this.refreshGroupStyles();

    }, 200);
  }

  // Split View Divider Drag Handlers

  handleDividerPointerDown(e) {
    e.preventDefault();

    this.activeDividerSplit = this.getSplitForTab(this.activeTabId);
    if (!this.activeDividerSplit) return;

    this.isDraggingDivider = true;

    if (this.webviewContainer) {
      this.webviewContainer.style.pointerEvents = 'none';
    }

    const divider = document.getElementById('split-view-divider');
    if (divider) divider.classList.add('dragging');

    this.onDividerMove = this.handleDividerPointerMove.bind(this);
    this.onDividerUp = this.handleDividerPointerUp.bind(this);

    window.addEventListener('pointermove', this.onDividerMove);
    window.addEventListener('pointerup', this.onDividerUp);
  }

  handleDividerPointerMove(e) {
    if (!this.isDraggingDivider || !this.activeDividerSplit) return;

    const containerRect = this.webviewContainer.getBoundingClientRect();

    let newRatio = ((e.clientX - containerRect.left) / containerRect.width) * 100;

    newRatio = Math.max(10, Math.min(newRatio, 90));

    // Update the state
    this.activeDividerSplit.splitRatio = newRatio;

    const leftWv = this.webviews.get(this.activeDividerSplit.leftTabId);
    const rightWv = this.webviews.get(this.activeDividerSplit.rightTabId);

    if (leftWv && rightWv) {
      leftWv.style.flex = `0 0 ${newRatio}%`;
      rightWv.style.flex = `0 0 ${100 - newRatio}%`;
    }
  }

  handleDividerPointerUp(e) {
    if (!this.isDraggingDivider) return;
    this.isDraggingDivider = false;

    const divider = document.getElementById('split-view-divider');
    if (divider) divider.classList.remove('dragging');

    if (this.webviewContainer) {
      this.webviewContainer.style.pointerEvents = '';
    }

    window.removeEventListener('pointermove', this.onDividerMove);
    window.removeEventListener('pointerup', this.onDividerUp);

    this.saveTabsState(); 
  }

  // --- P2P Protocol Helpers ---

  _getProtocol(url) {
    if (url.startsWith('ipfs://') || url.startsWith('ipns://')) {
      return 'ipfs';
    }
    if (url.startsWith('hyper://')) {
      return 'hyper';
    }
    if (url.startsWith('hs://')) {
      return 'hs';
    }
    if (url.startsWith('web3://')) {
      return 'web3';
    }
    if (url.startsWith('bt://') || url.startsWith('bittorrent://') || url.startsWith('magnet:')) {
      return 'bt';
    }
    if (url.startsWith('peersky://') || url.startsWith('browser://')) {
      return 'peersky';
    }
    return 'http';
  }

  _updateP2PIndicator(tabId) {
    const tab = this.tabs.find(t => t.id === tabId);
    const tabElement = document.getElementById(tabId);
    if (!tab || !tabElement) return;

    let indicator = tabElement.querySelector('.p2p-indicator');
    const protocol = this._getProtocol(tab.url);

    if (['ipfs', 'hyper', 'web3', 'bt', 'hs'].includes(protocol)) {
      if (!indicator) {
        indicator = document.createElement('img');
        indicator.className = 'p2p-indicator';
        indicator.src = 'peersky://static/assets/svg/diamond-fill.svg';
        indicator.style.width = '8px';
        indicator.style.height = '8px';
        indicator.style.marginLeft = '4px';
      
        const favicon = tabElement.querySelector('.tab-favicon');
        if (favicon) {
          favicon.insertAdjacentElement('afterend', indicator);
        } else {
          tabElement.prepend(indicator);
        }
      }
    
      let filterColor;
      switch (protocol) {
        case 'bt':
          // Light green filter
          filterColor = 'brightness(0) saturate(100%) invert(71%) sepia(48%) saturate(651%) hue-rotate(74deg) brightness(105%) contrast(92%)';
          break;
        case 'hyper':
          // Light violet filter
          filterColor = 'brightness(0) saturate(100%) invert(81%) sepia(36%) saturate(1211%) hue-rotate(266deg) brightness(95%) contrast(98%)';
          break;
        case 'ipfs':
          // Cyan filter
          filterColor = 'brightness(0) saturate(100%) invert(70%) sepia(98%) saturate(1780%) hue-rotate(154deg) brightness(101%) contrast(101%)';
          break;
        case 'hs':
          filterColor = 'brightness(0) saturate(100%) invert(81%) sepia(36%) saturate(1211%) hue-rotate(266deg) brightness(95%) contrast(98%)';
          break;
        case 'ipns':
          // Gray filter
          filterColor = 'brightness(0) saturate(100%) invert(50%) sepia(0%) saturate(0%) hue-rotate(0deg) brightness(95%) contrast(95%)';
          break;
        default:
          filterColor = 'brightness(0) saturate(100%) invert(50%)';
      }
    
      indicator.style.filter = filterColor;
      indicator.title = `This tab is using the ${protocol} protocol.`;
      indicator.style.display = 'inline-block';
    } else {
      if (indicator) {
        indicator.remove();
      }
    }
  }
}

customElements.define("tab-bar", TabBar);
