class NavBox extends HTMLElement {
  constructor() {
    super();
    this.isLoading = false;
    this.buildNavBox();
    this.attachEvents();
    this.attachThemeListener();
  }

  parseUrlForStyling(url) {
    if (!url || typeof url !== 'string') return { protocolDomain: '', path: '' };
    
    // Handle peersky:// URLs
    if (url.startsWith('peersky://')) {
      const match = url.match(/^(peersky:\/\/[^\/]*)(\/.*)?$/);
      if (match) {
        return {
          protocolDomain: match[1] || '',
          path: match[2] || ''
        };
      }
    }
    
    // For non-peersky URLs, return as is (no styling)
    return { protocolDomain: url, path: '' };
  }

  setStyledUrl(url) {
    const urlDisplay = this.querySelector("#url");
    if (!urlDisplay) return;

    const { protocolDomain, path } = this.parseUrlForStyling(url);
    
    if (protocolDomain && path) {
      // Create styled content for peersky URLs
      urlDisplay.innerHTML = `<span class="url-protocol-domain-highlight">${protocolDomain}</span><span class="url-path-highlight">${path}</span>`;
    } else if (protocolDomain) {
      // Single colored content or regular URLs
      if (protocolDomain.startsWith('peersky://')) {
        urlDisplay.innerHTML = `<span class="url-protocol-domain-highlight">${protocolDomain}</span>`;
      } else {
        urlDisplay.textContent = protocolDomain;
      }
    } else {
      urlDisplay.textContent = '';
    }
  }

  buildNavBox() {
    this.id = "navbox";
    const buttons = [
      { id: "back", svg: "left.svg", position: "start" },
      { id: "forward", svg: "right.svg", position: "start" },
      { id: "refresh", svg: "reload.svg", position: "start" },
      { id: "home", svg: "home.svg", position: "start" },
      { id: "plus", svg: "plus.svg", position: "end" },
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

    const urlDisplay = document.createElement("div");
    urlDisplay.id = "url";
    urlDisplay.contentEditable = true;
    urlDisplay.setAttribute("data-placeholder", "Search with DuckDuckGo or type a P2P URL");
    urlDisplay.classList.add("transition-disabled"); // Prevent initial flicker
    this.appendChild(urlDisplay);
    
    // Update placeholder based on search engine setting
    this.updateSearchPlaceholder();

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
        } else if (button.id === "settings") {
          this.dispatchEvent(new CustomEvent("navigate", { detail: { url: "peersky://settings" } }));
        } else if (!button.disabled) {
          this.navigate(button.id);
        }
      }
    });

    const urlDisplay = this.querySelector("#url");
    if (urlDisplay) {
      urlDisplay.addEventListener("keypress", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          const url = event.target.textContent.trim();
          this.dispatchEvent(new CustomEvent("navigate", { detail: { url } }));
        }
      });
    } else {
      console.error("URL display not found within nav-box.");
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
      
      // Enable transitions after theme is applied
      const urlDisplay = this.querySelector("#url");
      if (urlDisplay) {
        urlDisplay.classList.remove('transition-disabled');
      }
      
      // Remove the temporary class after a brief moment
      setTimeout(() => {
        this.classList.remove('theme-updating');
      }, 100);
    });
  }

  async updateSearchPlaceholder() {
    const urlDisplay = this.querySelector("#url");
    if (!urlDisplay) return;
    
    try {
      const { ipcRenderer } = require('electron');
      const searchEngine = await ipcRenderer.invoke('settings-get', 'searchEngine');
      
      const engineNames = {
        'duckduckgo': 'DuckDuckGo',
        'ecosia': 'Ecosia',
        'startpage': 'Startpage'
      };
      
      const engineName = engineNames[searchEngine] || 'DuckDuckGo';
      urlDisplay.setAttribute("data-placeholder", `Search with ${engineName} or type a P2P URL`);
    } catch (error) {
      console.warn('NavBox: Could not get search engine setting:', error);
      urlDisplay.setAttribute("data-placeholder", "Search with DuckDuckGo or type a P2P URL");
    }
  }
}

customElements.define("nav-box", NavBox);
