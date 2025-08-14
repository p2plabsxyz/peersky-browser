/**
 * ExtensionsPopup - Self-contained popup UI for browser extensions list
 * Handles popup lifecycle, positioning, and internal interactions
 */
export class ExtensionsPopup {
    constructor() {
        this.popup = null;
        this.isVisible = false;
        this.targetButton = null;
        
        // Bind methods to preserve context
        this.hide = this.hide.bind(this);
        this.handleClickOutside = this.handleClickOutside.bind(this);
        this.handleKeyDown = this.handleKeyDown.bind(this);
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
     * Generate sample extension items for the static UI
     */
    generateExtensionItems() {
        const sampleExtensions = [
            { id: '1', name: 'Extension One', pinned: true },
            { id: '2', name: 'Extension Two', pinned: false },
            { id: '3', name: 'Extension Three', pinned: false },
        ];

        return sampleExtensions.map(ext => `
            <div class="extension-item" role="listitem" data-extension-id="${ext.id}">
                <div class="extension-icon" role="img" aria-label="${ext.name} icon">
                    <div class="svg-container"></div>
                </div>
                <div class="extension-name" title="${ext.name}">
                    ${ext.name}
                </div>
                <div class="extension-controls">
                    <button 
                        class="pin-button ${ext.pinned ? 'pinned' : ''}" 
                        type="button"
                        aria-label="${ext.pinned ? 'Unpin' : 'Pin'} ${ext.name}"
                        title="${ext.pinned ? 'Unpin' : 'Pin'} extension"
                    >
                        <div class="svg-container"></div>
                    </button>
                    <button 
                        class="kebab-button" 
                        type="button"
                        aria-label="More options for ${ext.name}"
                        title="More options"
                    >
                        <div class="svg-container"></div>
                    </button>
                </div>
            </div>
        `).join('');
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
    show(targetButton) {
        if (this.isVisible) return;

        this.targetButton = targetButton;
        
        if (!this.popup) {
            this.popup = this.createPopup();
            this.setupEventListeners();
        }

        this.popup.classList.add('open');
        this.isVisible = true;

        // Position after DOM update
        requestAnimationFrame(() => {
            this.positionPopup();
        });

        // Setup global event listeners
        document.addEventListener('click', this.handleClickOutside);
        document.addEventListener('keydown', this.handleKeyDown);
    }

    /**
     * Hide the popup
     */
    hide() {
        if (!this.isVisible) return;

        this.popup?.classList.remove('open');
        this.isVisible = false;

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

        // Pin button interactions
        this.popup.addEventListener('click', (event) => {
            if (event.target.classList.contains('pin-button')) {
                event.preventDefault();
                event.stopPropagation();
                this.togglePin(event.target);
            }
        });

        // Kebab menu interactions
        this.popup.addEventListener('click', (event) => {
            if (event.target.classList.contains('kebab-button')) {
                event.preventDefault();
                event.stopPropagation();
                // Placeholder for future kebab menu functionality
                console.log('Kebab menu clicked for extension');
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
     * Toggle pin state for an extension
     */
    togglePin(pinButton) {
        const isPinned = pinButton.classList.contains('pinned');
        const extensionName = pinButton.closest('.extension-item')?.querySelector('.extension-name')?.textContent;
        
        if (isPinned) {
            pinButton.classList.remove('pinned');
            pinButton.setAttribute('aria-label', `Pin ${extensionName}`);
            pinButton.setAttribute('title', 'Pin extension');
        } else {
            pinButton.classList.add('pinned');
            pinButton.setAttribute('aria-label', `Unpin ${extensionName}`);
            pinButton.setAttribute('title', 'Unpin extension');
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

        // Load pin button icons
        const pinButtons = popup.querySelectorAll('.pin-button .svg-container');
        pinButtons.forEach(container => {
            this.loadSVG(container, 'peersky://static/assets/svg/pin-angle.svg');
        });

        // Load kebab menu icons
        const kebabButtons = popup.querySelectorAll('.kebab-button .svg-container');
        kebabButtons.forEach(container => {
            this.loadSVG(container, 'peersky://static/assets/svg/three-dots.svg');
        });

        // Load extension icons (placeholder puzzle piece icons)
        const extensionIcons = popup.querySelectorAll('.extension-icon .svg-container');
        extensionIcons.forEach(container => {
            this.loadSVG(container, 'peersky://static/assets/svg/puzzle.svg');
        });
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
                        svgElement.setAttribute('width', '16');
                        svgElement.setAttribute('height', '16');
                    } else {
                        svgElement.setAttribute('width', '12');
                        svgElement.setAttribute('height', '12');
                    }
                    svgElement.setAttribute('fill', 'currentColor');
                }
            })
            .catch(error => {
                console.error(`Error loading SVG from ${svgPath}:`, error);
            });
    }
}