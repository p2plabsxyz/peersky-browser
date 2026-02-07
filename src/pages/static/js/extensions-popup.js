/**
 * ExtensionsPopup - Self-contained popup UI for browser extensions list
 * Handles popup lifecycle, positioning, and internal interactions
 */
export class ExtensionsPopup {
    constructor() {
        this.popup = null;
        this.isVisible = false;
        this.targetButton = null;
        this.extensions = []; // Store real extension data
        this.isLoading = false;
        this._openKebabAnchor = null; // Track currently open kebab anchor for toggle
        
        // Bind methods to preserve context
        this.hide = this.hide.bind(this);
        this.handleClickOutside = this.handleClickOutside.bind(this);
        this.handleKeyDown = this.handleKeyDown.bind(this);
        
        // Setup IPC access (same pattern as nav-box)
        this.ipc = (() => {
            const { ipcRenderer } = require('electron');
            return ipcRenderer;
        })();
        
        // Setup real-time extension state listening
        this.setupExtensionListeners();
    }

    /**
     * Setup real-time extension state listeners
     */
    setupExtensionListeners() {
        // Listen for browser action changes (enable/disable, install/uninstall)
        this.ipc.on('browser-action-changed', (event, data) => {
            console.log('[ExtensionsPopup] Browser action changed:', data);
            
            // If popup is visible, refresh the extension list
            if (this.isVisible) {
                this.refreshExtensionList();
            }
        });

        this.ipc.on('browser-action-updated', () => {
            if (this.isVisible) {
                this.updateExtensionBadges();
            }
        });

        // Listen for general extension state changes
        this.ipc.on('extension-toggled', (event, extensionId, enabled) => {
            console.log(`[ExtensionsPopup] Extension ${extensionId} toggled: ${enabled}`);
            
            // If popup is visible, refresh the extension list
            if (this.isVisible) {
                this.refreshExtensionList();
            }
        });

        // Listen for extension installations
        this.ipc.on('extension-installed', (event, extensionData) => {
            console.log('[ExtensionsPopup] Extension installed:', extensionData);
            
            // If popup is visible, refresh the extension list
            if (this.isVisible) {
                this.refreshExtensionList();
            }
        });

        // Listen for extension uninstalls
        this.ipc.on('extension-uninstalled', (event, extensionId) => {
            console.log('[ExtensionsPopup] Extension uninstalled:', extensionId);
            
            // If popup is visible, refresh the extension list
            if (this.isVisible) {
                this.refreshExtensionList();
            }
        });
    }

    /**
     * Create the popup HTML structure
     */
    createPopup() {
        const popup = document.createElement('div');
        popup.className = 'extensions-popup';
        popup.setAttribute('role', 'dialog');
        popup.setAttribute('aria-label', 'Extensions list');
        popup.setAttribute('aria-modal', 'true');

        popup.innerHTML = `
            <div class="extensions-popup-header">
                <h3>Extensions</h3>
                <button class="close-button" type="button" aria-label="Close extensions popup" title="Close">
                    <div class="svg-container"></div>
                </button>
            </div>
            <div class="extensions-popup-list" role="list">
                ${this.generateExtensionItems()}
            </div>
        `;

        document.body.appendChild(popup);
        
        // Load SVG icons after DOM insertion
        this.loadPopupSVGs(popup);
        
        return popup;
    }

    /**
     * HTML sanitization utilities for extension security
     */
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

    validateCssColor(color) {
        if (!color || typeof color !== 'string') return null;
        const trimmed = color.trim();
        if (trimmed.length === 0 || trimmed.length > 64) return null;
        try {
            if (typeof CSS !== 'undefined' && CSS.supports && CSS.supports('color', trimmed)) return trimmed;
        } catch (_) { }
        return null;
    }

