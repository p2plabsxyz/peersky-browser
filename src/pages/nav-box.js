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
    
    // Autocomplete state
    this._autocompleteDebounceTimer = null;
    this._autocompleteSelectedIndex = -1;
    this._autocompleteResults = [];
    this._isAutocompleteVisible = false;
    
    this.buildNavBox();
    this.attachEvents();
    this.updateSearchPlaceholder();
    this.attachThemeListener();
    this.attachExtensionListeners();
    this.attachAutocompleteListeners();
    this.initializeExtensionsPopup();
  }

  connectedCallback() {
    // Ensure placeholder updates when element is attached to DOM
    this.updateSearchPlaceholder();
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
    urlInput.setAttribute("autocomplete", "off");
    this.updateSearchPlaceholder();

    const qrButton = this.createButton(
      "qr-code",
      "peersky://static/assets/svg/qr-code.svg"
    );
    qrButton.classList.add("inside-urlbar");

    // Create autocomplete dropdown
    const autocompleteDropdown = document.createElement("div");
    autocompleteDropdown.className = "url-autocomplete-dropdown";
    autocompleteDropdown.id = "url-autocomplete";

    urlBarWrapper.appendChild(urlInput);
    urlBarWrapper.appendChild(qrButton);
    urlBarWrapper.appendChild(autocompleteDropdown);
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

  validateCssColor(color) {
    if (!color || typeof color !== 'string') return null;
    const trimmed = color.trim();
    if (trimmed.length === 0 || trimmed.length > 64) return null;
    try {
      if (typeof CSS !== 'undefined' && CSS.supports && CSS.supports('color', trimmed)) return trimmed;
    } catch (_) { }
    return null;
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
        
        // Filter to only show pinned extensions (max 6)
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
            const iconUrl = this.validateIconUrl(action.icon);
            const isInlineSvg = typeof iconUrl === 'string' && iconUrl.startsWith('peersky://') && iconUrl.endsWith('.svg');

            if (isInlineSvg) {
              // Inline SVG so it can inherit theme color via currentColor
              const iconContainer = document.createElement('div');
              iconContainer.className = 'extension-icon';
              this.loadSVG(iconContainer, iconUrl);
              button.appendChild(iconContainer);
            } else {
              const img = document.createElement('img');
              img.className = 'extension-icon';
              img.src = iconUrl;
              img.alt = this.escapeHtmlAttribute(action.name || 'Extension');
              // Fallback to inline puzzle icon if image fails
              img.onerror = () => {
                const fallback = document.createElement('div');
                fallback.className = 'extension-icon';
                this.loadSVG(fallback, 'peersky://static/assets/svg/puzzle.svg');
                if (img.parentNode) {
                  img.parentNode.replaceChild(fallback, img);
                }
              };
              button.appendChild(img);
            }
            
            // Add badge if present (sanitized)
            if (action.badgeText) {
              const badge = document.createElement('span');
              badge.className = 'extension-badge';
              badge.textContent = action.badgeText; // textContent auto-escapes
              const bg = this.validateCssColor(action.badgeBackgroundColor);
              if (bg) badge.style.backgroundColor = bg;
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
        
        console.log(`[NavBox] Rendered ${pinnedActions.length} pinned extension${pinnedActions.length !== 1 ? 's' : ''} out of ${allActions.length} total (max 6)`);
      } else {
        // Clear container if no actions
        container.innerHTML = '';
      }
    } catch (error) {
      console.error('[NavBox] Failed to render browser actions:', error);
      container.innerHTML = '';
    }
  }

  async updateBrowserActionBadges() {
    const container = this.querySelector("#extension-icons");
    if (!container) {
      return;
    }

    try {
      const actionsResult = await navBoxIPC.invoke('extensions-list-browser-actions');
      if (!actionsResult?.success || !Array.isArray(actionsResult.actions)) {
        return;
      }

      actionsResult.actions.forEach((action) => {
        const sanitizedId = this.escapeHtmlAttribute(action.id || '');
        if (!sanitizedId) {
          return;
        }

        const button = container.querySelector(`.extension-action-btn[data-extension-id="${sanitizedId}"]`);
        if (!button) {
          return;
        }

        const sanitizedTitle = this.escapeHtmlAttribute(action.title || action.name || '');
        if (sanitizedTitle && button.title !== sanitizedTitle) {
          button.title = sanitizedTitle;
        }

        const badgeText = (action.badgeText != null && String(action.badgeText).length > 0) ? String(action.badgeText) : '';
        let badge = button.querySelector('.extension-badge');

        if (!badgeText) {
          if (badge) {
            badge.remove();
          }
          return;
        }

        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'extension-badge';
          button.appendChild(badge);
        }

        if (badge.textContent !== badgeText) {
          badge.textContent = badgeText;
        }

        const bg = this.validateCssColor(action.badgeBackgroundColor);
        badge.style.backgroundColor = bg || '';
      });
    } catch (error) {
      console.error('[NavBox] Failed to update browser action badges:', error);
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
        this.showToast('Extension action failed', 'error');
      }
      } else {
        // Set up cleanup for temp icon when popup closes (if applicable)
        if (options.isPinned === false && anchor && anchor.classList.contains('temp-icon')) {
        //  this.setupTempIconCleanup(anchor);
        }
      }
    } catch (error) {
      console.error('[NavBox] Extension action error:', error);
      this.showToast('Extension action failed', 'error');
    }
  }
  removeAllTempIcon() {
    document.querySelectorAll('.temp-icon').forEach(el => el.remove());
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

  showToast(message, type = 'info') {
    // Simple toast notification for user feedback, with type styling
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      right: 20px;
      color: white;
      padding: 12px 20px;
      border-radius: 6px;
      font-size: 14px;
      z-index: 10000;
      opacity: 0;
      transition: opacity 0.3s ease;
    `;

    // Type-specific background colors (aligned with settings messages)
    let bg = '#2196f3'; // info
    if (type === 'error') bg = '#f44336';
    else if (type === 'warning') bg = '#ff9800';
    else if (type === 'success') bg = '#0fba84';
    toast.style.backgroundColor = bg;
    
    document.body.appendChild(toast);

    // Position below the nav bar to avoid overlap
    try {
      const navRect = this.getBoundingClientRect();
      const topOffset = Math.max(0, (navRect?.bottom || 0) + 16);
      toast.style.top = `${topOffset}px`;
    } catch (_) {
      toast.style.top = '20px';
    }
    
    // Animate in
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
    });
    
    // Remove after a short delay (longer for errors)
    const duration = type === 'error' ? 3000 : 2000;
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    }, duration);
  }

  loadSVG(container, svgPath) {
    fetch(svgPath)
      .then((response) => response.text())
      .then((svgContent) => {
        container.innerHTML = svgContent;
        const svgElement = container.querySelector("svg");
        if (svgElement) {
          // Set sizes by context
          if (container.closest('.extension-action-btn')) {
            // Toolbar extension icons
            svgElement.setAttribute('width', '20');
            svgElement.setAttribute('height', '20');
          } else if (svgPath.includes("extensions.svg")) {
            // Extensions puzzle button icon
            svgElement.setAttribute("width", "22");
            svgElement.setAttribute("height", "22");
          } else {
            // Default small icons for nav controls
            svgElement.setAttribute("width", "18");
            svgElement.setAttribute("height", "18");
          }
          svgElement.setAttribute("fill", "currentColor");
          // Ensure stroke-based icons adopt theme color
          try {
            svgElement.querySelectorAll('[stroke]').forEach(el => el.setAttribute('stroke', 'currentColor'));
          } catch (_) {}
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

    let top = buttonRect.bottom - navBoxRect.top + 50;

    const titlebar = document.querySelector("#titlebar");
    if (process.platform === 'darwin' && titlebar?.classList.contains('titlebar-collapsed-darwin')) {
      top -= 38;
    }

    this._qrPopup.style.position = "absolute";
    this._qrPopup.style.top = `${top}px`; 
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

  _titleCase(key) {
    if (!key) return 'Search';
    return key.replace(/(^|[\s-])(\w)/g, (_, p1, p2) => p1 + p2.toUpperCase());
  }

  _safeParseUrl(s) {
    try { return new URL(s); } catch {}
    try { return new URL('https://' + s); } catch {}
    return null;
  }

  async updateSearchPlaceholder() {
    const input = this.querySelector('#url');
    if (!input) return;

    try {
      const { ipcRenderer } = require("electron");
      const engineKey = await ipcRenderer.invoke('settings-get', 'searchEngine');

      let name;
      if (engineKey === 'custom') {
        const tpl = await ipcRenderer.invoke('settings-get', 'customSearchTemplate');
        const u = this._safeParseUrl(tpl);

        if (u?.hostname) {
          // remove 'www.' and the top-level domain (.com, .org, .net, etc.)
          const cleanHost = u.hostname
            .replace(/^www\./i, '') // remove www.
            .replace(/\.[^.]+$/, ''); // remove last dot + tld

          // capitalize first letter
          name = this._titleCase(cleanHost);
        } else {
          name = 'Custom';
        }
      } else if (engineKey) {
        name = this._titleCase(engineKey);
      } else {
        name = 'DuckDuckGo'
      }

      input.placeholder = `Search with ${name} or type a P2P URL`;
    } catch (err) {
      console.warn('updateSearchPlaceholder failed:', err);
      input.placeholder = 'Search or type a P2P URL';
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

      const normalizeFilePathToUrl = (filePath) => {
        if (!filePath) return null;
        if (process.platform === "win32") {
          const normalized = filePath.replace(/\\/g, "/");
          return `file://${normalized.startsWith("/") ? "" : "/"}${normalized}`;
        }
        return `file://${filePath}`;
      };

      const handleDropNavigate = (event) => {
        event.preventDefault();
        event.stopPropagation();

        const { dataTransfer } = event;
        if (!dataTransfer) return;

        if (dataTransfer.files && dataTransfer.files.length > 0) {
          const file = dataTransfer.files[0];
          const targetUrl = normalizeFilePathToUrl(file.path);
          if (targetUrl) {
            urlInput.value = targetUrl;
            this.dispatchEvent(new CustomEvent("navigate", { detail: { url: targetUrl } }));
            return;
          }
        }

        const textUrl = dataTransfer.getData("text/uri-list") || dataTransfer.getData("text/plain");
        if (textUrl) {
          const url = textUrl.trim();
          if (url) {
            urlInput.value = url;
            this.dispatchEvent(new CustomEvent("navigate", { detail: { url } }));
          }
        }
      };

      const preventDefaultDrag = (event) => {
        if (!event.dataTransfer) return;
        if ((event.dataTransfer.files && event.dataTransfer.files.length > 0) ||
            event.dataTransfer.types?.includes("text/uri-list") ||
            event.dataTransfer.types?.includes("text/plain")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      };

      ["dragenter", "dragover"].forEach((evt) => {
        urlInput.addEventListener(evt, preventDefaultDrag);
      });
      urlInput.addEventListener("drop", handleDropNavigate);
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

    if (navBoxIPC && typeof navBoxIPC.on === 'function') {
      navBoxIPC.on('browser-action-updated', () => {
        this.updateBrowserActionBadges();
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

  // Autocomplete / History Suggestions
  attachAutocompleteListeners() {
    const urlInput = this.querySelector("#url");
    const dropdown = this.querySelector("#url-autocomplete");
    
    if (!urlInput || !dropdown) {
      console.warn('[NavBox] Autocomplete elements not found');
      return;
    }

    // Input event - search as user types
    urlInput.addEventListener("input", (e) => {
      this._handleAutocompleteInput(e.target.value);
    });

    // Keyboard navigation
    urlInput.addEventListener("keydown", (e) => {
      this._handleAutocompleteKeydown(e);
    });

    // Focus event - show suggestions if there's input
    urlInput.addEventListener("focus", () => {
      if (urlInput.value.trim().length > 0 && this._autocompleteResults.length > 0) {
        this._showAutocomplete();
      }
    });

    // Blur event - hide suggestions (with delay for click handling)
    urlInput.addEventListener("blur", () => {
      setTimeout(() => this._hideAutocomplete(), 150);
    });

    // Click outside to close
    document.addEventListener("mousedown", (e) => {
      if (!this.contains(e.target)) {
        this._hideAutocomplete();
      }
    });
  }

  async _handleAutocompleteInput(value) {
    // Clear any pending debounce timer
    if (this._autocompleteDebounceTimer) {
      clearTimeout(this._autocompleteDebounceTimer);
    }

    const query = value.trim();
    
    // Hide if empty
    if (query.length < 1) {
      this._hideAutocomplete();
      this._autocompleteResults = [];
      return;
    }

    // Debounce the search (200ms)
    this._autocompleteDebounceTimer = setTimeout(async () => {
      try {
        const result = await navBoxIPC.invoke('history-search', query);
        
        if (result.success && result.results && result.results.length > 0) {
          this._autocompleteResults = result.results;
          this._autocompleteSelectedIndex = -1;
          this._renderAutocompleteResults();
          this._showAutocomplete();
        } else {
          this._autocompleteResults = [];
          this._hideAutocomplete();
        }
      } catch (error) {
        console.error('[NavBox] History search failed:', error);
        this._hideAutocomplete();
      }
    }, 200);
  }

  _handleAutocompleteKeydown(e) {
    if (!this._isAutocompleteVisible) {
      return;
    }

    const dropdown = this.querySelector("#url-autocomplete");
    const items = dropdown?.querySelectorAll('.autocomplete-item');
    
    if (!items || items.length === 0) {
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this._autocompleteSelectedIndex = Math.min(
          this._autocompleteSelectedIndex + 1,
          items.length - 1
        );
        this._updateAutocompleteSelection();
        break;

      case 'ArrowUp':
        e.preventDefault();
        this._autocompleteSelectedIndex = Math.max(
          this._autocompleteSelectedIndex - 1,
          -1
        );
        this._updateAutocompleteSelection();
        break;

      case 'Enter':
        if (this._autocompleteSelectedIndex >= 0) {
          e.preventDefault();
          const selected = this._autocompleteResults[this._autocompleteSelectedIndex];
          if (selected) {
            this._selectAutocompleteItem(selected);
          }
        } else {
          this._hideAutocomplete();
        }
        break;

      case 'Escape':
        e.preventDefault();
        this._hideAutocomplete();
        break;

      case 'Tab':
        this._hideAutocomplete();
        break;
    }
  }

  _renderAutocompleteResults() {
    const dropdown = this.querySelector("#url-autocomplete");
    if (!dropdown) return;

    // Clear existing results
    dropdown.innerHTML = '';

    this._autocompleteResults.forEach((result, index) => {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      item.dataset.index = index;

      // Create content wrapper
      const content = document.createElement('div');
      content.className = 'autocomplete-content';

      // Title
      const title = document.createElement('div');
      title.className = 'autocomplete-title';
      title.textContent = result.title || result.host || 'Untitled';

      // URL
      const url = document.createElement('div');
      url.className = 'autocomplete-url';
      url.textContent = result.url || '';

      content.appendChild(title);
      content.appendChild(url);

      item.appendChild(content);

      // Click handler
      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Prevent blur
        this._selectAutocompleteItem(result);
      });

      // Hover handler
      item.addEventListener('mouseenter', () => {
        this._autocompleteSelectedIndex = index;
        this._updateAutocompleteSelection();
      });

      dropdown.appendChild(item);
    });
  }

  _updateAutocompleteSelection() {
    const dropdown = this.querySelector("#url-autocomplete");
    if (!dropdown) return;

    const items = dropdown.querySelectorAll('.autocomplete-item');
    items.forEach((item, index) => {
      if (index === this._autocompleteSelectedIndex) {
        item.classList.add('selected');
        item.scrollIntoView({ block: 'nearest' });
      } else {
        item.classList.remove('selected');
      }
    });

    // Update URL input with selected item's URL for preview
    const urlInput = this.querySelector("#url");
    if (urlInput && this._autocompleteSelectedIndex >= 0) {
      const selected = this._autocompleteResults[this._autocompleteSelectedIndex];
      if (selected && selected.url) {
        urlInput.value = selected.url;
      }
    }
  }

  _selectAutocompleteItem(result) {
    const urlInput = this.querySelector("#url");
    if (urlInput && result.url) {
      urlInput.value = result.url;
      this._hideAutocomplete();
      
      // Dispatch navigate event
      this.dispatchEvent(new CustomEvent("navigate", {
        detail: { url: result.url }
      }));
    }
  }

  _showAutocomplete() {
    const dropdown = this.querySelector("#url-autocomplete");
    if (dropdown && this._autocompleteResults.length > 0) {
      dropdown.classList.add('visible');
      this._isAutocompleteVisible = true;
    }
  }

  _hideAutocomplete() {
    const dropdown = this.querySelector("#url-autocomplete");
    if (dropdown) {
      dropdown.classList.remove('visible');
      this._isAutocompleteVisible = false;
      this._autocompleteSelectedIndex = -1;
    }
  }
}

customElements.define("nav-box", NavBox);
