const path = require("path");

/**
 * TrackedBox - Webview container with dynamic preload script assignment
 * 
 * Supports secure loading of internal pages (like settings) with appropriate
 * preload scripts while maintaining context isolation for security.
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
    // Determine appropriate preload script based on URL
    const preloadScript = (url === 'peersky://settings' || url === 'peersky://home') ? 
      'settings-preload.js' : 'preload.js';
    
    // Recreate webview with correct preload (preload must be set at creation time)
    this.createWebview(preloadScript, url);
  }

  createWebview(preloadScript, url) {
    // Remove existing webview if it exists
    if (this.webview) {
      this.webview.remove();
    }
    
    // Create new webview with proper preload script
    this.webview = document.createElement("webview");
    this.webview.setAttribute("allowpopups", "true");
    this.webview.setAttribute("preload", "file://" + path.join(__dirname, preloadScript));
    
    // Apply consistent styling
    this.applyWebviewStyling();
    
    // Add event listeners
    this.setupEventListeners();
    
    // Add to DOM and load URL
    this.appendChild(this.webview);
    this.webview.src = url;
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