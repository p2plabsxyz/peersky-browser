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

  reload() {
    this.webview.reload();
  }

  loadURL(url) {
    this.webview.src = url;
  }

  getURL() {
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
