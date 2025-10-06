const BaseTabBar = customElements.get('tab-bar');

export default class VerticalTabs extends BaseTabBar {
  constructor() {
    super();
    this.isExpanded = false;
    this.hoverTimeout = null; // Add timeout for hover delay
    this.leaveTimeout = null; // Add timeout for leave delay
  }

  buildTabBar() {
    super.buildTabBar();
    this.classList.add('vertical-tabs');
    if (this.tabContainer) {
      this.tabContainer.classList.add('vertical-tabs-container');

      // Move add button to end so tabs appear before it
      this.addButton = this.tabContainer.querySelector('#add-tab');
      this.ensureAddButtonPosition();

      // Allow vertical scrolling with mouse wheel and stop horizontal handler
      this.tabContainer.addEventListener(
        'wheel',
        (e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.stopImmediatePropagation();
            // default vertical scrolling is preserved
          }
        },
        { capture: true }
      );

      // Update sticky state on scroll
      this.tabContainer.addEventListener('scroll', () =>
        this.updateAddButtonSticky()
      );
    }

    // Add hover event listeners with delays for smooth expansion
    this.addEventListener('mouseenter', () => {
      if (this.classList.contains('keep-expanded')) return;
      // Clear any pending leave timeout
      if (this.leaveTimeout) {
        clearTimeout(this.leaveTimeout);
        this.leaveTimeout = null;
      }
      
      // Set hover timeout for delayed expansion
      this.hoverTimeout = setTimeout(() => {
        this.isExpanded = true;
        this.classList.add('expanded');
      }, 300);
    });
    
    this.addEventListener('mouseleave', () => {
      if (this.classList.contains('keep-expanded')) return;
      // Clear any pending hover timeout
      if (this.hoverTimeout) {
        clearTimeout(this.hoverTimeout);
        this.hoverTimeout = null;
      }
      
      // Set leave timeout for delayed collapse
      this.leaveTimeout = setTimeout(() => {
        this.isExpanded = false;
        this.classList.remove('expanded');
      }, 300);
    });
    
    window.addEventListener('resize', () => this.updateAddButtonSticky());
    // Ensure CSS is loaded before applying styles
    this.loadVerticalTabsCSS();

    // Initial sticky state
    this.updateAddButtonSticky();

    // On macOS, collapse the titlebar when vertical tabs are enabled
    if (process.platform === 'darwin') {
      this.collapseTitlebarOnDarwin();
    }
  }

  collapseTitlebarOnDarwin() {
    const titlebar = document.querySelector('title-bar');
    if (titlebar && typeof titlebar.toggleDarwinCollapse === 'function') {
      titlebar.toggleDarwinCollapse(true);
    }
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
    
    this.ensureAddButtonPosition();
    this.updateAddButtonSticky();

    // Ensure favicon is properly sized for vertical tabs
    const tabElement = document.getElementById(tabId);
    if (tabElement) {
      const favicon = tabElement.querySelector('.tab-favicon');
      if ((favicon && !favicon.style.backgroundImage) || favicon.style.backgroundImage === 'none') {
        favicon.style.backgroundImage = "url(peersky://static/assets/icon16.png)";
      }
    }
    
    return result;
  }

  closeTab(tabId) {
    super.closeTab(tabId);
    this.ensureAddButtonPosition();
    this.updateAddButtonSticky();
  }

  ensureAddButtonPosition() {
    if (this.addButton && this.addButton.parentElement) {
      this.tabContainer.appendChild(this.addButton);
    }
  }

  updateAddButtonSticky() {
    if (!this.addButton) return;
    const shouldStick =
      this.tabContainer.scrollHeight > this.tabContainer.clientHeight;
    this.addButton.classList.toggle('sticky', shouldStick);
  }

  // Override hover behavior when keep-expanded is active
  updateKeepExpandedState(keepExpanded) {
    if (keepExpanded) {
      this.classList.add('keep-expanded');
      // Clear any timeouts
      if (this.hoverTimeout) {
        clearTimeout(this.hoverTimeout);
        this.hoverTimeout = null;
      }
      if (this.leaveTimeout) {
        clearTimeout(this.leaveTimeout);
        this.leaveTimeout = null;
      }
      // Force expanded state
      this.isExpanded = true;
      this.classList.add('expanded');
    } else {
      this.classList.remove('keep-expanded');
      // Re-enable hover behavior
      this.isExpanded = false;
      this.classList.remove('expanded');
    }
  }
}

customElements.define('vertical-tabs', VerticalTabs);