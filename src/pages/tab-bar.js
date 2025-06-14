class TabBar extends HTMLElement {
  constructor() {
    super();
    this.tabs = [];
    this.activeTabId = null;
    this.tabCounter = 0;
    this.webviews = new Map(); // Store webviews by tab ID
    this.webviewContainer = null; // Will be set by connectWebviewContainer
    this.pinnedTabs = new Set(); // Track pinned tabs
    this.buildTabBar();
    this.setupBrowserCloseHandler();
    this.setupTabContextMenu();
  }

  // Connect to the webview container where all webviews will live
  connectWebviewContainer(container) {
    this.webviewContainer = container;
    // After connecting container, restore or create initial tabs
    this.restoreOrCreateInitialTabs();
    
    // Force activation of the initial tab's webview after a delay
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
    
    // Don't add first tab automatically here anymore
    // Will be handled in restoreOrCreateInitialTabs
  }

  // Restore persisted tabs or create initial home tab
  restoreOrCreateInitialTabs() {
    // Check if this is an isolated window
    const searchParams = new URL(window.location.href).searchParams;
    const isIsolated = searchParams.get('isolate') === 'true';
    const initialUrl = searchParams.get('url');
    
    if (isIsolated && initialUrl) {
      // Create only one tab with the specified URL
      const homeTabId = this.addTab(initialUrl, "New Tab");
      this.saveTabsState();
      return;
    }
    
    // Normal restoration logic
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
          title: tab.title,
          isPinned: this.pinnedTabs.has(tab.id)
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
      
      // Restore pinned state
      if (tabData.isPinned) {
        this.pinnedTabs.add(tabId);
        // timeout for ui update
        setTimeout(()=>{
        const tabElement = document.getElementById(tabId);
        if (tabElement) {
          tabElement.classList.add('pinned');
        }
      }, 0);
      }
      
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
        if (faviconElement && faviconElement.style.display === "none") {
          faviconElement.style.backgroundImage = "url(peersky://static/assets/icon16.png)";
          faviconElement.style.display = "block";
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
  
    // Handle audio state changes
    webview.addEventListener("media-started-playing", () => {
      this.updateTabMuteState(tabId);
    });
  
    webview.addEventListener("media-paused", () => {
      this.updateTabMuteState(tabId);
    });
  
    webview.addEventListener("new-window", (e) => {
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

    menu.innerHTML = `
      <div class="context-menu-item" data-action="reload">
        <span class="menu-icon">🔄</span>
        Reload page
      </div>
      <div class="context-menu-item" data-action="duplicate">
        <span class="menu-icon">📑</span>
        Duplicate tab
      </div>
      <div class="context-menu-item" data-action="mute">
        <span class="menu-icon">${isMuted ? '🔊' : '🔇'}</span>
        ${isMuted ? 'Unmute site' : 'Mute site'}
      </div>
      <div class="context-menu-item" data-action="new-tab-right">
        <span class="menu-icon">➡️</span>
        New tab to the right
      </div>
      <div class="context-menu-item" data-action="move-to-new-window">
        <span class="menu-icon">🗔</span>
        Move to new window
      </div>
      <div class="context-menu-separator"></div>
      <div class="context-menu-item" data-action="pin">
        <span class="menu-icon">📌</span>
        ${isPinned ? 'Unpin tab' : 'Pin tab'}
      </div>
      <div class="context-menu-separator"></div>
      <div class="context-menu-item" data-action="close-others">
        <span class="menu-icon">✖️</span>
        Close other tabs
      </div>
      <div class="context-menu-item" data-action="close">
        <span class="menu-icon">❌</span>
        Close tab
      </div>
    `;

    // Add event listeners to menu items
    menu.addEventListener('click', (e) => {
      const action = e.target.closest('.context-menu-item')?.dataset.action;
      if (action) {
        this.handleTabContextMenuAction(action, tabId);
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
    }
  }

  // Duplicate a tab - creates new tab with same URL
  duplicateTab(tabId) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;
    
    const newTitle = tab.title === 'Home' ? 'Home' : `${tab.title} (Copy)`;
    const newTabId = this.addTab(tab.url, newTitle);
    
    this.moveTabToPosition(newTabId, this.tabs.findIndex(t => t.id === tabId) + 1);
    
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

  moveTabToNewWindow(tabId) {
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
      tabId: tab.id,
      isolate: true
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
    
    // Update DOM order
    const tabElement = document.getElementById(tabId);
    if (tabElement && this.tabContainer) {
      this.tabContainer.removeChild(tabElement);
      
      if (position === 0) {
        // Insert at beginning
        this.tabContainer.insertBefore(tabElement, this.tabContainer.firstChild);
      } else if (position >= this.tabs.length - 1) {
        // Insert at end
        this.tabContainer.appendChild(tabElement);
      } else {
        // Insert at specific position
        const nextTabId = this.tabs[position + 1].id;
        const nextTabElement = document.getElementById(nextTabId);
        if (nextTabElement) {
          this.tabContainer.insertBefore(tabElement, nextTabElement);
        } else {
          this.tabContainer.appendChild(tabElement);
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
}

customElements.define("tab-bar", TabBar);