const BaseTabBar = customElements.get('tab-bar');

export default class VerticalTabs extends BaseTabBar {
  constructor() {
    super();
    this.isExpanded = false;
  }

  buildTabBar() {
    super.buildTabBar();
    this.classList.add('vertical-tabs');
    if (this.tabContainer) {
      this.tabContainer.classList.add('vertical-tabs-container');
    }
    
    // Add hover event listeners for smooth expansion
    this.addEventListener('mouseenter', () => {
      this.isExpanded = true;
      this.classList.add('expanded');
    });
    
    this.addEventListener('mouseleave', () => {
      this.isExpanded = false;
      this.classList.remove('expanded');
    });
    
    // Ensure CSS is loaded before applying styles
    this.loadVerticalTabsCSS();
  }
  
  loadVerticalTabsCSS() {
    // Check if CSS is already loaded
    if (document.querySelector('link[href*="vertical-tabs.css"]')) {
      return;
    }
    
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'browser://theme/vertical-tabs.css';
    link.onload = () => {
      // Force a reflow to apply styles
      this.style.display = 'none';
      this.offsetHeight; // Trigger reflow
      this.style.display = '';
    };
    document.head.appendChild(link);
  }

  // Override tab creation to ensure proper favicon handling
  addTabWithId(tabId, url = "peersky://home", title = "Home") {
    const result = super.addTabWithId(tabId, url, title);
    
    // Ensure favicon is properly sized for vertical tabs
    const tabElement = document.getElementById(tabId);
    if (tabElement) {
      const favicon = tabElement.querySelector('.tab-favicon');
      if (favicon && !favicon.style.backgroundImage || favicon.style.backgroundImage === 'none') {
        favicon.style.backgroundImage = "url(peersky://static/assets/icon16.png)";
      }
    }
    
    return result;
  }
}

customElements.define('vertical-tabs', VerticalTabs);