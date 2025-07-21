class NavBox extends HTMLElement {
  constructor() {
    super();
    this.isLoading = false;
    this._qrPopup = null;
    this._qrButton = null;
    this._outsideClickListener = null;
    this._resizeListener = null;
    this.buildNavBox();
    this.attachEvents();
  }

  buildNavBox() {
    this.id = "navbox";
    const buttons = [
      { id: "back", svg: "left.svg", position: "start" },
      { id: "forward", svg: "right.svg", position: "start" },
      { id: "refresh", svg: "reload.svg", position: "start" },
      { id: "home", svg: "home.svg", position: "start" },
      { id: "bookmark", svg: "bookmark.svg", position: "start" },
      { id: "plus", svg: "plus.svg", position: "end" },
    ];

    this.buttonElements = {};

    // Create buttons that should appear before the URL input
    buttons
      .filter((btn) => btn.position === "start")
      .forEach((button) => {
        const btnElement = this.createButton(
          button.id,
          `peersky://static/assets/svg/${button.svg}`
        );
        this.appendChild(btnElement);
        this.buttonElements[button.id] = btnElement;
      });

    const urlBarWrapper = document.createElement("div");
    urlBarWrapper.className = "url-bar-wrapper";

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.id = "url";
    urlInput.placeholder = "Search with DuckDuckGo or type a P2P URL";

    const qrButton = this.createButton(
      "qr-code",
      "peersky://static/assets/svg/qr-code.svg"
    );
    qrButton.classList.add("inside-urlbar");

    urlBarWrapper.appendChild(urlInput);
    urlBarWrapper.appendChild(qrButton);
    this.appendChild(urlBarWrapper);

    this.buttonElements["qr-code"] = qrButton;

    // Create buttons that should appear after the URL input
    buttons
      .filter((btn) => btn.position === "end")
      .forEach((button) => {
        const btnElement = this.createButton(
          button.id,
          `peersky://static/assets/svg/${button.svg}`
        );
        this.appendChild(btnElement);
        this.buttonElements[button.id] = btnElement;
      });
  }

  createButton(id, svgPath) {
    const button = document.createElement("button");
    button.className = "nav-button";
    button.id = id;

    // Create a container for the SVG to manage icons
    const svgContainer = document.createElement("div");
    svgContainer.className = "svg-container";
    button.appendChild(svgContainer);

    this.loadSVG(svgContainer, svgPath);

    return button;
  }

  loadSVG(container, svgPath) {
    fetch(svgPath)
      .then((response) => response.text())
      .then((svgContent) => {
        container.innerHTML = svgContent;
        const svgElement = container.querySelector("svg");
        if (svgElement) {
          svgElement.setAttribute("width", "18");
          svgElement.setAttribute("height", "18");
          svgElement.setAttribute("fill", "currentColor");
        }
      })
      .catch((error) => {
        console.error(`Error loading SVG from ${svgPath}:`, error);
      });
  }

  updateButtonIcon(button, svgFileName) {
    const svgPath = `peersky://static/assets/svg/${svgFileName}`;
    const svgContainer = button.querySelector(".svg-container");
    if (svgContainer) {
      this.loadSVG(svgContainer, svgPath);
    } else {
      console.error("SVG container not found within the button.");
    }
  }

  // Bookmark state management
  setBookmarkState(isBookmarked) {
    const bookmarkButton = this.buttonElements["bookmark"];
    if (bookmarkButton) {
      if (isBookmarked) {
        this.updateButtonIcon(bookmarkButton, "bookmark-fill.svg");
      } else {
        this.updateButtonIcon(bookmarkButton, "bookmark.svg");
      }
    }
  }

  // Qr-code State Management

  hideQrCodePopup() {
    if (this._qrPopup) {
      this._qrPopup.classList.remove("open");
      this._qrPopup.classList.add("close");
      setTimeout(() => {
        this._qrPopup.remove();
        this._qrPopup = null;
      }, 300);
    }
  }

  _toggleQrCodePopup() {
    if (this._qrPopup) {
      this.hideQrCodePopup();
      return;
    }

    const currentUrl = this.querySelector("#url").value;
    if (!currentUrl) return;

    this._qrPopup = document.createElement("div");
    this._qrPopup.className = "qr-popup";
    this._qrPopup.innerHTML = `
    <div class="qr-popup-header">
      <p>Scan QR Code</p>
      <button class="close-btn">
        <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
        </svg>
      </button>
    </div>
    <qr-code src="${currentUrl} data-bg='white' data-fg="black" "></qr-code>
    <span class="qr-url">${currentUrl}</span>
    <button class="download-btn disabled">Download</button>
  `;

    document.body.appendChild(this._qrPopup);
    this._qrButton = this.buttonElements["qr-code"];

    this._positionQrPopup();

    this._outsideClickListener = (e) => {
      if (
        this._qrPopup &&
        !this._qrPopup.contains(e.target) &&
        !this._qrButton.contains(e.target)
      ) {
        this.hideQrCodePopup();
      }
    };
    document.addEventListener("mousedown", this._outsideClickListener);

    this._resizeListener = () => {
      this._positionQrPopup();
    };
    window.addEventListener("resize", this._resizeListener);

    setTimeout(() => {
      this._qrPopup.classList.add("open");
    }, 0);

    const closeBtn = this._qrPopup.querySelector(".close-btn");
    closeBtn.addEventListener("click", () => this.hideQrCodePopup());

    const downloadBtn = this._qrPopup.querySelector(".download-btn");
    downloadBtn.addEventListener("click", () => this._downloadQrCode());

    setTimeout(() => {
      const qrCode = this._qrPopup.querySelector("qr-code img");
      if (qrCode) {
        downloadBtn.disabled = false;
      }
    }, 300);
  }

  _positionQrPopup() {
    if (!this._qrPopup || !this._qrButton) return;

    const buttonRect = this._qrButton.getBoundingClientRect();
    this._qrPopup.style.top = `${buttonRect.bottom + 10}px`;
    this._qrPopup.style.right = `${window.innerWidth - buttonRect.right}px`;
  }

  hideQrCodePopup() {
    if (this._qrPopup) {
      this._qrPopup.classList.remove("open");
      this._qrPopup.classList.add("close");
      setTimeout(() => {
        this._qrPopup.remove();
        this._qrPopup = null;
      }, 300);
    }

    if (this._outsideClickListener) {
      document.removeEventListener("mousedown", this._outsideClickListener);
      this._outsideClickListener = null;
    }

    if (this._resizeListener) {
      window.removeEventListener("resize", this._resizeListener);
      this._resizeListener = null;
    }
  }

  _downloadQrCode() {
    let img = this._qrPopup?.querySelector("qr-code img");
    const a = document.createElement("a");
    a.href = img.src;
    a.download = "qr-code.png";

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  setLoading(isLoading) {
    this.isLoading = isLoading;
    const refreshButton = this.buttonElements["refresh"];
    if (refreshButton) {
      if (isLoading) {
        this.updateButtonIcon(refreshButton, "close.svg");
      } else {
        this.updateButtonIcon(refreshButton, "reload.svg");
      }
    } else {
      console.error("Refresh button not found.");
    }
  }

  setNavigationButtons(canGoBack, canGoForward) {
    const backButton = this.buttonElements["back"];
    const forwardButton = this.buttonElements["forward"];

    if (backButton) {
      if (canGoBack) {
        backButton.classList.add("active");
        backButton.removeAttribute("disabled");
      } else {
        backButton.classList.remove("active");
        backButton.setAttribute("disabled", "true");
      }
    }

    if (forwardButton) {
      if (canGoForward) {
        forwardButton.classList.add("active");
        forwardButton.removeAttribute("disabled");
      } else {
        forwardButton.classList.remove("active");
        forwardButton.setAttribute("disabled", "true");
      }
    }
  }

  attachEvents() {
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (button) {
        if (button.id === "refresh") {
          if (this.isLoading) {
            this.dispatchEvent(new CustomEvent("stop"));
          } else {
            this.dispatchEvent(new CustomEvent("reload"));
          }
        } else if (button.id === "plus") {
          this.dispatchEvent(new CustomEvent("new-window"));
        } else if (button.id === "bookmark") {
          this.dispatchEvent(new CustomEvent("toggle-bookmark"));
        } else if (button.id === "qr-code") {
          this._toggleQrCodePopup();
        } else if (!button.disabled) {
          this.navigate(button.id);
        }
      }
    });

    const urlInput = this.querySelector("#url");
    if (urlInput) {
      urlInput.addEventListener("keypress", (event) => {
        if (event.key === "Enter") {
          const url = event.target.value.trim();
          this.dispatchEvent(new CustomEvent("navigate", { detail: { url } }));
        }
      });
    } else {
      console.error("URL input not found within nav-box.");
    }
  }

  navigate(action) {
    this.dispatchEvent(new CustomEvent(action));
  }
}

customElements.define("nav-box", NavBox);