    /**
     * Load real extension data from backend
     */
    async loadExtensions() {
        this.isLoading = true;
        
        try {
            // Get enabled extensions with browser actions
            const extensionsResult = await this.ipc.invoke('extensions-list-browser-actions');
            const pinnedResult = await this.ipc.invoke('extensions-get-pinned');
            
            if (extensionsResult?.success) {
                this.extensions = extensionsResult.actions || [];
                const pinnedExtensions = pinnedResult?.success ? pinnedResult.pinnedExtensions || [] : [];
                
                // Mark pinned extensions in the extension data
                this.extensions.forEach(ext => {
                    ext.pinned = pinnedExtensions.includes(ext.id);
                });
                
                console.log(`[ExtensionsPopup] Loaded ${this.extensions.length} enabled extensions, ${pinnedExtensions.length} pinned`);
            } else {
                console.error('[ExtensionsPopup] Failed to load extensions:', extensionsResult?.error);
                this.extensions = [];
            }
        } catch (error) {
            console.error('[ExtensionsPopup] Extension loading error:', error);
            this.extensions = [];
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Generate extension items from real data (secured)
     */
    generateExtensionItems() {
        if (this.isLoading) {
            return `
                <div class="extension-loading">
                    <div class="loading-spinner"></div>
                    <p>Loading extensions...</p>
                </div>
            `;
        }

        if (this.extensions.length === 0) {
            return `
                <div class="extensions-empty">
                    <p>No enabled extensions</p>
                </div>
            `;
        }

        return this.extensions.map(ext => {
            const escapedId = this.escapeHtmlAttribute(ext.id || '');
            const escapedName = this.escapeHtml(ext.name || 'Unknown Extension');
            const escapedNameAttr = this.escapeHtmlAttribute(ext.name || 'Unknown Extension');
            const pinLabel = ext.pinned ? 'Unpin' : 'Pin';
            const hasAction = !!ext.hasAction; // extensions without actions should appear but not be pinnable/clickable
            const badgeText = (ext.badgeText != null && String(ext.badgeText).length > 0) ? String(ext.badgeText) : '';
            const badgeTextEscaped = this.escapeHtml(badgeText);
            const badgeColorAttr = this.escapeHtmlAttribute(typeof ext.badgeBackgroundColor === 'string' ? ext.badgeBackgroundColor : '');
            
            return `
                <div class="extension-item ${hasAction ? '' : 'no-action'}" role="listitem" data-extension-id="${escapedId}">
                    <div class="extension-icon" role="img" aria-label="${escapedNameAttr} icon">
                        ${ext.icon ? `<img src="${this.escapeHtmlAttribute(ext.icon)}" alt="${escapedNameAttr} icon" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">` : ''}
                        <div class="svg-container" style="${ext.icon ? 'display:none' : 'display:block'}"></div>
                        ${badgeText ? `<span class="extension-badge" data-badge-color="${badgeColorAttr}">${badgeTextEscaped}</span>` : ''}
                    </div>
                    <div class="extension-name" title="${escapedNameAttr}">
                        ${escapedName}${hasAction ? '' : ' <span style="opacity:0.7; font-size:12px;">(no button)</span>'}
                    </div>
                    <div class="extension-controls">
                        <button 
                            class="pin-button ${ext.pinned ? 'pinned' : ''}" 
                            type="button"
                            ${hasAction ? '' : 'disabled'}
                            aria-label="${this.escapeHtmlAttribute(pinLabel + ' ' + ext.name)}"
                            title="${this.escapeHtmlAttribute(hasAction ? (pinLabel + ' extension') : 'This extension has no toolbar button')}"
                        >
                            <div class="svg-container"></div>
                        </button>
                        <button 
                            class="kebab-button" 
                            type="button"
                            aria-label="${this.escapeHtmlAttribute('More options for ' + ext.name)}"
                            title="More options"
                        >
                            <div class="svg-container"></div>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    }

    /**
     * Position popup relative to target button
     */
    positionPopup() {
        if (!this.popup || !this.targetButton) return;

        const buttonRect = this.targetButton.getBoundingClientRect();
        const popupRect = this.popup.getBoundingClientRect();
        
        // Position below button, aligned to right edge
        let left = buttonRect.right - popupRect.width;
        let top = buttonRect.bottom + 8;

        // Ensure popup stays within viewport
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        // Horizontal bounds checking
        if (left < 20) {
            left = 20;
        } else if (left + popupRect.width > viewportWidth - 20) {
            left = viewportWidth - popupRect.width - 20;
        }
        
        // Vertical bounds checking
        if (top + popupRect.height > viewportHeight - 20) {
            top = buttonRect.top - popupRect.height - 8;
        }

        this.popup.style.left = `${left}px`;
        this.popup.style.top = `${top}px`;
    }

    /**
     * Show the popup
     */
    async show(targetButton) {
        if (this.isVisible) return;

        this.targetButton = targetButton;
        
        if (!this.popup) {
            this.popup = this.createPopup();
            this.setupEventListeners();
        }

        this.popup.classList.add('open');
        this.isVisible = true;

        // Load extension data and update popup content
        await this.refreshExtensionList();

        // Position after DOM update
        requestAnimationFrame(() => {
            this.positionPopup();
        });

        // Setup global event listeners
        document.addEventListener('click', this.handleClickOutside);
        document.addEventListener('keydown', this.handleKeyDown);
    }

    /**
     * Refresh the extension list in the popup
     */
    async refreshExtensionList() {
        if (!this.popup) return;

        const listContainer = this.popup.querySelector('.extensions-popup-list');
        if (!listContainer) return;

        // Show loading state
        this.isLoading = true;
        listContainer.innerHTML = this.generateExtensionItems();
        this.loadPopupSVGs(this.popup); // Load loading spinner if any

        // Load real data
        await this.loadExtensions();
        
        // Update with real data
        listContainer.innerHTML = this.generateExtensionItems();
        this.loadPopupSVGs(this.popup); // Load all SVGs for the new content
        this.applyBadgeStyles(listContainer);
    }

    async updateExtensionBadges() {
        if (!this.popup) return;

        const listContainer = this.popup.querySelector('.extensions-popup-list');
        if (!listContainer) return;

        await this.loadExtensions();

        if (!Array.isArray(this.extensions) || this.extensions.length === 0) {
            return;
        }

        this.extensions.forEach(ext => {
            const escapedId = this.escapeHtmlAttribute(ext.id || '');
            if (!escapedId) return;

            const item = listContainer.querySelector(`.extension-item[data-extension-id="${escapedId}"]`);
            if (!item) return;

            const icon = item.querySelector('.extension-icon');
            if (!icon) return;

            const badgeText = (ext.badgeText != null && String(ext.badgeText).length > 0) ? String(ext.badgeText) : '';
            let badge = icon.querySelector('.extension-badge');

            if (!badgeText) {
                if (badge) {
                    badge.remove();
                }
                return;
            }

            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'extension-badge';
                icon.appendChild(badge);
            }

            if (badge.textContent !== badgeText) {
                badge.textContent = badgeText;
            }

            const bg = this.validateCssColor(ext.badgeBackgroundColor);
            badge.style.backgroundColor = bg || '';
            if (bg) {
                badge.setAttribute('data-badge-color', bg);
            } else {
                badge.removeAttribute('data-badge-color');
            }
        });
    }

    applyBadgeStyles(container) {
        if (!container) return;
        const badges = container.querySelectorAll('.extension-badge[data-badge-color]');
        badges.forEach((badge) => {
            const raw = badge.getAttribute('data-badge-color') || '';
            const bg = this.validateCssColor(raw);
            if (bg) badge.style.backgroundColor = bg;
        });
    }

    /**
     * Hide the popup
     */
    hide() {
        if (!this.isVisible) return;
        document.querySelector(".extension-kebab-menu")?.remove();
        this.popup?.classList.remove('open');
        this.isVisible = false;
        this._openKebabAnchor = null;

        // Remove global event listeners
        document.removeEventListener('click', this.handleClickOutside);
        document.removeEventListener('keydown', this.handleKeyDown);
    }

    /**
     * Toggle popup visibility
     */
    toggle(targetButton) {
        if (this.isVisible) {
            this.hide();
        } else {
            this.show(targetButton);
        }
    }

    /**
     * Setup internal event listeners for popup interactions
     */
    setupEventListeners() {
        if (!this.popup) return;

        // Pin button interactions - prevent any dropdown behavior
        this.popup.addEventListener('click', (event) => {
            if (event.target.classList.contains('pin-button') || event.target.closest('.pin-button')) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                
                // Get the actual pin button element
                const pinButton = event.target.classList.contains('pin-button') 
                    ? event.target 
                    : event.target.closest('.pin-button');
                
                this.togglePin(pinButton);
                return false;
            }
        }, true); // Use capture phase to ensure we get the event first

        // Kebab menu interactions
        this.popup.addEventListener("click", (event) => {
            if (
              event.target.classList.contains("kebab-button") ||
              event.target.closest(".kebab-button")
            ) {
              event.preventDefault();
              event.stopPropagation();
              event.stopImmediatePropagation();
      
              const kebabButton = event.target.closest(".kebab-button");
              const existingMenu = document.querySelector(".extension-kebab-menu");
              // Toggle behavior: if clicking the same kebab when menu is open, just close it
              if (existingMenu && this._openKebabAnchor === kebabButton) {
                existingMenu.remove();
                this._openKebabAnchor = null;
                return;
              }
              // Otherwise, close any existing and open a new one
              existingMenu?.remove();
      
              const menu = document.createElement("div");
              menu.className = "extension-kebab-menu";
      
              const extensionEl = kebabButton.closest(".extension-item");
              const extensionId = extensionEl?.dataset.extensionId;
              const pinButton = extensionEl?.querySelector(".pin-button");
              const isPinned = pinButton.classList.contains("pinned");
              const extensionItem = event.target.closest(".extension-item");
              const extensionName =
                extensionItem?.querySelector(".extension-name")?.textContent;
              const safeExtensionName = this.escapeHtml(extensionName || '');
      
              menu.innerHTML = `
          <ul>
            <li class="menu-item" data-action="toChromewebstore">${safeExtensionName}</li>
            <li class="menu-item" data-action="togglePin">${
              isPinned ? "Unpin" : "Pin"
            }</li>
            <li class="menu-item" data-action="uninstall">Uninstall Extension</li>
          </ul>
        `;
        menu.style.position = "absolute";
        menu.style.visibility = "hidden";
        menu.style.zIndex = "9999";
        document.body.appendChild(menu);

        const btnRect = kebabButton.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const padding = 8;

        let left = btnRect.left;
        let top = btnRect.bottom + 4;

        if (left + menuRect.width > window.innerWidth - padding) {
          left = window.innerWidth - menuRect.width - padding;
        }

        if (top + menuRect.height > window.innerHeight - padding) {
          top = btnRect.top - menuRect.height - 4;
        }

        // Align menu's left edge with kebab button's left border
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        menu.style.visibility = "visible";
        // Track anchor for toggle behavior
        this._openKebabAnchor = kebabButton;
        menu.querySelectorAll(".menu-item").forEach((item) => {
            item.addEventListener("click", async (e) => {
              e.stopPropagation();
              if (item.dataset.action === "toChromewebstore") {
                const url = `https://chromewebstore.google.com/detail/${encodeURIComponent(
                  extensionName
                )}/${extensionId}?hl=en`;
                const { ipcRenderer } = require("electron");
                ipcRenderer.send("open-tab-in-main-window", url);
                this.hide();
              }
  
              if (item.dataset.action === "togglePin") {
                this.togglePin(pinButton);
              }
              if (item.dataset.action === "uninstall") {
                try {
                  const result = await this.ipc.invoke(
                    "extensions-uninstall",
                    extensionId
                  );
                  if (result?.success) {
                    console.log(
                      `[ExtensionsPopup] Uninstalled ${extensionId} successfully`
                    );
                    await this.ipc.invoke("extensions-unpin", extensionId);
                    const navBox = document.querySelector("nav-box");
                    navBox.renderBrowserActions();
                    this.refreshExtensionList();
                  } else {
                    console.error(
                      `[ExtensionsPopup] Failed to uninstall ${extensionId}:`,
                      result?.error
                    );
                  }
                } catch (err) {
                  console.error(
                    `[ExtensionsPopup] IPC uninstall error for ${extensionId}:`,
                    err
                  );
                }
              }
              console.log(`click: ${item.dataset.action}`);
              menu.remove();
              this._openKebabAnchor = null;
            });
          });
  
          const handleClickOutside = (e) => {
            if (!menu.contains(e.target) && !kebabButton.contains(e.target)) {
              menu.remove();
              this._openKebabAnchor = null;
              document.removeEventListener("click", handleClickOutside);
            }
          };
          document.addEventListener("click", handleClickOutside);
  
          // Placeholder for future kebab menu functionality
          console.log("Kebab menu clicked for extension");
        }
      });


        // Extension item clicks (for popup opening from dropdown)
        this.popup.addEventListener('click', (event) => {
            const extensionItem = event.target.closest('.extension-item');
            if (extensionItem && !event.target.closest('.extension-controls')) {
                event.preventDefault();
                event.stopPropagation();
                const id = extensionItem?.dataset?.extensionId;
                const ext = this.extensions.find(e => e.id === id);
                if (ext && ext.hasAction) {
                  this.handleExtensionClick(extensionItem);
                } else {
                  const navBox = document.querySelector('nav-box');
                  if (navBox && typeof navBox.showToast === 'function') {
                    navBox.showToast('This extension has no toolbar button', 'error');
                  }
                }
            }
        });

        // Close button
        this.popup.addEventListener('click', (event) => {
            if (event.target.closest('.close-button')) {
                event.preventDefault();
                event.stopPropagation();
                this.hide();
            }
        });
    }

    /**
     * Handle extension item click (for opening browser action popup)
     */
    handleExtensionClick(extensionItem) {
        const extensionId = extensionItem.dataset.extensionId;
        if (!extensionId) {
            console.warn('ExtensionsPopup: No extension ID found');
            return;
        }

        // Find the extension data for the clicked item
        const extension = this.extensions.find(ext => ext.id === extensionId);
        if (!extension) {
            console.warn('ExtensionsPopup: Extension data not found for', extensionId);
            return;
        }

        // Get the nav-box instance to trigger the extension action
        const navBox = document.querySelector('nav-box');
        if (navBox) {
            let anchorElement = null;
            let options = { isPinned: false };

            // Check if extension is already pinned and use existing icon
            if (extension.pinned) {
                anchorElement = this.findPinnedExtensionIcon(extensionId);
                if (anchorElement) {
                    options.isPinned = true;
                    console.log(`[ExtensionsPopup] Using existing pinned icon for ${extensionId}`);
                }
            }

            // If no pinned icon found, create temporary icon for unpinned extensions
            if (!anchorElement) {
                anchorElement = this.insertTempIconNextToPuzzle(extensionId, extension);
                if (anchorElement) {
                    console.log(`[ExtensionsPopup] Created temporary icon for extension: ${extensionId}`);
                }
            }

            if (anchorElement) {
                // Trigger the extension action with the appropriate anchor
                navBox.handleExtensionActionClick(extensionId, anchorElement, options);
                
                // Hide the dropdown after triggering the action
                this.hide();
            } else {
                console.error(`[ExtensionsPopup] Failed to create anchor element for extension: ${extensionId}`);
            }
        } else {
            console.error('ExtensionsPopup: Nav-box not found');
        }
    }

    /**
     * Find existing pinned extension icon in the toolbar
     * @param {string} extensionId - Extension ID to find
     * @returns {HTMLElement|null} The pinned extension button or null if not found
     */
    findPinnedExtensionIcon(extensionId) {
        const navBox = document.querySelector('nav-box');
        if (!navBox) {
            console.warn('[ExtensionsPopup] Nav-box not found');
            return null;
        }

        // Look for pinned extension button with matching extension ID
        const escapedId = this.escapeHtmlAttribute(extensionId);
        const pinnedIcon = navBox.querySelector(`.extension-action-btn.pinned-extension[data-extension-id="${escapedId}"]`);
        
        if (pinnedIcon) {
            console.log(`[ExtensionsPopup] Found existing pinned icon for extension: ${extensionId}`);
            return pinnedIcon;
        }
        
        return null;
    }

    /**
     * Insert temporary icon next to puzzle button for non-pinned extensions
     * @param {string} extensionId - Extension ID
     * @param {Object} extension - Extension data object
     * @returns {HTMLElement|null} The created temporary button element or null if failed
     */
    insertTempIconNextToPuzzle(extensionId, extension) {
        const navBox = document.querySelector('nav-box');
        const puzzleButton = navBox?.querySelector('#extensions');
        
        if (!puzzleButton) {
            console.warn('ExtensionsPopup: Puzzle button not found');
            return null;
        }

        // Create temporary icon (same structure as nav-box renderBrowserActions)
        const tempIcon = document.createElement('button');
        tempIcon.className = 'extension-action-btn temp-icon';
        tempIcon.dataset.extensionId = this.escapeHtmlAttribute(extensionId);
        tempIcon.title = this.escapeHtmlAttribute(extension.title || extension.name || '');
        tempIcon.style.cssText = `
            opacity: 0;
            transform: scale(0.8);
            transition: all 0.12s ease;
        `;
        
        // Create and validate icon (same pattern as nav-box)
        const iconUrl = extension.icon || 'peersky://static/assets/svg/puzzle.svg';
        const isInlineSvg = typeof iconUrl === 'string' && iconUrl.startsWith('peersky://') && iconUrl.endsWith('.svg');

        if (isInlineSvg) {
            const iconContainer = document.createElement('div');
            iconContainer.className = 'extension-icon';
            this.loadSVG(iconContainer, iconUrl);
            tempIcon.appendChild(iconContainer);
        } else {
            const img = document.createElement('img');
            img.className = 'extension-icon';
            img.src = iconUrl;
            img.alt = this.escapeHtmlAttribute(extension.name || 'Extension');
            img.onerror = () => {
                const fallback = document.createElement('div');
                fallback.className = 'extension-icon';
                this.loadSVG(fallback, 'peersky://static/assets/svg/puzzle.svg');
                if (img.parentNode) {
                    img.parentNode.replaceChild(fallback, img);
                }
            };
            tempIcon.appendChild(img);
        }
        
        // Add badge if present (same as nav-box)
        if (extension.badgeText) {
            const badge = document.createElement('span');
            badge.className = 'extension-badge';
            badge.textContent = extension.badgeText;
            const bg = this.validateCssColor(extension.badgeBackgroundColor);
            if (bg) badge.style.backgroundColor = bg;
            tempIcon.appendChild(badge);
        }
        
        // Insert after puzzle button
        puzzleButton.parentNode.insertBefore(tempIcon, puzzleButton.nextSibling);
        
        // Animate in
        requestAnimationFrame(() => {
            tempIcon.style.opacity = '1';
            tempIcon.style.transform = 'scale(1)';
        });

        return tempIcon;
    }

    /**
     * Toggle pin state for an extension
     */
    async togglePin(pinButton) {
        const isPinned = pinButton.classList.contains('pinned');
        const extensionItem = pinButton.closest('.extension-item');
        const extensionId = extensionItem?.dataset.extensionId;
        const extensionName = extensionItem?.querySelector('.extension-name')?.textContent;
        const svgContainer = pinButton.querySelector('.svg-container');
        
        if (!extensionId) {
            console.error('[ExtensionsPopup] No extension ID found for pin toggle');
            return;
        }

        try {
            // Add animation class before state change
            pinButton.classList.add('pin-animating');
            
            let result;
            if (isPinned) {
                // Unpin extension
                result = await this.ipc.invoke('extensions-unpin', extensionId);
                if (result?.success) {
                    // Animate out, then change state
                    setTimeout(() => {
                        pinButton.classList.remove('pinned', 'pin-animating');
                        pinButton.setAttribute('aria-label', `Pin ${extensionName}`);
                        pinButton.setAttribute('title', 'Pin extension');
                        
                        // Load outline pin icon for unpinned state
                        if (svgContainer) {
                            this.loadSVG(svgContainer, 'peersky://static/assets/svg/pin-angle.svg');
                        }
                    }, 80);
                    
                    console.log(`[ExtensionsPopup] Extension ${extensionName} unpinned successfully`);
                } else {
                    pinButton.classList.remove('pin-animating');
                    console.error('[ExtensionsPopup] Failed to unpin extension:', result?.error);
                }
            } else {
                // Pin extension
                result = await this.ipc.invoke('extensions-pin', extensionId);
                if (result?.success) {
                    // Animate out, then change state
                    setTimeout(() => {
                        pinButton.classList.remove('pin-animating');
                        pinButton.classList.add('pinned');
                        pinButton.setAttribute('aria-label', `Unpin ${extensionName}`);
                        pinButton.setAttribute('title', 'Unpin extension');
                        
                        // Load filled pin icon for pinned state
                        if (svgContainer) {
                            this.loadSVG(svgContainer, 'peersky://static/assets/svg/pin-angle-fill.svg');
                        }
                    }, 80);
                    
                    console.log(`[ExtensionsPopup] Extension ${extensionName} pinned successfully`);
                } else {
                    pinButton.classList.remove('pin-animating');
                    console.error('[ExtensionsPopup] Failed to pin extension:', result?.error);
                    
                    // Show user-friendly error for pin limit
                    if (result?.code === 'E_PIN_LIMIT') {
                        console.warn('[ExtensionsPopup] Pin limit reached (6 extensions maximum)');
                        const navBox = document.querySelector('nav-box');
                        if (navBox && typeof navBox.showToast === 'function') {
                            navBox.showToast('Maximum 6 pinned extensions', 'error');
                        } else {
                            alert('Maximum 6 pinned extensions');
                        }
                    }
                }
            }
            
            // Refresh the toolbar to show/hide pinned icons
            const navBox = document.querySelector('nav-box');
            if (navBox && result?.success) {
                navBox.renderBrowserActions();
            }
            
        } catch (error) {
            console.error('[ExtensionsPopup] Pin toggle IPC error:', error);
        }
    }

    /**
     * Handle clicks outside the popup to close it
     */
    handleClickOutside(event) {
        if (!this.popup || !this.isVisible) return;

        // Don't close if clicking inside popup or on the target button
        if (this.popup.contains(event.target) || 
            (this.targetButton && this.targetButton.contains(event.target))) {
            return;
        }

        this.hide();
    }

    /**
     * Handle keyboard navigation
     */
    handleKeyDown(event) {
        if (!this.isVisible) return;

        if (event.key === 'Escape') {
            event.preventDefault();
            this.hide();
            // Return focus to the extensions button
            if (this.targetButton) {
                this.targetButton.focus();
            }
        }
    }

    /**
     * Clean up popup and event listeners
     */
    destroy() {
        this.hide();
        
        // Clean up extension event listeners
        this.ipc.removeAllListeners('browser-action-changed');
        this.ipc.removeAllListeners('extension-toggled');
        this.ipc.removeAllListeners('extension-installed');
        this.ipc.removeAllListeners('extension-uninstalled');
        
        if (this.popup) {
            this.popup.remove();
            this.popup = null;
        }

        this.targetButton = null;
    }

    /**
     * Load SVG icons for the popup elements
     */
    loadPopupSVGs(popup) {
        // Load close button icon
        const closeButton = popup.querySelector('.close-button .svg-container');
        if (closeButton) {
            this.loadSVG(closeButton, 'peersky://static/assets/svg/close.svg');
        }

        // Load pin button icons - different icons for pinned vs unpinned state
        const pinButtons = popup.querySelectorAll('.pin-button');
        pinButtons.forEach(button => {
            const container = button.querySelector('.svg-container');
            const isPinned = button.classList.contains('pinned');
            const iconPath = isPinned 
                ? 'peersky://static/assets/svg/pin-angle-fill.svg'
                : 'peersky://static/assets/svg/pin-angle.svg';
            this.loadSVG(container, iconPath);
        });

        // Load kebab menu icons
        const kebabButtons = popup.querySelectorAll('.kebab-button .svg-container');
        kebabButtons.forEach(container => {
            this.loadSVG(container, 'peersky://static/assets/svg/three-dots.svg');
        });

        // Load extension fallback icons (puzzle piece for fallback)
        const extensionIcons = popup.querySelectorAll('.extension-icon .svg-container');
        extensionIcons.forEach(container => {
            this.loadSVG(container, 'peersky://static/assets/svg/puzzle.svg');
        });

        // Empty state no longer has an icon - removed for cleaner UI

        // Load loading state elements (if any specific icons needed)
        const loadingIcon = popup.querySelector('.extension-loading .svg-container');
        if (loadingIcon) {
            this.loadSVG(loadingIcon, 'peersky://static/assets/svg/puzzle.svg');
        }
    }

    /**
     * Load SVG content into a container (similar to nav-box pattern)
     */
    loadSVG(container, svgPath) {
        fetch(svgPath)
            .then(response => response.text())
            .then(svgContent => {
                container.innerHTML = svgContent;
                const svgElement = container.querySelector('svg');
                if (svgElement) {
                    // Set appropriate sizes for different contexts
                    if (container.closest('.close-button')) {
                        svgElement.setAttribute('width', '14');
                        svgElement.setAttribute('height', '14');
                    } else if (container.closest('.extension-icon')) {
                        svgElement.setAttribute('width', '20');
                        svgElement.setAttribute('height', '20');
                    } else {
                        svgElement.setAttribute('width', '12');
                        svgElement.setAttribute('height', '12');
                    }
                    svgElement.setAttribute('fill', 'currentColor');
                    // Ensure stroke-based icons adopt theme color
                    svgElement.querySelectorAll('[stroke]').forEach(el => el.setAttribute('stroke', 'currentColor'));
                }
            })
            .catch(error => {
                console.error(`Error loading SVG from ${svgPath}:`, error);
            });
    }
}
