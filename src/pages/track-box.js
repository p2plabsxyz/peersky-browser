const path = require("path");

class TrackedBox extends HTMLElement {
  constructor() {
    super();
    this.observer = new ResizeObserver(() => this.emitResize());
    this.initWebView();
  }

  initWebView() {
    this.webview = document.createElement("webview");
    this.webview.setAttribute("allowpopups", "true");
    this.webview.style.height = "calc(100vh - 50px)";
    this.webview.style.width = "100%";

    // Dynamically resolve the preload script path
    this.webview.preload = "file://" + path.join(__dirname, "preload.js");

    this.webview.addEventListener("did-navigate", (e) => {
      this.dispatchEvent(
        new CustomEvent("did-navigate", {
          detail: { url: this.webview.getURL() },
        })
      );
    });

    this.webview.addEventListener("page-title-updated", (e) => {
      this.dispatchEvent(
        new CustomEvent("page-title-updated", { detail: { title: e.title } })
      );
    });

    this.appendChild(this.webview);
  }

  connectedCallback() {
    this.observer.observe(this);
    this.emitResize();
  }

  disconnectedCallback() {
    this.observer.unobserve(this);
  }

  emitResize() {
    const { x, y, width, height } = this.getBoundingClientRect();
    this.dispatchEvent(
      new CustomEvent("resize", { detail: { x, y, width, height } })
    );
  }

  goBack() {
    if (this.currentInternalURL) {
      // For internal pages, we can't go back in iframe history
      // Instead, navigate to a default page or do nothing
      return;
    }
    if (this.webview.canGoBack()) {
      this.webview.goBack();
    }
  }

  goForward() {
    if (this.currentInternalURL) {
      // For internal pages, we can't go forward in iframe history  
      return;
    }
    if (this.webview.canGoForward()) {
      this.webview.goForward();
    }
  }

  canGoBack() {
    if (this.currentInternalURL) {
      return false; // Internal pages don't have back/forward
    }
    try {
      return this.webview.canGoBack();
    } catch (e) {
      return false;
    }
  }

  canGoForward() {
    if (this.currentInternalURL) {
      return false; // Internal pages don't have back/forward
    }
    try {
      return this.webview.canGoForward();  
    } catch (e) {
      return false;
    }
  }

  reload() {
    if (this.currentInternalURL) {
      // Reload internal page
      this.loadInternalPage(this.currentInternalURL);
    } else {
      // Reload webview
      this.webview.reload();
    }
  }

  stop() {
    this.webview.stop();
  }

  loadURL(url) {
    // Check if this is an internal peersky:// page that should load in main frame
    if (url && url.startsWith('peersky://')) {
      this.loadInternalPage(url);
    } else {
      // External URLs load in webview as before
      this.currentInternalURL = null;
      if (this.mainFrame) this.mainFrame.style.display = 'none';
      this.webview.style.display = 'block';
      this.webview.src = url;
    }
  }

  loadInternalPage(url) {
    // Hide webview and show main frame content for internal pages
    this.webview.style.display = 'none';
    
    // Create or get main frame container
    if (!this.mainFrame) {
      this.mainFrame = document.createElement('iframe');
      this.mainFrame.style.height = 'calc(100vh - 50px)';
      this.mainFrame.style.width = '100%';
      this.mainFrame.style.border = 'none';
      // Note: iframe inherits context from parent frame
      this.appendChild(this.mainFrame);
    } else {
      this.mainFrame.style.display = 'block';
    }
    
    // Map peersky:// URLs to actual HTML files
    const pageMap = {
      'peersky://home': '../pages/home.html',
      'peersky://settings': '../pages/settings.html',
    };
    
    const htmlFile = pageMap[url];
    if (htmlFile) {
      this.currentInternalURL = url;
      this.mainFrame.src = htmlFile;
      // Dispatch navigation event so browser knows we've navigated
      this.dispatchEvent(
        new CustomEvent("did-navigate", {
          detail: { url: url },
        })
      );
    } else {
      // Fallback to webview for unknown peersky:// URLs
      this.currentInternalURL = null;
      this.webview.style.display = 'block';
      if (this.mainFrame) this.mainFrame.style.display = 'none';
      this.webview.src = url;
    }
  }

  getURL() {
    // Return the current URL whether it's in webview or main frame
    if (this.currentInternalURL) {
      return this.currentInternalURL;
    }
    return this.webview.src;
  }

  executeJavaScript(script) {
    this.webview.executeJavaScript(script);
  }

  get webviewElement() {
    return this.webview;
  }
}

customElements.define("tracked-box", TrackedBox);
