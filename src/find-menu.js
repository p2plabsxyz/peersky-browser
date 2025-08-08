class FindMenu extends HTMLElement {
  constructor() {
    super();

    this.currentSearchValue = '';
    this.matchCase = false;
    this.currentRequestId = null;
    this.matchesCount = 0;
    this.currentMatchIndex = 0;
    this.isPdf = false; // Track if current document is PDF
    this.wrappingBackward = false; // Tracks if we're wrapping around to the end
    this.updateTimeout = null;

    this.tabGroups = new Map(); // Store group metadata
    this.tabGroupAssignments = new Map(); // Map tab IDs to group IDs
    this.groupColors = ['#4285F4', '#EA4335', '#FBBC05', '#34A853', '#8AB4F8', '#F28B82', '#FDD663', '#81C995']; // Google Chrome-like colors

    this.addEventListener('keydown', ({ key }) => {
      if (key === 'Escape') this.hide();
    });
  }

  async connectedCallback() {
    this.innerHTML = `
      <input class="find-menu-input" title="Enter text to find in page" />
      <span class="match-count"></span>
      <button class="find-menu-button find-menu-previous" title="Find previous item"></button>
      <button class="find-menu-button find-menu-next" title="Find next item"></button>
      <button class="find-menu-button find-menu-hide" title="Hide find menu"></button>
    `;

    this.input = this.querySelector('.find-menu-input');
    this.matchCountDisplay = this.querySelector('.match-count');
    this.previousButton = this.querySelector('.find-menu-previous');
    this.nextButton = this.querySelector('.find-menu-next');
    this.hideButton = this.querySelector('.find-menu-hide');

    await this.loadSVG(this.previousButton, 'peersky://static/assets/svg/up.svg');
    await this.loadSVG(this.nextButton, 'peersky://static/assets/svg/down.svg');
    await this.loadSVG(this.hideButton, 'peersky://static/assets/svg/close.svg');

    // Setup foundInPage listener on webview
    this.setupFoundInPageListener();
    
    // Setup webview navigation events to detect PDFs
    this.setupWebviewNavigationListener();

    this.input.addEventListener('input', (e) => {
      const { value } = this;
      if (!value) {
        this.stopFindInPage('clearSelection');
        return;
      }
      
      this.findInWebview(value, { forward: true });
    });

    this.input.addEventListener('keydown', ({ keyCode, shiftKey }) => {
      if (keyCode === 13) {
        const { value } = this;
        if (!value) return this.hide();
        
        const forward = !shiftKey;
        this.findInWebview(value, { forward, findNext: true });
      }
    });

    this.previousButton.addEventListener('click', () => {
      const { value } = this;
      if (!value) return;
      this.findInWebview(value, { forward: false, findNext: true });
    });
    
    this.nextButton.addEventListener('click', () => {
      const { value } = this;
      if (!value) return;
      this.findInWebview(value, { forward: true, findNext: true });
    });
    
    this.hideButton.addEventListener('click', () => this.hide());
  }

  setupWebviewNavigationListener() {
    const webview = this.getWebviewElement();
    if (!webview) return;

    // Listen for did-navigate events to detect content type
    webview.addEventListener('did-navigate', () => {
      this.detectContentType();
    });
    
    webview.addEventListener('did-navigate-in-page', () => {
      this.detectContentType();
    });
    
    // Also check when loading finishes
    webview.addEventListener('did-finish-load', () => {
      this.detectContentType();
    });
  }

  async detectContentType() {
    if (this.isPdf !== null) return; // detect only once
    const webview = this.getWebviewElement();
    if (!webview) return;
    
    try {
      // Check if current page is a PDF by examining the URL or content
      const url = await webview.getURL();
      this.isPdf = url.toLowerCase().endsWith('.pdf') || 
                   url.toLowerCase().includes('application/pdf');
      
      // If we need more precise detection, we can use executeJavaScript
      if (!this.isPdf) {
        const contentType = await webview.executeJavaScript(`
          document.contentType || 
          (document.querySelector('embed[type="application/pdf"]') ? 'application/pdf' : '')
        `);
        this.isPdf = contentType === 'application/pdf';
      }
    } catch (error) {
      console.error('Error detecting content type:', error);
    }
  }
  // fix (orignal code)
  setupFoundInPageListener() {
    // Get the webview element
    const webview = this.getWebviewElement();
    if (!webview) return;

    // Listen for found-in-page events
    webview.addEventListener('found-in-page', (event) => {
      const { requestId, matches, activeMatchOrdinal } = event.result;
      console.log('found-in-page', requestId, matches, activeMatchOrdinal);
      
      // Ensure this is a response to our current request
      if (requestId !== this.currentRequestId) return;

      // updates the match count display only if 
      // 1. matchesCount is 0 (first search) or
      // 2. search value has changed 
      if (this.matchesCount === 0 || this.currentSearchValue !== this.input.value) {
        this.matchesCount = matches || 0;
      }
      if(matches > 0) {
        this.currentMatchIndex = activeMatchOrdinal;
        if(this.currentMatchIndex > this.matchesCount) {
          console.log('wrapping', this.currentMatchIndex, this.matchesCount);
          this.currentMatchIndex = 1;
        }
        else if(this.currentMatchIndex < 1 && this.matchesCount > 0) {
          this.currentMatchIndex = this.matchesCount
        }
      }
      else{
        this.currentMatchIndex = 0;
      }

      if (this.matchesCount > 0) {
        this.matchCountDisplay.textContent = `${this.currentMatchIndex} of ${this.matchesCount}`;
      } else {
        this.matchCountDisplay.textContent = 'No matches';
      }
    });
  }


  findInWebview(value, options = {}) {
    const webview = this.getWebviewElement();
    if (!webview) return;
  
    // If search value changed, reset the search
    if (value !== this.currentSearchValue) {
      this.stopFindInPage('clearSelection');
      this.currentSearchValue = value;
      options.findNext = false;
      
      // Reset counters when starting a new search
      this.matchesCount = 0;
      this.currentMatchIndex = 0;
    }
  
    // Use Electron's findInPage API for both HTML and PDF content
    try {
      this.currentRequestId = webview.findInPage(value, {
        forward: options.forward !== false,
        findNext: options.findNext || false,
        matchCase: this.matchCase,
      });
    } catch (error) {
      console.error('Error using findInPage:', error);
    }
  }

  stopFindInPage(action = 'keepSelection') {
    const webview = this.getWebviewElement();
    if (webview) {
      webview.stopFindInPage(action);
      if (action === 'clearSelection') {
        this.currentSearchValue = '';
        this.matchCountDisplay.textContent = '';
        this.matchesCount = 0;
        this.currentMatchIndex = 0;
      }
    }
  }

  getWebviewElement() {
    // First try getting the active tab's webview from TabBar
    const tabBar = document.querySelector('#tabbar');
    if (tabBar && typeof tabBar.getActiveWebview === 'function') {
      const activeWebview = tabBar.getActiveWebview();
      if (activeWebview) {
        return activeWebview;
      }
    }
    
    // Final fallback to direct webview element
    return document.querySelector('webview');
  }

  async loadSVG(button, svgPath) {
    const response = await fetch(svgPath);
    const svgContent = await response.text();
    const svgContainer = document.createElement("div");
    svgContainer.innerHTML = svgContent;
    svgContainer.querySelector("svg").setAttribute("width", "14");
    svgContainer.querySelector("svg").setAttribute("height", "14");
    svgContainer.querySelector("svg").setAttribute("fill", "currentColor");
    button.appendChild(svgContainer.firstChild);
  }

  resetSearch() {
    this.stopFindInPage('clearSelection');
  }

  get value() {
    return this.input.value;
  }

  show() {
    this.classList.toggle('hidden', false);
    // Check content type when showing search
    this.detectContentType();
    setTimeout(() => {
      this.focus();
    }, 10);
  }

  hide() {
    this.stopFindInPage('clearSelection');
    this.classList.toggle('hidden', true);
    this.dispatchEvent(new CustomEvent('hide'));
  }

  toggle() {
    const isHidden = this.classList.contains('hidden');
    this.classList.toggle('hidden');
    if (isHidden) {
      this.detectContentType();
      this.focus();
    } else {
      this.stopFindInPage('clearSelection');
      this.dispatchEvent(new CustomEvent('hide'));
    }
  }

  focus() {
    this.input.focus();
    this.input.select();
  }
}

customElements.define('find-menu', FindMenu);
