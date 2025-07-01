const path = require("path");

class TrackedBox extends HTMLElement {
  constructor() {
    super();
    this.observer = new ResizeObserver(() => this.emitResize());
    this.currentInternalURL = null;
    this.initWebView();
  }

  initWebView() {
    this.webview = document.createElement("webview");
    this.webview.setAttribute("allowpopups", "true");
    // Use absolute positioning to prevent layout interference
    this.webview.style.position = "absolute";
    this.webview.style.top = "45px"; // Leave space for nav bar
    this.webview.style.left = "0";
    this.webview.style.height = "calc(100vh - 45px)";
    this.webview.style.width = "100%";
    this.webview.style.zIndex = "1";

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
    if (this.webview.canGoBack()) {
      this.webview.goBack();
    }
  }

  goForward() {
    if (this.webview.canGoForward()) {
      this.webview.goForward();
    }
  }

  canGoBack() {
    try {
      return this.webview.canGoBack();
    } catch (e) {
      return false;
    }
  }

  canGoForward() {
    try {
      return this.webview.canGoForward();  
    } catch (e) {
      return false;
    }
  }

  reload() {
    this.webview.reload();
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
      if (this.mainFrame) {
        this.mainFrame.style.zIndex = "0";
        this.mainFrame.style.visibility = "hidden";
      }
      this.webview.style.zIndex = "1";
      this.webview.style.visibility = "visible";
      this.webview.src = url;
    }
  }

  loadInternalPage(url) {
    // Use z-index layering instead of display switching to prevent layout conflicts
    this.webview.style.zIndex = "0";
    this.webview.style.visibility = "hidden";
    
    // Create or get main frame container
    if (!this.mainFrame) {
      this.mainFrame = document.createElement('iframe');
      // Use absolute positioning to match webview layout
      this.mainFrame.style.position = "absolute";
      this.mainFrame.style.top = "45px"; // Leave space for nav bar
      this.mainFrame.style.left = "0";
      this.mainFrame.style.height = 'calc(100vh - 45px)';
      this.mainFrame.style.width = '100%';
      this.mainFrame.style.border = 'none';
      this.mainFrame.style.zIndex = "1";
      // Note: iframe inherits context from parent frame
      this.appendChild(this.mainFrame);
    } else {
      this.mainFrame.style.zIndex = "1";
      this.mainFrame.style.visibility = "visible";
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
      this.webview.style.zIndex = "1";
      this.webview.style.visibility = "visible";
      if (this.mainFrame) {
        this.mainFrame.style.zIndex = "0";
        this.mainFrame.style.visibility = "hidden";
      }
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
