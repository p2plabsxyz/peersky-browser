import '../elves/qr-code.js'

class QRPopup extends HTMLElement {
  connectedCallback() {
    this.render();
    this.querySelector(".close-btn").onclick = () => this.dispatchEvent(new Event("close"));
    this.querySelector(".download-btn").onclick = () => this.dispatchEvent(new Event("download"));
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

}

customElements.define("qr-popup", QRPopup);
