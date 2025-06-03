class TabBar extends HTMLElement {
    constructor() {
      super();
      this.tabs = [];
      this.activeTabId = null;
      this.tabCounter = 0;
      this.buildTabBar();
    }
  
    buildTabBar() {
      this.id = "tabbar";
      this.className = "tabbar";
  
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
      
      // First tab to be added automatically when app starts
      this.addTab();
    }
  
    addTab(url = "peersky://home", title = "Home") {
      const tabId = `tab-${this.tabCounter++}`;
      
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
      
      this.selectTab(tabId);
      return tabId;
    }
  
    closeTab(tabId) {
      const tabElement = document.getElementById(tabId);
      if (!tabElement) return;
      
      // Get index of tab to close
      const tabIndex = this.tabs.findIndex(tab => tab.id === tabId);
      if (tabIndex === -1) return;
      
      // Remove tab from DOM and array
      tabElement.remove();
      this.tabs.splice(tabIndex, 1);
      
      // If we closed the active tab, select another one
      if (this.activeTabId === tabId) {
        // Select the previous tab, or the next one if there is no previous
        const newTabIndex = Math.max(0, tabIndex - 1);
        if (this.tabs[newTabIndex]) {
          this.selectTab(this.tabs[newTabIndex].id);
        } else if (this.tabs.length === 0) {
          // If no tabs left, create a new one
          this.addTab();
        }
      }
      
      // Dispatch tab closed event
      this.dispatchEvent(new CustomEvent("tab-closed", { detail: { tabId } }));
    }
  
    selectTab(tabId) {
      // Remove active class from current active tab
      if (this.activeTabId) {
        const currentActive = document.getElementById(this.activeTabId);
        if (currentActive) {
          currentActive.classList.remove("active");
        }
      }
      
      // Add active class to new active tab
      const newActive = document.getElementById(tabId);
      if (newActive) {
        newActive.classList.add("active");
        this.activeTabId = tabId;
        
        const tab = this.tabs.find(t => t.id === tabId);
        if (tab) {
          this.dispatchEvent(new CustomEvent("tab-selected", { 
            detail: { tabId, url: tab.url } 
          }));
        }
      }
    }
  
    updateTab(tabId, { url, title }) {
      const tab = this.tabs.find(t => t.id === tabId);
      if (!tab) return;
      
      if (url) tab.url = url;
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
    }
  
    getActiveTab() {
      return this.tabs.find(tab => tab.id === this.activeTabId);
    }
  }
  
  customElements.define("tab-bar", TabBar);