const path = require("path");

/**
 * TrackedBox - Persistent webview container with unified preload script
 * 
 * Uses a single persistent webview element with unified preload script that
 * dynamically exposes appropriate APIs based on the current page context.
 * Eliminates webview recreation and preload switching complexity.
 */
class TrackedBox extends HTMLElement {
  constructor() {
    super();
    this.observer = new ResizeObserver(() => this.emitResize());
    this.webview = null;
  }

  connectedCallback() {
    this.observer.observe(this);
    this.emitResize();
    this.createPersistentWebview();
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

  loadURL(url) {
    if (!this.webview) {
      console.warn('TrackedBox: webview not initialized yet');
      return;
    }
    
    // Simply navigate - unified preload handles all contexts
    this.webview.src = url;
  }

  createPersistentWebview() {
    // Create webview only once with unified preload script
    this.webview = document.createElement("webview");
    this.webview.setAttribute("allowpopups", "true");
    this.webview.setAttribute("preload", "file://" + path.join(__dirname, "unified-preload.js"));
    
    // Apply consistent styling
    this.applyWebviewStyling();
    
    // Add event listeners
    this.setupEventListeners();
    
    // Add to DOM (without loading URL yet)
    this.appendChild(this.webview);
    
    console.log('TrackedBox: Persistent webview created with unified preload');
  }

  applyWebviewStyling() {
    const styles = {
      position: "absolute",
      top: "45px", // Leave space for navigation bar
      left: "0",
      height: "calc(100vh - 45px)",
      width: "100%",
      zIndex: "1",
      border: "none"
    };

    Object.assign(this.webview.style, styles);
  }

  setupEventListeners() {
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
  }

  // Navigation methods
  goBack() {
    if (this.webview && this.webview.canGoBack()) {
      this.webview.goBack();
    }
  }

  goForward() {
    if (this.webview && this.webview.canGoForward()) {
      this.webview.goForward();
    }
  }

  canGoBack() {
    try {
      return this.webview ? this.webview.canGoBack() : false;
    } catch (e) {
      return false;
    }
  }

  canGoForward() {
    try {
      return this.webview ? this.webview.canGoForward() : false;
    } catch (e) {
      return false;
    }
  }

  reload() {
    if (this.webview) {
      this.webview.reload();
    }
  }

  stop() {
    if (this.webview) {
      this.webview.stop();
    }
  }

  getURL() {
    try {
      return this.webview ? 
        (this.webview.getURL() || this.webview.src) : '';
    } catch (e) {
      return this.webview ? this.webview.src : '';
    }
  }

  executeJavaScript(script) {
    if (this.webview) {
      this.webview.executeJavaScript(script);
    }
  }

  get webviewElement() {
    return this.webview;
  }
}

customElements.define("tracked-box", TrackedBox);