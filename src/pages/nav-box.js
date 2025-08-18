// Direct IPC access for nav-box (browser chrome with nodeIntegration: true)
// Use scoped import to avoid collision with titlebar.js
const navBoxIPC = (() => {
  const { ipcRenderer } = require('electron');
  return ipcRenderer;
})();

class NavBox extends HTMLElement {
  constructor() {
    super();
    this.isLoading = false;
    this._qrPopup = null;
    this._qrButton = null;
    this._outsideClickListener = null;
    this._resizeListener = null;
    this._extensionsPopup = null;
    this.buildNavBox();
    this.attachEvents();
    this.attachThemeListener();
    this.attachExtensionListeners();
    this.initializeExtensionsPopup();
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
      { id: "extensions", svg: "extensions.svg", position: "end" },
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
        
        // Add extension icons container after extensions button
        if (button.id === "extensions") {
          this.createExtensionIconsContainer();
        }
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

  createExtensionIconsContainer() {
    const container = document.createElement("div");
    container.className = "extension-icons-container";
    container.id = "extension-icons";
    this.appendChild(container);
    
    // Load browser actions immediately
    this.renderBrowserActions();
  }

  // HTML sanitization utilities for extension security
  escapeHtml(text) {
    if (!text || typeof text !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  escapeHtmlAttribute(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Validate and sanitize extension icon URLs
  validateIconUrl(url) {
    if (!url || typeof url !== 'string') {
      return 'peersky://static/assets/svg/puzzle.svg'; // Fallback icon
    }

    // Allow only safe schemes
    const allowedSchemes = ['peersky:', 'data:', 'blob:'];
    const urlLower = url.toLowerCase();
    
    const isAllowed = allowedSchemes.some(scheme => urlLower.startsWith(scheme));
    
    if (!isAllowed) {
      console.warn(`[NavBox] Blocked unsafe icon URL: ${url}`);
      return 'peersky://static/assets/svg/puzzle.svg'; // Fallback icon
    }

    return url;
  }

  async renderBrowserActions() {
    console.log('[NavBox] renderBrowserActions() called');
    const container = this.querySelector("#extension-icons");
    if (!container) {
      console.warn('[NavBox] Extension icons container not found');
      return;
    }

    try {
      // Get browser actions from extension system via direct IPC
      const actionsResult = await navBoxIPC.invoke('extensions-list-browser-actions');
      const pinnedResult = await navBoxIPC.invoke('extensions-get-pinned');
      
      if (actionsResult?.success && actionsResult.actions?.length > 0) {
        const allActions = actionsResult.actions;
        const pinnedExtensions = pinnedResult?.success ? pinnedResult.pinnedExtensions || [] : [];
        
        // Filter to only show pinned extensions (max 3)
        const pinnedActions = allActions.filter(action => pinnedExtensions.includes(action.id));
        
        // Clear container first for security
        container.innerHTML = '';
        
        if (pinnedActions.length > 0) {
          // Add visual separator before pinned extensions
          this.addExtensionSeparator(container);
          
          // Create extension buttons for pinned extensions only
          pinnedActions.forEach(action => {
            const button = document.createElement('button');
            button.className = 'extension-action-btn pinned-extension';
            
            // Sanitize extension ID for data attribute
            const sanitizedId = this.escapeHtmlAttribute(action.id || '');
            button.dataset.extensionId = sanitizedId;
            
            // Sanitize title attribute
            const sanitizedTitle = this.escapeHtmlAttribute(action.title || action.name || '');
            button.title = sanitizedTitle;
            
            // Create and validate icon
            const img = document.createElement('img');
            img.className = 'extension-icon';
            img.src = this.validateIconUrl(action.icon);
            img.alt = this.escapeHtmlAttribute(action.name || 'Extension');
            
            button.appendChild(img);
            
            // Add badge if present (sanitized)
            if (action.badgeText) {
              const badge = document.createElement('span');
              badge.className = 'extension-badge';
              badge.textContent = action.badgeText; // textContent auto-escapes
              button.appendChild(badge);
            }
            
            // Add click listener
            button.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              this.handleExtensionActionClick(sanitizedId, button);
            });
            
            container.appendChild(button);
          });
        }
        
        console.log(`[NavBox] Rendered ${pinnedActions.length} pinned extension${pinnedActions.length !== 1 ? 's' : ''} out of ${allActions.length} total (max 3)`);
      } else {
        // Clear container if no actions
        container.innerHTML = '';
      }
    } catch (error) {
      console.error('[NavBox] Failed to render browser actions:', error);
      container.innerHTML = '';
    }
  }

  /**
   * Add visual separator between puzzle button and pinned extensions
   */
  addExtensionSeparator(container) {
    const separator = document.createElement('div');
    separator.className = 'extension-separator';
    separator.setAttribute('aria-hidden', 'true');
    container.appendChild(separator);
  }

  async handleExtensionActionClick(extensionId, anchorElement, options = {}) {
    if (!extensionId) {
      console.warn('[NavBox] No extension ID provided for browser action click');
      return;
    }

    try {
      // Get the anchor element for positioning (could be pinned icon or temp icon)
      const anchor = anchorElement || this.querySelector(`[data-extension-id="${extensionId}"]`);
      if (!anchor) {
        console.warn('[NavBox] No anchor element found for popup positioning');
        return;
      }

      // Measure bounding rect for popup positioning
      const rect = anchor.getBoundingClientRect();
      const anchorRect = {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom
      };

      // Try to open popup first, fall back to click if no popup
      const result = await navBoxIPC.invoke('extensions-open-browser-action-popup', { actionId: extensionId, anchorRect });
      
      if (!result?.success) {
        // Clean up temp icon if this was from dropdown
        if (options.isPinned === false && anchor && anchor.classList.contains('temp-icon')) {
          this.removeTempIcon(anchor);
        }
        
        // Fallback to regular click
        const clickResult = await navBoxIPC.invoke('extensions-click-browser-action', extensionId);
        
        if (!clickResult?.success) {
          console.error('[NavBox] Extension action failed:', clickResult?.error);
          this.showToast('Extension action failed');
        }
      } else {
        // Set up cleanup for temp icon when popup closes (if applicable)
        if (options.isPinned === false && anchor && anchor.classList.contains('temp-icon')) {
          this.setupTempIconCleanup(anchor);
        }
      }
    } catch (error) {
      console.error('[NavBox] Extension action error:', error);
      this.showToast('Extension action failed');
    }
  }

  removeTempIcon(tempIcon) {
    if (!tempIcon || !tempIcon.parentNode) return;
    
    // Animate out
    tempIcon.style.opacity = '0';
    tempIcon.style.transform = 'scale(0.8)';
    
    // Remove from DOM after animation
    setTimeout(() => {
      if (tempIcon.parentNode) {
        tempIcon.parentNode.removeChild(tempIcon);
      }
    }, 120);
  }

  setupTempIconCleanup(tempIcon) {
    // For now, remove temp icon after a delay
    // TODO: In a full implementation, we'd listen for popup close events
    // from the extension system and clean up accordingly
    setTimeout(() => {
      this.removeTempIcon(tempIcon);
    }, 5000); // Remove after 5 seconds as fallback
  }

  showToast(message) {
    // Simple toast notification for user feedback
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      background: var(--peersky-nav-button-inactive, #666);
      color: white;
      padding: 8px 16px;
      border-radius: 4px;
      font-size: 14px;
      z-index: 10000;
      opacity: 0;
      transition: opacity 0.3s ease;
    `;
    
    document.body.appendChild(toast);
    
    // Animate in
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
    });
    
    // Remove after 3 seconds
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    }, 3000);
  }

  loadSVG(container, svgPath) {
    fetch(svgPath)
      .then((response) => response.text())
      .then((svgContent) => {
        container.innerHTML = svgContent;
        const svgElement = container.querySelector("svg");
        if (svgElement) {
          // Set larger size specifically for extensions icon
          if (svgPath.includes("extensions.svg")) {
            svgElement.setAttribute("width", "22");
            svgElement.setAttribute("height", "22");
          } else {
            svgElement.setAttribute("width", "18");
            svgElement.setAttribute("height", "18");
          }
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

  _toggleQrCodePopup() {
    if (this._qrPopup) {
      this.hideQrCodePopup();
      return;
    }

    const currentUrl = this.querySelector("#url").value;
    if (!currentUrl) return;

    this._qrPopup = document.createElement("qr-popup");
    this._qrPopup.setAttribute("url", currentUrl);
    this._qrPopup.setAttribute("visible", "");
    this._qrButton = this.buttonElements["qr-code"];

    document.body.appendChild(this._qrPopup);
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

    this._qrPopup.addEventListener("close", () => this.hideQrCodePopup());
    this._qrPopup.addEventListener("download", () => this._downloadQrCode());
  }

 _positionQrPopup() {
    if (!this._qrPopup || !this._qrButton) return;

    const buttonRect = this._qrButton.getBoundingClientRect();
    const navBoxRect = this.getBoundingClientRect();

    this._qrPopup.style.position = "absolute";
    this._qrPopup.style.top = `${buttonRect.bottom - navBoxRect.top + 50}px`; 
    this._qrPopup.style.left = `${buttonRect.left - navBoxRect.left - 310}px`; 
  }

  hideQrCodePopup() {
    if (this._qrPopup) {
      this._qrPopup.removeAttribute("visible");
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
    const img = this._qrPopup?.querySelector("qr-code img");
    if (!img) return;

    const a = document.createElement("a");
    const randomId = Math.random().toString(36).substring(2, 6);
    a.href = img.src;
    a.download = `psky-code-${randomId}.png`;
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
        } else if (button.id === "bookmark") {
          this.dispatchEvent(new CustomEvent("toggle-bookmark"));
        } else if (button.id === "qr-code") {
          this._toggleQrCodePopup();
        } else if (button.id === "extensions") {
          this._toggleExtensionsPopup();
        } else if (button.id === "settings") {
          this.dispatchEvent(
            new CustomEvent("navigate", {
              detail: { url: "peersky://settings" },
            })
          );
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

  attachExtensionListeners() {
    // Listen for browser action changes
    if (window.electronAPI?.extensions?.onBrowserActionChanged) {
      window.electronAPI.extensions.onBrowserActionChanged(() => {
        console.log("NavBox: Browser actions changed, refreshing...");
        this.renderBrowserActions();
      });
    }
  }

  attachThemeListener() {
    // Listen for theme reload events from settings manager
    window.addEventListener("theme-reload", (event) => {
      console.log("NavBox received theme reload event:", event.detail);
      this.handleThemeChange(event.detail.theme);
    });

    // Listen for search engine changes from settings manager
    try {
      navBoxIPC.on("search-engine-changed", (event, newEngine) => {
        console.log("NavBox: Search engine changed to:", newEngine);
        this.updateSearchPlaceholder();
      });
    } catch (error) {
      console.warn("NavBox: Could not setup search engine listener:", error);
    }
  }

  handleThemeChange(theme) {
    // Force re-evaluation of CSS by toggling a class
    this.classList.remove("theme-updating");
    // Use requestAnimationFrame to ensure the class removal is processed
    requestAnimationFrame(() => {
      this.classList.add("theme-updating");
      console.log("NavBox theme updated to:", theme);

      // Remove the temporary class after a brief moment
      setTimeout(() => {
        this.classList.remove("theme-updating");
      }, 100);
    });
  }

  // Extensions Popup Management
  async initializeExtensionsPopup() {
    try {
      const { ExtensionsPopup } = await import('./static/js/extensions-popup.js');
      this._extensionsPopup = new ExtensionsPopup();
    } catch (error) {
      console.error('Failed to initialize extensions popup:', error);
    }
  }

  _toggleExtensionsPopup() {
    if (!this._extensionsPopup) {
      console.error('Extensions popup not initialized');
      return;
    }

    const extensionsButton = this.buttonElements["extensions"];
    if (extensionsButton) {
      this._extensionsPopup.toggle(extensionsButton);
    }
  }
}

customElements.define("nav-box", NavBox);
