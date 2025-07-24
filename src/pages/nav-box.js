class NavBox extends HTMLElement {
  constructor() {
    super();
    this.isLoading = false;
    this._qrPopup = null;
    this._qrButton = null;
    this._extensionsPopup = null; // TODO: Add extensions popup state
    this._extensionsButton = null; // TODO: Add extensions button reference
    this._outsideClickListener = null;
    this._resizeListener = null;
    this.buildNavBox();
    this.attachEvents();
    this.attachThemeListener();
  }

  setStyledUrl(url) {
    const urlInput = this.querySelector("#url");
    if (!urlInput) return;
    
    // Simple URL display for input element
    urlInput.value = url || "";
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
      { id: "extensions", svg: "puzzle.svg", position: "end" }, // TODO: Add extensions button
      { id: "settings", svg: "settings.svg", position: "end" },
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
    <qr-code src="${currentUrl}" data-bg="white" data-fg="black"></qr-code>
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
        } else if (button.id === "extensions") {
          this._toggleExtensionsPopup(); // TODO: Add extensions popup toggle
        } else if (button.id === "settings") {
          this.dispatchEvent(new CustomEvent("navigate", { detail: { url: "peersky://settings" } }));
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

  attachThemeListener() {
    // Listen for theme reload events from settings manager
    window.addEventListener('theme-reload', (event) => {
      console.log('NavBox received theme reload event:', event.detail);
      this.handleThemeChange(event.detail.theme);
    });
    
    // Listen for search engine changes from settings manager
    try {
      const { ipcRenderer } = require('electron');
      ipcRenderer.on('search-engine-changed', (event, newEngine) => {
        console.log('NavBox: Search engine changed to:', newEngine);
        this.updateSearchPlaceholder();
      });
    } catch (error) {
      console.warn('NavBox: Could not setup search engine listener:', error);
    }
  }

  handleThemeChange(theme) {
    // Force re-evaluation of CSS by toggling a class
    this.classList.remove('theme-updating');
    // Use requestAnimationFrame to ensure the class removal is processed
    requestAnimationFrame(() => {
      this.classList.add('theme-updating');
      console.log('NavBox theme updated to:', theme);
      
      
      // Remove the temporary class after a brief moment
      setTimeout(() => {
        this.classList.remove('theme-updating');
      }, 100);
    });
  }

  // TODO: Extensions Popup Management (similar to QR popup pattern)
  
  hideExtensionsPopup() {
    // TODO: Hide extensions popup with animation
    if (this._extensionsPopup) {
      this._extensionsPopup.classList.remove("open");
      this._extensionsPopup.classList.add("close");
      setTimeout(() => {
        this._extensionsPopup.remove();
        this._extensionsPopup = null;
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

  _toggleExtensionsPopup() {
    // TODO: Toggle extensions popup (similar to QR popup)
    if (this._extensionsPopup) {
      this.hideExtensionsPopup();
      return;
    }

    console.log('TODO: Create extensions popup');
    
    this._extensionsPopup = document.createElement("div");
    this._extensionsPopup.className = "extensions-popup";
    this._extensionsPopup.innerHTML = `
      <div class="extensions-popup-header">
        <p>Extensions</p>
        <button class="close-btn">
          <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>
      <div class="extensions-list">
        <!-- TODO: Extension list will be populated here -->
        <div class="extension-item">
          <span class="extension-name">Ad Blocker</span>
          <label class="toggle-label">
            <input type="checkbox" class="toggle-input" disabled>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="extension-item">
          <span class="extension-name">DScan</span>
          <label class="toggle-label">
            <input type="checkbox" class="toggle-input" disabled>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
      <div class="extensions-actions">
        <button class="install-btn disabled">Install Extension</button>
        <input type="text" class="p2p-input" placeholder="ipfs:// or hyper:// URL" disabled>
        <button class="settings-btn">Manage Extensions</button>
      </div>
      <div class="network-status">
        <span class="status-indicator offline">P2P: Offline</span>
      </div>
    `;

    document.body.appendChild(this._extensionsPopup);
    this._extensionsButton = this.buttonElements["extensions"];

    this._positionExtensionsPopup();

    // TODO: Setup event listeners (same pattern as QR popup)
    this._outsideClickListener = (e) => {
      if (
        this._extensionsPopup &&
        !this._extensionsPopup.contains(e.target) &&
        !this._extensionsButton.contains(e.target)
      ) {
        this.hideExtensionsPopup();
      }
    };
    document.addEventListener("mousedown", this._outsideClickListener);

    this._resizeListener = () => {
      this._positionExtensionsPopup();
    };
    window.addEventListener("resize", this._resizeListener);

    setTimeout(() => {
      this._extensionsPopup.classList.add("open");
    }, 0);

    // TODO: Setup popup button event listeners
    const closeBtn = this._extensionsPopup.querySelector(".close-btn");
    closeBtn.addEventListener("click", () => this.hideExtensionsPopup());

    const installBtn = this._extensionsPopup.querySelector(".install-btn");
    installBtn.addEventListener("click", () => this._handleExtensionInstall());

    const settingsBtn = this._extensionsPopup.querySelector(".settings-btn");
    settingsBtn.addEventListener("click", () => {
      this.hideExtensionsPopup();
      this.dispatchEvent(new CustomEvent("navigate", { detail: { url: "peersky://settings#extensions" } }));
    });

    // TODO: Load actual extension data
    this._loadExtensionData();
  }

  _positionExtensionsPopup() {
    // TODO: Position extensions popup (same as QR popup positioning)
    if (!this._extensionsPopup || !this._extensionsButton) return;

    const buttonRect = this._extensionsButton.getBoundingClientRect();
    this._extensionsPopup.style.top = `${buttonRect.bottom + 10}px`;
    this._extensionsPopup.style.right = `${window.innerWidth - buttonRect.right}px`;
  }

  _handleExtensionInstall() {
    // TODO: Handle extension installation
    console.log('TODO: Handle extension install button click');
    // Would open file picker or handle P2P URL input
  }

  _loadExtensionData() {
    // TODO: Load actual extension data from electronAPI
    console.log('TODO: Load extension data via electronAPI.extensions');
    // Would populate the extensions list with real data
    // Would update network status indicator
  }

}

customElements.define("nav-box", NavBox);
