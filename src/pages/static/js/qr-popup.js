class QRPopup extends HTMLElement {
  connectedCallback() {
    this.render();
    this.querySelector(".close-btn").onclick = () => this.dispatchEvent(new Event("close"));
    this.querySelector(".download-btn").onclick = () => this.dispatchEvent(new Event("download"));
  }

  static get observedAttributes() {
    return ["url", "visible"];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === "url") this.updateUrl(newValue);
    if (name === "visible") this.toggleVisibility();
  }

  render() {
    const url = this.getAttribute("url") || "";
    this.innerHTML = `
      <div class="qr-popup ${this.hasAttribute("visible") ? "open" : "close"}">
        <div class="qr-popup-header">
          <p>Scan QR Code</p>
          <button class="close-btn">✕</button>
        </div>
        <qr-code src="${url}" data-bg="white" data-fg="black"></qr-code>
        <span class="qr-url">${url}</span>
        <button class="download-btn disabled">Download</button>
      </div>
    `;
  }

  updateUrl(url) {
    const qr = this.querySelector("qr-code");
    if (qr) qr.setAttribute("src", url);
    const label = this.querySelector(".qr-url");
    if (label) label.textContent = url;
  }

  toggleVisibility() {
    const popup = this.querySelector(".qr-popup");
    if (!popup) return;
    popup.classList.toggle("open", this.hasAttribute("visible"));
    popup.classList.toggle("close", !this.hasAttribute("visible"));
  }
}

customElements.define("qr-popup", QRPopup);
