const { ipcRenderer } = require('electron');

class TitleBar extends HTMLElement {
  constructor() {
    super();
    this.buildTitleBar();
  }

  buildTitleBar() {
    this.id = "titlebar";
    this.className = "titlebar";
    
    // Left side - App icon
    const appIcon = document.createElement("div");
    appIcon.className = "app-icon";
    
    // Middle - Tabs container
    this.tabsContainer = document.createElement("div");
    this.tabsContainer.id = "tabbar-container";
    this.tabsContainer.className = "tabbar-container";
    
    if(process.platform !== "darwin") {
      // Right side - Window controls
      const windowControls = document.createElement("div");
      windowControls.className = "window-controls";
      
      // Window control buttons
      const minimizeBtn = document.createElement("button");
      minimizeBtn.className = "window-control minimize";
      minimizeBtn.innerHTML = "&#8211;";
      minimizeBtn.title = "Minimize";
      
      const maximizeBtn = document.createElement("button");
      maximizeBtn.className = "window-control maximize";
      maximizeBtn.innerHTML = "&#10065;";
      maximizeBtn.title = "Maximize";
      
      const closeBtn = document.createElement("button");
      closeBtn.className = "window-control close";
      closeBtn.innerHTML = "&#10005;";
      closeBtn.title = "Close";
      
      // Event listeners
      minimizeBtn.addEventListener("click", () => {
        ipcRenderer.send("window-control", "minimize");
      });
      
      maximizeBtn.addEventListener("click", () => {
        ipcRenderer.send("window-control", "maximize");
      });
      
      closeBtn.addEventListener("click", () => {
        ipcRenderer.send("window-control", "close");
      });
      
      windowControls.appendChild(minimizeBtn);
      windowControls.appendChild(maximizeBtn);
      windowControls.appendChild(closeBtn);
      
      this.appendChild(appIcon);
      this.appendChild(this.tabsContainer);
      this.appendChild(windowControls);
    }
    else {
      this.tabsContainer.style.marginLeft = "70px";
      
      this.appendChild(appIcon);
      this.appendChild(this.tabsContainer);
    }
  }
  
  connectTabBar(tabBar) {
    // Add the tabBar to container
    if (tabBar) {
      this.tabsContainer.appendChild(tabBar);
      
      // On macOS, check if vertical tabs are being used
      if (process.platform === "darwin" && tabBar.classList.contains('vertical-tabs')) {
        this.classList.add('titlebar-collapsed-darwin');
      }
    }
  }
  
  // Method to toggle titlebar visibility on Darwin
  toggleDarwinCollapse(shouldCollapse) {
    if (process.platform === "darwin") {
      if (shouldCollapse) {
        this.classList.add('titlebar-collapsed-darwin');
      } else {
        this.classList.remove('titlebar-collapsed-darwin');
      }
    }
  }
}

customElements.define('title-bar', TitleBar);